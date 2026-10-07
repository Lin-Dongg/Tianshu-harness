"""Restore individual defects in isolated module copies; relevant tests must fail."""
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
TEST = ROOT / 'src/skills/__tests__/skill-management.test.ts'
CASES = [
 ('scope identity', 'src/skills/skill-management.ts', '../skill-management.js', '`${scope}:${def.bodyPath ?? `${def.source}:${def.name}`}`', 'def.name', 'complete package'),
 ('overwrite version', 'src/skills/skill-management.ts', '../skill-management.js', 'if (existing && (!options.expectedVersion || readPackage(existing).fingerprint !== options.expectedVersion))', 'if (false)', 'staged preview'),
 ('full resources', 'src/skills/skill-management.ts', '../skill-management.js', 'for (const file of pkg.files) {', "for (const file of pkg.files.filter(f => f.path === 'SKILL.md')) {", 'ZIP imports'),
 ('resume pin', 'src/skills/session-skill-snapshot.ts', '../session-skill-snapshot.js', 'if (path && existsSync(path)) {', 'if (false) {', 'two projects'),
 ('resource pin', 'src/skills/session-skill-snapshot.ts', '../session-skill-snapshot.js', '!existsSync(destination) || !readFileSync(destination).equals(bytes)', '!existsSync(destination)', 'restored resources'),
 ('engine snapshot inheritance', 'src/prompt/engine.ts', '../../prompt/engine.js', 'engine.sessionSkills = this.sessionSkills', 'engine.sessionSkills = undefined', 'management changes leave'),
 ('tool session registry', 'src/tools/skill.ts', '../../tools/skill.js', 'params.skillRegistry ?? skillRegistry', 'skillRegistry', 'runtime skill tool'),
 ('off enforcement', 'src/tools/skill.ts', '../../tools/skill.js', "=== 'off') return", "=== 'removed-off') return", 'runtime skill tool'),
 ('manual enforcement', 'src/tools/skill.ts', '../../tools/skill.js', "=== 'manual') return", "=== 'removed-manual') return", 'runtime skill tool'),
 ('ZIP original path', 'src/skills/skill-import.ts', '../skill-import.js', "(entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name", "entry.name", 'ZIP imports'),
]
def run(case):
 title, file, imported, before, after, pattern = case
 source = ROOT / file
 content = source.read_text()
 if content.count(before) != 1: raise RuntimeError(f'{title}: mutation anchor not unique')
 module = source.parent / ('.skill-mutation-' + source.name)
 driver = TEST.parent / '.skill-mutation.test.ts'
 try:
  module.write_text(content.replace(before, after, 1))
  driver.write_text(TEST.read_text().replace("'" + imported + "'", "'" + str(module) + "'"))
  result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-name-pattern', pattern, str(driver)], cwd=ROOT, capture_output=True, text=True)
  output = result.stdout + result.stderr
  if result.returncode == 0 or 'AssertionError' not in output: raise RuntimeError(f'{title}: expected assertion RED, got {result.returncode}\n{output}')
  print(f'RED confirmed: {title}', flush=True)
 finally:
  module.unlink(missing_ok=True); driver.unlink(missing_ok=True)
for case in CASES: run(case)
print(f'{len(CASES)} isolated defect restorations caught by assertions')
