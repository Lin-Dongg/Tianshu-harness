/**
 * Red/green line decorations for client-applied edits (Wave B).
 * Cleared on accept / session switch / new prompt.
 */
import * as vscode from 'vscode'

export interface PendingEdit {
  requestId: string
  sessionId: string
  relPath: string
  uri: vscode.Uri
  oldContent: string
  newContent: string
  added: vscode.Range[]
  removed: vscode.Range[]
}

const addedType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
})

const removedType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
  overviewRulerColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  opacity: '0.55',
})

/**
 * Compute simple line-level added/removed ranges (LCS-free; good enough for review).
 *
 * For pure reorders or changes where every old line also appears in the new
 * content (and vice versa), the Set-based diff produces zero ranges even
 * though content differs. Emit a full-file "changed" range as fallback so
 * the user sees which file was touched.
 */
export function computeLineRanges(oldContent: string, newContent: string): { added: vscode.Range[]; removed: vscode.Range[] } {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  const added: vscode.Range[] = []
  const removed: vscode.Range[] = []
  for (let i = 0; i < newLines.length; i++) {
    if (!oldSet.has(newLines[i]!)) {
      added.push(new vscode.Range(i, 0, i, 0))
    }
  }
  for (let i = 0; i < oldLines.length; i++) {
    if (!newSet.has(oldLines[i]!)) {
      removed.push(new vscode.Range(i, 0, i, 0))
    }
  }

  // Fallback: Set-based diff detected no changes but content does differ
  // (e.g. pure reorder). Mark the whole file so the user sees it was touched.
  if (added.length === 0 && removed.length === 0 && oldContent !== newContent) {
    const last = Math.max(newLines.length - 1, 0)
    added.push(new vscode.Range(0, 0, last, 0))
  }

  return { added, removed }
}

export class DiffDecorationController {
  private pending = new Map<string, PendingEdit>() // key = uri.fsPath

  list(): PendingEdit[] {
    return [...this.pending.values()]
  }

  get(uri: vscode.Uri): PendingEdit | undefined {
    return this.pending.get(uri.fsPath)
  }

  async show(edit: PendingEdit): Promise<void> {
    this.pending.set(edit.uri.fsPath, edit)
    const doc = await vscode.workspace.openTextDocument(edit.uri)
    if (this.pending.get(edit.uri.fsPath) !== edit) return
    const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false })
    if (this.pending.get(edit.uri.fsPath) !== edit) return
    editor.setDecorations(addedType, edit.added)
    // Removed lines no longer exist in the new doc — show as overview only via added contrast.
    editor.setDecorations(removedType, [])
  }

  clear(uri?: vscode.Uri): void {
    if (uri) {
      this.pending.delete(uri.fsPath)
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.fsPath === uri.fsPath) {
          ed.setDecorations(addedType, [])
          ed.setDecorations(removedType, [])
        }
      }
      return
    }
    for (const p of this.pending.keys()) {
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.fsPath === p) {
          ed.setDecorations(addedType, [])
          ed.setDecorations(removedType, [])
        }
      }
    }
    this.pending.clear()
  }

  dispose(): void {
    this.clear()
    addedType.dispose()
    removedType.dispose()
  }
}
