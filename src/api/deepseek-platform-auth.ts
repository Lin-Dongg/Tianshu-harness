import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { writeFileAtomicSync } from '../fs-atomic.js'

export function loadPlatformAuth(): { token: string; cookies: string } | null {
  const filePath = join(rivetHome(), 'deepseek-platform-auth.json')
  if (!existsSync(filePath)) return null
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (typeof data?.token !== 'string' || !data.token.trim()) return null
    return { token: data.token, cookies: typeof data.cookies === 'string' ? data.cookies : '' }
  } catch {
    return null
  }
}

export function savePlatformAuth(token: string, cookies: string): void {
  const home = rivetHome()
  mkdirSync(home, { recursive: true })
  writeFileAtomicSync(join(home, 'deepseek-platform-auth.json'), JSON.stringify({ token, cookies, savedAt: Date.now() }) + '\n')
}

export function clearPlatformAuth(): void {
  const filePath = join(rivetHome(), 'deepseek-platform-auth.json')
  if (existsSync(filePath)) writeFileAtomicSync(filePath, '{}\n')
}
