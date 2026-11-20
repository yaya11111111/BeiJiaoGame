/**
 * 管理端：谁能看玩家反馈。
 *
 * 权限模型：`admins` 集合，`_id` = openid。名单里没有 → 1002。
 * 为什么用集合而不是写死数组：
 *   加人、停用都不用重新部署云函数（`enabled: false` 即收回权限，保留记录）；
 *   项目就几个人，一次 `getDoc` 的开销可以忽略。
 *
 * 命名注意：**不要**把管理端列表叫 `feedback.list` ——
 * E 的《接口需求》§1.3 已经把 `feedback.list` 定义成「玩家看自己的反馈」。
 * 两个语义同名的接口一旦混淆，越权读全量会很难被发现，所以统一挂 `admin.` 前缀。
 *
 * 对应 E 的要求「反馈提交后由谁查看」：
 *   查看方式 A = 云开发控制台直接看 `feedbacks` 集合（不经过这里）；
 *   查看方式 B = `admin.feedback.list`，只对 admins 名单开放。
 */

import { C, db, _, getDoc, now, scoreId } from '../shared/db'
import { ApiError, ERROR } from '../shared/errors'
import { scoreFromTimeMs, SCORE_RULE_VERSION } from '../shared/rules'
import type { ApiContext, ScoreDoc } from '../shared/types'

const STATUSES = ['open', 'triaged', 'fixed', 'closed'] as const
const CATEGORIES = ['bug', 'stuck', 'suggestion', 'newmode'] as const

const LIST_DEFAULT = 20
const LIST_MAX = 100

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 判断某个 openid 是否管理员。
 * `enabled === false` 视为已收回 —— 用 `!== false` 而不是 `=== true`，
 * 是为了让「只写 _id 和 openid 的老文档」也算数，不用每条都补字段。
 */
export async function isAdmin(openid: string): Promise<boolean> {
  if (!openid) return false
  const doc = await getDoc(C.admins, openid)
  return !!doc && doc.enabled !== false
}

/**
 * admin.whoami —— 我是谁、我是不是管理员。
 *
 * 这个接口**不设权限**：它就是给「配名单的人」自查用的。
 * 把 3 个 openid 导进 admins 后，各自跑一次就能确认导对了没有，
 * 否则只能靠 `admin.feedback.list` 报 1002 反推，排查起来很绕。
 */
export async function whoami(_params: any, ctx: ApiContext) {
  return { openid: ctx.openid, isAdmin: await isAdmin(ctx.openid) }
}

/**
 * admin.feedback.list —— 分页读全量反馈（仅管理员）。
 *
 * 分页用 createdAt 游标（`before`），不用 skip：
 * 反馈是持续新增的，skip 分页在翻页途中会被新数据顶得重复/漏项。
 *
 * 注意 createdAt 是毫秒，同一毫秒内的两条记录在翻页边界上理论上会漏一条，
 * 实际量级（一天几十条）不会遇到；真遇到了再加 (_id) 二级游标。
 */
export async function list(params: any, ctx: ApiContext) {
  if (!(await isAdmin(ctx.openid))) {
    throw new ApiError(ERROR.FORBIDDEN)
  }

  const where: Record<string, any> = {}

  const status = str(params && params.status)
  if (status) {
    if (STATUSES.indexOf(status as typeof STATUSES[number]) < 0) {
      throw new ApiError({ ...ERROR.PARAM_INVALID, message: 'status 只能是 open/triaged/fixed/closed' })
    }
    where.status = status
  }

  const category = str(params && params.category)
  if (category) {
    if (CATEGORIES.indexOf(category as typeof CATEGORIES[number]) < 0) {
      throw new ApiError({ ...ERROR.PARAM_INVALID, message: 'category 取值不正确' })
    }
    where.category = category
  }

  const levelId = str(params && params.levelId)
  if (levelId) where.levelId = levelId

  const rawLimit = params && params.limit
  let limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.floor(rawLimit) : LIST_DEFAULT
  if (limit > LIST_MAX) limit = LIST_MAX

  const rawBefore = params && params.before
  const before = typeof rawBefore === 'number' && rawBefore > 0 ? Math.floor(rawBefore) : 0
  if (before) where.createdAt = _.lt(before)

  // 多取一条用来判断 hasMore，比再发一次 count 便宜
  let q: any = db.collection(C.feedbacks)
  if (Object.keys(where).length > 0) q = q.where(where)
  q = q.orderBy('createdAt', 'desc').limit(limit + 1)

  const res = await q.get()
  const rows: any[] = (res && res.data) || []
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return {
    list: page.map(toItem),
    hasMore,
    // 下一页传 before: nextBefore；空页把游标原样带回去，客户端不会卡死
    nextBefore: page.length > 0 ? page[page.length - 1].createdAt : before,
  }
}

/** 只挑管理端要看的字段，别把整条文档（含 _openid 之类）原样透出去 */
function toItem(doc: any) {
  return {
    feedbackId: doc._id || '',
    openid: doc.openid || doc._openid || '',
    category: doc.category || '',
    content: doc.content || '',
    screenshotFileId: doc.screenshotFileId || '',
    levelId: doc.levelId || '',
    levelTitle: doc.levelTitle || '',
    mode: doc.mode || '',
    viewId: doc.viewId || '',
    page: doc.page || '',
    roomCode: doc.roomCode || '',
    clientVersion: doc.clientVersion || '',
    submittedAt: doc.submittedAt || 0,
    createdAt: doc.createdAt || 0,
    status: doc.status || 'open',
  }
}

/** 回填时每页读多少条 progress。云函数端单次上限 1000，这里保守取 100 */
const BACKFILL_PAGE = 100
/** 最多回传多少条样例给调用方核对，避免返回体过大 */
const BACKFILL_SAMPLE = 50

/**
 * admin.backfillSoloScores —— **一次性**回填单人榜（FR-16）。
 *
 * 背景：个人记录（`progress`）比排行榜早开发，早期通关的记录从来没写过 `scores`；
 * 后来补了 `level.submit` 的写榜逻辑，但只对**新通关**生效，老数据补不回来 ——
 * 表现就是「个人记录里有成绩，排行榜一片空白」。
 *
 * 口径（必须和 `writeSoloScore` 完全一致，否则回填出来的榜和真实打出来的对不上）：
 * - 用时取 `progress.bestTimeMs`（**历史最好**，不是首通用时）。榜单本来就是
 *   「每人只留最好的一次」，所以这个取值是对的，不需要首通数据。
 * - tie-break 用 `progress.clearedAt`（只在首次写入时落，之后不变 = 首通时间）。
 * - 分数必须走 `scoreFromTimeMs`，不能自己算。
 * - **绝对不能写 `openids` 字段** —— 双人榜的过滤条件是 `openids: _.exists(true)`，
 *   带上它这条单人记录会跑到双人榜里去。
 * - `GUIDE` 不进榜；`bestTimeMs <= 0` 不入榜（0 秒会霸榜）。
 *
 * 安全设计：
 * - 仅 `admins` 名单可调用（1002）。
 * - **默认 dryRun**，必须显式传 `dryRun: false` 才真写 —— 防止手滑。
 * - 已存在且 `timeMs > 0` 的记录**一律跳过**，绝不覆盖线上真实成绩。
 * - 只读 `progress`、只写 `scores`，不动任何其他集合。
 * - 用固定 `_id` + `set()`，天然幂等，重复跑不会产生重复行。
 *
 * 已知局限（2026-11-20 与用户确认后接受）：
 * `progress` 不区分单双人（`_id` 只有 openid + levelId），所以**只在双人房里
 * 通关过的玩家也会被算进单人榜**。数据量小的时候人工核一眼即可。
 * 双人榜**不回填** —— 历史房间已关闭，凑不出可靠的 pairKey。
 */
export async function backfillSoloScores(params: any, ctx: ApiContext) {
  if (!(await isAdmin(ctx.openid))) {
    throw new ApiError(ERROR.FORBIDDEN)
  }

  const dryRun = !(params && params.dryRun === false)

  let scanned = 0
  let eligible = 0
  let skippedExisting = 0
  let skippedInvalid = 0
  let skippedGuide = 0
  let written = 0
  const sample: any[] = []
  const errors: string[] = []

  let skip = 0
  // 按 _id 排序保证分页稳定（skip 分页要求顺序确定，否则会重复/漏项）
  for (;;) {
    const res = await db
      .collection(C.progress)
      .where({ status: 'cleared' })
      .orderBy('_id', 'asc')
      .skip(skip)
      .limit(BACKFILL_PAGE)
      .get()
    const rows: any[] = (res && res.data) || []
    if (rows.length === 0) break
    scanned += rows.length

    for (const row of rows) {
      const openid = typeof row.openid === 'string' ? row.openid : ''
      const levelId = typeof row.levelId === 'string' ? row.levelId : ''
      const bestTimeMs = typeof row.bestTimeMs === 'number' ? row.bestTimeMs : 0
      const clearedAt = typeof row.clearedAt === 'number' ? row.clearedAt : 0

      if (!openid || !levelId) {
        skippedInvalid += 1
        continue
      }
      if (levelId === 'GUIDE') {
        skippedGuide += 1
        continue
      }
      // timeMs <= 0 不入榜：既没法排名，还会把 0 秒顶到榜首
      if (!(bestTimeMs > 0)) {
        skippedInvalid += 1
        continue
      }

      eligible += 1
      const id = scoreId(openid, levelId, 'solo')

      const existing = (await getDoc(C.scores, id)) as ScoreDoc | null
      if (existing && typeof existing.timeMs === 'number' && existing.timeMs > 0) {
        skippedExisting += 1
        continue
      }

      const score = scoreFromTimeMs(bestTimeMs)
      if (sample.length < BACKFILL_SAMPLE) {
        sample.push({ _id: id, levelId, timeMs: bestTimeMs, score, clearedAt })
      }
      if (dryRun) continue

      try {
        await db
          .collection(C.scores)
          .doc(id)
          .set({
            data: {
              openid,
              levelId,
              mode: 'solo',
              score,
              timeMs: bestTimeMs,
              // 历史房间信息已不可考，留空串；不影响排名
              roomCode: '',
              scoreRuleVersion: SCORE_RULE_VERSION,
              clearedAt: clearedAt > 0 ? clearedAt : now(),
              updatedAt: now(),
            },
          })
        written += 1
      } catch (error: any) {
        errors.push(`${id}: ${(error && (error.errMsg || error.message)) || 'unknown'}`)
      }
    }

    if (rows.length < BACKFILL_PAGE) break
    skip += rows.length
  }

  return {
    dryRun,
    scanned, // 扫到的 cleared 进度条数
    eligible, // 符合回填条件（有 openid / 非 GUIDE / 有用时）
    written, // 实际写入条数（dryRun 时恒为 0）
    skippedExisting, // 榜单里已有，跳过
    skippedInvalid, // 缺字段或用时 <= 0
    skippedGuide, // GUIDE 不进榜
    sample,
    errors: errors.slice(0, 20),
  }
}
