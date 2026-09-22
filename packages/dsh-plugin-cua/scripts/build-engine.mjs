/**
 * Build the native `cua-engine` and place it beside the plugin.
 *
 * Two backends, two toolchains, one output path. Each is driven directly rather
 * than through a wrapper so the failure mode is legible: a machine without the
 * toolchain gets one clear sentence instead of a missing-binary error at
 * tool-call time.
 *
 * A host with no backend at all is skipped with a message rather than an error:
 * the package still loads there and reports `unsupported_platform`, which is a
 * truthful state rather than a broken install.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDir = join(packageRoot, 'lib', 'bin')

/**
 * Which shape to publish the .NET engine in.
 *
 * The default is a **folder**, not a single file, and that is an antivirus
 * decision rather than a packaging preference. `PublishSingleFile` with
 * `IncludeNativeLibrariesForSelfExtract` — which WPF needs, because it ships
 * native libraries — makes the executable write those libraries into
 * `%TEMP%\.net\<name>\<hash>\` on every start and load them from there. That is
 * the same thing a dropper does, it leaves a fresh copy behind on every build,
 * and it is the strongest signal in this binary. A folder publish has none of
 * that behaviour and still needs no .NET runtime installed.
 *
 * The two opt-ins exist for callers who want something else and accept the
 * trade-off:
 *
 * - `CUA_ENGINE_WIN_FRAMEWORK_DEPENDENT=1` — 0.3 MB, no self-extraction, but the
 *   machine must already have the .NET 9 desktop runtime.
 * - `CUA_ENGINE_WIN_SINGLE_FILE=1` — one file, and it self-extracts on start.
 */
const frameworkDependent = process.env.CUA_ENGINE_WIN_FRAMEWORK_DEPENDENT === '1'
const singleFile = process.env.CUA_ENGINE_WIN_SINGLE_FILE === '1'

if (process.platform === 'darwin') {
  buildSwift()
} else if (process.platform === 'win32') {
  buildDotnet()
} else {
  process.stderr.write(
    `cua-engine: the implemented backends are macOS and Windows; ${process.platform} has none to build.\n`
    + 'The plugin will load and report an unsupported platform.\n',
  )
  process.exit(0)
}

/** Build the Swift engine with SwiftPM and copy it into `lib/bin`. */
function buildSwift() {
  const packageDir = join(packageRoot, 'native', 'cua-engine')
  const configuration = process.env.CUA_ENGINE_CONFIGURATION ?? 'release'

  if (!existsSync(join(packageDir, 'Package.swift'))) {
    process.stderr.write(`cua-engine: no Swift package at ${packageDir}\n`)
    process.exit(1)
  }

  const which = spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8' })
  if (which.status !== 0) {
    process.stderr.write(
      'cua-engine: the Swift toolchain is required to build the engine.\n'
      + 'Install it with `xcode-select --install`, then re-run `pnpm run build:engine`.\n',
    )
    process.exit(1)
  }

  process.stdout.write(`cua-engine: building the Swift engine (${configuration})…\n`)
  const build = spawnSync('swift', ['build', '-c', configuration, '--product', 'cua-engine'], {
    cwd: packageDir,
    stdio: 'inherit',
  })
  if (build.status !== 0) {
    process.stderr.write('cua-engine: swift build failed\n')
    process.exit(build.status ?? 1)
  }

  // Ask SwiftPM where it put the binary instead of guessing the layout, which
  // has changed between toolchain versions.
  const showBin = spawnSync('swift', ['build', '-c', configuration, '--show-bin-path'], {
    cwd: packageDir,
    encoding: 'utf8',
  })
  if (showBin.status !== 0) {
    process.stderr.write('cua-engine: could not locate the built binary\n')
    process.exit(showBin.status ?? 1)
  }
  const built = join(showBin.stdout.trim(), 'cua-engine')
  if (!existsSync(built)) {
    process.stderr.write(`cua-engine: expected the binary at ${built} but it is not there\n`)
    process.exit(1)
  }

  installFile(built, 'cua-engine')
}

/** Build the .NET engine and install the published output into `lib/bin`. */
function buildDotnet() {
  const projectDir = join(packageRoot, 'native', 'cua-engine-win')
  const project = join(projectDir, 'CuaEngine.csproj')
  if (!existsSync(project)) {
    process.stderr.write(`cua-engine: no .NET project at ${project}\n`)
    process.exit(1)
  }

  const probe = spawnSync('dotnet', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    process.stderr.write(
      'cua-engine: the .NET SDK is required to build the Windows engine.\n'
      + 'Install the .NET 9 SDK (https://aka.ms/dotnet/download), then re-run `pnpm run build:engine`.\n',
    )
    process.exit(1)
  }

  const staging = join(projectDir, 'obj', 'publish')
  rmSync(staging, { recursive: true, force: true })

  const mode = singleFile
    ? (frameworkDependent ? 'single file, framework-dependent' : 'single file, self-contained')
    : (frameworkDependent ? 'folder, framework-dependent' : 'folder, self-contained')
  process.stdout.write(`cua-engine: building the .NET engine (${mode})…\n`)
  const publish = spawnSync('dotnet', [
    'publish', project,
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', frameworkDependent ? 'false' : 'true',
    `-p:PublishSingleFile=${singleFile ? 'true' : 'false'}`,
    `-p:IncludeNativeLibrariesForSelfExtract=${singleFile ? 'true' : 'false'}`,
    '-p:DebugType=none',
    '-o', staging,
    '--nologo',
  ], { cwd: projectDir, stdio: 'inherit' })
  if (publish.status !== 0) {
    process.stderr.write('cua-engine: dotnet publish failed\n')
    process.exit(publish.status ?? 1)
  }

  const built = join(staging, 'cua-engine.exe')
  if (!existsSync(built)) {
    process.stderr.write(`cua-engine: expected cua-engine.exe in ${staging} but it is not there\n`)
    process.exit(1)
  }

  // A folder publish ships its dependencies beside the executable, so the whole
  // directory has to travel together. A single-file publish is just the one file.
  if (singleFile) installFile(built, 'cua-engine.exe')
  else installDirectory(staging, 'cua-engine', 'cua-engine.exe')
}

/** Replace `lib/bin` with one freshly built executable. */
function installFile(built, name) {
  rmSync(outputDir, { recursive: true, force: true })
  const outputPath = join(outputDir, name)
  mkdirSync(dirname(outputPath), { recursive: true })
  copyFileSync(built, outputPath)
  sign(outputPath)
  const size = statSync(outputPath).size
  process.stdout.write(`cua-engine: wrote ${outputPath} (${(size / 1024 / 1024).toFixed(2)} MiB)\n`)
}

/**
 * Replace `lib/bin` with a freshly published directory.
 *
 * The folder is kept whole rather than being flattened into `lib/bin`: the
 * publish output is a .NET application layout whose files have to stay together,
 * and leaving the plugin's own directory clean means the installed engine is one
 * unambiguous thing to point at.
 */
function installDirectory(staging, folderName, executableName) {
  rmSync(outputDir, { recursive: true, force: true })
  const target = join(outputDir, folderName)
  mkdirSync(target, { recursive: true })
  // `robocopy` rather than a hand-rolled walk: the publish output has nested
  // runtime directories whose shape is not this script's business. Its exit
  // codes are a bitmask where 0-7 mean success and 8 and up mean failure.
  const copied = spawnSync(
    'robocopy', [staging, target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { stdio: 'ignore' },
  )
  if (copied.status === null || copied.status >= 8) {
    process.stderr.write(`cua-engine: copying the publish output failed (robocopy exit ${copied.status})\n`)
    process.exit(1)
  }

  const outputPath = join(target, executableName)
  if (!existsSync(outputPath)) {
    process.stderr.write(`cua-engine: expected ${outputPath} after copying but it is not there\n`)
    process.exit(1)
  }
  sign(outputPath)
  let files = 0
  for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files++
  }
  const size = statSync(outputPath).size
  process.stdout.write(
    `cua-engine: wrote ${outputPath} (${(size / 1024 / 1024).toFixed(1)} MiB, ${files} files in the folder)\n`,
  )
}

/**
 * Sign the engine when a certificate is configured.
 *
 * Optional, and the only thing that actually removes the "unknown publisher"
 * verdict rather than reducing it. Set `CUA_ENGINE_SIGN_PFX` to a `.pfx` path
 * (and `CUA_ENGINE_SIGN_PASSWORD` if it has one) and every build signs what it
 * produced. Uses `Set-AuthenticodeSignature` so no Windows SDK is required.
 */
function sign(executablePath) {
  const pfx = process.env.CUA_ENGINE_SIGN_PFX
  if (pfx === undefined || pfx === '') return
  if (!existsSync(pfx)) {
    process.stderr.write(`cua-engine: CUA_ENGINE_SIGN_PFX points at ${pfx}, which does not exist\n`)
    process.exit(1)
  }
  const password = process.env.CUA_ENGINE_SIGN_PASSWORD ?? ''
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$cert = Get-PfxCertificate -FilePath '${pfx.replaceAll("'", "''")}'`,
    `$result = Set-AuthenticodeSignature -FilePath '${executablePath.replaceAll("'", "''")}' -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'`,
    'if ($result.Status -ne "Valid") { Write-Error "signing failed: $($result.Status) $($result.StatusMessage)" }',
  ].join('; ')
  const signed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    env: { ...process.env, CUA_SIGN_PASSWORD: password },
  })
  if (signed.status !== 0) {
    process.stderr.write('cua-engine: signing failed; the engine was built but is unsigned\n')
    process.exit(signed.status ?? 1)
  }
  process.stdout.write('cua-engine: signed with the configured certificate\n')
}
