import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { extname, posix } from 'node:path'
import JSZip from 'jszip'
import { SaxesParser } from 'saxes'

const MAX_XML_BYTES = 32 * 1024 * 1024
const ODF_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
const ODF_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'

/** Read only selected XML entries, bounding decompressed data before buffering it. */
async function readXml(zip: JSZip, path: string, budget: { remaining: number }): Promise<string> {
  const entry = zip.file(path)
  if (!entry) throw new Error(`Missing Office part: ${path}`)
  const stream = new Readable({ autoDestroy: true }).wrap(entry.nodeStream('nodebuffer'))
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk)
      budget.remaining -= bytes.length
      if (budget.remaining < 0) throw new Error('Office XML exceeds extraction limit')
      chunks.push(bytes)
    }
  } finally { stream.destroy() }
  const bytes = Buffer.concat(chunks)
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 60 && bytes[1] === 0
    ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 60
      ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

function officeText(xml: string): string {
  const parser = new SaxesParser({ xmlns: true })
  const text: string[] = []
  let capture = 0
  const isOoxml = (uri: string) => /\/(wordprocessingml|drawingml)\/(2006\/)?main$/.test(uri)
  parser.on('opentag', node => {
    if ((isOoxml(node.uri) && node.local === 't') || (node.uri === ODF_TEXT && ['p', 'h'].includes(node.local))) capture++
    if ((isOoxml(node.uri) && ['br', 'cr'].includes(node.local)) || (node.uri === ODF_TEXT && node.local === 'line-break')) text.push('\n')
    if (node.local === 'tab' && (isOoxml(node.uri) || node.uri === ODF_TEXT)) text.push('\t')
    if (node.uri === ODF_TEXT && node.local === 's') {
      const count = Object.values(node.attributes).find(a => a.local === 'c')?.value
      text.push(' '.repeat(Math.min(1000, Math.max(1, Number(count) || 1))))
    }
  })
  parser.on('text', value => { if (capture > 0) text.push(value) })
  parser.on('cdata', value => { if (capture > 0) text.push(value) })
  parser.on('closetag', node => {
    if ((isOoxml(node.uri) && node.local === 't') || (node.uri === ODF_TEXT && ['p', 'h'].includes(node.local))) capture--
    if ((isOoxml(node.uri) && node.local === 'p') || (node.uri === ODF_TEXT && ['p', 'h'].includes(node.local)) || (node.uri === ODF_TABLE && node.local === 'table-row')) text.push('\n')
    if ((isOoxml(node.uri) && node.local === 'tc') || (node.uri === ODF_TABLE && node.local === 'table-cell')) text.push('\t')
  })
  parser.write(xml).close()
  return text.join('').trim()
}

/** Respect the presentation's slide order rather than the slide filenames. */
async function slidePaths(zip: JSZip, budget: { remaining: number }): Promise<string[]> {
  if (!zip.file('ppt/presentation.xml') || !zip.file('ppt/_rels/presentation.xml.rels')) {
    return Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }
  const targets = new Map<string, string>()
  const rels = new SaxesParser({ xmlns: true })
  rels.on('opentag', node => {
    if (node.local !== 'Relationship') return
    const attrs = Object.fromEntries(Object.values(node.attributes).map(a => [a.local, a.value]))
    if (attrs.TargetMode === 'External' || !attrs.Type?.endsWith('/slide') || !attrs.Id || !attrs.Target) return
    const path = attrs.Target.startsWith('/') ? attrs.Target.slice(1) : posix.normalize(`ppt/${attrs.Target}`)
    if (/^ppt\/slides\/[^/]+\.xml$/.test(path)) targets.set(attrs.Id, path)
  })
  rels.write(await readXml(zip, 'ppt/_rels/presentation.xml.rels', budget)).close()
  const paths: string[] = []
  const presentation = new SaxesParser({ xmlns: true })
  presentation.on('opentag', node => {
    if (node.local !== 'sldId') return
    const id = Object.values(node.attributes).find(a => a.local === 'id' && a.uri.endsWith('/relationships'))?.value
    const target = id ? targets.get(id) : undefined
    if (target) paths.push(target)
  })
  presentation.write(await readXml(zip, 'ppt/presentation.xml', budget)).close()
  return paths
}

/** Pure JS fallback for OOXML/ODF text; images and layout remain in the original. */
export async function extractOfficeXml(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(filePath))
  const budget = { remaining: MAX_XML_BYTES }
  const ext = extname(filePath).toLowerCase()
  let paths: string[]
  if (ext === '.docx') {
    paths = ['word/document.xml', ...Object.keys(zip.files).filter(p => /^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p)).sort()]
  } else if (ext === '.pptx') paths = await slidePaths(zip, budget)
  else paths = ['content.xml']
  if (paths.length > 1000) throw new Error('Office document has too many parts')
  const parts: string[] = []
  for (const path of paths) {
    const text = officeText(await readXml(zip, path, budget))
    if (text) parts.push(ext === '.pptx' ? `[Slide ${parts.length + 1}]\n${text}` : text)
  }
  return parts.join('\n\n')
}
