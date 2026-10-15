/**
 * 双人关卡的同步：把本地操作广播给房间，再把对面视角的操作拉回来应用。
 *
 * **为什么是轮询而不是数据库 watch**：见 C 的 `server/README.md` —— watch 受
 * 集合权限、连接数、切后台断连影响，出问题还难排查；轮询和断线重连共用同一套
 * `sinceSeq`，代码只有一份。点击解谜对延迟不敏感，1 秒完全够。
 *
 * **失败一律只记日志、绝不拦玩家**：离线、没 init、云函数挂了，一个人也得能把
 * 关卡玩完（只是对面看不到）。
 *
 * ## 为什么要有「本轮」这个概念
 *
 * 房间的 `events` 是一根**跨关卡、永不清理**的流水。如果进关卡就从 seq=0 拉，
 * 已经把上一关（甚至上一局同一关）的 `result` 重放一遍 —— 症状就是
 * **「一进新关就立刻通关、弹出结算页」**（2026-10-10 实测踩到的）。
 *
 * 所以每个客户端进关卡时广播一条 `start`、离开时广播一条 `close`，
 * 再用一个探测把「本轮从哪条开始」算出来：
 *
 * - **本轮** = 从最近一次「结束标记」（`result` 或 `close`）之后的第一条 `start` 算起
 * - 只回放**本轮 + 当前关卡**的事件，别的整段跳过
 *
 * 两个客户端各自算，规则一样、日志一样 → 算出来的 `sinceSeq` 也一样，
 * 不需要谁去当「主持人」。
 *
 * 本文件**不 import 'cc'**，所以能在 Node 里直接单测（云接口塞个假 invoker 就行）。
 */

import type { CloudApi, RoomEvent } from '../common/CloudApi';
import type { LevelSyncEvent } from './LevelRuntime';

/** pull 的间隔（秒）。C 建议 1 秒 —— 点击解谜不需要更细 */
const PULL_INTERVAL_SEC = 1;

/**
 * 一次 pull 最多几条。**必须和服务端的 PULL_LIMIT 一致** ——
 * 拉满一页就说明后面可能还有，要接着拉。对不上会导致事件被跳过。
 */
const PULL_PAGE_SIZE = 200;

/** 同步用的控制事件（不是关卡操作，不会被 applyRemote 处理） */
const START = 'start';
const CLOSE = 'close';

/**
 * 探测失败后隔多久再试（秒）。
 *
 * **为什么要重试**：原来的写法是「探测失败就整局不同步」—— 理由是宁可不同步、
 * 也不能把上一轮的事件回放进来。但代价太大：进关卡那一下云函数抖一下
 * （实测过 `-404012 polling exceed max timeout`，一次要 47 秒才认输），
 * 那一局你就**再也收不到对面任何东西**，症状是「对方通关了、我还卡在关卡里」。
 *
 * 稍后探测成功是**安全**的：`sinceSeq` 会被设成「本轮的开头」而不是「现在」，
 * 漏掉的事件补着回放一遍；自己做过的那几条靠 `consumed` 挡掉，不会重复。
 */
const PROBE_RETRY_SEC = 3;

/** 最多重试几次。试完还不行就真的不同步了 —— 不能对着一个挂掉的云一直打 */
const MAX_PROBE_ATTEMPTS = 12;

/**
 * 广播失败后重试几次、每次隔多久（毫秒，第 n 次等 n × 这个数）。
 *
 * **一次失败就放弃的话，这条操作就永久没了** —— 接收侧的 `pull` 会自愈
 * （游标不前进、下次重拉），但**发送侧没有第二次机会**。症状很典型：
 * 「我这边明明做了，对面说没做」—— 比如第 2 关 B 拼好拼图、A 那边还喊没拼好；
 * 或者一方通关了、对面一直不结算（丢的是那条 `result`）。
 *
 * 实测根因是云函数不稳（`-404012` 那种超时），但客户端不该把一次抖动
 * 放大成「这条操作丢了」。
 */
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 500;

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 网络上的 payload 是 unknown 的，先验形状再交给运行时。
 *
 * **认不出来的 type 直接丢**（返回 null）：对面可能是新版本、带了本地还不认识
 * 的事件类型，那种情况应该安静跳过，而不是把一整局搞崩。
 */
export function toSyncEvent(event: RoomEvent): LevelSyncEvent | null {
  const payload = event.payload ?? {};
  switch (event.type) {
    case 'pickup': {
      const nodeId = asString(payload.nodeId);
      const itemIds = asStringArray(payload.itemIds);
      return nodeId && itemIds && itemIds.length > 0 ? { type: 'pickup', nodeId, itemIds } : null;
    }
    case 'use': {
      const nodeId = asString(payload.nodeId);
      const consumed = asStringArray(payload.consumed);
      const produced = asStringArray(payload.produced);
      return nodeId && consumed && produced ? { type: 'use', nodeId, consumed, produced } : null;
    }
    case 'reveal': {
      const nodeId = asString(payload.nodeId);
      return nodeId ? { type: 'reveal', nodeId } : null;
    }
    case 'scene': {
      const viewId = payload.viewId === 'A' || payload.viewId === 'B' ? payload.viewId : null;
      const sceneId = asString(payload.sceneId);
      return viewId && sceneId ? { type: 'scene', viewId, sceneId } : null;
    }
    case 'result': {
      if (payload.status !== 'success') return null;
      const elapsedSec = asNonNegativeNumber(payload.elapsedSec);
      return elapsedSec === undefined
        ? { type: 'result', status: 'success' }
        : { type: 'result', status: 'success', elapsedSec };
    }
    default:
      return null;
  }
}

/**
 * 算「本轮从哪条事件开始」。
 *
 * 从我的 `start` 往前扫：先退到本轮最早的 `start`，碰到 `result` / `close`
 * （上一轮的结束标记）就停。别的关卡的事件直接跳过。
 *
 * 两个客户端算出来的是同一个值 —— 规则只依赖日志内容，不依赖谁先谁后。
 */
export function currentRunStartSeq(
  events: RoomEvent[],
  levelId: string,
  myStartSeq: number,
): number {
  let candidate = myStartSeq;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.seq > myStartSeq) continue;
    if (event.payload?.levelId !== levelId) continue;
    if (event.type === 'result' || event.type === CLOSE) break;
    if (event.type === START) candidate = event.seq;
  }
  return candidate;
}

export class LevelSync {
  /** 已经回放到哪一条。断线重连后接着用它，中间的事件不会丢 */
  private sinceSeq = 0;
  /** 距离上次 pull 攒了多少秒 */
  private accumulatedSec = 0;
  private inFlight = false;
  private stopped = false;
  /** 探测完之前不拉、不回放 —— 不然会把上一轮的 result 当成自己的 */
  private ready = false;
  /** 正在探测中。`begin()` 现在会被 tick 反复调，得挡住重入 */
  private probing = false;
  /** 探测试过几次、还要等几秒才能再试（失败后自愈用，见 PROBE_RETRY_SEC） */
  private probeAttempts = 0;
  private probeCooldownSec = 0;

  constructor(
    private readonly cloud: CloudApi,
    private readonly roomCode: string,
    private readonly levelId: string,
    private readonly onRemote: (event: LevelSyncEvent) => void,
    private readonly onWarn: (message: string, error: unknown) => void = () => {},
  ) {}

  /**
   * 进关卡时调一次：广播 `start`，再把「本轮从哪条开始」探测出来。
   *
   * 探测就是老老实实把房间流水拉一遍（只读、不回放）。一次进关卡拉一遍，
   * 量很小；换来的是「不会重放上一轮的 result」。
   */
  async begin(): Promise<void> {
    if (this.stopped || this.probing) return;
    this.probing = true;
    this.probeAttempts += 1;
    try {
      // 先把自己的 start 发出去 —— 探测要能看到它，才知道「我在这条流水里站哪个位置」
      const mine = await this.cloud.publish({
        code: this.roomCode,
        type: START,
        levelId: this.levelId,
        payload: { levelId: this.levelId },
      });

      const all = await this.pullAll();
      this.sinceSeq = currentRunStartSeq(all, this.levelId, mine.seq);
      this.ready = true;
    } catch (error) {
      // 探测失败：**先不同步**（不置 ready）—— 此刻还没有可信的 sinceSeq，
      // 直接拉就可能是从 0 拉，把上一轮的 result 当自己的。
      // 但**不是就此放弃**：tick 会隔 PROBE_RETRY_SEC 秒再探一次（见那里的注释）
      this.probeCooldownSec = PROBE_RETRY_SEC;
      const last = this.probeAttempts >= MAX_PROBE_ATTEMPTS;
      this.onWarn(
        last
          ? `[LevelSync] 同步探测连续失败 ${this.probeAttempts} 次，本次不做双人同步`
          : `[LevelSync] 同步探测失败，${PROBE_RETRY_SEC} 秒后重试（第 ${this.probeAttempts} 次）`,
        error,
      );
    } finally {
      this.probing = false;
    }
  }

  /** 本地发生了一次操作 → 广播出去（失败会自动重试，见 SEND_ATTEMPTS） */
  send(event: LevelSyncEvent): void {
    if (this.stopped) return;
    const { type, ...payload } = event;
    void this.sendWithRetry(type, payload);
  }

  /**
   * 广播 + 重试。**注意这里不检查 `stopped`** —— 通关那条 `result` 正好是
   * 「广播完关卡马上就被拆掉」的场景（`handoffDelaySec` 是 0 的关卡甚至当帧就拆），
   * 拆掉时 `stop()` 会把 `stopped` 置真；要是重试也认这个旗标，那条 `result`
   * 就再也没机会送出去了。代价只是拆关卡后最多再打两次云调用，可以接受。
   */
  private async sendWithRetry(type: string, payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        await this.cloud.publish({
          code: this.roomCode,
          type,
          // 两处都要带：服务端字段（按关过滤/清理用）+ payload 里那份（对面回放读的是它）
          levelId: this.levelId,
          payload: { ...payload, levelId: this.levelId },
        });
        return;
      } catch (error) {
        if (attempt >= SEND_ATTEMPTS) {
          this.onWarn(
            `[LevelSync] 广播 ${type} 连续失败 ${SEND_ATTEMPTS} 次，这条操作对面收不到了（不影响本地游玩）`,
            error,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_MS * attempt));
      }
    }
  }

  /** 适配层每帧调它。探测没过就先重试探测，过了才攒间隔去拉 */
  tick(deltaSec: number): void {
    if (this.stopped || this.inFlight || !(deltaSec > 0)) return;

    // 还没探到「本轮从哪条开始」→ 隔几秒重试，**而不是整局不同步**。
    // 见 PROBE_RETRY_SEC 的注释：一次云抖动不该让这一局彻底收不到对面
    if (!this.ready) {
      if (this.probing || this.probeAttempts >= MAX_PROBE_ATTEMPTS) return;
      this.probeCooldownSec -= deltaSec;
      if (this.probeCooldownSec > 0) return;
      void this.begin();
      return;
    }

    this.accumulatedSec += deltaSec;
    if (this.accumulatedSec < PULL_INTERVAL_SEC) return;
    this.accumulatedSec = 0;
    void this.pull();
  }

  /** 拆关卡 / 通关后调。广播一条 `close` 给这一轮封口，然后不再发也不再拉 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.ready) return;
    this.cloud
      .publish({
        code: this.roomCode,
        type: CLOSE,
        levelId: this.levelId,
        payload: { levelId: this.levelId },
      })
      .catch((error) => this.onWarn('[LevelSync] 结束标记广播失败', error));
  }

  /** 把房间流水整段拉一遍（分页拉完），只读不改状态 */
  private async pullAll(): Promise<RoomEvent[]> {
    const all: RoomEvent[] = [];
    let cursor = 0;
    let more = true;
    while (more) {
      const page = await this.cloud.pull({ code: this.roomCode, sinceSeq: cursor });
      const events = page.events ?? [];
      for (const event of events) all.push(event);
      if (events.length > 0) cursor = page.lastSeq;
      more = events.length >= PULL_PAGE_SIZE && cursor > 0;
    }
    return all;
  }

  /**
   * 拉增量。`inFlight` 挡住重入：云函数慢的时候每帧都会进 tick，不挡就会并发发一堆请求。
   */
  private async pull(): Promise<void> {
    this.inFlight = true;
    try {
      let more = true;
      while (more && !this.stopped) {
        const page = await this.cloud.pull({ code: this.roomCode, sinceSeq: this.sinceSeq });
        const events = page.events ?? [];
        // 服务端按 seq 升序给，这里也按序回放 —— 顺序反了会先看到「没道具」再看到「拿到道具」
        for (const raw of events) {
          this.sinceSeq = Math.max(this.sinceSeq, raw.seq);
          // 控制事件不交给关卡；别的关卡的事件跳过（房间可能已经换关了）
          if (raw.type === START || raw.type === CLOSE) continue;
          if (raw.payload?.levelId !== this.levelId) continue;
          const event = toSyncEvent(raw);
          if (event) this.onRemote(event);
        }
        more = events.length >= PULL_PAGE_SIZE;
      }
    } catch (error) {
      this.onWarn('[LevelSync] 拉取失败（不影响本地游玩）', error);
    } finally {
      this.inFlight = false;
    }
  }
}
