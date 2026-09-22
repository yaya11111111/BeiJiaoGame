/**
 * 关卡私密数据下发 + 答案判定。
 *
 * 这是「信息差」玩法的技术落点，也是最需要小心的地方：
 * 客户端配置里只有图、坐标、交互类型，真正的线索正文和答案都在服务端。
 * 玩家只能拿到自己这一侧的线索，拿不到对面视角，也永远拿不到答案。
 */

import { C, db, getDoc, now, progressId } from '../shared/db'
import { ApiError, ERROR, requireArray, requireString } from '../shared/errors'
import type { ApiContext, LevelDoc, RoomDoc } from '../shared/types'

/** 默认容错次数，关卡配置里没写 maxAttempts 时用这个 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * level.getView —— 按身份下发线索
 *
 * - solo（单人）：一个人本来就要看两个视角，所以返回 A、B 两份
 * - duo（双人）：只返回自己在房间里被分配到的那一个视角，对面的一律不给
 *
 * 返回值里**永远没有 answer 字段**，puzzle 只给判定无关的信息。
 */
export async function getView(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')
  const mode = requireString(params, 'mode')

  if (mode !== 'solo' && mode !== 'duo') {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: "mode 只能是 'solo' 或 'duo'" })
  }

  const level: LevelDoc | null = await getDoc(C.levels, levelId)
  if (!level) throw new ApiError(ERROR.LEVEL_NOT_FOUND)

  let visibleViews: Record<string, { clues: Record<string, string> }>

  if (mode === 'solo') {
    // 单人模式：两个视角都给
    visibleViews = { A: level.views.A, B: level.views.B }
  } else {
    // 双人模式：先查房间确认自己的视角，只下发这一侧
    const code = requireString(params, 'code').toUpperCase()
    const room: RoomDoc | null = await getDoc(C.rooms, code)
    if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)

    const me = room.players.find((p) => p.openid === openid)
    if (!me) throw new ApiError(ERROR.NOT_IN_ROOM)

    visibleViews = { [me.viewId]: (level.views as any)[me.viewId] }
  }

  return {
    levelId,
    views: visibleViews,
    // 注意：这里刻意不返回 answer、requiredItems。
    // 客户端只需要知道"往哪个节点提交、还剩几次机会"。
    puzzle: {
      type: level.puzzle.type,
      submitNodeId: level.puzzle.submitNodeId,
      maxAttempts: level.puzzle.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    },
  }
}

/**
 * level.submit —— 提交答案，服务端判定
 *
 * 只回 correct 和剩余次数，**绝不回传正确答案**。
 * 这条是需求评审定的隐私口径，就算以后要做"提示"功能也不能破例。
 */
export async function submit(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')
  const answer = requireArray(params, 'answer') as string[]
  const elapsedMs = typeof params.elapsedMs === 'number' ? params.elapsedMs : 0

  const level: LevelDoc | null = await getDoc(C.levels, levelId)
  if (!level) throw new ApiError(ERROR.LEVEL_NOT_FOUND)

  const maxAttempts = level.puzzle.maxAttempts || DEFAULT_MAX_ATTEMPTS

  // 取（或建）进度记录，用 attempts 算剩余容错次数
  const pid = progressId(openid, levelId)
  let progress: any = await getDoc(C.progress, pid)
  if (!progress) {
    progress = {
      _id: pid,
      openid,
      levelId,
      status: 'unlocked',
      bestTimeMs: 0,
      attempts: 0,
      clearedAt: 0,
      updatedAt: now(),
    }
    await db.collection(C.progress).add({ data: progress })
  }

  // 已经用光机会了就直接判失败，不再比对
  if (progress.attempts >= maxAttempts) {
    return { correct: false, remainAttempts: 0, failed: true }
  }

  const attempts = progress.attempts + 1

  // 严格按顺序比对。答案通常是道具 id 序列，顺序错了就是错
  const expected = level.puzzle.answer || []
  const correct =
    expected.length === answer.length && expected.every((v: string, i: number) => v === answer[i])

  if (correct) {
    // 通关：只在成绩更好时刷新最好用时
    const bestTimeMs =
      progress.bestTimeMs > 0 ? Math.min(progress.bestTimeMs, elapsedMs) : elapsedMs || 0
    await db.collection(C.progress).doc(pid).update({
      data: { status: 'cleared', bestTimeMs, attempts, clearedAt: now(), updatedAt: now() },
    })
    return { correct: true, remainAttempts: maxAttempts - attempts, failed: false, bestTimeMs }
  }

  // 答错：只累加次数，不透露答案
  await db.collection(C.progress).doc(pid).update({
    data: { attempts, updatedAt: now() },
  })
  return {
    correct: false,
    remainAttempts: Math.max(0, maxAttempts - attempts),
    failed: attempts >= maxAttempts,
  }
}
