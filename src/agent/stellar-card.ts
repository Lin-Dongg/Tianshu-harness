/** Display metadata only. This does not grant a founder badge. */
export const STELLAR_CARDS = [
  { name: '共鸣星约', role: '星图一隅 · 你在这里亮着', from: 0, to: 0 },
  { name: '创世星约', role: '星轨的起点 · 你点燃了它', from: 1, to: 300 },
  { name: '守望星约', role: '恒星不熄 · 你让它亮着', from: 301, to: 600 },
  { name: '同行星约', role: '彗尾划过 · 你与我们同路', from: 601, to: 1000 },
] as const
export function stellarCard(tier?: number | null, rank?: number | null) {
  const card = STELLAR_CARDS[Number.isInteger(tier) && tier! >= 1 && tier! <= 3 ? tier! : 0]!
  const rankLabel = Number.isInteger(rank) && rank! >= card.from && rank! <= card.to && rank! > 0 ? String(rank).padStart(3, '0') : null
  return { ...card, rankLabel }
}
