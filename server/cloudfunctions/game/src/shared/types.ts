/** 一次调用的上下文。目前只有 openid，以后要加 IP、版本号就往这里加。 */
export interface ApiContext {
  openid: string
}

/** rooms 集合里 players 数组的一项 */
export interface RoomPlayer {
  openid: string
  nickname: string
  /** 视角。第一个进房的是 A，第二个是 B */
  viewId: 'A' | 'B'
  online: boolean
  /** 最后一次心跳时间，超过 30 秒视为离线 */
  lastSeenAt: number
}

/** rooms 文档 */
export interface RoomDoc {
  _id: string
  code: string
  levelId: string
  hostOpenid: string
  status: 'waiting' | 'playing' | 'closed'
  /** 房主统一开局的服务端时间戳；0 表示仍在房间准备页。 */
  startedAt?: number
  /**
   * 本局开局瞬间房内两人的 openid 快照（FR-15，2026-11-02 新增）。
   *
   * 为什么不能直接用 `players`：`players` 会在玩家退出时被移除成员。
   * 非房主先退 → `players` 只剩房主 → 房主再退出时，双人存档的 pairKey
   * 就无从得知了（房主离开即关房，房间那时候已经 closed）。
   * 房间关闭后 rooms 文档并不删除，所以这个快照始终可取。
   */
  sessionPlayers?: string[]
  /**
   * 双人可玩交集的缓存（2026-11-13，`room.sync` 用）。
   *
   * 算一次交集要给**每个**玩家各查一遍 progress（最多 100 条），而 `room.sync`
   * 是 1 秒级的高频接口 —— 不缓存的话，省下的调用次数会原封不动从读次数上还回去。
   * 只在这三个字段齐全、`playableCacheKey`（排序后的 openid 串）没变、
   * 且距 `playableCacheAt` 不超过 PLAYABLE_TTL_MS 时复用，否则重算并写回。
   */
  playableCache?: string[]
  playableCacheKey?: string
  playableCacheAt?: number
  /**
   * 本局已经结算过的那一次 `startedAt`（2026-11-19 新增，对应缺陷 T9）。
   *
   * 双人局里两端都可能各上报一次通关，而「一局只结算一次」是必须的：
   * 不拦的话 `clearedAt` 会被后一次刷掉、搭档档案的 playCount 会翻倍、
   * 结算事件也会冒两条。用 startedAt 而不是布尔值，是因为换关/重开都会把
   * startedAt 归零重算，同一个字段自然就区分了「新的一局」。
   */
  clearedRunAt?: number
  players: RoomPlayer[]
  /** 房间内事件序号，只由服务端自增，客户端只读 */
  lastSeq: number
  createdAt: number
  updatedAt: number
}

/** events 文档。只追加，永不修改、不删除。 */
export interface EventDoc {
  roomId: string
  /**
   * 事件所属关卡。2026-10-10 起提升为服务端字段：
   * 之前只是客户端塞在 payload 里的约定，服务端无法按关过滤/清理。
   * 老数据没有这个字段，读出来按空字符串处理。
   */
  levelId: string
  type: string
  senderId: string
  seq: number
  ts: number
  payload: Record<string, any>
}

/** progress 文档。_id 固定是 `${openid}_${levelId}` */
export interface ProgressDoc {
  _id: string
  openid: string
  levelId: string
  status: 'unlocked' | 'cleared'
  bestTimeMs: number
  attempts: number
  clearedAt: number
  updatedAt: number
}

/** users 文档 */
export interface UserDoc {
  _id: string
  openid: string
  nickname: string
  avatarUrl?: string
  currentLevelId: string
  createdAt: number
  lastLoginAt: number
}

/**
 * 标准答案的两种形状（和客户端 LevelConfig 的 PuzzleAnswer 完全对齐）：
 * - 数组 → 有序答案，按顺序严格比对（numberpad 输入）
 * - 对象 → 按键答案，逐空比对（form 表单输入）
 */
export type PuzzleAnswer = string[] | Record<string, string>

/**
 * levels 文档（关卡私密数据，绝不能整份下发）。
 * 由 server/seeds/build-seed.js 从客户端关卡配置自动生成，字段一一对应：
 * - clue 的键是 nodeId，值是客户端配置里 inspect 热点的 text
 * - unlocks 就是客户端配置里的 rewards.progress（通关后解锁的地图节点 id 列表）
 * - 没有 puzzle 的关是「操作通关」（某个 use 热点 completes），服务端不判题，
 *   通关由客户端完成后调 level.submit 上报，服务端采信并落库
 */
export interface LevelDoc {
  _id: string
  levelId: string
  chapterId: string
  title: string
  views: {
    A: { clues: Record<string, string> }
    B: { clues: Record<string, string> }
  }
  /** 答题通关的关才有；操作通关的关没有这个字段 */
  puzzle?: {
    type: string
    submitNodeId: string
    /** 标准答案。这个字段永远不会出现在任何接口的返回里。 */
    answer: PuzzleAnswer
    /** 提交前背包里必须持有的道具，和 answer 相互独立 */
    requiredItems?: string[]
    maxAttempts?: number
  }
  /** 通关后解锁的地图节点 id 列表（= 客户端配置 rewards.progress） */
  unlocks: string[]
  /**
   * 本关倒计时上限（秒），不填 = 不限时。
   *
   * 目前 `levels.seed.json` 里**没有**这个字段（build-seed 没搬客户端的
   * `LevelConfig.timeLimitSec`）。服务端靠 `shared/rules.ts` 的兜底表先顶着，
   * 文档里有值时优先用文档的 —— 以后补了种子就会自动生效，不用再改代码。
   */
  timeLimitSec?: number
}

/**
 * scores 集合：关卡榜单。**一人 · 一关 · 一模式 只有一条**，
 * `_id` 固定拼 `${openid}_${levelId}_${mode}`（见 db.scoreId），重玩更好就覆盖。
 *
 * 注意 `timeMs` 是**这一局**的用时，和 progress.bestTimeMs 不是一回事：
 * 后者服务「我的记录」和关卡列表，两者不要合并。
 */
export interface ScoreDoc {
  _id: string
  openid: string
  levelId: string
  mode: 'solo' | 'duo'
  /** 服务端按 SCORE_RULE_VERSION 算出来的展示分，越高越好 */
  score: number
  /** 本局用时（毫秒）。排名按它升序 */
  timeMs: number
  /** 双人局才有：另一个人的 openid。单人局为空串 */
  partnerOpenid: string
  /** 双人局留痕，便于排查；单人局为空串 */
  roomCode: string
  scoreRuleVersion: number
  clearedAt: number
  updatedAt: number
}

/** partners 集合：双人搭档档案，`_id` = pairKey（两个 openid 升序拼接） */
export interface PartnerDoc {
  _id: string
  /** 给客户端当 key 用，**不含 openid** */
  partnerId: string
  /** 升序的两个 openid */
  openids: string[]
  /** 昵称头像快照，每次一起通关时刷新（对方资料可能改） */
  profiles: Record<string, { nickname: string; avatarUrl: string }>
  /** 共同通关过的关卡，按先后顺序去重 */
  clearedLevels: string[]
  clearedCount: number
  /** 一起结算过的局数。本期只统计「通关」的局，没通关的局不计（见 partner.list 注释） */
  playCount: number
  /** 每关最佳合作记录，只留更好的那一次 */
  bestRecords: Record<string, { timeMs: number; score: number; clearedAt: number }>
  badges: string[]
  firstPlayedAt: number
  lastPlayedAt: number
  updatedAt: number
}
