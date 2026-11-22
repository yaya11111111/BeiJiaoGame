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

import { C, db, duoScoreId, getDoc, now, progressId, savePairKey, scoreId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import { resolveTimeLimitSec, scoreFromTimeMs, SCORE_RULE_VERSION } from '../shared/rules'
import { clearSaveForRoom } from './save'
import { rankOf } from './rank'
import { recordDuoClear } from './partner'
import type { ApiContext, LevelDoc, PuzzleAnswer, RoomDoc, ScoreDoc } from '../shared/types'

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
 * 单人只记自己；双人房间通关时记房内双方。
 * 一人完成后另一端会被 result 事件带进结算，但答题关不会再次提交答案，所以必须
 * 由服务端在首次合法通关时一次性给双方落 cleared。
 */
async function settleTarget(
  params: any,
  ctx: ApiContext,
  levelId: string,
): Promise<{ openids: string[]; room: RoomDoc | null; code: string }> {
  const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : ''
  if (!code) return { openids: [ctx.openid], room: null, code: '' }

  const room: RoomDoc | null = await getDoc(C.rooms, code)
  if (!room) throw new ApiError(ERROR.ROOM_NOT_FOUND)
  if (!room.players.some((player) => player.openid === ctx.openid)) {
    throw new ApiError(ERROR.NOT_IN_ROOM)
  }
  if (room.status !== 'playing' || !room.startedAt) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '房间尚未开始游戏' })
  }
  if (room.levelId !== levelId) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '提交关卡与房间当前关卡不一致' })
  }
  return { openids: room.players.map((player) => player.openid), room, code }
}

/**
 * 限时关的截止校验（缺陷 T10）。
 *
 * 只在「马上要记通关」这一步拦，答错、缺道具这些既有路径的判定顺序一个字都不动。
 *
 * 依据是客户端上报的 `elapsedMs`，不是服务端墙钟：单人局没有开局时刻可比，
 * 双人局的 `startedAt` 又会被「暂停」（暂停时长目前不落服务端，见 T8），
 * 用墙钟算会把暂停过的正常玩家误判成超时。所以这是一道软校验 ——
 * 挡得住「老老实实耗到 0 才上报」的客户端，挡不住把 elapsedMs 改小的改包。
 * `elapsedMs <= 0`（没报用时）视为无法判断，放行。
 */
function assertWithinTimeLimit(level: LevelDoc, levelId: string, elapsedMs: number): void {
  const limitSec = resolveTimeLimitSec(levelId, level.timeLimitSec)
  if (limitSec <= 0 || elapsedMs <= 0) return
  if (elapsedMs > limitSec * 1000) {
    throw new ApiError({
      ...ERROR.TIME_UP,
      message: `本关限时 ${limitSec} 秒，本次上报用时 ${Math.floor(elapsedMs / 1000)} 秒`,
    })
  }
}

/**
 * 抢占「本局首结算权」（缺陷 T9）。
 *
 * 双人局两端都可能各上报一次通关，但一局只能结算一次：不拦的话 `clearedAt` 会被
 * 后一次刷掉、搭档档案的 `playCount` 翻倍、结算事件也会冒两条。
 *
 * 判定用的是 `room.startedAt` 而不是布尔标记 —— 换关 / 重开都会把 startedAt 归零重算，
 * 同一个字段自然就区分了「新的一局」，不用额外清理。
 *
 * 必须放事务里：两端几乎同时提交时，先读后写有竞态，两个请求会同时认为自己是首个。
 * 返回 true = 我抢到了，可以往下落库；false = 本局已被另一端结算过。
 */
async function claimRun(room: RoomDoc | null): Promise<boolean> {
  // 单人局没有「一局」的概念，每次都算首结算
  if (!room || !room.startedAt) return true
  const runAt = room.startedAt
  if (room.clearedRunAt === runAt) return false

  const claimed = await db.runTransaction(async (tx: typeof db) => {
    const fresh = (await getDoc(C.rooms, room.code, tx)) as RoomDoc | null
    if (!fresh) return false
    if (fresh.clearedRunAt === runAt) return false
    await tx.collection(C.rooms).doc(room.code).update({
      data: { clearedRunAt: runAt, updatedAt: now() },
    })
    return true
  })
  return claimed === true
}

/**
 * 写**单人**榜（FR-16）。一人 · 一关 只留更好的一条。
 *
 * `timeMs <= 0` 直接跳过 —— 没有可用用时就没法排名，硬写进去 0 秒通关会霸榜。
 *
 * 返回**最终留在库里的那条成绩**（可能不是这次上报的：重玩变差时保留旧的）。
 * 名次必须按它算，否则「上次 100 秒、这次 200 秒」会把玩家算到更靠后的位置。
 */
async function writeSoloScore(input: {
  openid: string
  levelId: string
  timeMs: number
  code: string
  clearedAt: number
}): Promise<{ score: number; timeMs: number; clearedAt: number } | null> {
  if (!(input.timeMs > 0)) return null

  const id = scoreId(input.openid, input.levelId, 'solo')
  const existing = (await getDoc(C.scores, id)) as ScoreDoc | null
  return overwriteIfBetter(id, existing, input, {
    openid: input.openid,
    levelId: input.levelId,
    mode: 'solo',
  })
}

/**
 * 写**双人**榜（FR-16，v3.9 起按队聚合）。一队 · 一关 只留更好的一条。
 *
 * 和单人榜最大的区别：`_id` 由 **pairKey** 决定（`duo_<摘要>`），
 * 所以 A、B 两人一起通关只会产生**一条**记录。不这么改的话，
 * 同一局会出「A 搭档 B」「B 搭档 A」两行，`rank` / `total` / `mine` 全是错的。
 *
 * 队友是谁写在 `openids` 里（升序），它同时也是「这是不是一条双人队记录」的判定依据。
 */
async function writeDuoScore(input: {
  openids: string[]
  levelId: string
  timeMs: number
  code: string
  clearedAt: number
}): Promise<{ score: number; timeMs: number; clearedAt: number } | null> {
  if (!(input.timeMs > 0)) return null

  const openids = input.openids.filter(Boolean).sort()
  // 单人凑不出队伍，交给单人榜那条路
  if (openids.length < 2) return null

  const teamKey = savePairKey(openids)
  const id = duoScoreId(teamKey, input.levelId)
  const existing = (await getDoc(C.scores, id)) as ScoreDoc | null
  return overwriteIfBetter(id, existing, input, {
    openid: '', // 双人记录不归属单人，成员一律看 openids
    openids,
    teamKey,
    levelId: input.levelId,
    mode: 'duo',
  })
}

/**
 * 两条写榜路径共用的「更好的才覆盖」逻辑。
 *
 * 抽出来是为了保证单人/双人的比较口径**完全一致** —— 一旦两边的
 * 「怎么算更好」写得不一样，榜单上就会出同分不同序的怪事。
 */
async function overwriteIfBetter(
  id: string,
  existing: ScoreDoc | null,
  input: { timeMs: number; code: string; clearedAt: number },
  identity: Record<string, unknown>,
): Promise<{ score: number; timeMs: number; clearedAt: number } | null> {
  // 重玩变差就不覆盖（榜单只留最好的一次）
  if (existing && typeof existing.timeMs === 'number' && existing.timeMs > 0 && existing.timeMs <= input.timeMs) {
    return {
      score: typeof existing.score === 'number' ? existing.score : 0,
      timeMs: existing.timeMs,
      clearedAt: typeof existing.clearedAt === 'number' ? existing.clearedAt : 0,
    }
  }

  const score = scoreFromTimeMs(input.timeMs)
  await db.collection(C.scores).doc(id).set({
    data: {
      ...identity,
      score,
      timeMs: input.timeMs,
      roomCode: input.code || '',
      scoreRuleVersion: SCORE_RULE_VERSION,
      clearedAt: input.clearedAt,
      updatedAt: now(),
    },
  })
  return { score, timeMs: input.timeMs, clearedAt: input.clearedAt }
}

/** 一次结算的产物，供 submit 的两个通关分支复用 */
interface Settlement {
  bestTimeMs: number
  score: number | null
  rank: number | null
  isNewBest: boolean
  /** 本局已被另一端结算过，这次只做了幂等返回 */
  duplicate: boolean
}

/**
 * 通关结算的唯一入口：超时校验 → 抢首结算权 → 落 cleared → 清存档 → 写榜单/搭档档案。
 *
 * 顺序不能换：先抢首结算权再落库，否则两端同时提交会双写；
 * 先落 score 再算 rank，否则名次会少算自己这一条。
 */
async function settleClear(input: {
  params: any
  ctx: ApiContext
  level: LevelDoc
  levelId: string
  elapsedMs: number
  submitterAttempts: number
  previousBestMs: number
}): Promise<Settlement> {
  const { params, ctx, level, levelId, elapsedMs } = input
  const target = await settleTarget(params, ctx, levelId)
  const mode: 'solo' | 'duo' = target.room ? 'duo' : 'solo'

  assertWithinTimeLimit(level, levelId, elapsedMs)

  // 本局已被另一端结算过：只做幂等返回，什么都不写（T9）
  if (!(await claimRun(target.room))) {
    return {
      bestTimeMs: input.previousBestMs || 0,
      score: null,
      rank: null,
      isNewBest: false,
      duplicate: true,
    }
  }

  const bestTimeMs = await saveClearedForPlayers(
    target.openids,
    levelId,
    elapsedMs,
    ctx.openid,
    input.submitterAttempts,
  )
  // 通关了，这一局的存档就没用了 —— 清掉，免得下次组队还提示「继续上次的进度」
  await clearSaveForRoom(params.code, levelId)

  const clearedAt = now()

  // 榜单与搭档档案都是「附带产物」：失败只记日志，绝不能把通关本身搞挂。
  // 玩家已经通关了，不该因为排行榜写不进去就报错重来。
  let score: number | null = null
  let rank: number | null = null
  try {
    if (mode === 'duo') {
      // 双人：**一队一条**，两人共用同一条记录，所以这里只写一次。
      // 结算页两个人看到的名次自然一致（本来就是同一队）。
      const written = await writeDuoScore({
        openids: target.openids,
        levelId,
        timeMs: elapsedMs,
        code: target.code,
        clearedAt,
      })
      score = written ? written.score : null
      if (written) {
        // 按**库里那条成绩**算名次：重玩变差时库里留的是旧的好成绩，名次不该跟着掉
        rank = await rankOf(levelId, 'duo', written.timeMs, written.clearedAt)
      }
      await recordDuoClear({ openids: target.openids, levelId, timeMs: elapsedMs, score: score || 0, clearedAt })
    } else {
      const written = await writeSoloScore({
        openid: ctx.openid,
        levelId,
        timeMs: elapsedMs,
        code: target.code,
        clearedAt,
      })
      score = written ? written.score : null
      if (written) {
        rank = await rankOf(levelId, 'solo', written.timeMs, written.clearedAt)
      }
    }
  } catch (error) {
    console.error('[level] 榜单/搭档档案写入失败：', error)
  }

  const isNewBest = elapsedMs > 0 && (input.previousBestMs <= 0 || input.previousBestMs > elapsedMs)

  return { bestTimeMs, score, rank, isNewBest, duplicate: false }
}

async function saveClearedForPlayers(
  openids: string[],
  levelId: string,
  elapsedMs: number,
  submitterOpenid: string,
  submitterAttempts: number,
): Promise<number> {
  let submitterBest = elapsedMs
  await Promise.all(openids.map(async (openid) => {
    const pid = progressId(openid, levelId)
    const old: any = await getDoc(C.progress, pid)
    const bestTimeMs = pickBestTime(old?.bestTimeMs || 0, elapsedMs)
    const attempts = openid === submitterOpenid ? submitterAttempts : old?.attempts || 0
    const clearedAt = old?.clearedAt || now()
    await db.collection(C.progress).doc(pid).set({
      data: {
        openid,
        levelId,
        status: 'cleared',
        bestTimeMs,
        attempts,
        clearedAt,
        updatedAt: now(),
      },
    })
    if (openid === submitterOpenid) submitterBest = bestTimeMs
  }))
  return submitterBest
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
    const settled = await settleClear({
      params,
      ctx,
      level,
      levelId,
      elapsedMs,
      submitterAttempts: progress.attempts || 0,
      previousBestMs: progress.bestTimeMs || 0,
    })
    return {
      correct: true,
      failed: false,
      remainAttempts: null, // 没有容错次数的概念
      bestTimeMs: settled.bestTimeMs,
      unlocks: level.unlocks || [],
      // 结算页「本关第 N 名」用这三个字段；没上榜 / 没报用时为 null
      score: settled.score,
      rank: settled.rank,
      isNewBest: settled.isNewBest,
      ...(settled.duplicate ? { duplicate: true } : {}),
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
    const settled = await settleClear({
      params,
      ctx,
      level,
      levelId,
      elapsedMs,
      submitterAttempts: attempts,
      previousBestMs: progress.bestTimeMs || 0,
    })
    return {
      correct: true,
      remainAttempts: maxAttempts - attempts,
      failed: false,
      bestTimeMs: settled.bestTimeMs,
      unlocks: level.unlocks || [],
      score: settled.score,
      rank: settled.rank,
      isNewBest: settled.isNewBest,
      ...(settled.duplicate ? { duplicate: true } : {}),
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
