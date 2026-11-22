/**
 * 跨关收藏与图鉴彩蛋（FR-11 / FR-12 / FR-13）。
 *
 * 一人一条文档（`_id` = openid），里面直接塞 clues / eggs / eggTotals 三个数组。
 * 10 关的量级，单文档完全放得下，`library.get` 一次读完，不用按关查。
 *
 * **写入一律幂等**：同一件物品、同一个彩蛋重复上报只记一次。
 * 一关重玩多次不该把图鉴刷出重复项，所以按 (levelId, itemId) / (levelId, eggId) 去重。
 */

import { C, db, getDoc, now } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext } from '../shared/types'

/** 防异常数据：10 关的收藏与彩蛋数量远低于这个量 */
const MAX_CLUES = 200
const MAX_EGGS = 100

interface ClueEntry {
  itemId: string
  name: string
  levelId: string
  collectedAt: number
}

interface EggEntry {
  eggId: string
  title: string
  levelId: string
  foundAt: number
}

interface LibraryDoc {
  _id: string
  openid: string
  clues: ClueEntry[]
  eggs: EggEntry[]
  eggTotals: Record<string, number>
  updatedAt: number
}

/** 取数组，不是数组就当空数组（这两个字段都是可选的） */
function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}

/** 只保留形状对的条目，顺手把字符串收干净 */
function cleanEntries(list: any[], key: 'itemId' | 'eggId', max: number): any[] {
  if (list.length > max) {
    throw new ApiError({
      ...ERROR.PARAM_INVALID,
      message: `一次上报的${key === 'itemId' ? '收藏' : '彩蛋'}数量过多`,
    })
  }
  return list
    .filter((e) => e && typeof e === 'object' && typeof e[key] === 'string' && e[key].trim() !== '')
    .map((e) => ({
      [key]: String(e[key]).trim(),
      name: typeof e.name === 'string' ? e.name.trim() : '',
      title: typeof e.title === 'string' ? e.title.trim() : '',
    }))
}

export async function get(_params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const doc = await getDoc(C.libraries, openid)
  if (!doc) return { clues: [], eggs: [], eggTotals: {} }
  return {
    clues: (doc.clues || []) as ClueEntry[],
    eggs: (doc.eggs || []) as EggEntry[],
    eggTotals: (doc.eggTotals || {}) as Record<string, number>,
  }
}

export async function add(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')

  const incomingClues = cleanEntries(arr(params.clues), 'itemId', MAX_CLUES)
  const incomingEggs = cleanEntries(arr(params.eggs), 'eggId', MAX_EGGS)

  // eggTotal 是本关配置的彩蛋总数，每次覆盖写（配置可能改）
  const eggTotal = typeof params.eggTotal === 'number' && params.eggTotal >= 0
    ? Math.floor(params.eggTotal)
    : null

  const existing = (await getDoc(C.libraries, openid)) as LibraryDoc | null

  if (!existing) {
    const ts = now()
    const clues: ClueEntry[] = incomingClues.map((e) => ({
      itemId: e.itemId, name: e.name, levelId, collectedAt: ts,
    }))
    const eggs: EggEntry[] = incomingEggs.map((e) => ({
      eggId: e.eggId, title: e.title, levelId, foundAt: ts,
    }))
    const eggTotals: Record<string, number> = {}
    if (eggTotal !== null) eggTotals[levelId] = eggTotal

    await db.collection(C.libraries).add({
      data: { _id: openid, openid, clues, eggs, eggTotals, updatedAt: ts },
    })
    return { clues, eggs, eggTotals }
  }

  // 合并：已存在的 (levelId, itemId) / (levelId, eggId) 直接跳过，实现幂等
  const clues = existing.clues || []
  const knownClues = new Set(clues.map((c) => `${c.levelId}_${c.itemId}`))
  for (const e of incomingClues) {
    const key = `${levelId}_${e.itemId}`
    if (knownClues.has(key)) continue
    knownClues.add(key)
    clues.push({ itemId: e.itemId, name: e.name, levelId, collectedAt: now() })
  }

  const eggs = existing.eggs || []
  const knownEggs = new Set(eggs.map((g) => `${g.levelId}_${g.eggId}`))
  for (const e of incomingEggs) {
    const key = `${levelId}_${e.eggId}`
    if (knownEggs.has(key)) continue
    knownEggs.add(key)
    eggs.push({ eggId: e.eggId, title: e.title, levelId, foundAt: now() })
  }

  const eggTotals = existing.eggTotals || {}
  if (eggTotal !== null) eggTotals[levelId] = eggTotal

  await db.collection(C.libraries).doc(openid).update({
    data: { clues, eggs, eggTotals, updatedAt: now() },
  })
  return { clues, eggs, eggTotals }
}
