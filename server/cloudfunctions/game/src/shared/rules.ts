/**
 * 业务口径常量：计分、时限、搭档徽章。
 *
 * 单独抽出来是因为这三样东西**会被多处读**（level.submit 写、rank.level 读、
 * partner.list 读），散在各自文件里早晚会改一处漏一处。
 *
 * 一条原则：客户端只上报「发生了什么」（用时），**分数、名次、徽章都由服务端算**。
 * 客户端要是能自己决定分数和名次，这两个功能就没有意义了。
 */

/**
 * 计分公式版本。改公式时 +1，历史数据不动 ——
 * 这样以后能区分「这条成绩是按哪版规则算出来的」，不至于悄悄失真。
 *
 * v1（2026-11-19 定）：**只按通关用时排名**，越快越高。
 * 原草案里的 `hintsUsed` / `eggsFound` 两个指标 D 还没上报，
 * 等补齐后升到 v2 再把它们加进公式。
 */
export const SCORE_RULE_VERSION = 1

/** 分数基准。用时 0 秒 = 1000 分，每慢 1 秒扣 1 分，最低 0 分 */
const BASE_SCORE = 1000

/**
 * 用时 → 分数。**排名不按这个字段排**（按 timeMs 升序，两者等价），
 * 它只是给 E 的榜单页显示用的一个更好看的数字。
 *
 * `timeMs <= 0` 视为「没有可用用时」，返回 0 —— 调用方不应把这种记录写进榜单，
 * 否则 0 秒通关会直接霸榜。
 */
export function scoreFromTimeMs(timeMs: number): number {
  if (typeof timeMs !== 'number' || !(timeMs > 0)) return 0
  return Math.max(0, BASE_SCORE - Math.floor(timeMs / 1000))
}

/**
 * 每关的倒计时上限（秒），给 `level.submit` 做超时校验用。
 *
 * **为什么硬编码**：客户端 `LevelConfig.timeLimitSec` 只有 L01 配了 300 秒，
 * 而 `server/seeds/levels.seed.json` 里压根没有这个字段（build-seed 没搬）。
 * 重新生成种子 + 重新导入数据库才能让服务端读到它，代价太大。
 *
 * 所以这里两层：**关卡文档里有 `timeLimitSec` 就优先用文档的**（以后补上种子自动生效），
 * 没有就查这张表。表和客户端配置不一致时以客户端为准，改客户端记得同步这里。
 * 表里没列 = 不限时。
 */
const LEVEL_TIME_LIMIT_SEC: Record<string, number> = {
  L01: 300,
}

/** 取本关的倒计时上限（秒）。0 = 不限时，不做任何超时校验 */
export function resolveTimeLimitSec(levelId: string, docLimit?: unknown): number {
  if (typeof docLimit === 'number' && docLimit > 0) return Math.floor(docLimit)
  const fromTable = LEVEL_TIME_LIMIT_SEC[levelId]
  return typeof fromTable === 'number' && fromTable > 0 ? fromTable : 0
}

/** 关卡总数（不含 GUIDE）。`all_levels` 徽章按它算 */
export const PLAYABLE_LEVEL_COUNT = 10

export interface BadgeDef {
  id: string
  title: string
  description: string
  /** 共同通关多少关才拿到 */
  need: number
}

/**
 * 搭档徽章（草案 §4.4，2026-11-19 A/用户确认按这 4 条实现）。
 *
 * 达成即永久保留：判断依据是 `clearedCount` 这个累计值，只增不减，
 * 所以不会出现"后来没一起玩了徽章消失"的情况。
 */
export const BADGES: BadgeDef[] = [
  { id: 'first_team', title: '初次并肩', description: '第一次一起通关任意一关', need: 1 },
  { id: 'three_levels', title: '默契初成', description: '共同通关 3 关', need: 3 },
  { id: 'five_levels', title: '心有灵犀', description: '共同通关 5 关', need: 5 },
  { id: 'all_levels', title: '全勤搭档', description: `共同通关全部 ${PLAYABLE_LEVEL_COUNT} 关`, need: PLAYABLE_LEVEL_COUNT },
]

/** 按已共同通关数算出该有的徽章。返回给客户端的形状是 `{ id, title, description }` */
export function badgesForClearedCount(clearedCount: number): Array<{ id: string; title: string; description: string }> {
  const count = typeof clearedCount === 'number' && clearedCount > 0 ? clearedCount : 0
  return BADGES.filter((badge) => count >= badge.need).map((badge) => ({
    id: badge.id,
    title: badge.title,
    description: badge.description,
  }))
}
