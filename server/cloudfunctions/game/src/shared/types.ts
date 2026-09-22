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
 * levels 文档（关卡私密数据，绝不能整份下发）。
 * clue 的键是 nodeId，值就是客户端配置里 hotspot.text 的内容。
 */
export interface LevelDoc {
  _id: string
  levelId: string
  views: {
    A: { clues: Record<string, string> }
    B: { clues: Record<string, string> }
  }
  puzzle: {
    type: string
    submitNodeId: string
    /** 标准答案，按顺序严格比对。这个字段永远不会出现在任何接口的返回里。 */
    answer: string[]
    requiredItems?: string[]
    maxAttempts?: number
  }
}
