import { registerHooks } from 'node:module'
const variant = process.env.TIANSHU_DISPLAY_DEFECT
registerHooks({ load(url, context, nextLoad) {
 const result = nextLoad(url, context)
 if (!result.source) return result
 let code = result.source.toString(), changed = code
 if (variant === 'output' && url.includes('/session-manager.')) changed = code.replace(/this\.persistence\.saveToolOutput\(session\.record\.id,\s*id,\s*display\)/, 'this.persistence.saveToolOutput(session.record.id, id, display.slice(0, 2000))')
 if (variant === 'redaction' && url.includes('/session-manager.')) changed = code.replace(/(?:const|let) display\s*=\s*redactText\(evidence\?\.outputText\s*\?\?\s*uiContent\s*\?\?\s*result\)/, 'const display = uiContent ?? result')
 if (variant === 'evidence' && url.includes('/event-tap.')) changed = code.replace(/inner\.onToolResult\(id,\s*name,\s*result,\s*isError,\s*rawPath,\s*uiContent,\s*evidence\)/, 'inner.onToolResult(id, name, result, isError, rawPath, uiContent)')
 if (variant === 'pipeline' && url.includes('/tool-pipeline.')) changed = code.replace(/images:\s*rawToolResult\?\.images/, 'images: undefined')
 if (variant === 'bash-display' && url.includes('/tools/bash.')) changed = code.replace(/displayOutput:\s*persistedRaw/g, 'displayOutput: buildUiOutput(filtered, meta)')
 if (variant === 'runner-display' && url.includes('/tools/run-tests.')) changed = code.replace(/displayOutput:\s*displayOutput\.text\(\)/g, 'displayOutput: raw')
 if (variant === 'grouping' && url.includes('/surfaces/ThreadView.')) changed = code.replace(/return groupCommandEntries\(items\)/, 'return items')
 if (variant === 'raw-command' && url.includes('/state/event-reducer.')) changed = code.replace('commandText:', 'lostCommandText:')
 if (changed !== code) console.error(`applied display defect: ${variant}`)
 if (changed !== code) return { ...result, source: changed }
 return result
} })
