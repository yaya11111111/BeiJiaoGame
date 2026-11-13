/**
 * 双人房间：建房、入房、离开、查状态、心跳。
 *
 * 房间码就是文档 _id，所以「建房」和「查房」都不用建索引，一次 doc().get() 搞定。
 */

import { C, db, getDoc, now, progressId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import { peekSave } from './save'
import { toEventItem } from './event'
import type { ApiContext, RoomDoc, RoomPlayer } from '../shared/types'

/** 房间码字符集。故意去掉了 0/O/1/I 这些容易看混的字符，玩家口头报码时不会出错 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 「能组队选的关」的顺序。
 *
 * **这不是关卡总顺序** —— 那个在客户端 `common/LevelConfig.ts` 的 `LEVEL_ORDER`，
 * 用来算结算页的「下一关」按钮。两份用处不同：这份只服务于房间选关
 * （算两人可玩集合的交集、找「最远通关的下一关」）。
 *
 * **第 10 关 2026-10-12 已补齐**（客户端 `configs/level.10.json` + 重新生成的种子），
 * 所以它回到了表里。以后再加关，**先有配置和种子再往这里加** —— 反过来会让房主
 * 选到一个点进去报「关卡数据缺失」的按钮。
 */
const LEVEL_ORDER = ['GUIDE', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10']
/** 给双方留出轮询、加载页面的时间，真正计时仍以这个服务端时间为准。 */
const START_DELAY_MS = 3000

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
 * 算「两人都能玩」的关卡：各自可玩集合的交集。
 *
 * 「可玩」按 **unlocked** 算、不按 cleared —— 「已解锁、还没通关」正是要一起来通的那种。
 *
 * **GUIDE 有意留在集合里**（2026-10-12 和 E 确认）：新手引导关允许双人一起玩，
 * 所以每个玩家的可玩集合都先塞一个 GUIDE，两个零进度的新手交集也不会是空集。
 * 这也意味着服务端不必再登录时补基线进度记录（见 auth.login）。
 */
async function playableLevelIds(room: RoomDoc): Promise<string[]> {
  if (room.players.length === 0) return ['GUIDE']

  const perPlayer = await Promise.all(room.players.map(async (player) => {
    // 一人一查，而不是 where({ openid: _.in([...]) })：房间最多 2 人，两发并行读的成本
    // 可以接受，而 where({ openid }) 是这个集合上已经在用、跑通过的模式，不为省一次读
    // 去引入一个没验证过的操作符。
    //
    // 回退兜底：进度只是快照的附属信息，一次查询异常不该让 create / join / state
    // 三个接口一起挂；state 又是房间页的高频轮询。
    // 正常路径每人只查一次；旧实现把查询异常 catch 成空数组，界面会静默退化成
    // “只能选第 0 关”。现在查询失败时才按确定性的文档 id 逐关回退，兼顾轮询成本
    // 和老环境/索引异常下的正确性。
    let progress: any[]
    try {
      const res = await db.collection(C.progress).where({ openid: player.openid }).limit(100).get()
      progress = (res && res.data) || []
    } catch (_error) {
      progress = (await Promise.all(LEVEL_ORDER.map((levelId) =>
        getDoc(C.progress, progressId(player.openid, levelId)),
      ))).filter(Boolean) as any[]
    }
    const available = new Set<string>(['GUIDE'])
    let furthestCleared = -1

    for (const entry of progress) {
      if (entry.status === 'unlocked' || entry.status === 'cleared') available.add(entry.levelId)
      if (entry.status === 'cleared') {
        furthestCleared = Math.max(furthestCleared, LEVEL_ORDER.indexOf(entry.levelId))
      }
    }

    // 通关更后面的关卡意味着前面的关卡也一定可以重玩。旧进度数据可能只保存了
    // 最近通关的那一关，没有为每个前置关卡都留一条文档；如果只相信实际记录，
    // “已通关第 1 关”的玩家会缺少第 0/1 关按钮。这里根据最高通关位置补齐
    // 0..下一关，之后两名玩家再取交集。
    const highestPlayable = Math.min(furthestCleared + 1, LEVEL_ORDER.length - 1)
    for (let index = 0; index <= highestPlayable; index += 1) {
      available.add(LEVEL_ORDER[index])
    }
    return available
  }))

  return LEVEL_ORDER.filter((levelId) => perPlayer.every((available) => available.has(levelId)))
}

/**
 * 房间快照。`playable` / `saveInfo` 是给高频接口（room.sync）省查询用的：
 * 传了就直接用，不传就照旧现算 —— create / join / setLevel 这些一次性接口不用关心。
 */
async function toSnapshot(
  room: RoomDoc,
  myOpenid: string,
  playable?: string[],
  saveInfo?: { hasSave: boolean; saveComplete: boolean },
) {
  const me = room.players.find((p) => p.openid === myOpenid)
  const serverNow = now()
  // 顺带告诉客户端「这一关有没有可恢复的存档」，省掉一次 save.load 往返。
  // 房间不足 2 人时 peekSave 内部直接短路，不会真的去查集合。
  const peeked = saveInfo || await peekSave(room, room.levelId)
  return {
    code: room.code,
    levelId: room.levelId,
    status: room.status,
    myViewId: me ? me.viewId : null,
    isHost: room.hostOpenid === myOpenid,
    startedAt: room.startedAt || 0,
    serverNow,
    hasSave: peeked.hasSave,
    saveComplete: peeked.saveComplete,
    playableLevelIds: playable || await playableLevelIds(room),
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

  // 不认识的关卡 id **直接报错**，不要静默改成 GUIDE。
  // 静默降级的好处是「不会白屏」，代价是客户端传错参数时谁也不知道出过问题 ——
  // 玩家只会看到房间莫名开在第 0 关。门口就拦掉，参数错就是参数错。
  if (LEVEL_ORDER.indexOf(levelId) < 0) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: `关卡 ${levelId} 不存在` })
  }

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
    status: 'waiting', // 两人到齐后仍等待房主调用 room.start
    startedAt: 0,
    players: [{ openid, nickname, viewId: 'A', online: true, lastSeenAt: ts }],
    lastSeq: 0,
    createdAt: ts,
    updatedAt: ts,
  }

  await db.collection(C.rooms).add({ data: room })
  return toSnapshot(room, openid)
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

  let joinedRoom: RoomDoc | null = null
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
        joinedRoom = { ...room, players }
        return
      }

      if (room.players.length >= 2) throw new ApiError(ERROR.ROOM_FULL)

      // 视角分配看「A 有没有人占」，而不是看人数。
      //
      // 以前写的是 length === 0 ? 'A' : 'B'：一旦房主（A）先离开、房里只剩 B，
      // 新房客会因为 length === 1 被分到 'B'，房间里出现两个 B，双视角的信息差直接失效。
      // 现在房主离开会关闭房间（见 leave），这条路径本已走不到，但保留防御性写法，
      // 免得以后放开「房主让位」时又踩回来。
      const viewId: 'A' | 'B' = room.players.some((p) => p.viewId === 'A') ? 'B' : 'A'
      const players: RoomPlayer[] = [
        ...room.players,
        { openid, nickname, viewId, online: true, lastSeenAt: now() },
      ]
      await tx.collection(C.rooms).doc(code).update({
        data: { players, status: 'waiting', startedAt: 0, updatedAt: now() },
      })
      joinedRoom = { ...room, players, status: 'waiting' as const, startedAt: 0 }
    })
  } catch (e: any) {
    // 事务里抛的 ApiError 会触发回滚并原样透出来，业务错误码不变
    if (e instanceof ApiError) throw e
    // 事务里 get 一个不存在的文档，有的版本直接抛错而不是返回空，翻译成 2001
    const msg = String((e && (e.errMsg || e.message)) || '')
    if (/not exist|not found/i.test(msg)) throw new ApiError(ERROR.ROOM_NOT_FOUND)
    throw e
  }

  // 显式转回声明类型：事务回调里那个赋值 TS 的控制流分析追踪不到，
  // 不加这行它会把 joinedRoom 收窄成 never，下面取 .levelId 编译不过。
  const joined = joinedRoom as RoomDoc | null
  if (!joined) throw new ApiError(ERROR.INTERNAL)

  const playable = await playableLevelIds(joined)
  let room = joined
  const defaultLevelId = playable[playable.length - 1] || 'GUIDE'
  if (room.levelId !== defaultLevelId) {
    // 第二名玩家加入后，默认切到双方共同可玩的最高关卡。房主仍然可以通过
    // room.setLevel 改回列表中的任意较早关卡。
    const levelId = defaultLevelId
    await db.collection(C.rooms).doc(code).update({ data: { levelId, updatedAt: now() } })
    room = { ...room, levelId }
  }
  return toSnapshot(room, openid, playable)
}

/**
 * room.leave —— 退出房间
 *
 * **房主离开 = 房间关闭**（2026-10-10 定，2026-10-12 和 E 再次确认）。
 * 这么做的前提是「建房的人永远是视角 A」这个约定继续有效：
 * 如果房主走了房间还开着，剩下的是 B，新房客再进来就分不出正确的 A/B，
 * 而且没人有权选关（选关权限绑在房主身上）。关掉最省事，语义也最干净。
 * 非房主离开只是退回 waiting，房主可以继续等人。
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
  // 房主走了直接关房；非房主走了只要还有人，房间就退回 waiting
  const status: RoomDoc['status'] = isHost || players.length === 0 ? 'closed' : 'waiting'

  await db.collection(C.rooms).doc(code).update({
    // status 用上面按「房主离开 = 房间关闭」算好的那个（2026-10-12 与 E 确认的口径）；
    // startedAt 归零是因为这一轮结束了 —— 房间要么关了、要么退回等待，
    // 留着上一轮的开局时间会让下一次 room.start 的幂等判断误判
    data: { players, status, startedAt: 0, updatedAt: now() },
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

  return toSnapshot({ ...room, players }, openid)
}

/*
 * room.sync —— 房间快照 + 事件增量的**聚合**拉取（2026-11-13 新增）。
 *
 * ## 为什么要聚合
 * 房间页原来同时跑三条定时器：`room.state` 0.5 秒、`room.heartbeat` 10 秒、
 * 关卡内 `event.pull` 1 秒。三者读写的都是**同一份 rooms 文档**，一轮下来两三次
 * 云调用，其中两次做的事高度重叠。合并成一次调用后轮询开销直接减半，而且
 * 「我还活着」这件事由它顺手刷新，心跳接口可以整个停掉。
 *
 * ## 三条硬约定（改之前先看理由）
 * 1. **房间已关闭不报错**，返回 200 + `status:'closed'`。房主走了之后要靠客户端
 *    自己退出房间页；这里若抛 2003，客户端会当成网络异常一直重试，卡死在房间页
 *    （`API.md` 里那条「客户端必须处理 closed 分支」说的就是这个）。
 * 2. **lastSeq 是本页最后一条的 seq**，空页等于入参 `sinceSeq`。用房间全局值会让
 *    客户端跳过一页之外没拉到的中间事件（`event.ts` 里同一个坑已经踩过）。
 * 3. **不按 levelId 过滤事件**。客户端算「本轮从哪条开始」要靠跨关的 `result` /
 *    `close` 找边界（`LevelSync.currentRunStartSeq`），只回本关事件会让它把上一轮
 *    当成同一轮 —— 症状是「一进新关立刻通关」。过滤留在客户端做。
 */

/** 一次最多回多少条，比 event.pull 的 200 小；够不够用由 hasMore 告诉客户端 */
const SYNC_PAGE_LIMIT = 100
/** lastSeenAt 最多 10 秒写一次 —— 和原来 10 秒心跳同一个写频率，不额外增加写配额 */
const SEEN_WRITE_MS = 10 * 1000
/** 30 秒没刷新就算离线，和 room.state 里的阈值保持一致 */
const PEER_OFFLINE_MS = 30 * 1000
/** 可玩交集缓存的有效期 */
const PLAYABLE_TTL_MS = 15 * 1000

/** 见上方三条硬约定 */
export async function sync(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  // 房间关了也放行（见约定 1），所以这里只校验「你是不是这局的人」
  if (!room.players.some((p) => p.openid === openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }

  // sinceSeq 必须显式传：缺省当 0 会把整间房的历史重放一遍，
  // 客户端只要忘了传一次，对面就会看到一串上一局的操作。
  // 不合法报 3001（PARAM_INVALID）—— 注意不是 4001，那个是「关卡数据缺失」。
  const sinceSeq = params.sinceSeq
  if (typeof sinceSeq !== 'number' || !Number.isFinite(sinceSeq) || sinceSeq < 0) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: 'sinceSeq 必须是 >= 0 的数字' })
  }

  const ts = now()
  const patch: Record<string, any> = {}
  let players = room.players

  // ① 在线状态 + 我的 lastSeenAt。关闭的房间只读不写：写了也没人看，纯浪费写配额。
  if (room.status !== 'closed') {
    let changed = false
    players = room.players.map((p) => {
      if (p.openid === openid) {
        // 节流：10 秒内已经写过就只在返回值里显示在线，不再落库
        if (p.online && ts - (p.lastSeenAt || 0) < SEEN_WRITE_MS) return p
        changed = true
        return { ...p, online: true, lastSeenAt: ts }
      }
      const online = ts - (p.lastSeenAt || 0) < PEER_OFFLINE_MS
      if (online === p.online) return p
      changed = true
      return { ...p, online }
    })
    if (changed) patch.players = players
  }

  // ② 可玩交集：15 秒缓存。这是原来最贵的一步 —— 每人一次 progress 查询，
  //    room.sync 是 1 秒级的，不缓存等于把省下的调用次数从读次数上还回去。
  const key = players.map((p) => p.openid).sort().join('|')
  let playable: string[]
  if (
    room.playableCacheKey === key
    && Array.isArray(room.playableCache)
    && ts - (room.playableCacheAt || 0) < PLAYABLE_TTL_MS
  ) {
    playable = room.playableCache
  } else {
    playable = await playableLevelIds({ ...room, players })
    if (room.status !== 'closed') {
      patch.playableCache = playable
      patch.playableCacheKey = key
      patch.playableCacheAt = ts
    }
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = ts
    await db.collection(C.rooms).doc(code).update({ data: patch })
  }

  // ③ 多取一条用来判断「后面还有没有」，比 event.pull 用 length >= 200 去猜准
  const [res, saved] = await Promise.all([
    db
      .collection(C.events)
      .where({ roomId: code, seq: db.command.gt(sinceSeq) })
      .orderBy('seq', 'asc')
      .limit(SYNC_PAGE_LIMIT + 1)
      .get(),
    // ④ 存档探测：只有房间页用得上，进关卡后跳过这一次 saves 查询
    room.status === 'playing'
      ? Promise.resolve({ hasSave: false, saveComplete: false })
      : peekSave({ ...room, players }, room.levelId),
  ])

  const rows: any[] = (res && res.data) || []
  const hasMore = rows.length > SYNC_PAGE_LIMIT
  const list = hasMore ? rows.slice(0, SYNC_PAGE_LIMIT) : rows

  return {
    room: await toSnapshot({ ...room, players }, openid, playable, saved),
    events: list.map(toEventItem),
    // 约定 2：本页最后一条；空页原样退回 sinceSeq，客户端游标就不会跳
    lastSeq: list.length > 0 ? list[list.length - 1].seq : sinceSeq,
    hasMore,
  }
}

/** room.setLevel —— 房主换关（2026-10-10 新增）
 *
 * 入参：{ code, levelId }
 * 校验（按顺序）：房间存在 → 房间没关 → 调用者在房里 → **调用者是房主**
 *              → levelId 在两人可玩交集里 → 关卡数据存在
 *
 * 和 create 不同：**这里会校验可玩交集**。房主是在客户端给的候选列表里点按钮，
 * 列表来源是服务端算好的 playableLevelIds，正常情况下一定能命中；
 * 校验是为了挡住「房主界面数据过期（同伴刚退出/进度变了）」和手改参数的请求。
 * 校验失败给 3001 —— 它是「参数不合法」，和「你不是房主」这种越权（2005）不是一回事。
 *
 * 另外必须验「调用者在房里」：房主身份存在 hostOpenid 字段里不会随 leave 清空，
 * 少了这一步，一个已经退出房间的前房主还能继续改房里的关卡。
 *
 * 换关**不重置事件流水**：事件流已经按 levelId 打了标（见 event.ts），
 * 客户端只回放「本轮 + 本关」的事件，上一关的事件不会串进来，
 * 所以 lastSeq 不需要动，也不需要清 events。
 */
export async function setLevel(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()
  const levelId = requireString(params, 'levelId').toUpperCase()
  const room: RoomDoc | null = await getDoc(C.rooms, code)

  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (room.status === 'closed') throw new ApiError(ERROR.ROOM_CLOSED)
  if (!room.players.some((p) => p.openid === openid)) throw new ApiError(ERROR.NOT_IN_ROOM)
  if (room.hostOpenid !== openid) throw new ApiError(ERROR.NOT_HOST)

  const playable = await playableLevelIds(room)
  if (!playable.includes(levelId)) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '该关卡尚未对双方解锁' })
  }

  const level = await getDoc(C.levels, levelId)
  if (!level) throw new ApiError(ERROR.LEVEL_NOT_FOUND)
  // 换关要把房间退回 waiting、并清掉 startedAt —— 换完能重新开局。
  // 这一步和 room.start 是一套：start 靠 `status === 'playing' && startedAt`
  // 做幂等，换关不重置的话，下一轮就再也生成不出新的开局时间了
  await db.collection(C.rooms).doc(code).update({
    data: { levelId, status: 'waiting', startedAt: 0, updatedAt: now() },
  })
  return toSnapshot({ ...room, levelId, status: 'waiting', startedAt: 0 }, openid, playable)
}

/** room.start —— 仅房主可统一开局；另一名玩家通过 room.state 自动收到。 */
export async function start(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const code = requireString(params, 'code').toUpperCase()
  const room: RoomDoc | null = await getDoc(C.rooms, code)

  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (room.status === 'closed') throw new ApiError(ERROR.ROOM_CLOSED)
  if (room.hostOpenid !== openid) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '只有房主可以开始游戏' })
  }
  if (room.players.length < 2 || room.players.some((player) => !player.online)) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '请等待好友进入房间并保持在线' })
  }

  // 重复点击幂等：同一轮已经开始时返回原来的 startedAt，不能生成两个开局时间。
  if (room.status === 'playing' && room.startedAt) return toSnapshot(room, openid)

  const startedAt = now() + START_DELAY_MS
  // 本局参与者快照（FR-15）。双人存档靠它算 pairKey —— 不能用 players，
  // 因为 players 会在玩家退出时移除成员，先退的人一走就凑不齐两个人了。
  const sessionPlayers = room.players.map((p) => p.openid)
  await db.collection(C.rooms).doc(code).update({
    data: { status: 'playing', startedAt, sessionPlayers, updatedAt: now() },
  })
  return toSnapshot({ ...room, status: 'playing', startedAt, sessionPlayers }, openid)
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
  // 房间关了（房主走了，见 leave）就不再刷新在线状态。
  // 读操作 room.state / event.pull 仍然放行，客户端要靠它们观察 closed 状态
  if (room.status === 'closed') throw new ApiError(ERROR.ROOM_CLOSED)

  await updateMe(room, openid, { online: true, lastSeenAt: now() })
  return { online: true }
}
