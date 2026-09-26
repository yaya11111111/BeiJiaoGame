/**
 * 双人房间：建房、入房、离开、查状态、心跳。
 *
 * 房间码就是文档 _id，所以「建房」和「查房」都不用建索引，一次 doc().get() 搞定。
 */

import { C, db, getDoc, now } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext, RoomDoc, RoomPlayer } from '../shared/types'

/** 房间码字符集。故意去掉了 0/O/1/I 这些容易看混的字符，玩家口头报码时不会出错 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// 关于 Math.random 的安全性：房间码本来就是用来分享给人的，不是秘密凭证；
// 生成后有撞码重试，32^6 约 10 亿的空间 + 房间随玩随关，被枚举蹭房的实际风险可以忽略。
// 如果将来房间码承载付费/隐私内容，再换成 crypto 级随机源。
function genCode(): string {
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return s
}

/** 把房间文档转成客户端能看的快照：去掉 openid，只留昵称/视角/在线状态 */
function toSnapshot(room: RoomDoc, myOpenid: string) {
  const me = room.players.find((p) => p.openid === myOpenid)
  return {
    code: room.code,
    levelId: room.levelId,
    status: room.status,
    myViewId: me ? me.viewId : null,
    players: room.players.map((p) => ({
      nickname: p.nickname,
      viewId: p.viewId,
      online: p.online,
    })),
  }
}

/**
 * 更新 players 数组里「我」这一项。
 * 云开发的 update 不能直接改数组里的某个元素，所以只能整体取出、改完再 set 回去。
 * 房间最多 2 人，这样整体覆盖不会有并发问题。
 */
async function updateMe(room: RoomDoc, openid: string, patch: Partial<RoomPlayer>) {
  const players = room.players.map((p) => (p.openid === openid ? { ...p, ...patch } : p))
  await db.collection(C.rooms).doc(room._id).update({
    data: { players, updatedAt: now() },
  })
}

/**
 * room.create —— 建房，建房者自动是视角 A
 */
export async function create(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')

  // 取昵称，给房间里的 players 数组用
  const user = await getDoc(C.users, openid)
  const nickname = user ? user.nickname : '玩家'

  // 生成房间码：最多试 5 次，撞码就重摇
  let code = ''
  for (let i = 0; i < 5; i++) {
    const candidate = genCode()
    const exists = await getDoc(C.rooms, candidate)
    if (!exists) {
      code = candidate
      break
    }
  }
  if (!code) {
    throw new ApiError({ ...ERROR.INTERNAL, message: '生成房间码失败，请重试' })
  }

  const ts = now()
  const room: RoomDoc = {
    _id: code,
    code,
    levelId,
    hostOpenid: openid,
    status: 'waiting', // 还差一个人，等人进来才变 playing
    players: [{ openid, nickname, viewId: 'A', online: true, lastSeenAt: ts }],
    lastSeq: 0,
    createdAt: ts,
    updatedAt: ts,
  }

  await db.collection(C.rooms).add({ data: room })
  return { code, levelId, myViewId: 'A' as const, status: 'waiting' }
}

/**
 * room.join —— 入房
 * 视角分配：第一个是 A，第二个是 B。同一人重复调用返回原来的视角（幂等），
 * 这样玩家断线重连时不会莫名其妙被换到另一边。
 *
 * 「读房间 → 校验 → 加人」放在事务里做：两个人同时点入房时，
 * 非事务的读-改-写会互相覆盖（后写把先写的人挤出房间）。
 * 云开发的事务是乐观锁，冲突时自动重试。
 */
export async function join(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()

  // 取昵称，给房间里的 players 数组用（在事务外取，减少事务里的操作数）
  const user = await getDoc(C.users, openid)
  const nickname = user ? user.nickname : '玩家'

  let snapshot: any = null
  try {
    await db.runTransaction(async (tx: any) => {
      const res = await tx.collection(C.rooms).doc(code).get()
      const room: RoomDoc | null = (res && res.data) || null
      if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
      if (room.status === 'closed') throw new ApiError(ERROR.ROOM_CLOSED)

      // 已经在房里 → 幂等返回，顺便把在线状态刷回来
      const already = room.players.find((p) => p.openid === openid)
      if (already) {
        const players = room.players.map((p) =>
          p.openid === openid ? { ...p, online: true, lastSeenAt: now() } : p
        )
        await tx.collection(C.rooms).doc(code).update({ data: { players, updatedAt: now() } })
        snapshot = toSnapshot({ ...room, players }, openid)
        return
      }

      if (room.players.length >= 2) throw new ApiError(ERROR.ROOM_FULL)

      // 房里没人（理论上不会，建房者一定在）→ A；已有一个 → B
      const viewId: 'A' | 'B' = room.players.length === 0 ? 'A' : 'B'
      const players: RoomPlayer[] = [
        ...room.players,
        { openid, nickname, viewId, online: true, lastSeenAt: now() },
      ]
      await tx.collection(C.rooms).doc(code).update({
        data: { players, status: 'playing', updatedAt: now() },
      })
      snapshot = toSnapshot({ ...room, players, status: 'playing' as const }, openid)
    })
  } catch (e: any) {
    // 事务里抛的 ApiError 会触发回滚并原样透出来，业务错误码不变
    if (e instanceof ApiError) throw e
    // 事务里 get 一个不存在的文档，有的版本直接抛错而不是返回空，翻译成 2001
    const msg = String((e && (e.errMsg || e.message)) || '')
    if (/not exist|not found/i.test(msg)) throw new ApiError(ERROR.ROOM_NOT_FOUND)
    throw e
  }

  return snapshot
}

/**
 * room.leave —— 退出房间
 * 人走光了就把房间标成 closed，避免房间码一直占着。
 */
export async function leave(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  const players = room.players.filter((p) => p.openid !== openid)
  await db.collection(C.rooms).doc(code).update({
    data: {
      players,
      status: players.length === 0 ? 'closed' : 'waiting',
      updatedAt: now(),
    },
  })

  return { left: true }
}

/**
 * room.state —— 查房间快照。E 的房间页准备状态就靠轮询这个。
 *
 * 这个接口被高频轮询，所以只在「有人的在线状态真的变了」时才写库，
 * 不每次轮询都无差别 update（浪费写配额，还容易和 heartbeat 互相覆盖）。
 * 调用方自己的 lastSeenAt 由 heartbeat 负责刷新，这里不动。
 */
export async function state(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  // 把超过 30 秒没心跳的人标成离线，让对面的 UI 能感知掉线
  const ts = now()
  let changed = false
  const players = room.players.map((p) => {
    if (p.openid === openid) {
      // 刚重连回来的玩家可能还挂着 offline 标记，顺手翻回来
      if (!p.online) {
        changed = true
        return { ...p, online: true }
      }
      return p
    }
    const online = ts - (p.lastSeenAt || 0) < 30 * 1000
    if (online !== p.online) changed = true
    return { ...p, online }
  })

  if (changed) {
    await db.collection(C.rooms).doc(code).update({ data: { players, updatedAt: ts } })
  }

  return toSnapshot({ ...room, players }, openid)
}

/**
 * room.heartbeat —— 心跳，客户端每 10 秒调一次
 * 超过 30 秒没心跳，对面的 room.state 就会把你显示成离线。
 */
export async function heartbeat(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  await updateMe(room, openid, { online: true, lastSeenAt: now() })
  return { online: true }
}
