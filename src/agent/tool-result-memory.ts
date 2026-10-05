import { INLINE_TOOL_RESULT_MAX_CHARS } from '../compact/constants.js'
// ─── Memory-safety helpers ───────────────────────────────────────

/** Artifact marker pattern: "[artifact:ID]" at end of content. */
const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_:.%~-]+)\]\s*$/

/**
 * Trim tool result content that exceeds {@link INLINE_TOOL_RESULT_MAX_CHARS}.
 * Preserves the artifact marker so the model can still recover full content
 * via read_section. Full content remains on disk — this only bounds JS heap usage.
 */
export function trimToolResultForMemory(content: string): string {
  if (content.length <= INLINE_TOOL_RESULT_MAX_CHARS) return content

  const artifactMatch = content.match(ARTIFACT_MARKER_REGEX)
  const marker = artifactMatch ? artifactMatch[0] : ''
  const markerLen = marker.length

  // Reserve space for the marker + the memory-trimmed tag
  const tagOverhead = `<memory-trimmed original_chars="${content.length}" />\n`.length
  const keepChars = Math.max(0, INLINE_TOOL_RESULT_MAX_CHARS - markerLen - tagOverhead)
  const truncated = content.slice(0, keepChars)

  const memoryTag = `<memory-trimmed original_chars="${content.length}" kept_chars="${keepChars}" />`

  if (artifactMatch) {
    return truncated + '\n' + memoryTag + '\n' + marker
  }
  return truncated + '\n' + memoryTag
}
