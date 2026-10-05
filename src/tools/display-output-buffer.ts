/** Display-only capture; model previews and execution verdicts remain independent. */
export class DisplayOutputBuffer {
  private parts: string[] = []
  private bytes = 0
  truncated = false
  constructor(private readonly limit = 8 * 1024 * 1024) {}
  append(text: string): void {
    if (!text || this.truncated) return
    const buffer = Buffer.from(text)
    const remaining = this.limit - this.bytes
    if (buffer.length > remaining) {
      this.parts.push(buffer.subarray(0, remaining).toString('utf8'))
      this.bytes = this.limit
      this.truncated = true
    } else { this.parts.push(text); this.bytes += buffer.length }
  }
  text(): string { return this.parts.join('') }
}
