import { STAR_DOMAINS } from '../../src/agent/star-domain-data.js'
import { TAIYI_VOLATILE_CONDENSED } from '../../scripts/experiments/taiyi-variants.js'

const t = STAR_DOMAINS.taiyi
const A = t.volatileBlock
console.log('A volatileBlock chars     :', A.length)
console.log('C volatileBlock chars     :', TAIYI_VOLATILE_CONDENSED.length)
console.log('systemPromptSuffix (DEAD)  :', t.systemPromptSuffix.length)
console.log('A - C delta               :', A.length - TAIYI_VOLATILE_CONDENSED.length)
console.log('marker(天得一以清) in A    :', A.includes('天得一以清'))
console.log('marker(天得一以清) in C    :', TAIYI_VOLATILE_CONDENSED.includes('天得一以清'))
