export function validateReleaseNotes(value, version) {
  if (!value || value.schemaVersion !== 1 || value.version !== version || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new Error('Invalid release notes');
  for (const language of ['zh', 'en']) {
    const n = value.locales?.[language];
    if (!n || typeof n.title !== 'string' || !n.title.trim() || n.title.length > 160 || !Array.isArray(n.highlights) || n.highlights.length > 3 || !n.highlights.every(x => typeof x === 'string' && x.trim() && x.length <= 300) || (n.notice !== undefined && (typeof n.notice !== 'string' || n.notice.length > 1000))) throw new Error('Invalid localized release notes');
  }
  if (value.fullNotesUrl !== undefined) {
    const u = new URL(value.fullNotesUrl);
    if (u.protocol !== 'https:' || u.username || u.password || !['github.com', 'tianshuharness.com'].includes(u.hostname)) throw new Error('Invalid release notes link');
  }
  return value;
}
