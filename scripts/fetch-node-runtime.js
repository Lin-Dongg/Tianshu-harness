#!/usr/bin/env node
/** Shared CLI/desktop Node payload fetcher. Importing the version has no side effects. */
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const DEFAULT_NODE_VERSION = '24.18.0'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function fetchNodeRuntime(outputRoot) {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE || ''
  const platform = triple.includes('darwin') ? 'darwin' : triple.includes('windows') ? 'win32' : triple.includes('linux') ? 'linux' : process.platform
  const arch = /^(aarch64|arm64)-/.test(triple) ? 'arm64' : triple.startsWith('x86_64-') ? 'x64' : process.arch
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported Node target: ${platform}-${arch}`)
  const version = process.env.NODE_VERSION || DEFAULT_NODE_VERSION
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid NODE_VERSION: ${version}`)
  const token = platform === 'win32' ? 'win' : platform
  const root = outputRoot || (existsSync(join(repoRoot, 'desktop'))
    ? join(repoRoot, 'desktop', 'src-tauri', 'resources', 'node')
    : join(repoRoot, 'out', 'node-runtime'))
  const dest = join(root, `${token}-${arch}`)
  const nodeName = platform === 'win32' ? 'node.exe' : 'node'
  const marker = join(dest, '.node-version')
  if (existsSync(join(dest, nodeName)) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === version) {
    console.log(`✅ Node v${version} already staged → ${dest}`)
    return dest
  }

  const ext = platform === 'win32' ? 'zip' : 'tar.xz'
  const name = `node-v${version}-${token}-${arch}`
  const archive = `${name}.${ext}`
  const base = `https://nodejs.org/dist/v${version}`
  const temp = mkdtempSync(join(tmpdir(), 'tianshu-node-runtime-'))
  try {
    console.log(`Downloading ${base}/${archive}`)
    const response = await fetch(`${base}/${archive}`)
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`)
    const downloaded = join(temp, archive)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(downloaded))
    const sums = await fetch(`${base}/SHASUMS256.txt`)
    if (!sums.ok) throw new Error(`Node checksums failed: HTTP ${sums.status}`)
    const expected = (await sums.text()).split('\n').find(line => line.trim().endsWith(` ${archive}`))?.trim().split(/\s+/)[0]
    const actual = createHash('sha256').update(readFileSync(downloaded)).digest('hex')
    if (!expected || actual !== expected) throw new Error(`Node checksum mismatch: ${archive}`)
    execFileSync('tar', ['-xf', downloaded, '-C', temp], { stdio: 'inherit', windowsHide: true })
    const extracted = join(temp, name)
    const payload = join(temp, 'payload')
    mkdirSync(payload)
    if (platform === 'win32') {
      cpSync(extracted, payload, { recursive: true, verbatimSymlinks: true })
    } else {
      cpSync(join(extracted, 'bin', 'node'), join(payload, 'node'))
      const npm = join(payload, 'lib', 'node_modules', 'npm')
      mkdirSync(dirname(npm), { recursive: true })
      cpSync(join(extracted, 'lib', 'node_modules', 'npm'), npm, { recursive: true, verbatimSymlinks: true })
      symlinkSync('lib/node_modules/npm/bin/npm-cli.js', join(payload, 'npm'))
      symlinkSync('lib/node_modules/npm/bin/npx-cli.js', join(payload, 'npx'))
    }
    if (!existsSync(join(payload, nodeName))) throw new Error(`Node archive missing ${nodeName}`)
    writeFileSync(join(payload, '.node-version'), version + '\n')
    mkdirSync(root, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    // Copy through a fresh directory so signed executables never reuse an inode.
    const fresh = join(root, `.node-${token}-${arch}-${process.pid}`)
    cpSync(payload, fresh, { recursive: true, verbatimSymlinks: true })
    renameSync(fresh, dest)
    console.log(`✅ Node v${version} staged → ${dest}`)
    return dest
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchNodeRuntime(process.argv[2])
}
