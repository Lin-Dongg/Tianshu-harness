import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripVTControlCharacters as plain } from 'node:util'
import { wrapReadingText } from '../reading-layout.js'
import { formatMarkdown, parseBlocks } from '../markdown.js'
import { displayWidth } from '../../width.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
const markdown = (text: string, columns = 120) => formatMarkdown({ text, columns }, theme).map(plain)

test('120 列正文使用窗口宽度，路径不再提前在 80 列切开', () => {
  const text = '另有 ' + '甲'.repeat(30) + ' desktop/surfaces/ThreadView.tsx 等在对应主题内。'
  const rows = markdown(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0], text)
})

test('英文单词与文件名能放进一行时整体换行，路径优先在目录边界换行', () => {
  assert.deepEqual(wrapReadingText('abcde cache-routes.ts', 16), ['abcde', 'cache-routes.ts'])
  assert.deepEqual(wrapReadingText('desktop/surfaces/ThreadView.tsx', 20), ['desktop/surfaces/', 'ThreadView.tsx'])
})

test('长单词兜底折行不丢字，中文和组合 emoji 不被拆坏', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz中文👩‍💻e\u0301'
  const rows = wrapReadingText(text, 8)
  assert.equal(rows.join(''), text)
  assert.ok(rows.every(row => displayWidth(row) <= 8))
  assert.ok(rows.some(row => row.includes('👩‍💻')))
  assert.ok(rows.some(row => row.includes('e\u0301')))
})

test('换行后 ANSI 样式和 OSC 8 链接仍完整，链接内文件名整体换行', () => {
  const link = '\x1b]8;;https://example.com/file\x1b\\'
  const close = '\x1b]8;;\x1b\\'
  const rows = wrapReadingText(`abcde \x1b[36m${link}cache-routes.ts${close}\x1b[0m`, 16)
  assert.deepEqual(rows.map(plain), ['abcde', 'cache-routes.ts'])
  assert.ok(rows[1]!.includes(link))
  assert.ok(rows[1]!.includes(close))
  assert.ok(rows[1]!.includes('\x1b[36m'))
})

test('混合列表保留原编号、子列表缩进及续行对齐', () => {
  const rows = markdown('1. 主项\n   - 子项目 cache-routes.ts 和 insights-route.test.ts\n2. 下一项', 38)
  assert.ok(rows.includes('1. 主项'))
  assert.ok(rows.some(row => row.startsWith('   ◇ 子项目')))
  assert.ok(rows.includes('2. 下一项'))
  const wrapped = rows.find(row => row.includes('insights-route.test.ts'))!
  assert.ok(/^     insights-route.test.ts/.test(wrapped), JSON.stringify(rows))
})

test('列表开始编号与独立段落后的编号保持原文', () => {
  const source = '**说明**。\n3. 第三项\n4. 第四项\n\n后续。\n7. 第七项'
  assert.equal(parseBlocks(source).filter(block => block.type === 'list').length, 2)
  const rows = markdown(source)
  for (const item of ['3. 第三项', '4. 第四项', '7. 第七项']) assert.ok(rows.includes(item), rows.join('\n'))
})

test('80 列表格内文件名不在单词中间断开，每行边框对齐', () => {
  const rows = markdown('| 主题 | 文件 | 说明 |\n| --- | --- | --- |\n| Server 路由 | src/server/session-routes.ts cache-routes.ts insights-route.test.ts | 路由逻辑与缺陷复现脚本 |', 80)
  for (const name of ['session-routes.ts', 'cache-routes.ts', 'insights-route.test.ts']) {
    assert.ok(rows.some(row => row.includes(name)), `${name}: ${rows.join('\n')}`)
  }
  assert.equal(new Set(rows.map(row => displayWidth(row))).size, 1)
  assert.ok(rows.every(row => displayWidth(row) < 80))
})

test('行内代码保留原文间距，不在文件名两侧凭空加空格', () => {
  assert.deepEqual(markdown('文件：`cache-routes.ts`，执行 `npm test`。'), ['文件：cache-routes.ts，执行 npm test。'])
})

test('CJK 宽字符模式下表格仍对齐且不超出终端宽度', () => {
  const previous = process.env.RIVET_AMBIGUOUS_WIDTH
  try {
    for (const mode of ['wide', 'full']) {
      process.env.RIVET_AMBIGUOUS_WIDTH = mode
      const rows = markdown('| 文件 | 说明 |\n| --- | --- |\n| α · cache-routes.ts | 中文 · status |', 40)
      const widths = rows.map(row => displayWidth(row, { ambiguousAsWide: true }))
      assert.equal(new Set(widths).size, 1, `${mode}: ${widths}`)
      assert.ok(widths.every(width => width < 40), `${mode}: ${widths}`)
    }
  } finally {
    if (previous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = previous
  }
})

test('窄屏多列表格降级显示完整内容，不让双宽中文挤破边框', () => {
  const rows = markdown('| 一 | 二 | 三 | 四 | 五 | 六 | 七 | 八 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 甲 | 乙 | 丙 | 丁 | 戊 | 己 | 庚 | 辛 |', 40)
  assert.ok(rows.every(row => displayWidth(row) < 40), rows.join('\n'))
  for (const character of '甲乙丙丁戊己庚辛') assert.ok(rows.join('').includes(character))
})
