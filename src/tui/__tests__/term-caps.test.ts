import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFrontendRenderer } from '../engine/renderer-policy.js'
import { frontendOpenCommand } from '../engine/frontend-mouse.js'
import {
  isLegacyWindowsConsole,
  isCjkLocale,
  useAsciiGlyphs,
  resetTermCapsCache,
} from '../term-caps.js'

afterEach(() => {
  resetTermCapsCache()
})

describe('isLegacyWindowsConsole', () => {
  it('win32 且无现代终端标记 → true（PowerShell/cmd 直启 conhost）', () => {
    assert.equal(isLegacyWindowsConsole({}, 'win32'), true)
  })

  it('Windows Terminal（WT_SESSION）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ WT_SESSION: 'abc' }, 'win32'), false)
  })

  it('VS Code 集成终端（TERM_PROGRAM）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ TERM_PROGRAM: 'vscode' }, 'win32'), false)
  })

  it('ConEmu（ConEmuANSI）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ ConEmuANSI: 'ON' }, 'win32'), false)
  })

  it('mintty/Git Bash（TERM 已设）→ false', () => {
    assert.equal(isLegacyWindowsConsole({ TERM: 'xterm-256color' }, 'win32'), false)
  })

  it('非 win32 平台 → 恒 false', () => {
    assert.equal(isLegacyWindowsConsole({}, 'darwin'), false)
    assert.equal(isLegacyWindowsConsole({}, 'linux'), false)
  })
})

describe('isCjkLocale', () => {
  it('LANG=zh_CN.UTF-8 → true', () => {
    assert.equal(isCjkLocale({ LANG: 'zh_CN.UTF-8' }), true)
  })

  it('LC_ALL=ja_JP 优先命中 → true', () => {
    assert.equal(isCjkLocale({ LC_ALL: 'ja_JP', LANG: 'en_US.UTF-8' }), true)
  })

  it('LC_CTYPE=ko_KR → true', () => {
    assert.equal(isCjkLocale({ LC_CTYPE: 'ko_KR.UTF-8' }), true)
  })
})

describe('useAsciiGlyphs', () => {
  it('RIVET_ASCII_UI=1 显式开启 → true（不受缓存影响）', () => {
    assert.equal(useAsciiGlyphs({ RIVET_ASCII_UI: '1' }), true)
  })

  it('RIVET_ASCII_UI=0 显式关闭 → false（覆盖自动探测）', () => {
    assert.equal(useAsciiGlyphs({ RIVET_ASCII_UI: '0' }), false)
  })
})

describe('cross-platform renderer policy', () => {
  for (const [platform, env] of [
    ['darwin', { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }],
    ['darwin', { TERM_PROGRAM: 'iTerm.app' }],
    ['linux', { TERM: 'xterm-256color' }],
    ['linux', { TERM: 'foot' }],
    ['linux', { TERM: 'xterm-kitty' }],
    ['win32', { TERM_PROGRAM: 'vscode' }],
    ['win32', { WT_SESSION: 'test' }],
  ] as const) it(`auto preserves native scrollback on ${platform} host ${JSON.stringify(env)}`, () => {
    assert.equal(resolveFrontendRenderer('auto', true, false, env, platform), 'classic')
    assert.equal(resolveFrontendRenderer('fullscreen', true, false, env, platform), 'fullscreen')
  })
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    it(`${platform} keeps non-TTY, readers, unknown and remote hosts classic`, () => {
      assert.equal(resolveFrontendRenderer('fullscreen', false, false, {}, platform), 'classic')
      assert.equal(resolveFrontendRenderer('fullscreen', true, true, {}, platform), 'classic')
      assert.equal(resolveFrontendRenderer('fullscreen', true, false, { TERM: 'dumb' }, platform), 'classic')
      assert.equal(resolveFrontendRenderer('auto', true, false, {}, platform), 'classic')
      for (const env of [{ SSH_TTY: '/dev/pts/1' }, { TMUX: '/tmp/tmux' }, { STY: 'screen' }, { TERM: 'screen-256color' }]) {
        assert.equal(resolveFrontendRenderer('auto', true, false, { WT_SESSION: 'test', ...env }, platform), 'classic')
        assert.equal(resolveFrontendRenderer('fullscreen', true, false, env, platform), 'fullscreen')
      }
    })
  }
})

describe('platform text-file opening', () => {
  it('uses macOS text editor and Windows Notepad without shell interpolation', () => {
    assert.deepEqual(frontendOpenCommand('/work/a b.ts', 'darwin', {}), ['open', ['-t', '/work/a b.ts']])
    assert.deepEqual(frontendOpenCommand('C:\\work\\a b.ts', 'win32', {}), ['notepad.exe', ['C:\\work\\a b.ts']])
  })
  for (const [env, command] of [[{ TERM_PROGRAM: 'WezTerm' }, 'wezterm'], [{ TERM: 'xterm-kitty' }, 'kitty'], [{ TERM: 'foot' }, 'foot'], [{ TERM: 'alacritty' }, 'alacritty']] as const) {
    it(`uses Linux ${command} to run a text editor`, () => {
      const [binary, args] = frontendOpenCommand('/work/a b.ts', 'linux', env)
      assert.equal(binary, command); assert.equal(args.at(-1), '/work/a b.ts')
    })
  }
})
