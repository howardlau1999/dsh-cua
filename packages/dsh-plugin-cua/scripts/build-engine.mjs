/**
 * Build the native `cua-engine` and place it beside the plugin.
 *
 * SwiftPM is driven directly rather than through a wrapper so the failure mode
 * is legible: a machine without the Swift toolchain gets one clear sentence
 * instead of a missing-binary error at tool-call time.
 *
 * The build is skipped with a message (not an error) on a non-macOS host: the
 * package still loads there and reports `unsupported_platform`, which is a
 * truthful state rather than a broken install.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(packageRoot, 'native', 'cua-engine')
const outputDir = join(packageRoot, 'lib', 'bin')
const outputPath = join(outputDir, 'cua-engine')
const configuration = process.env.CUA_ENGINE_CONFIGURATION ?? 'release'

if (process.platform !== 'darwin') {
  process.stderr.write(
    `cua-engine: the only implemented backend today is macOS; ${process.platform} has no engine to build.\n`
    + 'The plugin will load and report an unsupported platform.\n',
  )
  process.exit(0)
}

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

process.stdout.write(`cua-engine: building (${configuration})…\n`)
const build = spawnSync('swift', ['build', '-c', configuration, '--product', 'cua-engine'], {
  cwd: packageDir,
  stdio: 'inherit',
})
if (build.status !== 0) {
  process.stderr.write('cua-engine: swift build failed\n')
  process.exit(build.status ?? 1)
}

// Ask SwiftPM where it put the binary instead of guessing the layout, which has
// changed between toolchain versions.
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

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })
copyFileSync(built, outputPath)
const size = statSync(outputPath).size
process.stdout.write(`cua-engine: wrote ${outputPath} (${(size / 1024 / 1024).toFixed(1)} MiB)\n`)
