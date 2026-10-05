import type { PwContext, PwPage } from './pw-surface.js'
import type { PageTracker } from './driver.js'
/** Popup, main-document navigation and page closure invalidate interaction context. */
export function observeBrowserTargets(context: PwContext, tracker: PageTracker, activePage: () => PwPage | null) {
  const listeners = new Set<() => void>(), watched = new WeakSet<PwPage>()
  const notify = () => { for (const listener of listeners) listener() }
  const watch = () => {
    for (const { page } of tracker.pages()) {
      if (watched.has(page)) continue
      watched.add(page)
      page.on('framenavigated', ((frame: { parentFrame?(): unknown }) => {
        if (!frame.parentFrame?.() && page === activePage()) notify()
      }) as never)
      page.on('close', notify as never)
    }
  }
  watch(); context.on('page', (() => { watch(); notify() }) as never)
  return { notify, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
