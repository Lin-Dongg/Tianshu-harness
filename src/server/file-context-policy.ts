/** Zero-dependency policy shared by the desktop picker and sidecar. */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024
export const FILE_CONTEXT_CACHE_MS = 30_000

export const CONTEXT_DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
}
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const TEXT = new Set(('txt md markdown mdx rst tex csv tsv json jsonc jsonl yaml yml toml xml svg html htm css scss sass less styl js jsx mjs cjs ts tsx mts cts vue svelte py pyi ipynb go rs java kt kts scala groovy c cc cpp cxx h hpp hh cs fs fsx vb swift m mm rb erb haml slim php phtml sh bash zsh fish ps1 bat cmd sql log ini cfg conf config lua r dart ex exs erl hrl clj cljs diff patch graphql gql').split(' '))
const NAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'license', 'readme', 'changelog', '.gitignore', '.editorconfig', '.npmrc'])
const BINARY = new Set(('exe dll so dylib bin mp3 mp4 mov avi mkv wav flac aac rar 7z gz bz2 xz dmg pkg iso jar war ear zipx woff woff2 ttf otf ico icns db sqlite sqlite3').split(' '))
/** 支持直传的压缩包（agent 侧 unzip/tar 必然可用）。zip/tar/tgz 按扩展名命中，
 *  tar.bz2/tar.xz 走 /\.tar\.(gz|bz2|xz)$/ 双扩展名判定（单文件 .gz/.bz2/.xz
 *  不在内——语义歧义，留在 BINARY 拒收）。rar/7z/dmg/pkg/iso 无通吃工具，拒收。 */
const ARCHIVE = new Set(['zip', 'tar', 'tgz'])
export type ContextFileKind = 'image' | 'text' | 'document' | 'archive' | 'candidate' | 'unsupported'

export function contextBasename(path: string): string { return path.split(/[/\\]/).pop() ?? path }
export function contextExtension(path: string): string {
  const name = contextBasename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}
export function isPrivateContextPath(path: string): boolean {
  const name = contextBasename(path).toLowerCase()
  return name === '.env' || name.startsWith('.env.') || /^(credentials|secrets?)(\.|$)/.test(name)
    || /private.*key|(?:^|[._-])(token|secret)(?:[._-]|$)/.test(name)
    || /\.(pem|key|p12|pfx)$/.test(name) || /^id_(rsa|ed25519|ecdsa)(\.|$)/.test(name)
}
export function isSupportedArchiveName(path: string): boolean {
  const name = contextBasename(path).toLowerCase()
  if (ARCHIVE.has(contextExtension(name))) return true
  return /\.tar\.(?:gz|bz2|xz)$/.test(name)
}
export function contextFileKind(path: string): ContextFileKind {
  if (isPrivateContextPath(path)) return 'unsupported'
  const ext = contextExtension(path)
  if (IMAGES.has(ext)) return 'image'
  if (CONTEXT_DOCUMENT_MIME[ext]) return 'document'
  if (isSupportedArchiveName(path)) return 'archive'
  if (BINARY.has(ext)) return 'unsupported'
  if (TEXT.has(ext) || NAMES.has(contextBasename(path).toLowerCase())) return 'text'
  return 'candidate'
}
/** Preferences affect ranking, never permission or decoding decisions. */
export function contextFilePriority(path: string): number {
  const name = contextBasename(path).toLowerCase()
  const ext = contextExtension(path)
  if (/\.(min\.[a-z]+|map)$/.test(name) || /(^|[.-])lock($|\.)/.test(name)) return 4
  if (CONTEXT_DOCUMENT_MIME[ext] || ['md', 'markdown', 'mdx', 'txt', 'rst', 'tex', 'csv', 'tsv'].includes(ext)) return 0
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'py', 'sql'].includes(ext)) return 1
  const kind = contextFileKind(path)
  // 压缩包可附加但不进 @ 上下文建议列表（内容是字节，不是可注入文本）。
  if (kind === 'archive') return 4
  return kind === 'text' ? 2 : 3
}
export function isSuggestedContextFile(path: string, query = ''): boolean {
  const kind = contextFileKind(path)
  if (kind === 'unsupported') return false
  const q = query.trim().replace(/\\/g, '/').toLowerCase()
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const exact = q !== '' && (normalized === q || contextBasename(normalized) === q)
  if (exact) return true
  return kind !== 'candidate' && contextFilePriority(path) < 4
}
export function decodeContextText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) throw new Error('text-too-large')
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  const hasBom = encoding !== 'utf-8' || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  // Only infer BOM-less UTF-16 from a strong alternating-null signature.
  // UTF-16 without this signature is not inferred; a BOM resolves ambiguity.
  if (!hasBom && bytes.length >= 8 && bytes.length % 2 === 0) {
    const units = bytes.length / 2
    const zeros = [0, 0]
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) zeros[i % 2]!++
    if (zeros[1]! / units >= 0.6 && zeros[0] === 0) encoding = 'utf-16le'
    else if (zeros[0]! / units >= 0.6 && zeros[1] === 0) encoding = 'utf-16be'
  }
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch {
    if (hasBom || encoding !== 'utf-8') throw new Error('text-encoding')
    // GB18030 includes GBK; fatal mode rejects malformed byte sequences.
    try { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes) }
    catch { throw new Error('text-encoding') }
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error('text-binary')
  return text
}
export function contextDataUrlBytes(dataUrl: string): Uint8Array {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
  if (!match || match[2]!.length % 4 !== 0) throw new Error('attachment-data')
  try { return Uint8Array.from(atob(match[2]!), c => c.charCodeAt(0)) }
  catch { throw new Error('attachment-data') }
}
