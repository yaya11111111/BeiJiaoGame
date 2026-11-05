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

import { C, db, _, getDoc } from '../shared/db'
import { ApiError, ERROR } from '../shared/errors'
import type { ApiContext } from '../shared/types'

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
