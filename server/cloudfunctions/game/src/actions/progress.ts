/**
 * 关卡进度读写。E 的地图页靠 progress.get 决定节点是锁定/解锁/通关。
 */

import { C, db, getDoc, now, progressId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext } from '../shared/types'

/** 关卡顺序。地图解锁逻辑用它判断"下一关"是谁 */
const LEVEL_ORDER = ['GUIDE', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10']

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
 * progress.save —— 保存进度
 *
 * 通关时传 elapsedMs（本局用时），只在成绩比历史最好更好时才覆盖 bestTimeMs。
 * D 在结算页调这个，E 不需要调。
 */
export async function save(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')
  const status = requireString(params, 'status')

  if (status !== 'unlocked' && status !== 'cleared') {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: "status 只能是 'unlocked' 或 'cleared'" })
  }

  const pid = progressId(openid, levelId)
  let doc: any = await getDoc(C.progress, pid)

  if (!doc) {
    doc = {
      _id: pid,
      openid,
      levelId,
      status,
      bestTimeMs: 0,
      attempts: 0,
      clearedAt: 0,
      updatedAt: now(),
    }
    await db.collection(C.progress).add({ data: doc })
  }

  const elapsedMs = typeof params.elapsedMs === 'number' ? params.elapsedMs : 0
  const bestTimeMs =
    status === 'cleared'
      ? doc.bestTimeMs > 0
        ? Math.min(doc.bestTimeMs, elapsedMs)
        : elapsedMs
      : doc.bestTimeMs

  const patch: any = { status, bestTimeMs, updatedAt: now() }
  if (status === 'cleared' && !doc.clearedAt) patch.clearedAt = now()

  await db.collection(C.progress).doc(pid).update({ data: patch })

  return { levelId, status, bestTimeMs, attempts: doc.attempts || 0 }
}

/**
 * progress.nextLevel —— 下一关是哪个（给 E 的地图解锁提示用，可选调用）
 */
export async function nextLevel(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')

  const idx = LEVEL_ORDER.indexOf(levelId)
  if (idx < 0 || idx === LEVEL_ORDER.length - 1) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '关卡不在顺序表里，或已经是最后一关' })
  }

  const nextId = LEVEL_ORDER[idx + 1]
  // 顺手把下一关标记为已解锁，这样地图页刷新就能看到新节点
  const pid = progressId(openid, nextId)
  const exists = await getDoc(C.progress, pid)
  if (!exists) {
    await db.collection(C.progress).add({
      data: {
        _id: pid,
        openid,
        levelId: nextId,
        status: 'unlocked',
        bestTimeMs: 0,
        attempts: 0,
        clearedAt: 0,
        updatedAt: now(),
      },
    })
  }

  return { levelId: nextId, unlocked: true }
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
