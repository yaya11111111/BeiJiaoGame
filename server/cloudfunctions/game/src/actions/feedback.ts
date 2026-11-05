/**
 * 玩家反馈（FR-14）。
 *
 * 载荷形状完全按 E 的 `Feedback.ts` 已经写好的版本 —— 字段名一个都不改，
 * 免得 E 再返工一次表单、测试和上下文映射。
 *
 * 这个集合**只写不读**：首版不提供 `feedback.list`，反馈是给 C 看的，
 * C 直接在云开发控制台查集合。玩家之间不该互相看到对方的反馈。
 */

import { C, db, now } from '../shared/db'
import { ApiError, ERROR } from '../shared/errors'
import type { ApiContext } from '../shared/types'

/** 和 E 的表单选项一一对应，改这里必须同步改 E 的分类文案 */
const CATEGORIES = ['bug', 'stuck', 'suggestion', 'newmode'] as const

const CONTENT_MIN = 5
const CONTENT_MAX = 300

/** 取字符串，空则退回默认串（反馈里大量字段是可选的） */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback
}

export async function submit(params: any, ctx: ApiContext) {
  const category = str(params.category)
  const content = str(params.content)

  if (CATEGORIES.indexOf(category as typeof CATEGORIES[number]) < 0) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '反馈类型不正确' })
  }
  if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
    throw new ApiError({
      ...ERROR.PARAM_INVALID,
      message: `反馈说明需要 ${CONTENT_MIN}-${CONTENT_MAX} 个字`,
    })
  }

  // context 是可选的整体；缺了就整个按空处理，不要一个个字段去报参数错
  const context = params && typeof params.context === 'object' && params.context !== null
    ? params.context
    : {}

  const data = {
    openid: ctx.openid,
    category,
    content,
    screenshotFileId: str(params.screenshotFileId),
    levelId: str(context.levelId),
    levelTitle: str(context.levelTitle),
    mode: str(context.mode),
    viewId: str(context.viewId),
    page: str(context.page),
    roomCode: str(context.roomCode),
    clientVersion: str(params.clientVersion),
    // 客户端时间只存不用：玩家手机时钟可能不准，统计一律以 createdAt 为准
    submittedAt: typeof context.submittedAt === 'number' ? context.submittedAt : 0,
    createdAt: now(),
    status: 'open',
  }

  const res = await db.collection(C.feedbacks).add({ data })
  const feedbackId = (res && res._id) || ''
  return { feedbackId, createdAt: data.createdAt }
}
