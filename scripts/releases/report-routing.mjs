import { readFileSync } from 'node:fs'
const file = process.argv[2]
if (!file) { console.error('Usage: node scripts/releases/report-routing.mjs <update-downloads.jsonl>'); process.exit(1) }
const rows = readFileSync(file,'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const sources = Object.fromEntries(['atomgit','github','oss'].map(source => [source,{ selected:0, fallback:0, completed:0, failed:0, cancelled:0, receivedBytes:0 }]))
for (const row of rows) {
  const result = Object.hasOwn(sources,row.source) ? sources[row.source] : undefined; if (!result) continue
  if (row.event === 'selected') result.selected++
  else if (row.event === 'fallback') result.fallback++
  else if (['download_complete','network_failure','no_progress_30s','integrity_failed','cancelled'].includes(row.event)) {
    if (row.event === 'download_complete') result.completed++
    else if (row.event === 'cancelled') result.cancelled++
    else result.failed++
    if (Number.isSafeInteger(row.receivedBytes) && row.receivedBytes >= 0) result.receivedBytes += row.receivedBytes
  }
}
console.log(JSON.stringify({ sources, measurement:'Client received bytes; website clicks and OSS billed egress require their separate provider ledgers.' },null,2))
