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
  players: RoomPlayer[]
  /** 房间内事件序号，只由服务端自增，客户端只读 */
  lastSeq: number
  createdAt: number
  updatedAt: number
}

/** events 文档。只追加，永不修改、不删除。 */
export interface EventDoc {
  roomId: string
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
}
