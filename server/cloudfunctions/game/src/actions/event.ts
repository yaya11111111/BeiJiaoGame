/**
 * 房间内事件：发布、增量拉取、埋点上报。
 *
 * 同步方案的取舍（C 在这里拍的板）：
 *   不用数据库的 watch 实时推送，改用「客户端每 1 秒轮询 event.pull」。
 *   理由：
 *     1. watch 受集合权限、连接数、切后台断连影响，出问题很难排查；
 *     2. 轮询和断线重连可以共用同一套 sinceSeq 逻辑，代码只有一份；
 *     3. 点击解谜对延迟不敏感，1 秒以内完全够。
 *   以后若真觉得慢，可以把定时轮询换成推送，客户端拿到的还是同一份数据，不用改。
 *
 * events 表是「只追加」的：写完不改不删，所以天然不会有两个人互相覆盖的问题。
 */

import { C, db, getDoc, nextSeq, now } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext, RoomDoc } from '../shared/types'

/** 一次最多拉多少条。防止有人攒了一堆事件把单次返回撑爆 */
const PULL_LIMIT = 200

/**
 * event.publish —— 发布一条房间事件
 * type 建议用：clue / pickup / submit / chat / hint / result
 */
export async function publish(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()
  const type = requireString(params, 'type')
  const payload = params.payload || {}

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  // seq 由服务端统一分配，保证房间内事件有全序，客户端才能按序回放
  const seq = await nextSeq(code)
  const ts = now()

  await db.collection(C.events).add({
    data: { roomId: code, type, senderId: openid, seq, ts, payload },
  })

  return { seq, ts }
}

/**
 * event.pull —— 增量拉取事件
 *
 * 客户端用法：
 *   1. 记住上次拿到的最大 seq
 *   2. 下次调用带 sinceSeq = 那个 seq
 *   3. 服务端只返回比它大的
 * 断线重连后照样从旧 seq 拉，中间的事件一条都不会丢。
 */
export async function pull(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()
  const sinceSeq = typeof params.sinceSeq === 'number' ? params.sinceSeq : 0

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  // 复合条件：roomId 相等 且 seq 大于 sinceSeq，再按 seq 升序
  // 注意：这两个字段必须建复合索引（roomId 升序 + seq 升序），否则数据量大时会很慢
  const res = await db
    .collection(C.events)
    .where({ roomId: code, seq: db.command.gt(sinceSeq) })
    .orderBy('seq', 'asc')
    .limit(PULL_LIMIT)
    .get()

  const list: any[] = (res && res.data) || []

  // lastSeq 必须是「本页最后一条事件的 seq」，不能用房间全局的 lastSeq：
  // 如果事件超过一页（PULL_LIMIT），全局值会让客户端把没拉到的中间事件跳过去
  const lastSeq = list.length > 0 ? list[list.length - 1].seq : sinceSeq

  return {
    events: list.map((e) => ({
      seq: e.seq,
      type: e.type,
      senderId: e.senderId,
      ts: e.ts,
      payload: e.payload,
    })),
    lastSeq,
  }
}

/**
 * event.report —— 埋点上报，给后台统计用
 * 统计口径：独立玩家数（users）、关卡进入/完成/退出数（events 里 type 为 level:* 的记录）
 */
export async function report(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const type = requireString(params, 'type')
  const levelId = typeof params.levelId === 'string' ? params.levelId : ''

  await db.collection(C.events).add({
    data: {
      // 个人埋点不属于任何房间，roomId 留空字符串，查询时用 where({ roomId: '' }) 区分
      roomId: '',
      type,
      senderId: openid,
      seq: 0, // 个人埋点不参与房间内的排序
      ts: now(),
      payload: { levelId, extra: params.extra || {} },
    },
  })

  return { logged: true }
}
