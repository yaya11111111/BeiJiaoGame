/**
 * 云函数调用的封装。
 *
 * **平台无关**：真正调 `wx.cloud.callFunction` 的那一步是**注入**进来的
 * （见 `CloudInvoker.ts`），所以本文件既不 import cc、也不碰 wx —— 能在 Node 里
 * 直接跑单测，不用开编辑器、也不用真连上云环境。
 *
 * 和 C 的契约见 `server/API.md`。字段名改之前先改那边。
 */

/** 成功信封 */
export interface CloudOk<T> {
  ok: true;
  data: T;
}

/** 失败信封。**业务失败也是这个形状，不会抛异常** —— 所以一定要判 ok */
export interface CloudFail {
  ok: false;
  code: number;
  message: string;
}

export type CloudEnvelope<T> = CloudOk<T> | CloudFail;

/** 错误码。与 `server/API.md` 第 2 节一致，改一边必须改另一边 */
export const CLOUD_CODE = {
  UNAUTHORIZED: 1001,
  ROOM_NOT_FOUND: 2001,
  ROOM_FULL: 2002,
  ROOM_CLOSED: 2003,
  NOT_IN_ROOM: 2004,
  PARAM_INVALID: 3001,
  LEVEL_NOT_FOUND: 4001,
  /** 提交时背包里缺少关卡要求的道具。**不消耗容错次数** */
  MISSING_ITEM: 4002,
  INTERNAL: 5000,
} as const;

/**
 * 业务失败。调用方**按 code 分支，别拿 message 字符串比** ——
 * message 是给玩家看的，改文案不该让逻辑失效。
 */
export class CloudError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`[云函数 ${code}] ${message}`);
    this.name = 'CloudError';
    this.code = code;
  }
}

/** 一次平台调用：把 action + params 发出去，拿回信封。由适配层注入 */
export type CloudInvoker = (
  action: string,
  params: Record<string, unknown>,
) => Promise<CloudEnvelope<unknown>>;

// ---------------------------------------------------------------- 契约类型

export type PlayModeArg = 'solo' | 'duo';

/** 答案的形状与客户端配置一致：数组 = 有序，对象 = 按键 */
export type CloudAnswer = string[] | Record<string, string>;

export interface GetViewParams {
  levelId: string;
  mode: PlayModeArg;
  /** duo 模式必传：房间码 */
  code?: string;
}

export interface GetViewResult {
  levelId: string;
  /** nodeId → 线索正文。duo 模式只有一个键 */
  views: Record<string, { clues: Record<string, string> }>;
  /**
   * 答题通关的关有；**操作通关的关是 null**（客户端走 completes 热点那条路）。
   * 不下发 answer —— 这是信息差玩法的口径，别指望在这儿拿到标准答案。
   */
  puzzle: {
    type: string;
    submitNodeId: string;
    maxAttempts: number;
    hasRequiredItems: boolean;
  } | null;
}

export interface SubmitParams {
  levelId: string;
  /** 答题通关的关必传；操作通关的关不传 */
  answer?: CloudAnswer;
  /** 关卡配了 requiredItems 时必传 —— 服务端拿不到背包，只能信客户端上报 */
  inventory?: string[];
  /** 本局用时（毫秒）。**不传或 ≤0 视为未提供，不影响最好成绩** */
  elapsedMs?: number;
  code?: string;
}

export interface SubmitResult {
  correct: boolean;
  failed: boolean;
  /** 操作通关的关固定为 null（没有容错次数的概念） */
  remainAttempts: number | null;
  bestTimeMs?: number;
  /** 通关时返回本关解锁的地图节点 id 列表 */
  unlocks?: string[];
}

export interface LevelEntry {
  levelId: string;
  chapterId: string;
  title: string;
  unlocks: string[];
  hasPuzzle: boolean;
  /** none = 还没碰过 */
  status: 'none' | 'unlocked' | 'cleared';
  bestTimeMs: number;
  clearedAt: number;
}

export interface AuthLoginResult {
  nickname: string;
  avatarUrl?: string;
  currentLevelId: string;
  isNewUser: boolean;
}

export interface AuthProfileResult {
  nickname: string;
  avatarUrl?: string;
  currentLevelId: string;
  clearedCount: number;
  totalTimeMs: number;
}

export interface RoomPlayerSnapshot {
  nickname: string;
  viewId: 'A' | 'B';
  online: boolean;
}

export interface RoomSnapshot {
  code: string;
  levelId: string;
  status: 'waiting' | 'playing' | 'closed';
  myViewId: 'A' | 'B' | null;
  isHost: boolean;
  playableLevelIds: string[];
  players: RoomPlayerSnapshot[];
}

export interface RoomCreateResult extends RoomSnapshot {
  myViewId: 'A';
  status: 'waiting';
  isHost: true;
}

export interface ProgressEntry {
  levelId: string;
  status: 'unlocked' | 'cleared';
  bestTimeMs: number;
  attempts: number;
  clearedAt: number;
}

export type ReportType = 'level:enter' | 'level:exit' | 'level:finish';

/**
 * 房间里的一条同步事件（服务端 `events` 集合里的一条）。
 *
 * `seq` 是**房间内全序**，由服务端分配 —— 客户端按 seq 升序回放，就不会
 * 因为网络乱序把操作的应用顺序搞反。
 */
export interface RoomEvent {
  seq: number;
  /** 关卡自定义：pickup / use / reveal / scene / result … */
  type: string;
  /** 谁发的（openid）。客户端不靠它去重，靠「应用是幂等的」 */
  senderId: string;
  ts: number;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------- 封装本体

/**
 * 云接口的封装。E 也可以直接用它调 auth / room 那些 —— `call` 是通用的，
 * 下面那几个只是 D 用到的、带类型的快捷方法。
 */
export class CloudApi {
  constructor(private readonly invoke: CloudInvoker) {}

  /**
   * 通用入口：调一个 action，成功返回 data，失败抛 CloudError。
   *
   * 用抛异常而不是返回信封，是因为调用方绝大多数情况下只关心"成功的那条路"，
   * 每次判 ok 会把正常逻辑淹掉。需要按 code 分支的地方 catch 住判 `err.code`。
   */
  async call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const envelope = await this.invoke(action, params);

    // 信封本身不是合法形状（比如网关返回了别的东西）—— 当成服务端错误
    if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      throw new CloudError(CLOUD_CODE.INTERNAL, '云函数返回了意外的形状');
    }

    if (envelope.ok) return envelope.data as T;
    throw new CloudError(envelope.code, envelope.message);
  }

  /** 按身份下发当前视角的线索。（本地配置里也有线索，那是离线/开发期用的） */
  getView(params: GetViewParams): Promise<GetViewResult> {
    return this.call<GetViewResult>('level.getView', { ...params });
  }

  /**
   * 提交答案 / 上报通关。
   *
   * **答错不是异常** —— 它返回 `{correct:false}`，不是 `ok:false`。
   * 只有参数错、道具没凑齐（4002）、关卡缺失（4001）之类才抛。
   */
  submit(params: SubmitParams): Promise<SubmitResult> {
    return this.call<SubmitResult>('level.submit', { ...params });
  }

  /** 埋点：关卡进入 / 退出 / 完成。供后台统计 */
  report(type: ReportType, levelId: string, extra?: Record<string, unknown>): Promise<{ logged: boolean }> {
    return this.call<{ logged: boolean }>('event.report', { type, levelId, extra });
  }

  /**
   * 把一次操作广播给房间里**另一个视角**（双人关卡的同步）。
   *
   * 服务端给每条事件分配一个全序 `seq`，客户端拿 `pull` 按 seq 回放。
   * 类型由关卡自己定（`pickup` / `use` / `reveal` / `scene` / `result`），
   * 服务端只当它是 `{ type, payload }` 原样存和转发。
   */
  publish(params: { code: string; type: string; payload?: Record<string, unknown> }): Promise<{ seq: number; ts: number }> {
    return this.call<{ seq: number; ts: number }>('event.publish', { ...params });
  }

  /**
   * 增量拉取房间事件。`sinceSeq` 传上次拿到的**最大** seq，只返回比它大的。
   *
   * 断线重连后用同一个 `sinceSeq` 接着拉，中间的事件一条都不会丢。
   * 返回的 `lastSeq` 是**本页最后一条**的 seq（不是房间全局值）——
   * 一次最多 200 条，条数打满时用它当新的 `sinceSeq` 再拉一次。
   */
  pull(params: { code: string; sinceSeq: number }): Promise<{ events: RoomEvent[]; lastSeq: number }> {
    return this.call<{ events: RoomEvent[]; lastSeq: number }>('event.pull', { ...params });
  }

  /** 关卡目录 + 我的进度。E 的地图页用 */
  list(): Promise<{ list: LevelEntry[] }> {
    return this.call<{ list: LevelEntry[] }>('level.list');
  }

  login(): Promise<AuthLoginResult> {
    return this.call<AuthLoginResult>('auth.login');
  }

  profile(): Promise<AuthProfileResult> {
    return this.call<AuthProfileResult>('auth.profile');
  }

  updateProfile(nickname: string, avatarUrl?: string): Promise<{ nickname: string; avatarUrl?: string }> {
    return this.call<{ nickname: string; avatarUrl?: string }>('auth.updateProfile', { nickname, avatarUrl });
  }

  createRoom(levelId: string): Promise<RoomCreateResult> {
    return this.call<RoomCreateResult>('room.create', { levelId });
  }

  joinRoom(code: string): Promise<RoomSnapshot> {
    return this.call<RoomSnapshot>('room.join', { code });
  }

  leaveRoom(code: string): Promise<{ left: boolean }> {
    return this.call<{ left: boolean }>('room.leave', { code });
  }

  getRoomState(code: string): Promise<RoomSnapshot> {
    return this.call<RoomSnapshot>('room.state', { code });
  }

  setRoomLevel(code: string, levelId: string): Promise<RoomSnapshot> {
    return this.call<RoomSnapshot>('room.setLevel', { code, levelId });
  }

  heartbeatRoom(code: string): Promise<{ online: boolean }> {
    return this.call<{ online: boolean }>('room.heartbeat', { code });
  }

  getProgress(levelId?: string): Promise<{ list: ProgressEntry[] }> {
    return this.call<{ list: ProgressEntry[] }>('progress.get', levelId ? { levelId } : {});
  }
}
