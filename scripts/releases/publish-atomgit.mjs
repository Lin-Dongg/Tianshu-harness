import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { sha256 } from './generate-catalog.mjs'
import { validateCatalog } from './catalog.mjs'

const BASE = 'https://api.atomgit.com/api/v5/repos/huiliyi37/Tianshu-harness'
export const downloadURL = (tag, name) => `${BASE}/releases/${encodeURIComponent(tag)}/attach_files/${encodeURIComponent(name)}/download`
export function validateAcceptance(value, catalog, artifact) {
  if (value?.schemaVersion !== 1 || value.version !== catalog.version || value.platform !== artifact.platform || value.sha256 !== artifact.sha256 || value.tauriRedirectVerified !== true || value.stableEntryVerified !== true || value.disconnectRetryVerified !== true || typeof value.limitsObserved !== 'string' || !value.limitsObserved.trim() || !Array.isArray(value.networks) || value.networks.length < 2) throw new Error('AtomGit manual acceptance is incomplete')
  const names = new Set()
  for (const network of value.networks) {
    if (network.passed !== true || typeof network.name !== 'string' || !network.name.trim() || !Number.isFinite(Date.parse(network.checkedAt))) throw new Error('Invalid domestic network acceptance record')
    names.add(network.name.trim())
  }
  if (names.size < 2) throw new Error('At least two distinct network observations are required')
  return true
}

/** Anonymous probe follows redirects but records only the stable API entry. Never downloads through our servers. */
export async function verifyDownload(url, expected, request = fetch) {
  const response = await request(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!response.ok || !response.body) throw new Error(`Anonymous package download failed: HTTP ${response.status}`)
  const hash = createHash('sha256'); let size = 0
  for await (const chunk of response.body) { size += chunk.length; if (size > expected.size) throw new Error('Package exceeds expected size'); hash.update(chunk) }
  const digest = hash.digest('hex')
  if (size !== expected.size || digest !== expected.sha256) throw new Error('Package SHA-256 or size mismatch')
  const head = await request(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) })
  const range = await request(url, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(15000) })
  const rangeSupported = range.status === 206 && /^bytes 0-\d+\/\d+$/.test(range.headers.get('content-range') ?? '')
  await range.body?.cancel()
  return { url, verified: true, anonymous: true, verifiedAt: new Date().toISOString(), sha256: digest, size, headStatus: head.status, rangeSupported }
}

function credential() {
  if (process.env.ATOMGIT_ACCESS_TOKEN) return process.env.ATOMGIT_ACCESS_TOKEN
  for (const host of ['atomgit.com','api.atomgit.com']) {
    try {
      const text = execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['pipe','pipe','ignore'], timeout: 5000, windowsHide: true }).toString()
      const password = text.split('\n').find(line => line.startsWith('password='))?.slice(9)
      if (password) return password
    } catch { /* try the API host without opening an interactive login */ }
  }
}
export function atomgitClient(token, request = fetch) {
  return async (path, options = {}) => {
    const url = new URL(`${BASE}${path}`); url.searchParams.set('access_token', token)
    const response = await request(url, { ...options, signal: AbortSignal.timeout(30000) })
    if (!response.ok) { const e = new Error(`AtomGit API failed: HTTP ${response.status}`); e.status = response.status; throw e }
    return response.json()
  }
}
/** Existing attachments are downloaded and compared before retry. A different immutable file is never overwritten. */
export async function uploadImmutable(api, tag, file, expected, request = fetch) {
  const name = basename(file), entry = downloadURL(tag, name)
  const probe = await request(entry, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) })
  if (probe.ok) return verifyDownload(entry, expected, request)
  if (probe.status !== 404) throw new Error(`Cannot establish attachment absence: HTTP ${probe.status}`)
  const info = await api(`/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(name)}`)
  const target = new URL(info.url)
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Unsafe upload address')
  const response = await request(target, { method: 'PUT', headers: info.headers, body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!response.ok) throw new Error(`Attachment upload failed: HTTP ${response.status}`)
  return verifyDownload(entry, expected, request)
}
async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i+1] }
  const assets = resolve(arg('--assets') ?? 'release')
  const catalogPath = arg('--catalog') ?? 'release-catalog.json'
  const catalog = validateCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')))
  const target = catalog.artifacts.find(a => a.platform === (arg('--platform') ?? 'windows-x86_64') && a.purpose === 'update')
  if (!target) throw new Error('Missing platform artifact')
  const file = join(assets, target.fileName)
  if (statSync(file).size !== target.size || await sha256(file) !== target.sha256) throw new Error('Local artifact differs from catalog')
  if (readFileSync(file + '.sig','utf8').trim() !== target.signature.trim()) throw new Error('Local signature differs from catalog')
  const acceptance = arg('--acceptance') ? validateAcceptance(JSON.parse(readFileSync(arg('--acceptance'),'utf8')),catalog,target) : false
  if (!process.argv.includes('--publish')) {
    console.log(`Dry run: v${catalog.version}, ${target.fileName}, ${target.size} bytes; use --publish to upload and verify`)
    return
  }
  const token = credential(); if (!token) { const error = new Error('AtomGit credential unavailable'); error.code='CREDENTIAL_UNAVAILABLE'; throw error }
  const api = atomgitClient(token), tag = `v${catalog.version}`
  try { await api(`/releases/tags/${tag}`) } catch (e) {
    if (e.status !== 404) throw e
    // Existing signed version/tag is required; never silently tag unrelated main HEAD.
    const tags = execFileSync('git', ['ls-remote', '--tags', 'https://atomgit.com/huiliyi37/Tianshu-harness.git', `refs/tags/${tag}`], { env: { ...process.env, GIT_TERMINAL_PROMPT:'0' }, stdio:['ignore','pipe','ignore'], timeout:30000, windowsHide: true }).toString()
    if (!tags.trim()) throw new Error('Version tag must be mirrored to AtomGit before publishing attachments')
    await api('/releases', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tag_name: tag, name: tag, body: catalog.notes ?? '', release_status:'latest' }) })
  }
  let proof = await uploadImmutable(api, tag, file, target)
  if (!proof.rangeSupported || proof.headStatus !== 200) throw new Error('Full download verified, but HEAD/Range acceptance failed; source remains disabled')
  const previous = target.sources.atomgit
  // Re-verification must not change immutable metadata on an idempotent retry.
  const qualified = acceptance || previous?.qualificationVerified === true
  proof.verified = qualified
  proof.qualificationVerified = qualified
  if (previous?.anonymous && previous.sha256 === proof.sha256 && previous.size === proof.size) {
    proof.verifiedAt = previous.verifiedAt
    if (previous.verified !== qualified) catalog.revision += 1
  } else catalog.revision += 1
  for (const a of catalog.artifacts.filter(a => a.platform === target.platform && a.fileName === target.fileName)) a.sources.atomgit = proof
  writeFileSync(catalogPath,JSON.stringify(validateCatalog(catalog),null,2)+'\n')
  const extra = async path => uploadImmutable(api, tag, path, { size: statSync(path).size, sha256: await sha256(path) })
  await extra(file+'.sig')
  const checksumPath = join(assets,`${target.fileName}.sha256`)
  writeFileSync(checksumPath,`${target.sha256}  ${target.fileName}\n`); await extra(checksumPath)
  if (process.argv.includes('--assets-only')) { console.log(`Verified ${target.platform} assets; metadata publication deferred until all intended platforms are ready`); return }
  const platforms = Object.fromEntries(catalog.artifacts.filter(a => a.purpose === 'update' && a.sources.atomgit?.anonymous).map(a => [a.platform, { url:a.sources.atomgit.url, signature:a.signature }]))
  const manifest = { version: catalog.version, notes: catalog.notes ?? '', pub_date: catalog.publishedAt, platforms }
  const manifestPath = join(assets,'latest.json'); writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n'); await extra(manifestPath)
  if (!qualified) { console.log('Anonymous bytes/HEAD/Range passed. AtomGit remains disabled pending recorded Tauri redirects, stable entry, disconnect retry, distinct domestic networks and limits observations (--acceptance).'); return }
  const output = join(assets,'release-catalog.json'); writeFileSync(output,JSON.stringify(validateCatalog(catalog),null,2)+'\n'); await extra(output)
  writeFileSync(catalogPath,JSON.stringify(catalog,null,2)+'\n')
  console.log(`Verified anonymous AtomGit download: ${target.fileName}, ${proof.size} bytes. Catalog saved; publish it to GitHub/OSS before enabling routing.`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  // HTTP errors can contain credential-bearing upload URLs. Never echo raw transport errors.
  console.error(error.code === 'CREDENTIAL_UNAVAILABLE' ? 'AtomGit credential unavailable. Configure ATOMGIT_ACCESS_TOKEN or the system Git credential helper; do not paste credentials into chat.' : 'AtomGit publication did not complete. No unverified source was enabled. Check release tag, immutable attachments and anonymous access.'); process.exitCode = 1
})
