/** CDP editing keys need native virtual-key codes, even when key/code are present. */
export function browserKeyParameters(event: { key?: string; code?: string; modifiers?: number }) {
  const codes: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Meta: 91 }
  const key = event.key ?? ''
  const virtualKey = codes[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0)
  const command = ((event.modifiers ?? 0) & 6) ? ({ a: 'selectAll', z: (event.modifiers ?? 0) & 8 ? 'redo' : 'undo', y: 'redo' } as Record<string, string>)[key.toLowerCase()] : undefined
  return { windowsVirtualKeyCode: virtualKey, ...(command ? { commands: [command] } : {}) }
}
