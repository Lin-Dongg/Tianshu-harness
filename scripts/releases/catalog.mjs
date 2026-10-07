/** Public release protocol, shared byte-for-byte with the website. No desktop implementation. */
export const CATALOG_URLS = [
  'https://tianshu-update.oss-cn-hangzhou.aliyuncs.com/tianshu/release-catalog.json',
  'https://github.com/huiliyi37/Tianshu-harness/releases/latest/download/release-catalog.json',
]
export const SOURCE_IDS = ['atomgit', 'github', 'oss']
export function stableVersion(version) {
  return typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) && version.split('.').every(n => Number.isSafeInteger(Number(n)))
}
export function compareVersion(a, b) {
  if (!stableVersion(a) || !stableVersion(b)) throw new Error('Only stable semantic versions are supported')
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}
export function sourceURL(source, raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) throw new Error('Download URL must be a stable public HTTPS entry')
  const allowed = { atomgit: ['api.atomgit.com', 'atomgit.com', 'gitcode.com'], github: ['github.com'], oss: ['tianshu-update.oss-cn-hangzhou.aliyuncs.com'] }
  if (!allowed[source]?.includes(url.hostname)) throw new Error('Unexpected download source host')
  if (source === 'github' && !url.pathname.startsWith('/huiliyi37/Tianshu-harness/releases/download/')) throw new Error('Unexpected GitHub release path')
  if (source === 'atomgit' && !url.pathname.includes('/huiliyi37/Tianshu-harness/')) throw new Error('Unexpected AtomGit release path')
  if (source === 'oss' && !url.pathname.startsWith('/tianshu/v')) throw new Error('Unexpected OSS release path')
  return url.href
}
export function validateCatalog(value) {
  if (!value || value.schemaVersion !== 1 || !stableVersion(value.version) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isFinite(Date.parse(value.publishedAt)) || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 32) throw new Error('Invalid release catalog')
  if (value.releaseNotesUrl !== undefined) { sourceURL('github', value.releaseNotesUrl); if (!new URL(value.releaseNotesUrl).pathname.endsWith(`/v${value.version}/release-notes.json`)) throw new Error('Release notes version mismatch') }
  const identities = new Set()
  for (const asset of value.artifacts) {
    const identity = `${asset.platform}:${asset.purpose}`
    if (identities.has(identity) || !/^(windows|darwin|linux)-(x86_64|aarch64)$/.test(asset.platform) || !['install', 'update'].includes(asset.purpose)) throw new Error('Duplicate or invalid artifact target')
    identities.add(identity)
    if (typeof asset.fileName !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(asset.fileName) || !asset.fileName.startsWith(`Tianshu_${value.version}_`) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid artifact identity')
    const arch = asset.platform.endsWith('x86_64') ? 'x64' : 'aarch64'
    const suffix = asset.platform.startsWith('windows') ? `${arch}-setup.exe` : asset.platform.startsWith('darwin') ? `${arch}.${asset.purpose === 'install' ? 'dmg' : 'app.tar.gz'}` : `${arch === 'x64' ? 'amd64' : arch}.AppImage`
    if (asset.fileName !== `Tianshu_${value.version}_${suffix}`) throw new Error('Artifact platform or purpose does not match package format')
    if (asset.purpose === 'update' && (typeof asset.signature !== 'string' || !asset.signature.trim())) throw new Error('Missing updater signature')
    if (!asset.sources || !Object.keys(asset.sources).length) throw new Error('Artifact has no sources')
    for (const [source, entry] of Object.entries(asset.sources)) {
      if (!SOURCE_IDS.includes(source) || typeof entry?.verified !== 'boolean') throw new Error('Invalid source verification')
      sourceURL(source, entry.url)
      const path = new URL(entry.url).pathname
      const expected = source === 'atomgit' ? `/releases/v${value.version}/attach_files/${asset.fileName}/download` : `/v${value.version}/${asset.fileName}`
      if (!path.endsWith(expected)) throw new Error('Source URL does not identify the catalog artifact')
      if (entry.verified && (!Number.isFinite(Date.parse(entry.verifiedAt)) || entry.sha256 !== asset.sha256 || entry.size !== asset.size)) throw new Error('Verified source does not match artifact')
      if (source === 'atomgit' && entry.verified && entry.anonymous !== true) throw new Error('AtomGit must pass anonymous download verification')
    }
  }
  return value
}
export function selectSources(catalog, platform, purpose, mode = 'auto', allowOSS = false) {
  validateCatalog(catalog)
  if (!['auto', 'atomgit', 'github'].includes(mode)) throw new Error('Invalid update source preference')
  const asset = catalog.artifacts.find(a => a.platform === platform && a.purpose === purpose)
  if (!asset) return undefined
  const order = allowOSS ? ['oss'] : mode === 'auto' ? ['atomgit', 'github'] : [mode]
  return { ...asset, candidates: order.filter(source => asset.sources[source]?.verified).map(source => ({ source, ...asset.sources[source] })) }
}
export function chooseCatalog(catalogs) {
  const valid = catalogs.flatMap(value => { try { return [validateCatalog(value)] } catch { return [] } })
  valid.sort((a, b) => compareVersion(b.version, a.version) || b.revision - a.revision)
  if (!valid.length) throw new Error('No valid release catalog is reachable')
  const chosen = valid[0]
  for (const other of valid.filter(c => c.version === chosen.version)) {
    for (const asset of chosen.artifacts) {
      const same = other.artifacts.find(a => a.platform === asset.platform && a.purpose === asset.purpose)
      if (same && (same.sha256 !== asset.sha256 || same.size !== asset.size || same.signature !== asset.signature)) throw new Error('Release sources disagree on artifact bytes')
    }
  }
  return chosen
}
export function assertCatalogUpdate(previous, next) {
  validateCatalog(previous); validateCatalog(next)
  if (compareVersion(previous.version, next.version) > 0) throw new Error('Cannot downgrade published catalog version')
  if (previous.version !== next.version) return
  chooseCatalog([previous,next])
  if (previous.revision > next.revision) throw new Error('Cannot downgrade catalog revision')
  if (previous.revision === next.revision && JSON.stringify(previous) !== JSON.stringify(next)) throw new Error('Changed catalog needs a higher revision')
}
