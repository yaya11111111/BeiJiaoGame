/**
 * 关卡运行时状态机。
 * 只广播事件、不碰 Cocos 节点，渲染交给 LevelView（唯一 import cc 的文件）。
 * 本文件不 import 任何 cc 模块。
 */

import { Emitter, type Unsubscribe } from '../common/Emitter';
import type { LevelConfig, PlayMode, ViewId } from '../common/LevelTypes';
import { buildIndex, type LevelIndex } from '../common/LevelConfig';

export type LevelStatus = 'playing' | 'success' | 'failed';

export type FailureReason = 'attempts-exhausted' | 'timeout';

export interface InventoryItem {
  itemId: string;
  /** 从哪个热点拿到的，用于结算页的线索回顾 */
  fromNodeId: string;
}

/** rect 仍是原图坐标，换算在 LevelView 做 */
export interface HotspotRuntime {
  nodeId: string;
  rect: [number, number, number, number];
  action: 'pickup' | 'inspect' | 'submit';
  enabled: boolean;
  done: boolean;
}

export interface LevelViewModel {
  levelId: string;
  chapterId: string;
  title: string;
  currentView: ViewId;
  canSwitchView: boolean;
  assetKey: string;
  hotspots: HotspotRuntime[];
  inventory: InventoryItem[];
  status: LevelStatus;
  attemptsLeft: number;
  timeLeftSec: number | null;
  hints: string[];
  hintsRemaining: number;
  lastLine: string | null;
}

export type ClickResult =
  | { ok: true; effect: 'picked'; itemId: string }
  | { ok: true; effect: 'inspected'; text: string | null }
  | { ok: true; effect: 'submitted'; correct: boolean }
  | { ok: false; reason: 'unknown-node' | 'not-visible' | 'missing-item' | 'already-done' | 'locked' };

export interface LevelEvents {
  'view:changed': { viewId: ViewId };
  'inventory:changed': { inventory: InventoryItem[] };
  'hotspot:revealed': { nodeId: string; viewId: ViewId };
  'line:shown': { text: string };
  'hint:unlocked': { index: number; text: string };
  'answer:wrong': { attemptsLeft: number };
  'level:success': { progress: string[]; elapsedSec: number };
  'level:failed': { reason: FailureReason; elapsedSec: number };
  /** 任何状态变化后都会发一次，适配层可以直接订阅它做整体重绘 */
  'state:changed': LevelViewModel;
}

export interface LevelRuntimeOptions {
  mode: PlayMode;
  /** duo 模式下由服务端指派，默认 'A' */
  initialView?: ViewId;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class LevelRuntime {
  private readonly config: LevelConfig;
  private readonly index: LevelIndex;
  private readonly mode: PlayMode;
  private readonly emitter = new Emitter<LevelEvents>();

  private readonly initialView: ViewId;
  private currentView: ViewId;

  /** 用数组而不是 Set —— 顺序就是提交答案的顺序 */
  private inventory: InventoryItem[] = [];
  private readonly revealed = new Set<string>();
  private readonly consumed = new Set<string>();

  private status: LevelStatus = 'playing';
  private attempts = 0;
  private elapsedSec = 0;
  private hintsUnlocked = 0;
  private lastLine: string | null = null;

  constructor(config: LevelConfig, options: LevelRuntimeOptions) {
    this.config = config;
    this.index = buildIndex(config);
    this.mode = options.mode;
    this.initialView = options.initialView ?? 'A';
    this.currentView = this.initialView;
  }

  on<K extends keyof LevelEvents>(event: K, listener: (payload: LevelEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  once<K extends keyof LevelEvents>(event: K, listener: (payload: LevelEvents[K]) => void): Unsubscribe {
    return this.emitter.once(event, listener);
  }

  /** 每次返回新对象，外部改了不影响内部 */
  getState(): LevelViewModel {
    return {
      levelId: this.config.levelId,
      chapterId: this.config.chapterId,
      title: this.config.title,
      currentView: this.currentView,
      canSwitchView: this.canSwitchView(),
      assetKey: this.config.views[this.currentView].assetKey,
      hotspots: this.getVisibleHotspots(),
      inventory: this.getInventory(),
      status: this.status,
      attemptsLeft: this.maxAttempts() - this.attempts,
      timeLeftSec: this.timeLeftSec(),
      hints: this.config.hints.slice(0, this.hintsUnlocked),
      hintsRemaining: this.config.hints.length - this.hintsUnlocked,
      lastLine: this.lastLine,
    };
  }

  getStatus(): LevelStatus {
    return this.status;
  }

  getCurrentView(): ViewId {
    return this.currentView;
  }

  getInventory(): InventoryItem[] {
    return this.inventory.map((item) => ({ ...item }));
  }

  /** duo 模式视角由服务端指派，客户端不能切 */
  canSwitchView(): boolean {
    return this.mode === 'solo' && this.config.mode.indexOf('solo') !== -1;
  }

  switchView(viewId: ViewId): boolean {
    if (this.status !== 'playing') return false;
    if (!this.canSwitchView()) return false;
    if (viewId === this.currentView) return false;
    if (!this.config.views[viewId]) return false;

    this.currentView = viewId;
    this.emitter.emit('view:changed', { viewId });
    this.emitState();
    return true;
  }

  /** 玩家在场景里的一切操作都走这里，包括提交 */
  click(nodeId: string): ClickResult {
    if (this.status !== 'playing') return { ok: false, reason: 'locked' };

    const entry = this.index.nodes.get(nodeId);
    if (!entry) return { ok: false, reason: 'unknown-node' };

    const { viewId, hotspot } = entry;

    if (viewId !== this.currentView) return { ok: false, reason: 'not-visible' };
    if (hotspot.hiddenByDefault && !this.revealed.has(nodeId)) return { ok: false, reason: 'not-visible' };
    if (hotspot.requiresItem && !this.hasItem(hotspot.requiresItem)) {
      return { ok: false, reason: 'missing-item' };
    }
    // 只有 pickup 是一次性的 —— 再点会重复入包。
    // inspect 必须允许反复点：双人模式下对面要来回确认线索文字，读一次就锁死
    // 会让关键线索（如第 1 关的施工告示）再也调不出来。submit 用来重试。
    if (hotspot.action === 'pickup' && this.consumed.has(nodeId)) {
      return { ok: false, reason: 'already-done' };
    }

    if (hotspot.action === 'submit') {
      const outcome = this.attemptSubmit();
      // 道具没凑齐时不算「提交了一次」，如实报点不动，
      // 否则渲染层会播一个「答错」的动画，但玩家根本没提交
      if (outcome === 'blocked') return { ok: false, reason: 'missing-item' };
      return { ok: true, effect: 'submitted', correct: outcome === 'success' };
    }

    let effect: ClickResult;

    if (hotspot.action === 'pickup') {
      const itemId = hotspot.itemId!;
      this.inventory.push({ itemId, fromNodeId: nodeId });
      // consumed 只收 pickup，语义是「这个热点的东西已经被拿走了」。
      // inspect 不进这个集合，否则 getVisibleHotspots() 会把它标成 done 且
      // enabled:false，渲染层照样点不动，上层这条放行等于白改。
      this.consumed.add(nodeId);
      effect = { ok: true, effect: 'picked', itemId };
      this.emitter.emit('inventory:changed', { inventory: this.getInventory() });
    } else {
      effect = { ok: true, effect: 'inspected', text: hotspot.text ?? null };
      if (hotspot.text) this.showLine(hotspot.text);
    }

    // inspect 现在可重复点，这里加一道判断：同一个节点只揭示一次，
    // 否则复读线索会让渲染层反复播揭示动画
    if (hotspot.revealsNode && !this.revealed.has(hotspot.revealsNode)) {
      this.revealed.add(hotspot.revealsNode);
      const target = this.index.nodes.get(hotspot.revealsNode);
      if (target) {
        this.emitter.emit('hotspot:revealed', { nodeId: hotspot.revealsNode, viewId: target.viewId });
      }
    }

    this.emitState();
    return effect;
  }

  /**
   * 提交答案。不传参数时用背包里的道具顺序作为答案。
   * 判定失败时不把正确答案下发到客户端，只回原因，符合「服务端只下发当前视角所需的线索」。
   */
  submit(answer?: string[]): boolean {
    return this.attemptSubmit(answer) === 'success';
  }

  private attemptSubmit(answer?: string[]): 'success' | 'wrong' | 'blocked' {
    if (this.status !== 'playing') return 'blocked';

    for (const item of this.config.puzzle.requiredItems ?? []) {
      if (!this.hasItem(item)) {
        this.showLine('还差点东西，再找找。');
        this.emitState();
        return 'blocked';
      }
    }

    const candidate = answer ?? this.inventory.map((item) => item.itemId);
    const expected = this.config.puzzle.answer;
    const correct = candidate.length === expected.length && candidate.every((v, i) => v === expected[i]);

    if (correct) {
      this.status = 'success';
      this.emitter.emit('level:success', {
        progress: [...this.config.rewards.progress],
        elapsedSec: this.elapsedSec,
      });
      this.emitState();
      return 'success';
    }

    this.attempts += 1;
    const attemptsLeft = this.maxAttempts() - this.attempts;

    if (attemptsLeft <= 0) {
      this.status = 'failed';
      this.emitter.emit('level:failed', { reason: 'attempts-exhausted', elapsedSec: this.elapsedSec });
    } else {
      this.emitter.emit('answer:wrong', { attemptsLeft });
      this.showLine(`不对，再想想。（还剩 ${attemptsLeft} 次）`);
    }

    this.emitState();
    return 'wrong';
  }

  /**
   * 由适配层在 update(dt) 里调用。核心不起定时器，否则单测要等真实时间。
   *
   * 两点注意：
   * 1. 不限时关卡（引导关）也要累计用时 —— 结算页的用时回顾和后台统计的
   *    用时都取自这里（FR-12），早退会让不限时关卡的用时恒为 0。
   * 2. 广播只在「倒计时显示的秒数」变化时发生。state:changed 的语义是
   *    「整屏可以重绘了」，每帧发一次会让适配层每帧重建热点数组和 UI。
   */
  tick(deltaSec: number): void {
    if (this.status !== 'playing') return;
    if (!(deltaSec > 0)) return;

    const timeLeftBefore = this.timeLeftSec();
    this.elapsedSec += deltaSec;

    const limit = this.config.timeLimitSec;
    if (limit === undefined) return; // 不限时：只累计用时，没有秒数变化可广播

    if (this.elapsedSec >= limit) {
      this.elapsedSec = limit;
      this.status = 'failed';
      this.emitter.emit('level:failed', { reason: 'timeout', elapsedSec: this.elapsedSec });
      this.emitState();
      return;
    }

    if (this.timeLeftSec() !== timeLeftBefore) this.emitState();
  }

  requestHint(): string | null {
    if (this.status !== 'playing') return null;
    if (this.hintsUnlocked >= this.config.hints.length) return null;

    const index = this.hintsUnlocked;
    const text = this.config.hints[index];
    this.hintsUnlocked += 1;

    this.emitter.emit('hint:unlocked', { index, text });
    this.emitState();
    return text;
  }

  reset(): void {
    this.inventory = [];
    this.revealed.clear();
    this.consumed.clear();
    this.status = 'playing';
    this.attempts = 0;
    this.elapsedSec = 0;
    this.hintsUnlocked = 0;
    this.lastLine = null;
    this.currentView = this.initialView;
    this.emitState();
  }

  /** 结算页的线索回顾，只含道具和用时，不含答案 */
  getReview(): { levelId: string; title: string; status: LevelStatus; elapsedSec: number; items: InventoryItem[] } {
    return {
      levelId: this.config.levelId,
      title: this.config.title,
      status: this.status,
      elapsedSec: this.elapsedSec,
      items: this.getInventory(),
    };
  }

  private maxAttempts(): number {
    return this.config.puzzle.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private timeLeftSec(): number | null {
    if (this.config.timeLimitSec === undefined) return null;
    return Math.max(0, Math.ceil(this.config.timeLimitSec - this.elapsedSec));
  }

  private hasItem(itemId: string): boolean {
    return this.inventory.some((item) => item.itemId === itemId);
  }

  private showLine(text: string): void {
    this.lastLine = text;
    this.emitter.emit('line:shown', { text });
  }

  /** 跨视角的线索在这里被过滤掉，客户端拿不到另一视角的物件 */
  private getVisibleHotspots(): HotspotRuntime[] {
    const hotspots: HotspotRuntime[] = [];
    for (const hotspot of this.config.views[this.currentView].hotspots) {
      if (hotspot.hiddenByDefault && !this.revealed.has(hotspot.nodeId)) continue;
      hotspots.push({
        nodeId: hotspot.nodeId,
        rect: [...hotspot.rect] as [number, number, number, number],
        action: hotspot.action,
        enabled:
          !(hotspot.requiresItem && !this.hasItem(hotspot.requiresItem)) &&
          !(hotspot.action !== 'submit' && this.consumed.has(hotspot.nodeId)),
        done: this.consumed.has(hotspot.nodeId),
      });
    }
    return hotspots;
  }

  private emitState(): void {
    this.emitter.emit('state:changed', this.getState());
  }
}
