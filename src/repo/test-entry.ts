/** A test directory can contain support code; only runner entry names are tests. */
export function isTestEntry(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? ''
  return /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|sh)$/.test(name)
    || /^(?:test_.+|.+_test)\.py$/.test(name)
    || /^.+_test\.go$/.test(name)
}
