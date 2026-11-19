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
 * 一条记录 = 一人 · 一关 · 一模式（`scores._id` 固定拼），重玩更好就覆盖，
 * 所以榜单天然每人一行，查询期不用去重。
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
async function countBetter(  base: { levelId: string; mode: string },
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
 * rank.level —— 某关某模式的榜单
 *
 * 入参 `{ levelId, mode, limit }`，出参
 * `{ levelId, mode, total, list[], mine, scoreRuleVersion }`。
 * `mine` 即使不在前 N 也照给，客户端才能固定在底部显示「我的名次」。
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

  const base = { levelId, mode }

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
  const profiles = await loadProfiles(rows.map((row) => row.openid))

  const list = rows.map((row, index) => ({
    rank: index + 1,
    nickname: (profiles[row.openid] && profiles[row.openid].nickname) || NICKNAME_FALLBACK,
    avatarUrl: (profiles[row.openid] && profiles[row.openid].avatarUrl) || '',
    score: typeof row.score === 'number' ? row.score : 0,
    timeMs: typeof row.timeMs === 'number' ? row.timeMs : 0,
    isMe: row.openid === ctx.openid,
  }))

  // 自己这一条：单独取，因为大概率不在前 N 里
  const mineDoc: ScoreDoc | null = await getDoc(C.scores, scoreId(ctx.openid, levelId, mode))
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
  const better = await countBetter({ levelId, mode }, timeMs, clearedAt)
  return better + 1
}
