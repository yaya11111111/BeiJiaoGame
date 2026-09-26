/**
 * 关卡私密数据下发 + 答案判定 + 关卡目录。
 *
 * 这是「信息差」玩法的技术落点，也是最需要小心的地方：
 * 玩家只能拿到自己这一侧的线索，拿不到对面视角，也永远拿不到答案。
 *
 * 当前关卡分两类（和客户端 LevelConfig 完全对齐）：
 * - 答题通关：配置里有 puzzle，服务端拿着答案判题（支持数组/对象两种答案形状）
 * - 操作通关：配置里没有 puzzle，客户端在场景里完成操作后调 level.submit 上报，
 *   服务端采信并落库（操作过程在客户端发生，服务端本来就验证不了，
 *   但通关记录只由 submit 产生这一条规矩不变）
 */

import { C, db, getDoc, now, progressId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext, LevelDoc, PuzzleAnswer, RoomDoc } from '../shared/types'

/** 默认容错次数，关卡配置里没写 maxAttempts 时用这个 */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * level.list —— 关卡目录 + 当前玩家进度（给 E 的地图页）
 *
 * 一次拿全：每关的 chapterId / title / unlocks（通关解锁哪些地图节点），
 * 以及这个玩家在每关上的进度。地图节点的解锁状态由客户端推导：
 * 初始节点 + 所有已通关关卡的 unlocks 并集，服务端不单独存解锁状态。
 */
export async function list(_params: any, ctx: ApiContext) {
  const openid = ctx.openid

  // 关卡总量就十来个，limit 100 足够
  const levelsRes = await db.collection(C.levels).limit(100).get()
  const levels: LevelDoc[] = (levelsRes && levelsRes.data) || []

  const progressRes = await db.collection(C.progress).where({ openid }).limit(100).get()
  const progressList: any[] = (progressRes && progressRes.data) || []
  const progressMap: Record<string, any> = {}
  for (const p of progressList) progressMap[p.levelId] = p

  return {
    list: levels.map((lv) => {
      const p = progressMap[lv.levelId]
      return {
        levelId: lv.levelId,
        chapterId: lv.chapterId,
        title: lv.title,
        unlocks: lv.unlocks || [],
        hasPuzzle: !!lv.puzzle,
        // 没有进度记录 = 还没碰过这关。是否可进入由客户端按解锁规则推导
        status: p ? p.status : 'none',
        bestTimeMs: p ? p.bestTimeMs || 0 : 0,
        clearedAt: p ? p.clearedAt || 0 : 0,
      }
    }),
  }
}

/**
 * level.getView —— 按身份下发线索
 *
 * - solo（单人）：一个人本来就要看两个视角，所以返回 A、B 两份
 * - duo（双人）：只返回自己在房间里被分配到的那一个视角，对面的一律不给；
 *   且 levelId 必须和房间正在玩的关卡一致，防止拿房间码套别的关的线索
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

    // 房间玩的是哪关，就只能拿哪关的线索
    if (room.levelId !== levelId) {
      throw new ApiError({ ...ERROR.PARAM_INVALID, message: 'levelId 与房间当前关卡不一致' })
    }

    visibleViews = { [me.viewId]: (level.views as any)[me.viewId] }
  }

  return {
    levelId,
    views: visibleViews,
    // 注意：这里刻意不返回 answer、requiredItems 明细。
    // 客户端只需要知道"往哪个节点提交、还剩几次机会、要不要先凑道具"。
    // 操作通关的关没有 puzzle，返回 null，客户端走 completes 热点那条路
    puzzle: level.puzzle
      ? {
          type: level.puzzle.type,
          submitNodeId: level.puzzle.submitNodeId,
          maxAttempts: level.puzzle.maxAttempts || DEFAULT_MAX_ATTEMPTS,
          hasRequiredItems: !!(level.puzzle.requiredItems && level.puzzle.requiredItems.length > 0),
        }
      : null,
  }
}

/**
 * 按形状比对答案：
 * - 数组 → 有序答案，长度一致且逐位相等
 * - 对象 → 按键答案，键集合一致且每个键的值相等
 * 形状不同（一个数组一个对象）直接判错。
 */
function isAnswerCorrect(expected: PuzzleAnswer, actual: any): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((v, i) => v === actual[i])
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    const keys = Object.keys(expected)
    if (Object.keys(actual).length !== keys.length) return false
    return keys.every((k) => actual[k] === expected[k])
  }
  return false
}

/**
 * level.submit —— 提交答案 / 上报通关，服务端落库
 *
 * 答题通关的关：服务端判题，只回 correct 和剩余次数，**绝不回传正确答案**。
 * 操作通关的关：没有 puzzle 可判，采信客户端的通关上报。
 *
 * 两条路径的共同点：通关记录（cleared）只由这个接口产生。
 * progress.save 不接受 cleared，这是防"客户端自封通关"的唯一闸口。
 */
export async function submit(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const levelId = requireString(params, 'levelId')
  // elapsedMs 缺省按「未提供」处理（用 <=0 表示），绝不参与最好成绩计算 —
  // 否则一个没传用时的请求会把历史最好成绩刷成 0
  const elapsedMs = typeof params.elapsedMs === 'number' && params.elapsedMs > 0 ? params.elapsedMs : 0

  const level: LevelDoc | null = await getDoc(C.levels, levelId)
  if (!level) throw new ApiError(ERROR.LEVEL_NOT_FOUND)

  // 取（或建）进度记录
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

  // ================================================================
  // 操作通关：没有 puzzle，客户端完成操作后上报，服务端采信
  // ================================================================
  if (!level.puzzle) {
    const bestTimeMs = pickBestTime(progress.bestTimeMs, elapsedMs)
    await db.collection(C.progress).doc(pid).update({
      data: { status: 'cleared', bestTimeMs, clearedAt: progress.clearedAt || now(), updatedAt: now() },
    })
    return {
      correct: true,
      failed: false,
      remainAttempts: null, // 没有容错次数的概念
      bestTimeMs,
      unlocks: level.unlocks || [],
    }
  }

  // ================================================================
  // 答题通关：服务端判题
  // ================================================================
  const puzzle = level.puzzle
  const maxAttempts = puzzle.maxAttempts || DEFAULT_MAX_ATTEMPTS

  // 道具门槛：requiredItems 和答案是相互独立的两个字段。
  // 背包（inventory）由客户端如实上报 —— 服务端拿不到背包，只能信它，
  // 但「客户端本地检查可以跳过」正是要把校验放在服务端的原因。
  // 道具不够不算一次提交，不消耗容错次数。
  const required = puzzle.requiredItems || []
  if (required.length > 0) {
    const inventory: string[] = Array.isArray(params.inventory) ? params.inventory : []
    const missing = required.filter((item) => inventory.indexOf(item) === -1)
    if (missing.length > 0) {
      throw new ApiError({ ...ERROR.MISSING_ITEM, message: `缺少必要道具：${missing.join('、')}` })
    }
  }

  // 重新开局判定：上次已经失败（次数用光）或已通关（重玩），attempts 清零重新计。
  // 没有这一步，失败过的玩家会永远卡在 failed，重玩也会带着上一局的次数
  let attempts = progress.attempts || 0
  if (attempts >= maxAttempts || progress.status === 'cleared') {
    attempts = 0
  }

  const answer = params.answer
  if (answer === undefined || answer === null) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '参数 answer 缺失' })
  }

  attempts += 1
  const correct = isAnswerCorrect(puzzle.answer, answer)

  if (correct) {
    // 通关：只在成绩更好时刷新最好用时（没传用时不刷新）
    const bestTimeMs = pickBestTime(progress.bestTimeMs, elapsedMs)
    await db.collection(C.progress).doc(pid).update({
      data: { status: 'cleared', bestTimeMs, attempts, clearedAt: now(), updatedAt: now() },
    })
    return {
      correct: true,
      remainAttempts: maxAttempts - attempts,
      failed: false,
      bestTimeMs,
      unlocks: level.unlocks || [],
    }
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

/**
 * 算最好成绩：只接受「这次确实报了用时（>0）且比历史更好」。
 * 历史是 0（从没记过）就用这次的；这次没报（0）就保持历史不变。
 */
function pickBestTime(oldBest: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return oldBest || 0
  if (!oldBest || oldBest <= 0) return elapsedMs
  return Math.min(oldBest, elapsedMs)
}
