/**
 * FR-17 双人搭档档案。
 *
 * 「搭档」= **一起通关过的人**，不是微信好友 —— 小游戏拿不到关系链（除非走开放数据域，
 * 本期不做）。所以这里只记录和谁合作过、合作了几关，不给客户端任何「直接发给某个人」
 * 的能力（E 的「再次邀请」是先 `room.create` 再自己分享房间码）。
 *
 * 写入时机只有一个：**双人局被结算的那一刻**（`level.submit` 拿到首结算权之后）。
 * `playCount` 因此只统计「通关的局」，没通关的局不计 —— 要统计全部局得在
 * `room.start` 埋一次写，那会让开局多一次数据库写，本期先不做（2026-11-19 与用户确认）。
 */

import { createHash } from 'node:crypto'
import { C, db, getDoc, now, savePairKey } from '../shared/db'
import { badgesForClearedCount } from '../shared/rules'
import { loadProfiles, NICKNAME_FALLBACK } from '../shared/users'
import type { ApiContext, PartnerDoc } from '../shared/types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function normalizeLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)))
}

/**
 * 对外暴露的短 id。**不能含 openid** —— 契约里明确「不返回 openid」，
 * 用 pairKey 的哈希前 10 位做前端 key 就够了，碰撞概率在搭档量级下可以忽略。
 */
function partnerIdFor(pairKey: string): string {
  return 'p_' + createHash('sha256').update(pairKey).digest('hex').slice(0, 10)
}

/** 把一条档案按「调用者视角」翻译成接口形状：对方是另一个人 */
function toEntry(doc: PartnerDoc, myOpenid: string) {
  const openids = Array.isArray(doc.openids) ? doc.openids : []
  const other = openids.filter((id) => id !== myOpenid)[0] || ''
  const profile = (doc.profiles && doc.profiles[other]) || { nickname: '', avatarUrl: '' }

  const bestRecords = Object.keys(doc.bestRecords || {}).map((levelId) => {
    const record = (doc.bestRecords || {})[levelId] || ({} as any)
    return {
      levelId,
      timeMs: typeof record.timeMs === 'number' ? record.timeMs : 0,
      score: typeof record.score === 'number' ? record.score : 0,
    }
  })
  // 客户端 `partnerBestTime` 会自己挑最快的一条，这里只保证顺序稳定
  bestRecords.sort((a, b) => a.timeMs - b.timeMs)

  const clearedCount = typeof doc.clearedCount === 'number' ? doc.clearedCount : 0

  return {
    partnerId: doc.partnerId || partnerIdFor(doc._id || ''),
    nickname: profile.nickname || NICKNAME_FALLBACK,
    avatarUrl: profile.avatarUrl || '',
    clearedCount,
    clearedLevels: Array.isArray(doc.clearedLevels) ? doc.clearedLevels : [],
    playCount: typeof doc.playCount === 'number' ? doc.playCount : 0,
    bestRecords,
    // 徽章按 clearedCount 现算（它只增不减），不直接信库里存的数组 ——
    // 这样规则改了不用回填历史数据，也顺手修掉"旧数据漏写徽章"的情况
    badges: badgesForClearedCount(clearedCount),
    lastPlayedAt: typeof doc.lastPlayedAt === 'number' ? doc.lastPlayedAt : 0,
  }
}

/**
 * partner.list —— 我的搭档档案，按最近一起玩的时间倒序。
 *
 * `where({ openids: ctx.openid })` 用的是 Mongo 的「数组包含」语义：
 * 等价于 `openids` 里含有我这个值。所以一条档案对 A、B 双方都能查到。
 */
export async function list(params: any, ctx: ApiContext) {
  const limit = normalizeLimit(params.limit)
  const where = { openids: ctx.openid }

  const [countRes, res] = await Promise.all([
    db.collection(C.partners).where(where).count(),
    db.collection(C.partners).where(where).orderBy('lastPlayedAt', 'desc').limit(limit).get(),
  ])

  const docs: PartnerDoc[] = (res && res.data) || []
  return {
    total: (countRes && countRes.total) || 0,
    list: docs.map((doc) => toEntry(doc, ctx.openid)),
  }
}

/**
 * 双人通关时更新搭档档案（不经过 action 路由，由 `level.submit` 直接调）。
 *
 * 调用方保证「一局只调一次」（T9 的首结算权），所以这里可以放心用
 * 「读一次 + 覆盖写」而不必包事务，`playCount` 也不会被双端各加一次。
 */
export async function recordDuoClear(input: {
  openids: string[]
  levelId: string
  timeMs: number
  score: number
  clearedAt?: number
}): Promise<void> {
  const openids = (input.openids || []).filter(Boolean)
  // 单人局没有搭档档案可言
  if (openids.length < 2) return

  const pairKey = savePairKey(openids)
  const ts = typeof input.clearedAt === 'number' && input.clearedAt > 0 ? input.clearedAt : now()

  const [profiles, existingDoc] = await Promise.all([
    loadProfiles(openids),
    getDoc(C.partners, pairKey),
  ])
  const existing = existingDoc as PartnerDoc | null

  const profileSnap: PartnerDoc['profiles'] = {}
  for (const openid of openids) {
    const profile = profiles[openid]
    profileSnap[openid] = {
      nickname: (profile && profile.nickname) || NICKNAME_FALLBACK,
      avatarUrl: (profile && profile.avatarUrl) || '',
    }
  }

  const clearedLevels = (existing && Array.isArray(existing.clearedLevels) ? existing.clearedLevels : []).slice()
  if (clearedLevels.indexOf(input.levelId) < 0) clearedLevels.push(input.levelId)

  const bestRecords: PartnerDoc['bestRecords'] = { ...((existing && existing.bestRecords) || {}) }
  const previous = bestRecords[input.levelId]
  // 只留更好的那一次；timeMs <= 0 表示这次没报用时，不许它覆盖已有记录
  if (input.timeMs > 0 && (!previous || previous.timeMs <= 0 || input.timeMs < previous.timeMs)) {
    bestRecords[input.levelId] = { timeMs: input.timeMs, score: input.score, clearedAt: ts }
  }

  const clearedCount = clearedLevels.length

  await db.collection(C.partners).doc(pairKey).set({
    data: {
      partnerId: (existing && existing.partnerId) || partnerIdFor(pairKey),
      openids: openids.slice().sort(),
      profiles: profileSnap,
      clearedLevels,
      clearedCount,
      playCount: ((existing && existing.playCount) || 0) + 1,
      bestRecords,
      badges: badgesForClearedCount(clearedCount).map((badge) => badge.id),
      firstPlayedAt: (existing && existing.firstPlayedAt) || ts,
      lastPlayedAt: ts,
      updatedAt: now(),
    },
  })
}
