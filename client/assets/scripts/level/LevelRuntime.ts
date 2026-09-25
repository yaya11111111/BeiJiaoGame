/**
 * 关卡运行时状态机。
 * 只广播事件、不碰 Cocos 节点，渲染交给 LevelView（唯一 import cc 的文件）。
 * 本文件不 import 任何 cc 模块。
 */

import { Emitter, type Unsubscribe } from '../common/Emitter';
import type {
  HotspotConfig,
  InputSpec,
  LevelConfig,
  PlayMode,
  PuzzleAnswer,
  SubmittedAnswer,
  ViewId,
} from '../common/LevelTypes';
import { buildIndex, type LevelIndex } from '../common/LevelConfig';

const DEFAULT_MAX_ATTEMPTS = 3;

/** 提交的答案和配置里的答案形状是否一致（数组 vs 对象） */
function shapeMatches(candidate: SubmittedAnswer, expected: PuzzleAnswer): boolean {
  return Array.isArray(candidate) === Array.isArray(expected);
}

/**
 * 判定。
 * - 数组：长度相同且逐位相等 —— **顺序敏感**，密码 241 和 142 不是一回事
 * - 对象：键集合相同且每个键的值相等 —— **顺序无关**，表单先填哪个空不该影响对错
 */
function isAnswerCorrect(candidate: SubmittedAnswer, expected: PuzzleAnswer): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(candidate)) return false;
    return candidate.length === expected.length && candidate.every((v, i) => v === expected[i]);
  }
  if (Array.isArray(candidate)) return false;

  const expectedKeys = Object.keys(expected);
  if (Object.keys(candidate).length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => candidate[key] === expected[key]);
}

export type LevelStatus = 'playing' | 'success' | 'failed';

export type FailureReason = 'attempts-exhausted' | 'timeout';

export interface InventoryItem {
  itemId: string;
  /** 玩家看得见的名字，取自配置的 items。界面显示这个，别显示 itemId */
  name: string;
  /** 从哪个热点拿到的，用于结算页的线索回顾 */
  fromNodeId: string;
}

/** rect 仍是原图坐标，换算在 LevelView 做 */
export interface HotspotRuntime {
  nodeId: string;
  rect: [number, number, number, number];
  /** 直接引用配置里的联合类型，加新动作时不会漏改这里 */
  action: HotspotConfig['action'];
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
  /** 答错惩罚的剩余秒数。0 表示现在可以提交 */
  cooldownLeftSec: number;
  /** 界面该画什么输入控件。不含答案 */
  input: InputSpec;
  hints: string[];
  hintsRemaining: number;
  lastLine: string | null;
}

export type ClickResult =
  | { ok: true; effect: 'picked'; itemId: string }
  | { ok: true; effect: 'inspected'; text: string | null }
  | { ok: true; effect: 'submitted'; correct: boolean }
  /** 点了一个面板类关卡的提交热点：该弹出关卡自己的输入面板了 */
  | { ok: true; effect: 'input-ready'; nodeId: string }
  /**
   * 点了一个 use 热点：该弹输入面板了。
   * `useInput` 说弹哪个（密码 → 数字键盘，道具 → 背包列表），
   * **不带 acceptedItems / code 本身** —— 那等于把答案摆在界面上。
   */
  | {
      ok: true;
      effect: 'use-ready';
      nodeId: string;
      useInput: 'code' | 'item' | 'choice';
      digitCount: number;
      /** useInput 为 'choice' 时，现场摆着的那几个选项。**不含哪个对** */
      choices: string[];
      /** 打开面板时显示的那句话。场景里装置长得像的时候，这是唯一的区分 */
      prompt: string;
    }
  | {
      ok: false;
      reason: 'unknown-node' | 'not-visible' | 'missing-item' | 'already-done' | 'locked' | 'cooldown';
    };

export type UseFailReason =
  | 'unknown-node'
  /** 这个热点不是 use、不在当前视角，或者用错了输入方式（该输密码却给了道具） */
  | 'not-usable'
  | 'already-done'
  /** 背包里没有这件道具，或者要消耗的道具不齐 */
  | 'missing-item'
  /** 挑错了道具 / 输错了密码。**这是软拒绝，不算答错、不扣次数** */
  | 'rejected'
  | 'locked';

export type UseResult = { ok: true; produced: string[] } | { ok: false; reason: UseFailReason };

export interface LevelEvents {
  'view:changed': { viewId: ViewId };
  'inventory:changed': { inventory: InventoryItem[] };
  'hotspot:revealed': { nodeId: string; viewId: ViewId };
  'line:shown': { text: string };
  'hint:unlocked': { index: number; text: string };
  /** cooldownSec > 0 表示这次答错触发了惩罚，适配层要显示倒计时 */
  'answer:wrong': { attemptsLeft: number; cooldownSec: number };
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
  /**
   * 答错惩罚的解锁时刻，用 elapsedSec 表示（不是 Date.now）。
   * 用同一根时间轴，单测里只要 tick(10) 就能跳过惩罚，不用等真实时间。
   */
  private cooldownUntilSec = 0;

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
      cooldownLeftSec: this.cooldownLeftSec(),
      input: this.inputSpec(),
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
    // pickup 和 use 都是一次性的：pickup 再点会重复入包，
    // use 是一台装置只能用一次（used 之后就该变灰）。
    // inspect 必须允许反复点：双人模式下对面要来回确认线索文字，读一次就锁死
    // 会让关键线索（如第 1 关的施工告示）再也调不出来。submit 用来重试。
    if ((hotspot.action === 'pickup' || hotspot.action === 'use') && this.consumed.has(nodeId)) {
      return { ok: false, reason: 'already-done' };
    }

    if (hotspot.action === 'submit') {
      // 面板类关卡（input 为 numberpad/form）：点提交热点只是**打开面板**，
      // 不在这里判定。不然玩家手滑点一下就会拿背包顺序当答案交上去，
      // 白扣一次机会甚至触发答错惩罚
      const puzzle = this.config.puzzle;
      if (puzzle && puzzle.input && puzzle.input !== 'none') {
        return { ok: true, effect: 'input-ready', nodeId };
      }

      const outcome = this.attemptSubmit();
      // 道具没凑齐时不算「提交了一次」，如实报点不动，
      // 否则渲染层会播一个「答错」的动画，但玩家根本没提交
      if (outcome === 'blocked') return { ok: false, reason: 'missing-item' };
      // 惩罚期里也点不动。要单独报一个 reason，渲染层才能显示「还有 N 秒」
      // 而不是手足无措地什么都不说
      if (outcome === 'cooling') return { ok: false, reason: 'cooldown' };
      return { ok: true, effect: 'submitted', correct: outcome === 'success' };
    }

    // use 热点：这里只报「可以输入了」，具体输入交给 useCode / useItem / useChoice。
    // choices 要带出去（那是现场看得见的东西），但**不带 correctChoice** —— 那才是答案
    if (hotspot.action === 'use') {
      const prompt = hotspot.prompt ?? '';
      if (hotspot.code) {
        return {
          ok: true,
          effect: 'use-ready',
          nodeId,
          useInput: 'code',
          digitCount: hotspot.code.length,
          choices: [],
          prompt,
        };
      }
      if (hotspot.choices) {
        return {
          ok: true,
          effect: 'use-ready',
          nodeId,
          useInput: 'choice',
          digitCount: 0,
          // slice 而不是直接给引用：渲染层改了它不该影响到配置
          choices: hotspot.choices.slice(),
          prompt,
        };
      }
      return { ok: true, effect: 'use-ready', nodeId, useInput: 'item', digitCount: 0, choices: [], prompt };
    }

    let effect: ClickResult;

    if (hotspot.action === 'pickup') {
      // itemId 写成数组时一次拿多件（工具盒那种）。配置校验保证至少有一件
      const itemIds = typeof hotspot.itemId === 'string' ? [hotspot.itemId] : hotspot.itemId!;
      for (const itemId of itemIds) {
        this.pushItem(itemId, nodeId);
      }
      // consumed 只收 pickup / use，语义是「这个热点的东西已经被拿走了」。
      // inspect 不进这个集合，否则 getVisibleHotspots() 会把它标成 done 且
      // enabled:false，渲染层照样点不动，上层这条放行等于白改。
      this.consumed.add(nodeId);
      effect = { ok: true, effect: 'picked', itemId: itemIds[0] };
      this.emitter.emit('inventory:changed', { inventory: this.getInventory() });
    } else {
      effect = { ok: true, effect: 'inspected', text: hotspot.text ?? null };
      if (hotspot.text) this.showLine(hotspot.text);
    }

    this.revealFrom(hotspot);
    this.emitState();
    return effect;
  }

  /**
   * 把 `hotspot.revealsNode` 指向的节点揭示出来。同一节点只揭示一次 ——
   * inspect 可以复读，不去重的话渲染层会反复播揭示动画。
   *
   * 抽成公用的是因为它**不只是 inspect 的事**：click 在处理 use / submit 时会提前
   * return，走不到后面那段，所以 use 热点上的 revealsNode 一直是失效的
   * （第 2 关的岔口链、第 3 关的紫外线链全靠它）。现在两条路都调这里。
   */
  private revealFrom(hotspot: HotspotConfig): void {
    if (!hotspot.revealsNode) return;
    if (this.revealed.has(hotspot.revealsNode)) return;

    this.revealed.add(hotspot.revealsNode);
    const target = this.index.nodes.get(hotspot.revealsNode);
    if (target) {
      this.emitter.emit('hotspot:revealed', { nodeId: hotspot.revealsNode, viewId: target.viewId });
    }
  }

  /**
   * 提交答案。
   * 不传参数时用背包里的道具顺序作为答案，但那只对**有序**答案有意义；
   * 配置里是按键答案（表单/拖放/单选）时必须显式把答案传进来。
   *
   * 判定失败时不把正确答案下发到客户端，只回原因，符合「服务端只下发当前视角所需的线索」。
   */
  submit(answer?: SubmittedAnswer): boolean {
    return this.attemptSubmit(answer) === 'success';
  }

  private attemptSubmit(answer?: SubmittedAnswer): 'success' | 'wrong' | 'blocked' | 'cooling' {
    if (this.status !== 'playing') return 'blocked';
    if (this.cooldownLeftSec() > 0) return 'cooling';

    // 这关没有 puzzle —— 它靠一个 completes 的 use 热点通关，答题这条路走不通
    const puzzle = this.config.puzzle;
    if (!puzzle) return 'blocked';

    for (const item of puzzle.requiredItems ?? []) {
      if (!this.hasItem(item)) {
        this.showLine('还差点东西，再找找。');
        this.emitState();
        return 'blocked';
      }
    }

    const expected = puzzle.answer;
    const candidate = answer ?? this.defaultCandidate(expected);

    // 按键答案（表单/拖放/单选）必须显式传答案，不传就交不了 —— 这不是错误，
    // 是设计如此：那种关的提交按钮在表单里，不走热点点击。
    if (candidate === null) return 'blocked';

    // 形状对不上（该给对象却给了数组，或反过来）是调用方写错了，不是玩家答错。
    // 必须返回 blocked 而不是 wrong —— 否则玩家会白白被扣一次机会、甚至被锁 10 秒。
    if (!shapeMatches(candidate, expected)) {
      console.error('[LevelRuntime] 提交的答案形状与配置不符，本次提交被忽略');
      return 'blocked';
    }

    if (isAnswerCorrect(candidate, expected)) {
      this.succeed();
      return 'success';
    }

    this.attempts += 1;
    const attemptsLeft = this.maxAttempts() - this.attempts;

    const cooldownSec = puzzle.wrongCooldownSec ?? 0;
    if (cooldownSec > 0) this.cooldownUntilSec = this.elapsedSec + cooldownSec;

    if (attemptsLeft <= 0) {
      this.status = 'failed';
      this.emitter.emit('level:failed', { reason: 'attempts-exhausted', elapsedSec: this.elapsedSec });
    } else {
      // 先写文案再广播：适配层收到 answer:wrong 后要把它染红，
      // 顺序反了的话染色会被这里刚写的文案复位掉
      // 有惩罚就报惩罚，没惩罚才报剩余次数 —— 同时报两个玩家不知道该看哪个
      this.showLine(
        cooldownSec > 0
          ? `不对，再想想。（${Math.ceil(cooldownSec)} 秒后才能再试）`
          : `不对，再想想。（还剩 ${attemptsLeft} 次）`,
      );
      this.emitter.emit('answer:wrong', { attemptsLeft, cooldownSec });
    }

    this.emitState();
    return 'wrong';
  }

  /** 不传答案时的兜底：背包顺序。只对有序答案成立 */
  private defaultCandidate(expected: PuzzleAnswer): SubmittedAnswer | null {
    if (!Array.isArray(expected)) return null;
    return this.inventory.map((item) => item.itemId);
  }

  /**
   * 在一台装置上使用一件道具（action 为 use 的热点）。
   *
   * 玩家要自己从背包里挑，挑错是**软拒绝**：不扣容错次数、不触发惩罚，只说一句话。
   * 理由：翻物件本来就是探索。罚得重玩家就不敢点了，而设计稿里
   * 「红圆章是辨析项」正要靠这一步 —— 挑红章被拒，玩家才知道该去找 B 的排除线索。
   */
  useItem(nodeId: string, itemId: string): UseResult {
    const guarded = this.guardUse(nodeId);
    if (!guarded.ok) return guarded;
    const { hotspot } = guarded;

    // 这台装置要的是密码或固定选项，不是背包里的道具
    if (hotspot.code || hotspot.choices) return { ok: false, reason: 'not-usable' };

    if (!this.hasItem(itemId)) return { ok: false, reason: 'missing-item' };

    const accepted = hotspot.acceptedItems ?? [];
    if (accepted.indexOf(itemId) === -1) return this.rejectUse(hotspot);

    const blocked = this.checkConsumes(hotspot);
    if (blocked) return blocked;

    return { ok: true, produced: this.succeedUse(nodeId, hotspot) };
  }

  /**
   * 往一台带密码的装置里输密码（`code`）。
   *
   * 输错也是**软拒绝**：设计稿明写「错误密码打不开，也不会封锁密码盒」，
   * 所以这里不扣次数、不锁时间，只说一句 rejectText。想加惩罚的关卡
   * 应该靠线索把难度做上去，而不是靠罚站。
   */
  useCode(nodeId: string, digits: string[]): UseResult {
    const guarded = this.guardUse(nodeId);
    if (!guarded.ok) return guarded;
    const { hotspot } = guarded;

    // 这台装置要的是道具，不是密码
    if (!hotspot.code) return { ok: false, reason: 'not-usable' };

    const expected = hotspot.code;
    const correct =
      digits.length === expected.length && digits.every((digit, i) => digit === expected[i]);
    if (!correct) return this.rejectUse(hotspot);

    const blocked = this.checkConsumes(hotspot);
    if (blocked) return blocked;

    return { ok: true, produced: this.succeedUse(nodeId, hotspot) };
  }

  /**
   * 在几个固定选项里选一个（第 2 关的三条岔路、第 3 关的三张通知）。
   *
   * 选错同样是**软拒绝**：这些都是"走过去看看会发生什么"的探索动作，
   * 罚重了玩家就不敢选，只会站在岔路口发呆。
   */
  useChoice(nodeId: string, choice: string): UseResult {
    const guarded = this.guardUse(nodeId);
    if (!guarded.ok) return guarded;
    const { hotspot } = guarded;

    if (!hotspot.choices) return { ok: false, reason: 'not-usable' };
    // 传了一个不在列表里的值 —— 是调用方传错了，不是玩家选错
    if (hotspot.choices.indexOf(choice) === -1) return { ok: false, reason: 'not-usable' };

    if (choice !== hotspot.correctChoice) return this.rejectUse(hotspot);

    const blocked = this.checkConsumes(hotspot);
    if (blocked) return blocked;

    return { ok: true, produced: this.succeedUse(nodeId, hotspot) };
  }

  /** useItem / useCode / useChoice 共用的前置检查。通过后返回热点配置 */
  private guardUse(nodeId: string): { ok: true; hotspot: HotspotConfig } | { ok: false; reason: UseFailReason } {
    if (this.status !== 'playing') return { ok: false, reason: 'locked' };

    const entry = this.index.nodes.get(nodeId);
    if (!entry) return { ok: false, reason: 'unknown-node' };

    const { viewId, hotspot } = entry;
    if (viewId !== this.currentView) return { ok: false, reason: 'not-usable' };
    if (hotspot.action !== 'use') return { ok: false, reason: 'not-usable' };
    if (this.consumed.has(nodeId)) return { ok: false, reason: 'already-done' };

    // 下面两条 click 那条路都查过，这里必须再查一遍：直接调 useXxx 会绕过 click，
    // 于是「还没揭示的隐藏热点」和「前置道具没拿到」这两个条件就都漏了。
    // 界面上现在利用不了（视图只在 click 成功后才调这三个），
    // 但同一个不变量在几个入口上不一致，早晚会出事。
    if (hotspot.hiddenByDefault && !this.revealed.has(nodeId)) {
      return { ok: false, reason: 'not-usable' };
    }
    if (hotspot.requiresItem && !this.hasItem(hotspot.requiresItem)) {
      return { ok: false, reason: 'missing-item' };
    }

    return { ok: true, hotspot };
  }

  /** 挑错道具 / 输错密码。软拒绝，只说一句话 */
  private rejectUse(hotspot: HotspotConfig): UseResult {
    if (hotspot.rejectText) this.showLine(hotspot.rejectText);
    this.emitState();
    return { ok: false, reason: 'rejected' };
  }

  /** 要消耗的道具必须都在。合成到一半发现少一件就很难解释 */
  private checkConsumes(hotspot: HotspotConfig): UseResult | null {
    for (const required of hotspot.consumes ?? []) {
      if (!this.hasItem(required)) {
        this.showLine('还差点东西，再找找。');
        this.emitState();
        return { ok: false, reason: 'missing-item' };
      }
    }
    return null;
  }

  /**
   * 用成功：消耗、产出、把装置标成已用。
   * 如果这个热点标了 completes，这一下就是通关。
   */
  private succeedUse(nodeId: string, hotspot: HotspotConfig): string[] {
    for (const spent of hotspot.consumes ?? []) this.removeItem(spent);

    const outputs =
      typeof hotspot.produces === 'string' ? [hotspot.produces] : hotspot.produces ?? [];
    for (const itemId of outputs) {
      this.pushItem(itemId, nodeId);
    }

    // 装置只能用一次；consumes 不填的话道具留背包里，磁吸杆那种就能反复用
    this.consumed.add(nodeId);

    // use 热点也会揭示下一个节点（第 2 关的岔口链、第 3 关的紫外线链）
    this.revealFrom(hotspot);

    if (hotspot.successText) this.showLine(hotspot.successText);
    this.emitter.emit('inventory:changed', { inventory: this.getInventory() });

    if (hotspot.completes) this.succeed();
    else this.emitState();

    return outputs;
  }

  /**
   * 通关。**答题通和操作通都走这里**，保证 level:success 的载荷一致 ——
   * E 的地图靠它拿解锁节点，两条路各播一份迟早会不一致。
   */
  private succeed(): void {
    this.status = 'success';
    this.emitter.emit('level:success', {
      progress: [...this.config.rewards.progress],
      elapsedSec: this.elapsedSec,
    });
    this.emitState();
  }

  /**
   * 入包。名字从配置的 items 取 —— 界面显示名字，itemId 只在配置和存档里流转。
   * 取不到名字时退回 id：校验层保证这不会发生，但不能让界面显示 undefined
   */
  private pushItem(itemId: string, fromNodeId: string): void {
    const name = this.config.items ? this.config.items[itemId] : undefined;
    this.inventory.push({ itemId, name: name ?? itemId, fromNodeId });
  }

  /** 从背包里移除一件。只有第一件 —— 同一 id 不会有多件 */
  private removeItem(itemId: string): void {
    const index = this.inventory.findIndex((item) => item.itemId === itemId);
    if (index !== -1) this.inventory.splice(index, 1);
  }

  /**
   * 由适配层在 update(dt) 里调用。核心不起定时器，否则单测要等真实时间。
   *
   * 三点注意：
   * 1. 不限时关卡（引导关）也要累计用时 —— 结算页的用时回顾和后台统计的
   *    用时都取自这里（FR-12），早退会让不限时关卡的用时恒为 0。
   * 2. 广播只在**显示出来的秒数**变化时发生（倒计时和答错惩罚各算一路）。
   *    state:changed 的语义是「整屏可以重绘了」，每帧发一次会让适配层
   *    每帧重建热点数组和 UI。
   * 3. 所以不限时关卡也不能在这里早退 —— 它可能配了答错惩罚，
   *    惩罚的秒数一样要广播出去。
   */
  tick(deltaSec: number): void {
    if (this.status !== 'playing') return;
    if (!(deltaSec > 0)) return;

    const timeLeftBefore = this.timeLeftSec();
    const cooldownBefore = this.cooldownLeftSec();
    this.elapsedSec += deltaSec;

    const limit = this.config.timeLimitSec;
    if (limit !== undefined && this.elapsedSec >= limit) {
      this.elapsedSec = limit;
      this.status = 'failed';
      this.emitter.emit('level:failed', { reason: 'timeout', elapsedSec: this.elapsedSec });
      this.emitState();
      return;
    }

    if (this.timeLeftSec() !== timeLeftBefore || this.cooldownLeftSec() !== cooldownBefore) {
      this.emitState();
    }
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
    this.cooldownUntilSec = 0;
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
    if (!this.config.puzzle) return DEFAULT_MAX_ATTEMPTS;
    return this.config.puzzle.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private timeLeftSec(): number | null {
    if (this.config.timeLimitSec === undefined) return null;
    return Math.max(0, Math.ceil(this.config.timeLimitSec - this.elapsedSec));
  }

  private cooldownLeftSec(): number {
    return Math.max(0, Math.ceil(this.cooldownUntilSec - this.elapsedSec));
  }

  /**
   * 界面该画什么输入控件。只给控件需要的信息，**不含答案**：
   * 密码位数光看几个空格也知道，候选项里混着干扰项所以看不出哪个对。
   *
   * 配置的合法性已在 LevelConfig 里校验过，所以这里不做防守式判断，
   * 只处理「input 没配」的默认情况。
   */
  private inputSpec(): InputSpec {
    const puzzle = this.config.puzzle;
    // 没 puzzle 的关卡（靠 completes 的 use 热点通关）不需要输入控件
    if (!puzzle) return { kind: 'none', digitCount: 0, fields: [] };

    const kind = puzzle.input ?? 'none';

    if (kind === 'numberpad' && Array.isArray(puzzle.answer)) {
      return { kind, digitCount: puzzle.answer.length, fields: [] };
    }

    if (kind === 'form' && !Array.isArray(puzzle.answer)) {
      const fields = Object.keys(puzzle.answer).map((label) => ({
        label,
        options: puzzle.fieldOptions ? puzzle.fieldOptions[label] : [],
      }));
      return { kind, digitCount: 0, fields };
    }

    return { kind: 'none', digitCount: 0, fields: [] };
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
        // 注意：答错惩罚**不**把 enabled 置 false。置了的话适配层就不会派发点击，
        // 玩家点下去毫无反应，只会以为坏了。留着可点，让 click 回 'cooldown' 再播报「还有 N 秒」。
        done: this.consumed.has(hotspot.nodeId),
      });
    }
    return hotspots;
  }

  private emitState(): void {
    this.emitter.emit('state:changed', this.getState());
  }
}
