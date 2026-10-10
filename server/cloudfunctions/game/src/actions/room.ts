/**
 * 双人房间：建房、入房、离开、查状态、心跳。
 *
 * 房间码就是文档 _id，所以「建房」和「查房」都不用建索引，一次 doc().get() 搞定。
 */

import { C, db, getDoc, now } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext, PlayerProgressEntry, RoomDoc, RoomPlayer } from '../shared/types'

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

/**
 * 批量取若干玩家的进度摘要。
 *
 * 为什么是「一人一查」而不是 `where({ openid: _.in([...]) })`：
 * 房间里最多 2 个人，两发并行查询的成本可以接受，而 `where({ openid })`
 * 是本文件/进度模块已经在用的、跑通过的模式。选关功能刚上线，
 * 优先保证「不会出错」，不为了省一次读去引入没验证过的操作符。
 */
async function loadProgress(
  openids: string[]
): Promise<Record<string, PlayerProgressEntry[]>> {
  const out: Record<string, PlayerProgressEntry[]> = {}
  await Promise.all(
    openids.map(async (openid) => {
      const res = await db
        .collection(C.progress)
        .where({ openid })
        .limit(100)
        .get()
        .catch(() => null)
      const list: any[] = (res && res.data) || []
      out[openid] = list.map((p) => ({
        levelId: p.levelId,
        status: p.status === 'cleared' ? ('cleared' as const) : ('unlocked' as const),
      }))
    })
  )
  return out
}

/**
 * 把房间文档转成客户端能看的快照：去掉 openid，只留昵称/视角/在线状态/进度。
 *
 * players[].progress 是给「双人可玩交集」用的原始数据：服务端不判断谁能玩哪一关
 * （关卡顺序 LEVEL_ORDER、地图节点→关卡的映射、solo/duo 标记都在客户端），
 * 只如实给出每人每关的 unlocked / cleared，交集由客户端算。
 */
function toSnapshot(
  room: RoomDoc,
  myOpenid: string,
  progressMap: Record<string, PlayerProgressEntry[]> = {}
) {
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
      progress: progressMap[p.openid] || [],
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

  // 返回完整快照（而不是只回 code/myViewId）：房主建房后直接进房间页，
  // 房间页要算可玩交集，顺手把双方进度一起给出去，省一次轮询。
  const progressMap = await loadProgress(room.players.map((p) => p.openid))
  return toSnapshot(room, openid, progressMap)
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

  let finalRoom: RoomDoc | null = null
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
        finalRoom = { ...room, players }
        return
      }

      if (room.players.length >= 2) throw new ApiError(ERROR.ROOM_FULL)

      // 视角分配看「A 有没有人占」，而不是看人数：
      // 以前写的是 length===0 ? 'A' : 'B'，一旦房主（A）先离开、房里只剩 B，
      // 新房客会因为 length===1 被分到 'B'，房间里出现两个 B，信息差直接失效。
      // 现在房主离开会关闭房间（见 leave），这条路径本已走不到，但保留防御性写法，
      // 免得以后放开「房主让位」时又踩回来。
      const viewId: 'A' | 'B' = room.players.some((p) => p.viewId === 'A') ? 'B' : 'A'
      const players: RoomPlayer[] = [
        ...room.players,
        { openid, nickname, viewId, online: true, lastSeenAt: now() },
      ]
      await tx.collection(C.rooms).doc(code).update({
        data: { players, status: 'playing', updatedAt: now() },
      })
      finalRoom = { ...room, players, status: 'playing' as const }
    })
  } catch (e: any) {
    // 事务里抛的 ApiError 会触发回滚并原样透出来，业务错误码不变
    if (e instanceof ApiError) throw e
    // 事务里 get 一个不存在的文档，有的版本直接抛错而不是返回空，翻译成 2001
    const msg = String((e && (e.errMsg || e.message)) || '')
    if (/not exist|not found/i.test(msg)) throw new ApiError(ERROR.ROOM_NOT_FOUND)
    throw e
  }

  // 进度查询放在事务外：事务里每多一次读操作，就多一次乐观锁冲突回滚的概率，
  // 而进度只是快照的附属信息，不参与「谁进了房间」这个必须原子的判定。
  // 显式转回声明类型：事务回调里的赋值 TS 的控制流分析追踪不到，
  // 不转会把它推断成 never，下面取 .players 编译不过。
  const joined = finalRoom as RoomDoc | null
  if (!joined) throw new ApiError(ERROR.INTERNAL)
  const progressMap = await loadProgress(joined.players.map((p) => p.openid))
  return toSnapshot(joined, openid, progressMap)
}

/**
 * room.leave —— 退出房间
 *
 * 2026-10-10 定：**房主离开 = 房间关闭**。
 * 这么做的前提是「建房的人永远是视角 A」这个约定继续有效：
 * 如果房主走了房间还开着，剩下的是 B，新房客再进来就分不出正确的 A/B，
 * 而且没人有权选关（选关权限绑在房主身上）。关掉最省事，语义也最干净。
 * 非房主离开只是回到 waiting，房主可以等人再来一个。
 *
 * 留在房里的另一个人靠轮询 room.state 看到 status === 'closed' 后自行退出。
 */
export async function leave(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  const isHost = room.hostOpenid === openid
  const players = room.players.filter((p) => p.openid !== openid)
  const status: RoomDoc['status'] = isHost || players.length === 0 ? 'closed' : 'waiting'

  await db.collection(C.rooms).doc(code).update({
    data: { players, status, updatedAt: now() },
  })

  return { left: true, roomClosed: status === 'closed' }
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

  // 进度每次轮询都重查（不做缓存）：玩家在房间里通关后，可玩集合要立刻变化，
  // 缓存会产生「明明通关了对方还选不了」的错。代价是每次轮询多 2 次读
  // （房间最多 2 人），选关不是高频写操作，可以接受。
  const nextRoom = { ...room, players }
  const progressMap = await loadProgress(nextRoom.players.map((p) => p.openid))
  return toSnapshot(nextRoom, openid, progressMap)
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
  // 房间关了就别再往里写在线状态了（读操作 room.state / event.pull 仍然放行，
  // 客户端要靠它们观察 closed 状态）
  if (room.status === 'closed') throw new ApiError(ERROR.ROOM_CLOSED)

  await updateMe(room, openid, { online: true, lastSeenAt: now() })
  return { online: true }
}

/**
 * room.setLevel —— 房主中途换关（2026-10-10 新增）
 *
 * 入参：{ code, levelId }
 * 校验（按顺序）：房间存在 → 房间没关 → 调用者在房里 → **调用者是房主** → 关卡存在
 *
 * 关于校验到哪一步为止：
 * 「levelId 是不是两人都能玩」**服务端不校验**。可玩交集依赖关卡顺序、
 * 地图节点→关卡的映射、solo/duo 标记，这三样都在客户端，服务端算不出来
 * （详见 API.md）。所以这里只保证「关卡确实存在」，交集由客户端保证。
 *
 * 换关**不重置事件流水**：事件流已经按 levelId 打了标（见 event.ts），
 * 客户端只回放「本轮 + 本关」的事件，上一关的事件不会串进来，
 * 所以 lastSeq 不需要动，也不需要清 events。
 */
export async function setLevel(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()
  const levelId = requireString(params, 'levelId')

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (room.status === 'closed') throw new ApiError(ERROR.ROOM_CLOSED)
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  // 房主判定用服务端自己记的 hostOpenid，不靠「视角 A」去猜：
  // 建房者一定是 A，但反过来推不可靠，真相就存在文档里，直接用。
  if (room.hostOpenid !== openid) throw new ApiError(ERROR.NOT_HOST)

  const level = await getDoc(C.levels, levelId)
  if (!level) throw new ApiError(ERROR.LEVEL_NOT_FOUND)

  let nextRoom: RoomDoc = room
  if (room.levelId !== levelId) {
    await db.collection(C.rooms).doc(code).update({
      data: { levelId, updatedAt: now() },
    })
    nextRoom = { ...room, levelId }
  }

  // 返回新快照，房主客户端直接拿它刷新房间页；
  // 另一个玩家靠轮询 room.state 发现 levelId 变了，再提示「房主更换了关卡」。
  const progressMap = await loadProgress(nextRoom.players.map((p) => p.openid))
  return toSnapshot(nextRoom, openid, progressMap)
}
