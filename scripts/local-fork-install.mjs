/**
 * Install this checkout's packed release family into a standalone tree so the
 * fork can be driven as `dsh` without a registry round-trip.
 *
 * Every internal dependency range in the packed manifests (`^0.1.0-rc.5`) also
 * matches the registry's newer prerelease, so the local tarballs are pinned
 * twice: once as direct dependencies and once through `overrides`. Without the
 * overrides npm is free to satisfy a transitive range from the registry, which
 * would quietly reinstate the unpatched upstream package this fork exists to
 * replace.
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packed = resolve(process.argv[2] ?? 'dist/npm')
const target = resolve(process.argv[3] ?? join(process.env.HOME ?? '.', '.dsh-fork'))

/** Read `name`/`version` out of a tarball's manifest. */
function identity(tarball) {
  const raw = execSync(`tar -xzOf ${JSON.stringify(tarball)} package/package.json`, { encoding: 'utf8' })
  const manifest = JSON.parse(raw)
  return { name: manifest.name, version: manifest.version }
}

const dependencies = {}
const overrides = {}
for (const filename of readdirSync(packed).filter(name => name.endsWith('.tgz')).sort()) {
  const url = pathToFileURL(join(packed, filename)).href
  const { name } = identity(join(packed, filename))
  dependencies[name] = url
  overrides[name] = url
}
if (dependencies['@deepseek-ai/dsh'] === undefined) throw new Error('@deepseek-ai/dsh is not among the packed tarballs')

mkdirSync(target, { recursive: true })
writeFileSync(join(target, 'package.json'), `${JSON.stringify({
  name: 'dsh-fork-install',
  version: '0.0.0',
  private: true,
  dependencies,
  overrides,
}, null, 2)}\n`)

// Optional dependencies stay in: koffi ships its native binary as a per-platform
// optional package, and omitting it sends koffi's install script down a
// from-source build that does not link here. The repo's own packed-install
// verification omits them on purpose — it proves the tree starts without them —
// but this is a real install, so it takes the prebuilt binary.
console.log(`installing ${String(Object.keys(dependencies).length)} tarball(s) into ${target}`)
execFileSync('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], {
  cwd: target,
  stdio: 'inherit',
})

const installed = JSON.parse(readFileSync(join(target, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
console.log(`installed @deepseek-ai/dsh ${installed.version} at ${target}`)
