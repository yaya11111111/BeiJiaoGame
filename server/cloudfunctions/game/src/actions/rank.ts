/**
 * FR-16 关卡排行榜。
 *
 * 口径（2026-11-19 定）：
 * - **只按通关用时升序排名**，越短越前；同用时按先达成的在前（tie-break 必须确定性，
 *   否则翻页会重复/漏项）。
 * - 单人 / 双人**分两个榜**（`mode` 必传）。混在一起双人局会互相刷榜。
 * - `GUIDE` 不进榜，查它直接返回空榜，**不报错**（客户端可能顺手查一下）。
 * - 分数由服务端算（见 `shared/rules.ts` 的 `scoreFromTimeMs`），客户端只上报用时。
 * - **不返回他人 openid**，只给 `nickname` / `avatarUrl` / `rank` / `score` / `timeMs`。
 * - `isMe` 由服务端标，客户端不要拿昵称比对（重名会标错）。
 *
 * 记录粒度（v3.9 定）：
 * - 单人榜：一条记录 = 一人 · 一关，`_id` 固定拼，重玩更好就覆盖；
 * - 双人榜：一条记录 = **一队 · 一关**，`_id` 由 pairKey 摘要生成。
 *   早期是「一人一条」，同一局会出「A 搭档 B」「B 搭档 A」两行，
 *   `rank` / `total` / `mine` 全是玩家口径而不是队伍口径，所以改成了按队聚合。
 *
 * 因此两个榜查询期都不用去重，`total` 就是「有多少人 / 有多少队」。
 */

import { C, db, getDoc, scoreId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import { SCORE_RULE_VERSION } from '../shared/rules'
import { loadProfiles, NICKNAME_FALLBACK } from '../shared/users'
import type { ApiContext, ScoreDoc } from '../shared/types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** 引导关没有可比性，不进榜 */
const EXCLUDED_LEVEL_IDS = ['GUIDE']

function normalizeMode(raw: unknown): 'solo' | 'duo' {
  if (raw === 'solo' || raw === 'duo') return raw
  throw new ApiError({ ...ERROR.PARAM_INVALID, message: "参数 mode 只能是 'solo' 或 'duo'" })
}

/** 不传就用默认；非法值不报错（榜单是只读页，没必要为个 limit 拦人），超界截断 */
function normalizeLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)))
}

/** 比我这条更好的记录有多少条 → 名次 = 该数 + 1 */
async function countBetter(  base: Record<string, any>,
  timeMs: number,
  clearedAt: number,
): Promise<number> {
  // 拆成两条 count 而不是 `_.or`：or 的组合语法在老版本 SDK 上行为不一致，
  // 而且「用时更短」和「同用时更早」两个条件各自都能吃到同一个复合索引。
  const [faster, sameTimeEarlier] = await Promise.all([
    db.collection(C.scores).where({ ...base, timeMs: db.command.lt(timeMs) }).count(),
    db.collection(C.scores).where({ ...base, timeMs, clearedAt: db.command.lt(clearedAt) }).count(),
  ])
  return ((faster && faster.total) || 0) + ((sameTimeEarlier && sameTimeEarlier.total) || 0)
}

/**
 * 榜的过滤条件。
 *
 * 双人榜多一个 `openids: _.exists(true)` —— 不是多余的保险：
 * v3.9 之前双人成绩是**一人一条**、没有 `openids` 字段，如果不过滤，
 * 同一局的老数据会以「A 搭档 B」「B 搭档 A」两行混进新榜，`total` 也会虚高。
 * 单人榜不用过滤（单人记录从来都是一人一条）。
 */
function boardFilter(base: { levelId: string; mode: 'solo' | 'duo' }): Record<string, any> {
  if (base.mode !== 'duo') return base
  return { ...base, openids: db.command.exists(true) }
}

/**
 * 一条成绩属于哪些人。
 *
 * 双人记录看 `openids`，单人记录看 `openid`。老数据两种都可能缺，
 * 所以要能容忍空值 —— 不能因为一条脏数据就让整张榜 5000。
 */
function membersOf(row: ScoreDoc): string[] {
  const ids =
    Array.isArray(row.openids) && row.openids.length > 0 ? row.openids : [row.openid]
  return ids.filter((id) => typeof id === 'string' && id !== '')
}

/**
 * rank.level —— 某关某模式的榜单
 *
 * 入参 `{ levelId, mode, limit }`，出参
 * `{ levelId, mode, total, list[], mine, scoreRuleVersion }`。
 * `mine` 即使不在前 N 也照给，客户端才能固定在底部显示「我的名次」。
 *
 * **v3.9 起双人榜是一队一条**：每行带 `players: [{ nickname, avatarUrl, isMe }]`，
 * 客户端直接渲染成「A / B」，`rank` / `total` / `mine` 全部是队伍口径。
 * 平级的 `nickname` / `avatarUrl` 仍然保留（取队首），只是为了不打断旧客户端 ——
 * 旧逻辑会丢弃空昵称条目，删字段风险太大。
 */
export async function level(params: any, ctx: ApiContext) {
  const levelId = requireString(params, 'levelId')
  const mode = normalizeMode(params.mode)
  const limit = normalizeLimit(params.limit)

  const emptyBoard = {
    levelId,
    mode,
    total: 0,
    list: [] as unknown[],
    mine: null,
    scoreRuleVersion: SCORE_RULE_VERSION,
  }
  if (EXCLUDED_LEVEL_IDS.indexOf(levelId) >= 0) return emptyBoard

  const base = boardFilter({ levelId, mode })

  const [countRes, topRes] = await Promise.all([
    db.collection(C.scores).where(base).count(),
    db
      .collection(C.scores)
      .where(base)
      // 主排序：用时升序（= 分数降序，两者等价）；tie-break：先达成的在前
      .orderBy('timeMs', 'asc')
      .orderBy('clearedAt', 'asc')
      .limit(limit)
      .get(),
  ])

  const total = (countRes && countRes.total) || 0
  const rows: ScoreDoc[] = (topRes && topRes.data) || []

  // 双人榜一行要两个人的昵称，所以按队伍成员批量取资料（仍是一次查询）
  const allOpenids: string[] = []
  for (const row of rows) {
    for (const id of membersOf(row)) allOpenids.push(id)
  }
  const profiles = await loadProfiles(allOpenids)

  const list = rows.map((row, index) => {
    const ids = membersOf(row)
    const players = ids.map((id) => ({
      nickname: (profiles[id] && profiles[id].nickname) || NICKNAME_FALLBACK,
      avatarUrl: (profiles[id] && profiles[id].avatarUrl) || '',
      isMe: id === ctx.openid,
    }))
    const head = players[0]
    return {
      rank: index + 1,
      // 兼容字段：取队首。双人榜请改用 players 渲染「A / B」
      nickname: head ? head.nickname : NICKNAME_FALLBACK,
      avatarUrl: head ? head.avatarUrl : '',
      players,
      score: typeof row.score === 'number' ? row.score : 0,
      timeMs: typeof row.timeMs === 'number' ? row.timeMs : 0,
      isMe: ids.indexOf(ctx.openid) >= 0,
    }
  })

  // 自己这一条：单独取，因为大概率不在前 N 里。
  // 双人榜「我的成绩」= 我参与过的队记录里最快的那条（我可能和不同人打过同一关）
  let mineDoc: ScoreDoc | null = null
  if (mode === 'duo') {
    const mineRes = await db
      .collection(C.scores)
      .where({
        levelId,
        mode: 'duo',
        openids: ctx.openid,
        timeMs: db.command.gt(0),
      })
      .orderBy('timeMs', 'asc')
      .orderBy('clearedAt', 'asc')
      .limit(1)
      .get()
    mineDoc = ((mineRes && mineRes.data) || [])[0] || null
  } else {
    mineDoc = (await getDoc(C.scores, scoreId(ctx.openid, levelId, mode))) as ScoreDoc | null
  }

  let mine: { rank: number; score: number; timeMs: number; inTop: boolean } | null = null
  if (mineDoc && typeof mineDoc.timeMs === 'number' && mineDoc.timeMs > 0) {
    const clearedAt = typeof mineDoc.clearedAt === 'number' ? mineDoc.clearedAt : 0
    const better = await countBetter(base, mineDoc.timeMs, clearedAt)
    const rank = better + 1
    mine = {
      rank,
      score: typeof mineDoc.score === 'number' ? mineDoc.score : 0,
      timeMs: mineDoc.timeMs,
      // 只表示「有没有落在这次返回的 list 里」，客户端据此决定要不要高亮
      inTop: rank <= limit && rank <= total,
    }
  }

  return {
    levelId,
    mode,
    total,
    list,
    mine,
    scoreRuleVersion: SCORE_RULE_VERSION,
  }
}

/**
 * 某一条成绩的名次（1 起）。给 `level.submit` 用 —— 结算页要显示「本关第 N 名」，
 * 顺手算一次比让客户端再打一次 `rank.level` 便宜。
 *
 * 注意：必须在成绩**落库之后**调用，否则 count 出来的名次会少算自己这一条。
 */
export async function rankOf(
  levelId: string,
  mode: 'solo' | 'duo',
  timeMs: number,
  clearedAt: number,
): Promise<number> {
  // 过滤条件和榜单查询必须一致（双人要多一道 openids 存在性），
  // 否则结算页显示的名次会和榜上看到的对不上
  const better = await countBetter(boardFilter({ levelId, mode }), timeMs, clearedAt)
  return better + 1
}
