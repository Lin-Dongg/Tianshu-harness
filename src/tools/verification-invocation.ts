import { resolve, basename } from 'node:path'
import { shellWord, verificationArgv } from './verification-command.js'
import { splitVerificationRedirection } from './verification-redirection.js'

/** Only transparent shell wrappers and one literal directory change are accepted. */
export function unwrapVerification(command: string, cwd: string, allowOutputRedirection = true): { command: string; cwd: string; wrap: (inner: string) => string } | undefined {
  let current = command, directory = cwd
  const wrappers: Array<(inner: string) => string> = []
  for (let depth = 0; depth < 4; depth++) {
    const redirected = allowOutputRedirection ? splitVerificationRedirection(current) : undefined
    if (redirected) {
      wrappers.push(inner => inner + redirected.suffix)
      current = redirected.command
    }
    const argv = verificationArgv(current)
    const index = argv && basename(argv[0] ?? '') === 'rtk' ? (argv[1] === 'proxy' ? 2 : 1) : 0
    if (argv && ['bash', 'sh'].includes(argv[index] ?? '') && argv[index + 1] === '-c' && argv.length === index + 3) {
      const prefix = argv.slice(0, index + 2)
      wrappers.push(inner => [...prefix, inner].map(shellWord).join(' '))
      current = argv[index + 2]!
      continue
    }
    let quote = '', split = -1
    for (let i = 0; i < current.length; i++) {
      const c = current[i]!
      if (quote) { if (c === quote) quote = ''; continue }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '&' && current[i + 1] === '&') { if (split !== -1) return undefined; split = i; i++ }
      else if (/[;&|<>\n\r]/.test(c)) return undefined
    }
    if (split !== -1) {
      const cd = verificationArgv(current.slice(0, split))
      const path = cd?.[1] === '--' ? cd[2] : cd?.[1]
      if (!cd || cd[0] !== 'cd' || !path || /^[-~]|[*?\[\]\\]/.test(path) || cd.length !== (cd[1] === '--' ? 3 : 2)) return undefined
      directory = resolve(directory, path)
      const target = directory
      wrappers.push(inner => `cd -- ${shellWord(target)} && ${inner}`)
      current = current.slice(split + 2).trim()
      if (!verificationArgv(current)) return undefined
    }
    if (!verificationArgv(current)?.length) return undefined
    return { command: current, cwd: directory, wrap: inner => wrappers.reduceRight((value, wrap) => wrap(value), inner) }
  }
  return undefined
}
