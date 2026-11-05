/**
 * 双人关卡存档（FR-15）—— 保存退出 / 读取存档。
 *
 * 和「断线重连」是两件事，别混：
 * - 断线重连：房间还在，客户端本地内存里就有进度，第 8 周走 E 的本地快照。
 * - **本文件：跨会话存档**。房间随时可能因为「房主退出即关房」而消失，
 *   所以存档的键**绝不能含 roomCode**，否则房间一关存档就没了。
 *
 * 索引键 = pairKey（两个 openid 排序后拼） + levelId。
 * 房间只用来查「本局参与者是谁」（`rooms.sessionPlayers`），不参与存档的键。
 */

import { C, db, getDoc, now, savePairKey } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext, RoomDoc } from '../shared/types'

/** 单人进度上限，防异常数据把文档撑爆 */
const MAX_PROGRESS_BYTES = 64 * 1024

interface SaveSlot {
  openid: string
  progress: unknown
  savedAt: number
}

interface SaveDoc {
  _id?: string
  pairKey: string
  levelId: string
  elapsedSec: number
  players: SaveSlot[]
  savedAt: number
  updatedAt: number
}

async function findSave(pairKey: string, levelId: string): Promise<SaveDoc | null> {
  const res = await db
    .collection(C.saves)
    .where({ pairKey, levelId })
    .limit(1)
    .get()
    .catch(() => null)
  const list: SaveDoc[] = (res && res.data) || []
  return list.length > 0 ? list[0] : null
}

/**
 * 取本局参与者。
 *
 * 优先 `sessionPlayers`（`room.start` 时的快照）—— 因为 `players` 会在玩家退出时
 * 移除成员，先退的人一走就凑不齐两个人了。
 * 房间还没开局时没有 sessionPlayers，退回用当前 players（那时人还没退，是完整的）。
 */
function sessionOpenids(room: RoomDoc): string[] {
  if (Array.isArray(room.sessionPlayers) && room.sessionPlayers.length > 0) {
    return room.sessionPlayers
  }
  return (room.players || []).map((p) => p.openid)
}

/** 房间 + 关卡 → 存档 pairKey。房间不存在报 2001，你不在本局里报 2004 */
async function resolvePair(params: any, ctx: ApiContext): Promise<string> {
  const code = requireString(params, 'code').toUpperCase()
  const room = await getDoc(C.rooms, code)
  // 注意：这里**不校验房间是否已关闭**。房主退出会把房间关掉，
  // 但另一个人必须还能把存档传上来，否则这一半进度就丢了。
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)

  const openids = sessionOpenids(room as RoomDoc)
  if (openids.indexOf(ctx.openid) < 0) throw new ApiError(ERROR.NOT_IN_ROOM)
  return savePairKey(openids)
}

/**
 * 给 `room.state` 的快照用：本关有没有可恢复的存档。
 *
 * 只在房间里有 2 个人时才查（存档只对双人有意义），避免单人建房时每次
 * 0.5 秒轮询都白查一次 saves 集合。
 */
export async function peekSave(
  room: RoomDoc,
  levelId: string,
): Promise<{ hasSave: boolean; saveComplete: boolean }> {
  const openids = sessionOpenids(room)
  if (openids.length < 2 || !levelId) return { hasSave: false, saveComplete: false }

  const doc = await findSave(savePairKey(openids), levelId)
  if (!doc) return { hasSave: false, saveComplete: false }
  return { hasSave: true, saveComplete: (doc.players || []).length >= 2 }
}

/**
 * 通关时自动清掉这一对玩家的该关存档，防止残留（不经过 action 路由）。
 *
 * 通关是个低频动作，这里多读一次房间文档无所谓；失败也不影响通关结果，
 * 所以整段包在 try 里 —— 存档清理不该把通关本身搞挂。
 */
export async function clearSaveForRoom(code: string, levelId: string): Promise<void> {
  if (typeof code !== 'string' || code.trim() === '' || !levelId) return
  try {
    const room = await getDoc(C.rooms, code.trim().toUpperCase())
    if (!room) return
    const openids = sessionOpenids(room as RoomDoc)
    if (openids.length < 2) return
    const doc = await findSave(savePairKey(openids), levelId)
    if (!doc || !doc._id) return
    await db.collection(C.saves).doc(doc._id).remove()
  } catch (e) {
    console.error('[save] 通关清理存档失败：', e)
  }
}

export async function write(params: any, ctx: ApiContext) {
  const levelId = requireString(params, 'levelId')
  const pairKey = await resolvePair(params, ctx)

  const progress = params.progress
  if (progress === undefined || progress === null || typeof progress !== 'object') {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '缺少关卡进度' })
  }
  const bytes = JSON.stringify(progress).length
  if (bytes > MAX_PROGRESS_BYTES) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '关卡进度数据过大' })
  }

  const elapsedSec = typeof params.elapsedSec === 'number' && params.elapsedSec > 0
    ? Math.floor(params.elapsedSec)
    : 0

  const ts = now()
  const existing = await findSave(pairKey, levelId)

  if (!existing) {
    await db.collection(C.saves).add({
      data: {
        pairKey,
        levelId,
        elapsedSec,
        players: [{ openid: ctx.openid, progress, savedAt: ts }],
        savedAt: ts,
        updatedAt: ts,
      },
    })
    return { savedAt: ts, complete: false }
  }

  const players = existing.players || []
  const slot = players.filter((p) => p.openid === ctx.openid)[0]
  if (slot) {
    slot.progress = progress
    slot.savedAt = ts
  } else {
    players.push({ openid: ctx.openid, progress, savedAt: ts })
  }

  // 两边时钟略有差异时取较大的，避免把已用时间算少了
  const mergedElapsed = Math.max(existing.elapsedSec || 0, elapsedSec)

  await db.collection(C.saves).doc(existing._id!).update({
    data: { players, elapsedSec: mergedElapsed, savedAt: ts, updatedAt: ts },
  })
  return { savedAt: ts, complete: players.length >= 2 }
}

export async function load(params: any, ctx: ApiContext) {
  const levelId = requireString(params, 'levelId')
  const pairKey = await resolvePair(params, ctx)

  const doc = await findSave(pairKey, levelId)
  // 没有存档不是错误 —— 玩家第一次玩就是没有
  if (!doc) return { found: false }

  const players = doc.players || []
  const mine = players.filter((p) => p.openid === ctx.openid)[0]
  if (!mine) return { found: false }

  const peer = players.filter((p) => p.openid !== ctx.openid)[0]

  return {
    found: true,
    // 只给自己的那份。队友的线索和道具不能发给对方 ——
    // 双视角信息差是核心玩法，存档也不能破坏这条。
    complete: players.length >= 2,
    elapsedSec: doc.elapsedSec || 0,
    savedAt: doc.savedAt || 0,
    mine: mine.progress,
    peerReady: !!peer,
  }
}

export async function clear(params: any, ctx: ApiContext) {
  const levelId = requireString(params, 'levelId')
  const pairKey = await resolvePair(params, ctx)

  const doc = await findSave(pairKey, levelId)
  if (!doc || !doc._id) return { cleared: false }
  await db.collection(C.saves).doc(doc._id).remove()
  return { cleared: true }
}
