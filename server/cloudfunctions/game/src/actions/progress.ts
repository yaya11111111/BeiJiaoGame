/**
 * 关卡进度读写。E 的地图页靠 progress.get / level.list 决定节点是锁定/解锁/通关。
 *
 * 注意：这里没有 progress.nextLevel。
 * 「下一关是哪关」由客户端本地的 LEVEL_ORDER 算（common/LevelConfig.ts），
 * 服务端不再保存关卡顺序，也就不存在两边不一致的问题。
 * 地图节点解锁同理：初始节点 + 已通关关卡的 unlocks 并集，客户端自己推导。
 */

import { C, db, getDoc, now, progressId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext } from '../shared/types'

/**
 * progress.get —— 查进度
 * 传 levelId 就查一关，不传就返回这个玩家的全部进度（地图页一次拿全）
 */
export async function get(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = typeof params.levelId === 'string' ? params.levelId : ''

  let res: any
  if (levelId) {
    // 单关：直接用 _id 查，最快
    res = await db.collection(C.progress).doc(progressId(openid, levelId)).get().catch(() => null)
    const doc = res && res.data
    return { list: doc ? [toView(doc)] : [] }
  }

  // 全部：按 openid 过滤。10 关，取 100 条足够
  res = await db.collection(C.progress).where({ openid }).limit(100).get()
  const list: any[] = (res && res.data) || []
  return { list: list.map(toView) }
}

/**
 * progress.save —— 保存进度（只接受 'unlocked'）
 *
 * cleared 一律走 level.submit：
 * - 答题通关的关由服务端判题后才落 cleared
 * - 操作通关的关由客户端完成操作后调 submit 上报
 * 如果这里放行 cleared，客户端就能绕过判题直接自封通关，这道闸必须关死。
 */
export async function save(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')
  const status = requireString(params, 'status')

  if (status !== 'unlocked') {
    throw new ApiError({
      ...ERROR.PARAM_INVALID,
      message: "progress.save 只接受 status='unlocked'；通关请调 level.submit",
    })
  }

  const pid = progressId(openid, levelId)
  const doc: any = await getDoc(C.progress, pid)

  if (!doc) {
    await db.collection(C.progress).add({
      data: {
        _id: pid,
        openid,
        levelId,
        status: 'unlocked',
        bestTimeMs: 0,
        attempts: 0,
        clearedAt: 0,
        updatedAt: now(),
      },
    })
    return { levelId, status: 'unlocked', bestTimeMs: 0, attempts: 0 }
  }

  // 已通关的记录不允许被降级回 unlocked —— 通关事实只能累加，不能抹掉
  if (doc.status === 'cleared') {
    return toView(doc)
  }

  await db.collection(C.progress).doc(pid).update({
    data: { status: 'unlocked', updatedAt: now() },
  })
  return { levelId, status: 'unlocked', bestTimeMs: doc.bestTimeMs || 0, attempts: doc.attempts || 0 }
}

/** 转成客户端能看的结构，去掉 openid 和 _id */
function toView(doc: any) {
  return {
    levelId: doc.levelId,
    status: doc.status,
    bestTimeMs: doc.bestTimeMs || 0,
    attempts: doc.attempts || 0,
    clearedAt: doc.clearedAt || 0,
  }
}
