/**
 * Run the engine's Swift unit tests.
 *
 * `swift test` is not enough on a machine whose active developer directory is
 * the Command Line Tools rather than a full Xcode: the Swift Testing macros
 * live in a plugin bundle that SwiftPM does not put on the compiler's plugin
 * search path, so every `@Test` fails with "external macro implementation type
 * could not be found". The module and the plugin both ship with the toolchain —
 * only the search path is missing — so this resolves the plugin directory from
 * the active toolchain and passes it explicitly.
 *
 * The path is found rather than hardcoded because it differs between the two
 * layouts (`<toolchain>/usr/lib/swift/host/plugins/testing` for the Command
 * Line Tools, `<Xcode>/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/
 * plugins/testing` for Xcode), and a hardcoded path would make this script work
 * on exactly one of them.
 *
 * Usage: `node scripts/test-swift.mjs`
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(packageRoot, 'native', 'cua-engine')

/** Every place a toolchain keeps its macro plugin bundles, most specific first. */
function pluginSearchPaths() {
  const candidates = []
  const swift = spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8' })
  if (swift.status === 0 && swift.stdout.trim() !== '') {
    // <toolchain>/usr/bin/swift -> <toolchain>/usr/lib/swift/host/plugins
    candidates.push(join(dirname(dirname(swift.stdout.trim())), 'lib', 'swift', 'host', 'plugins'))
  }
  const developerDir = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' })
  if (developerDir.status === 0) {
    const root = developerDir.stdout.trim()
    candidates.push(join(root, 'usr', 'lib', 'swift', 'host', 'plugins'))
    const toolchains = join(root, 'Toolchains')
    if (existsSync(toolchains)) {
      for (const entry of readdirSync(toolchains)) {
        candidates.push(join(toolchains, entry, 'usr', 'lib', 'swift', 'host', 'plugins'))
      }
    }
  }
  candidates.push('/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins')
  return candidates
}

/** The directory containing `libTestingMacros.dylib`, when one is installed. */
function testingPluginPath() {
  for (const base of pluginSearchPaths()) {
    const testing = join(base, 'testing')
    if (existsSync(join(testing, 'libTestingMacros.dylib'))) return testing
  }
  return undefined
}

if (!existsSync(packageDir)) {
  process.stderr.write(`no Swift package at ${packageDir}\n`)
  process.exit(1)
}

const pluginPath = testingPluginPath()
const args = ['test']
if (pluginPath !== undefined) {
  // SwiftPM needs `-plugin-path` to reach the compiler, not to swift-testing.
  args.push('-Xswiftc', '-plugin-path', '-Xswiftc', pluginPath)
} else {
  process.stderr.write(
    'cua-engine: no Swift Testing macro plugin found; if the tests fail to build, '
      + 'install a full Xcode or pass -Xswiftc -plugin-path yourself.\n',
  )
}

const result = spawnSync('swift', args, { cwd: packageDir, stdio: 'inherit' })
process.exit(result.status ?? 1)
