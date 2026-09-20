/**
 * 关卡运行时状态机 —— D 负责的关卡模块核心。
 *
 * 它回答一个问题：玩家点了一下、切了一次视角、提交了一次，关卡状态该怎么变。
 * 它**不碰任何 Cocos 节点**，只广播事件；渲染交给 LevelView（唯一 import cc 的文件）。
 * 这样好处有两个：
 *   1. 单测可以直接在 Node 里跑，不用打开编辑器；
 *   2. 双人模式里同一份逻辑可以直接复用到服务端做判定校验，客户端改不了答案。
 *
 * 本文件不 import 任何 cc 模块。
 */

import { Emitter, type Unsubscribe } from '../common/Emitter';
import type { LevelConfig, PlayMode, ViewId } from '../common/LevelTypes';
import { buildIndex, type LevelIndex } from '../common/LevelConfig';

/** 关卡进行状态。 */
export type LevelStatus = 'playing' | 'success' | 'failed';

/** 失败原因。注意这里只给「原因」，不给正确答案 —— 答案不下发到客户端。 */
export type FailureReason = 'attempts-exhausted' | 'timeout';

/** 背包里的一件道具。 */
export interface InventoryItem {
  itemId: string;
  /** 从哪个热点拿到的，用于结算页的「关键线索回顾」 */
  fromNodeId: string;
}

/** 渲染层需要的热点数据。rect 仍是原图坐标，换算在 LevelView 做。 */
export interface HotspotRuntime {
  nodeId: string;
  rect: [number, number, number, number];
  action: 'pickup' | 'inspect' | 'submit';
  /** 当前是否可点。requiresItem 没满足、或已点过，就是 false */
  enabled: boolean;
  /** 已经点过（pickup 已拿 / inspect 已看） */
  done: boolean;
}

/** 渲染层读到的完整状态快照。只读，改状态必须走 runtime 的方法。 */
export interface LevelViewModel {
  levelId: string;
  chapterId: string;
  title: string;
  currentView: ViewId;
  /** duo 模式下视角由服务端指派，玩家不能自己切 */
  canSwitchView: boolean;
  assetKey: string;
  hotspots: HotspotRuntime[];
  inventory: InventoryItem[];
  status: LevelStatus;
  /** 剩余容错次数 */
  attemptsLeft: number;
  /** 剩余秒数；不限时则为 null */
  timeLeftSec: number | null;
  /** 已解锁的提示，按解锁顺序 */
  hints: string[];
  /** 还剩几段提示没解锁 */
  hintsRemaining: number;
  /** 最近一次要给玩家看的一句话（inspect 文案 / 道具入包反馈 / 错误提示） */
  lastLine: string | null;
}

/** 点击热点的结果。 */
export type ClickResult =
  | { ok: true; effect: 'picked'; itemId: string }
  | { ok: true; effect: 'inspected'; text: string | null }
  | { ok: true; effect: 'submitted'; correct: boolean }
  | { ok: false; reason: 'unknown-node' | 'not-visible' | 'missing-item' | 'already-done' | 'locked' };

/** 广播出去的事件。渲染层订阅这些，不要轮询。 */
export interface LevelEvents {
  'view:changed': { viewId: ViewId };
  'inventory:changed': { inventory: InventoryItem[] };
  'hotspot:revealed': { nodeId: string; viewId: ViewId };
  'line:shown': { text: string };
  'hint:unlocked': { index: number; text: string };
  /** 答案错了，但还没用完容错次数 */
  'answer:wrong': { attemptsLeft: number };
  'level:success': { progress: string[]; elapsedSec: number };
  'level:failed': { reason: FailureReason; elapsedSec: number };
  /** 任何状态变化后都会发一次，适配层图省事可以直接订阅它做整体重绘 */
  'state:changed': LevelViewModel;
}

export interface LevelRuntimeOptions {
  mode: PlayMode;
  /** 初始视角。duo 模式下由服务端指派，默认 'A' */
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

  /** 背包。用数组而不是 Set —— 顺序就是提交答案的顺序 */
  private inventory: InventoryItem[] = [];
  /** 已被 revealsNode 揭示出来的 nodeId */
  private readonly revealed = new Set<string>();
  /** 已经点过的 pickup / inspect 热点 */
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

    // 默认从 A 进。校验层已保证两个视角都存在，所以不需要再兜底
    this.initialView = options.initialView ?? 'A';
    this.currentView = this.initialView;
  }

  // ---------------------------------------------------------------- 订阅

  on<K extends keyof LevelEvents>(event: K, listener: (payload: LevelEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  once<K extends keyof LevelEvents>(event: K, listener: (payload: LevelEvents[K]) => void): Unsubscribe {
    return this.emitter.once(event, listener);
  }

  // ---------------------------------------------------------------- 读状态

  /** 取当前状态快照。每次返回新对象，外部改了不影响内部。 */
  getState(): LevelViewModel {
    return {
      levelId: this.config.levelId,
      chapterId: this.config.chapterId,
      title: this.config.title,
      currentView: this.currentView,
      canSwitchView: this.canSwitchView(),
      assetKey: this.config.views[this.currentView].assetKey,
      hotspots: this.getVisibleHotspots(),
      inventory: this.inventory.map((item) => ({ ...item })),
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

  /**
   * duo 模式下视角由服务端指派，客户端不能切。
   * 单人模式一个玩家看两个视角，可以自由切。
   */
  canSwitchView(): boolean {
    return this.mode === 'solo' && this.config.mode.includes('solo');
  }

  // ---------------------------------------------------------------- 操作

  /** 切换视角。单人模式专用；duo 模式、或切到当前视角，都返回 false。 */
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

  /**
   * 点击一个热点 —— 玩家在场景里的一切操作都走这里，包括提交。
   *
   * 之所以让提交也走 click（而不是单独的按钮回调），是因为需求里要求
   * 操作集中在点击/选择/拖动，提交在场景里也是一个可点物件。
   */
  click(nodeId: string): ClickResult {
    if (this.status !== 'playing') return { ok: false, reason: 'locked' };

    const entry = this.index.nodes.get(nodeId);
    if (!entry) return { ok: false, reason: 'unknown-node' };

    const { viewId, hotspot } = entry;

    // 单人模式只能操作当前视角的物件；切过去才能点
    if (viewId !== this.currentView) return { ok: false, reason: 'not-visible' };
    // 还没被揭示出来的跨视角线索
    if (hotspot.hiddenByDefault && !this.revealed.has(nodeId)) return { ok: false, reason: 'not-visible' };
    // 缺道具：这是「把线索带到另一个视角」的判定点
    if (hotspot.requiresItem && !this.hasItem(hotspot.requiresItem)) {
      return { ok: false, reason: 'missing-item' };
    }
    // pickup / inspect 点过就点不动了；submit 可以重复点（用来重试）
    if (hotspot.action !== 'submit' && this.consumed.has(nodeId)) {
      return { ok: false, reason: 'already-done' };
    }

    if (hotspot.action === 'submit') {
      const outcome = this.attemptSubmit();
      // 道具没凑齐时不算是「提交了一次」，如实告诉适配层点不动，
      // 否则渲染层会播一个「答错」的反馈动画，但玩家其实根本没提交
      if (outcome === 'blocked') return { ok: false, reason: 'missing-item' };
      return { ok: true, effect: 'submitted', correct: outcome === 'success' };
    }

    let effect: ClickResult;

    if (hotspot.action === 'pickup') {
      const itemId = hotspot.itemId!;
      this.inventory.push({ itemId, fromNodeId: nodeId });
      this.consumed.add(nodeId);
      effect = { ok: true, effect: 'picked', itemId };
      // 拾取本身不弹文案，让渲染层用道具入包的动效反馈即可
      this.emitter.emit('inventory:changed', { inventory: this.getInventory() });
    } else {
      this.consumed.add(nodeId);
      effect = { ok: true, effect: 'inspected', text: hotspot.text ?? null };
      if (hotspot.text) this.showLine(hotspot.text);
    }

    // 揭示另一视角的线索 —— 信息差的核心
    if (hotspot.revealsNode) {
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
   * 提交答案。
   *
   * 不传参数时，用背包里的道具顺序作为答案 —— 对应「按正确顺序依次点击」这类谜题
   * （路线重建、时间判断）。传参数时用于数字锁那种需要输入面板的谜题。
   *
   * 判定失败时**绝不把正确答案下发到客户端**，只回一个原因码，符合
   * 「服务端只向玩家发送当前视角需要的线索」这条要求。
   */
  submit(answer?: string[]): boolean {
    return this.attemptSubmit(answer) === 'success';
  }

  /**
   * 提交的内部实现。返回值区分三种情况，供 click() 如实转达给渲染层：
   *   success —— 答对，关卡通关
   *   wrong   —— 确实提交了但答错，计入容错次数
   *   blocked —— 道具没凑齐，这次点击根本没构成提交，不计数
   */
  private attemptSubmit(answer?: string[]): 'success' | 'wrong' | 'blocked' {
    if (this.status !== 'playing') return 'blocked';

    // 提交前必须凑齐道具，避免玩家空手点提交
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
   * 推进计时。适配层在 update(dt) 里调用即可。
   * 核心不自己起定时器 —— 否则单测要等真实时间，也没法复用到服务端。
   */
  tick(deltaSec: number): void {
    if (this.status !== 'playing') return;
    if (this.config.timeLimitSec === undefined) return;
    if (!(deltaSec > 0)) return;

    this.elapsedSec += deltaSec;

    if (this.elapsedSec >= this.config.timeLimitSec) {
      this.elapsedSec = this.config.timeLimitSec;
      this.status = 'failed';
      this.emitter.emit('level:failed', { reason: 'timeout', elapsedSec: this.elapsedSec });
      this.emitState();
      return;
    }

    this.emitState();
  }

  /** 请求下一段提示。提示按顺序解锁，用完返回 null。 */
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

  /** 重开本关。用于「失败复盘」后重新进入。 */
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

  /**
   * 结算页的「关键线索回顾」数据。
   * 只包含拿到手的道具和看过的文案，不含答案。
   */
  getReview(): { levelId: string; title: string; status: LevelStatus; elapsedSec: number; items: InventoryItem[] } {
    return {
      levelId: this.config.levelId,
      title: this.config.title,
      status: this.status,
      elapsedSec: this.elapsedSec,
      items: this.getInventory(),
    };
  }

  // ---------------------------------------------------------------- 内部

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

  /** 当前视角下可见的热点。跨视角的线索在这里被过滤掉，客户端拿不到另一视角的物件。 */
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
