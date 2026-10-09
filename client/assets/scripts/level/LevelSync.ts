/**
 * 双人关卡的同步：把本地操作广播给房间，再把对面视角的操作拉回来应用。
 *
 * **为什么是轮询而不是数据库 watch**：见 C 的 `server/README.md` —— watch 受
 * 集合权限、连接数、切后台断连影响，出问题还难排查；轮询和断线重连共用同一套
 * `sinceSeq`，代码只有一份。点击解谜对延迟不敏感，1 秒完全够。
 *
 * **失败一律只记日志、绝不拦玩家**：离线、没 init、云函数挂了，一个人也得能把
 * 关卡玩完（只是对面看不到）。和 CloudApi 里「提交失败不影响本地通关」同一个口径。
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

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
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
    case 'result':
      return payload.status === 'success' ? { type: 'result', status: 'success' } : null;
    default:
      return null;
  }
}

export class LevelSync {
  /** 已经回放到哪一条。断线重连后接着用它，中间的事件不会丢 */
  private sinceSeq = 0;
  /** 距离上次 pull 攒了多少秒 */
  private accumulatedSec = 0;
  private inFlight = false;
  private stopped = false;

  constructor(
    private readonly cloud: CloudApi,
    private readonly roomCode: string,
    private readonly onRemote: (event: LevelSyncEvent) => void,
    private readonly onWarn: (message: string, error: unknown) => void = () => {},
  ) {}

  /** 本地发生了一次操作 → 广播出去 */
  send(event: LevelSyncEvent): void {
    if (this.stopped) return;
    const { type, ...payload } = event;
    this.cloud
      .publish({ code: this.roomCode, type, payload: payload as Record<string, unknown> })
      .catch((error) => this.onWarn('[LevelSync] 广播失败（不影响本地游玩）', error));
  }

  /** 适配层每帧调它。攒够间隔才真去拉一次 */
  tick(deltaSec: number): void {
    if (this.stopped || this.inFlight || !(deltaSec > 0)) return;
    this.accumulatedSec += deltaSec;
    if (this.accumulatedSec < PULL_INTERVAL_SEC) return;
    this.accumulatedSec = 0;
    void this.pull();
  }

  /** 拆关卡 / 退出时调。停掉之后不再发也不再拉 */
  stop(): void {
    this.stopped = true;
  }

  /**
   * 拉一次（必要时接着拉，直到这一页没拉满）。
   *
   * `inFlight` 挡住重入：云函数慢的时候每帧都会进 tick，不挡就会并发发一堆请求。
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
