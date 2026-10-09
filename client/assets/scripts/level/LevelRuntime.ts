/**
 * 关卡运行时状态机。
 * 只广播事件、不碰 Cocos 节点，渲染交给 LevelView（唯一 import cc 的文件）。
 * 本文件不 import 任何 cc 模块。
 */

import { Emitter, type Unsubscribe } from '../common/Emitter';
import type {
  HotspotConfig,
  InputSpec,
  ItemConfig,
  LevelConfig,
  PlayMode,
  PuzzleAnswer,
  SceneConfig,
  SubmittedAnswer,
  ViewId,
} from '../common/LevelTypes';
import { buildIndex, nextLevelId, type LevelIndex } from '../common/LevelConfig';

const DEFAULT_MAX_ATTEMPTS = 3;

/** 把 `requiresItem` 归一成数组（写字符串 = 一件，写数组 = 这几件都得有） */
function requiredItemsOf(hotspot: HotspotConfig): string[] {
  if (typeof hotspot.requiresItem === 'string') return [hotspot.requiresItem];
  return hotspot.requiresItem ?? [];
}

/** 道具在配置里的样子。字符串形式（老写法）归一成 `{ name }` */
function itemConfigOf(items: LevelConfig['items'], itemId: string): ItemConfig | undefined {
  const raw = items ? items[itemId] : undefined;
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? { name: raw } : raw;
}

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
  /** 图标 key（配置里配了才有）。背包格子上画它 */
  iconKey?: string;
  /** 一句话说明（配置里配了才有）。背包里选中它时显示 */
  desc?: string;
  /** 只在程序内部流转、**不进背包面板**（第 2 关的「已归位碎片」） */
  hidden?: boolean;
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
  /**
   * 当前**场景** id（写了 `scenes` 的视角才有；单场景视角是 null）。
   * 界面靠它判断「要不要重画背景」—— 视角没变、场景变了，背景一样得换。
   */
  sceneId: string | null;
  /** 当前场景配的「返回」目标；null = 没有返回出口（不显示返回按钮） */
  backSceneId: string | null;
  hotspots: HotspotRuntime[];
  inventory: InventoryItem[];
  /** 背包里当前选中的道具 id（没选是 null）。左下角背包面板高亮它 */
  selectedItemId: string | null;
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
   * 点了一个 `goto` 热点：切了场景（第 2 关点岔路 / 往前走）。
   * `moved=false` 表示目标场景就是当前场景（配置写重了）—— 仍然算成功，
   * 界面不用为它单开一条「点了没反应」的分支
   */
  | { ok: true; effect: 'scene-changed'; sceneId: string | null; moved: boolean }
  /**
   * 点了一个 use 热点：该弹输入面板了。
   * `useInput` 说弹哪个（密码 → 数字键盘，道具 → 背包列表），
   * **不带 acceptedItems / code 本身** —— 那等于把答案摆在界面上。
   */
  | {
      ok: true;
      effect: 'use-ready';
      nodeId: string;
      /** 'item' 已经没有了（2026-10-10 起道具门走「先选后点」，不弹面板） */
      useInput: 'code' | 'choice';
      digitCount: number;
      /** useInput 为 'choice' 时，现场摆着的那几个选项。**不含哪个对** */
      choices: string[];
      /** 打开面板时显示的那句话。场景里装置长得像的时候，这是唯一的区分 */
      prompt: string;
    }
  | {
      ok: false;
      reason: 'unknown-node' | 'not-visible' | 'already-done' | 'locked' | 'cooldown';
    }
  /**
   * 道具门用掉了背包里选中的那件东西（成功）。
   *
   * 2026-10-10 起道具门不再弹「挑一件东西」的面板：玩家先在左下角背包里
   * 选中一件，再点装置。`produced` 是这次产出的新道具（界面对照它弹特写图）。
   */
  | { ok: true; effect: 'used'; nodeId: string; produced: string[] }
  /** 走到了道具门，但背包里还没选中东西 —— 把 prompt 说出来让玩家去挑 */
  | { ok: false; reason: 'no-item-selected'; text: string }
  /** 选中的那件东西这个装置不收。软拒绝（红章/蓝章的辨析就靠这句 rejectText） */
  | { ok: false; reason: 'rejected' }
  /**
   * 缺道具，点不动。`text` 是配置里 `requireText` 那句话 ——
   * 界面拿它当提示语；没配就是 undefined，界面退回通用的「还差点东西」。
   */
  | { ok: false; reason: 'missing-item'; text?: string };

export type UseFailReason =
  | 'unknown-node'
  /** 这个热点不是 use、不在当前视角，或者用错了输入方式（该输密码却给了道具） */
  | 'not-usable'
  | 'already-done'
  /** 背包里没有这件道具，或者要消耗的道具不齐 */
  | 'missing-item'
  /** 挑错了道具 / 输错了密码。**默认是软拒绝**；密码门配了 wrongCooldownSec 才附带罚站 */
  | 'rejected'
  /** 还在罚站期（密码门输错的冷却，或答题答错的冷却），这次操作不收 */
  | 'cooldown'
  | 'locked';

export type UseResult = { ok: true; produced: string[] } | { ok: false; reason: UseFailReason };

/**
 * 结算页要的全部信息。
 *
 * E 的外层结算页拿这一个对象就够了，不用去听 level:success 再自己拼 ——
 * 两处各拼一份，迟早不一致。
 */
export interface LevelReview {
  levelId: string;
  title: string;
  /** 'success' 通关 / 'failed' 失败 / 'playing' 还没结束（结算页不该在此时显示） */
  status: LevelStatus;
  elapsedSec: number;
  /** 沿途收集的道具，已带玩家看得见的名字 */
  items: InventoryItem[];
  /** 下一关的 id。最后一关是 null —— 那样「下一关」按钮该换成「回到地图」 */
  nextLevelId: string | null;
  /** 本关解锁的地图节点，E 的地图按这个挂入口 */
  unlockedNodeIds: string[];
}

/**
 * 双人同步：**一条要广播给对面视角的操作**。
 *
 * 为什么是「操作」而不是「状态快照」：道具会被消耗，快照没法表达「这件没了」——
 * 两边一 union 就把消耗掉的道具又合回来了。操作日志天然有序（服务端给 seq），
 * 按序回放就能得到同一个状态。
 *
 * **只带结构性的变化，不带线索文字。** 双视角信息差是这游戏的核心 ——
 * 把对面看到的字也同步过去，玩家就不用交流了，整个玩法就没了。
 */
export type LevelSyncEvent =
  | { type: 'pickup'; nodeId: string; itemIds: string[] }
  | { type: 'use'; nodeId: string; consumed: string[]; produced: string[] }
  | { type: 'reveal'; nodeId: string }
  | { type: 'scene'; viewId: ViewId; sceneId: string }
  | { type: 'result'; status: LevelStatus };

export interface LevelEvents {
  'view:changed': { viewId: ViewId };
  'inventory:changed': { inventory: InventoryItem[] };
  /** 本地发生了一件该广播给对面的操作。双人同步层订阅它去 publish（单人时没人收） */
  'sync:out': LevelSyncEvent;
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

  /**
   * 每个视角**当前在哪个场景**（单场景视角是 null）。
   *
   * 按视角各存一份：A 走到岔路 2 的时候切去 B 看地图，切回来还得在岔路 2 ——
   * 用一个全局的「当前场景」会在切视角时丢进度。
   */
  private scenes: Record<ViewId, string | null> = { A: null, B: null };

  /** 用数组而不是 Set —— 顺序就是提交答案的顺序 */
  private inventory: InventoryItem[] = [];
  /**
   * 背包里**当前选中的那件道具**（在左下角背包面板里点出来的）。
   *
   * 道具门靠它决定"用哪件" —— 取代了以前「点装置 → 弹面板挑一件」那套流程。
   * 被消耗掉时自动清空（见 removeItem）；不消耗的（磁吸杆）会一直留着，
   * 因为玩家马上还要在对面的装置上再用一次。
   */
  private selectedItemId: string | null = null;
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

  /**
   * 正在应用对面的操作。期间 `sync:out` 一律不发 —— 否则对面的事件会被
   * 原样再广播回去，两边来回弹，房间事件表几秒钟就爆了。
   */
  private applyingRemote = false;

  /** 广播一条要同步给对面视角的操作。单人模式下没人订阅，等于空转 */
  private emitSync(event: LevelSyncEvent): void {
    if (this.applyingRemote) return;
    this.emitter.emit('sync:out', event);
  }

  constructor(config: LevelConfig, options: LevelRuntimeOptions) {
    this.config = config;
    this.index = buildIndex(config);
    this.mode = options.mode;
    this.initialView = options.initialView ?? 'A';
    this.currentView = this.initialView;
    this.resetScenes();
  }

  /** 每个视角回到自己的初始场景（进关卡、以及「再来一次」都走这里） */
  private resetScenes(): void {
    for (const viewId of ['A', 'B'] as ViewId[]) {
      this.scenes[viewId] = this.config.views[viewId]?.initialScene ?? null;
    }
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
      assetKey: this.assetKeyOf(this.currentView),
      sceneId: this.scenes[this.currentView],
      backSceneId: this.sceneConfigOf(this.currentView)?.backScene ?? null,
      hotspots: this.getVisibleHotspots(),
      inventory: this.getInventory(),
      selectedItemId: this.selectedItemId,
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

  /**
   * 在背包里选中一件道具。**再点同一件 = 取消选中**（面板里点一下就切换）。
   *
   * 只认背包里真有的 —— 选一件没有的东西，后面 useItem 必然失败，
   * 留着那个选中态只会让玩家困惑「我明明选中了怎么用不了」。
   */
  selectItem(itemId: string | null): boolean {
    if (itemId !== null && !this.hasItem(itemId)) return false;
    this.selectedItemId = itemId === this.selectedItemId ? null : itemId;
    this.emitState();
    return true;
  }

  /** duo 模式视角由服务端指派，客户端不能切 */
  canSwitchView(): boolean {
    return this.mode === 'solo' && this.config.mode.indexOf('solo') !== -1;
  }

  /**
   * 某个视角现在该显示哪张背景图。
   *
   * 多场景视角取当前场景的，单场景视角取 `assetKey`。场景 id 和配置对不上时
   * （理论上校验层已经拦掉了）退回 `assetKey`，至少不会白屏。
   */
  private assetKeyOf(viewId: ViewId): string {
    const scene = this.sceneConfigOf(viewId);
    return scene ? scene.assetKey : this.config.views[viewId].assetKey ?? '';
  }

  private sceneConfigOf(viewId: ViewId): SceneConfig | undefined {
    const sceneId = this.scenes[viewId];
    if (sceneId === null) return undefined;
    return this.config.views[viewId].scenes?.[sceneId];
  }

  /** 当前视角的场景 id（单场景视角是 null）。界面判断「背景要不要重画」用 */
  getCurrentScene(): string | null {
    return this.scenes[this.currentView];
  }

  /**
   * 切到本视角的另一个场景 —— 点岔路、往前走、点「返回」都走这里。
   *
   * 纯导航：不拿道具、不给文字、不消耗次数、失败也没有代价。
   * 只有**本视角**里存在的场景 id 才切得动（跨视角切场景是配置错误，直接拒）。
   */
  goToScene(sceneId: string): boolean {
    if (this.status !== 'playing') return false;
    const view = this.config.views[this.currentView];
    if (!view.scenes || !view.scenes[sceneId]) return false;
    if (this.scenes[this.currentView] === sceneId) return false;

    this.scenes[this.currentView] = sceneId;
    // 和切视角同理：上一句反馈是上一个场景里看到的，带到新场景就是错的
    this.lastLine = null;
    this.emitSync({ type: 'scene', viewId: this.currentView, sceneId });
    this.emitState();
    return true;
  }

  /**
   * 把对面视角的操作合并进本地状态。
   *
   * **每一步都是幂等的**，所以不需要按 senderId 过滤掉自己发的事件 ——
   * 服务端会把房间里所有人的事件都发回来（包括自己那条），照单全收也不会重复：
   * - pickup / use 用 `consumed` 里有没有这个节点当守门人
   * - reveal / scene 本来就是集合写入，写两次等于写一次
   * - result 只在还 `playing` 时才认
   *
   * 应用期间会关掉 `sync:out`（`applyingRemote`），否则对面的事件会被原样
   * 再广播回去，两边来回弹。
   */
  applyRemote(event: LevelSyncEvent): void {
    this.applyingRemote = true;
    try {
      switch (event.type) {
        case 'pickup': {
          if (this.consumed.has(event.nodeId)) break;
          for (const itemId of event.itemIds) this.pushItem(itemId, event.nodeId);
          this.consumed.add(event.nodeId);
          this.emitter.emit('inventory:changed', { inventory: this.getInventory() });
          break;
        }
        case 'use': {
          if (this.consumed.has(event.nodeId)) break;
          for (const itemId of event.consumed) this.removeItem(itemId);
          for (const itemId of event.produced) this.pushItem(itemId, event.nodeId);
          this.consumed.add(event.nodeId);
          this.emitter.emit('inventory:changed', { inventory: this.getInventory() });
          break;
        }
        case 'reveal': {
          this.revealed.add(event.nodeId);
          break;
        }
        case 'scene': {
          // 只认配置里真有的场景 —— 对面用了新配置、本地还是旧的时别把状态搞坏
          if (this.config.views[event.viewId]?.scenes?.[event.sceneId]) {
            this.scenes[event.viewId] = event.sceneId;
          }
          break;
        }
        case 'result': {
          // 「一人完成 → 全队完成」。失败**不同步**：那是我自己的容错次数用完了，
          // 对面不该被我拖下水，各自重试互不影响
          if (event.status === 'success' && this.status === 'playing') this.succeed();
          break;
        }
      }
    } finally {
      this.applyingRemote = false;
    }
    this.emitState();
  }

  switchView(viewId: ViewId): boolean {
    if (this.status !== 'playing') return false;
    if (!this.canSwitchView()) return false;
    if (viewId === this.currentView) return false;
    if (!this.config.views[viewId]) return false;

    this.currentView = viewId;
    // 切视角把上一句反馈丢掉：那句话属于刚离开的那个视角，带到对面就是错的。
    // **必须在这里清 `lastLine`** —— 界面那边也会把对话框收起来，但下一次
    // state:changed（倒计时、点东西……）会照着 lastLine 又把它显示回来
    this.lastLine = null;
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
    // 多场景视角里，别的场景的热点点不动 —— 和「不在当前视角」一样，视同不可见
    if (!this.inCurrentScene(hotspot)) return { ok: false, reason: 'not-visible' };
    if (hotspot.hiddenByDefault && !this.revealed.has(nodeId)) return { ok: false, reason: 'not-visible' };
    if (!this.hasAllRequired(hotspot)) {
      // 配了 requireText 就把「缺什么、要谁去做」说清楚 —— 别让玩家对着一句
      // 「还差点东西」发懵（他已经把能捡的都捡完了，正觉得游戏坏了）
      return hotspot.requireText
        ? { ok: false, reason: 'missing-item', text: hotspot.requireText }
        : { ok: false, reason: 'missing-item' };
    }
    // pickup 和 use 都是一次性的：pickup 再点会重复入包，
    // use 是一台装置只能用一次（used 之后就该变灰）。
    // inspect 必须允许反复点：双人模式下对面要来回确认线索文字，读一次就锁死
    // 会让关键线索（如第 1 关的施工告示）再也调不出来。submit 用来重试。
    if ((hotspot.action === 'pickup' || hotspot.action === 'use') && this.consumed.has(nodeId)) {
      return { ok: false, reason: 'already-done' };
    }

    // goto：纯导航（第 2 关点岔路 / 往前走 / 返回）。切场景的活儿交给 goToScene，
    // 它自己会 emitState —— 这里不重复发
    if (hotspot.action === 'goto') {
      const moved = hotspot.gotoScene ? this.goToScene(hotspot.gotoScene) : false;
      return { ok: true, effect: 'scene-changed', sceneId: this.scenes[this.currentView], moved };
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
      // 罚站期间连面板都不该弹开 —— 弹了玩家输进去才发现被拒，白挨一次
      if (this.cooldownLeftSec() > 0) return { ok: false, reason: 'cooldown' };
      const prompt = hotspot.prompt ?? '';
      // 打密码 / 选选项的装置：**那句话得由运行时说**（showLine），不能只让界面写。
      // 界面的 setDialogText 不会更新 lastLine，而 refreshHud 有条规则
      // 「运行时说没有当前这句话了 → 把对话框收起来」—— 第 1 关有 5 分钟倒计时，
      // state:changed 每秒来一次，界面写的那句下一秒就被清掉了（2026-10-11 实测）。
      if (prompt) this.showLine(prompt);
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

      // 「东西齐了点一下就成」那种装置（第 2 关的拼合区）：**不涉及选择**。
      // 前置道具已经在上面 hasAllRequired 查过了，这里直接执行 ——
      // 所以「已归位碎片」那种中间道具根本不用进背包，也就不会让玩家困惑
      if (!hotspot.acceptedItems && !hotspot.code && !hotspot.choices) {
        const blocked = this.checkConsumes(hotspot);
        if (blocked) return { ok: false, reason: 'missing-item' };
        const produced = this.succeedUse(nodeId, hotspot);
        return { ok: true, effect: 'used', nodeId, produced };
      }

      // 道具门：**不再弹「挑一件东西」的面板**。玩家先在左下角背包里选中一件，
      // 再点装置 —— 没选就只把 prompt 说出来（进对话框），让他知道这里要用东西
      if (!this.selectedItemId) {
        if (prompt) this.showLine(prompt);
        return { ok: false, reason: 'no-item-selected', text: prompt };
      }
      const used = this.useItem(nodeId, this.selectedItemId);
      // 用成功了：选中的东西要是被消耗掉了（removeItem 会顺手清掉选中态），
      // 界面对照 produced 弹特写图
      if (used.ok) return { ok: true, effect: 'used', nodeId, produced: used.produced };
      // 挑错了：useItem 已经念过 rejectText 了，这里只把结果带回去。
      // **选中态保留** —— 玩家换一件再点就行，不用重新开背包
      return { ok: false, reason: 'rejected' };
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
      this.emitSync({ type: 'pickup', nodeId, itemIds });
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
    this.emitSync({ type: 'reveal', nodeId: hotspot.revealsNode });
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
    if (!correct) return this.rejectCodeUse(hotspot);

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
  /** 这个热点是不是在当前场景里（单场景视角恒为 true） */
  private inCurrentScene(hotspot: HotspotConfig): boolean {
    const sceneId = this.scenes[this.currentView];
    if (sceneId === null) return true;
    return hotspot.scene === sceneId;
  }

  /**
   * `requiresItem` 要求的那几件都在不在背包里。
   * 没写这个字段 = 不要求（`requiredItemsOf` 返回空数组，`every` 空数组恒真）。
   */
  private hasAllRequired(hotspot: HotspotConfig): boolean {
    return requiredItemsOf(hotspot).every((itemId) => this.hasItem(itemId));
  }

  private guardUse(nodeId: string): { ok: true; hotspot: HotspotConfig } | { ok: false; reason: UseFailReason } {
    if (this.status !== 'playing') return { ok: false, reason: 'locked' };
    // 密码门输错后的罚站期间，任何 use 操作都不收 —— 挑道具 / 选选项的门也一起，
    // 因为它们用的是同一个冷却计时器（一次罚站不是「只禁这一台装置」）
    if (this.cooldownLeftSec() > 0) return { ok: false, reason: 'cooldown' };

    const entry = this.index.nodes.get(nodeId);
    if (!entry) return { ok: false, reason: 'unknown-node' };

    const { viewId, hotspot } = entry;
    if (viewId !== this.currentView) return { ok: false, reason: 'not-usable' };
    if (!this.inCurrentScene(hotspot)) return { ok: false, reason: 'not-usable' };
    if (hotspot.action !== 'use') return { ok: false, reason: 'not-usable' };
    if (this.consumed.has(nodeId)) return { ok: false, reason: 'already-done' };

    // 下面两条 click 那条路都查过，这里必须再查一遍：直接调 useXxx 会绕过 click，
    // 于是「还没揭示的隐藏热点」和「前置道具没拿到」这两个条件就都漏了。
    // 界面上现在利用不了（视图只在 click 成功后才调这三个），
    // 但同一个不变量在几个入口上不一致，早晚会出事。
    if (hotspot.hiddenByDefault && !this.revealed.has(nodeId)) {
      return { ok: false, reason: 'not-usable' };
    }
    if (!this.hasAllRequired(hotspot)) return { ok: false, reason: 'missing-item' };

    return { ok: true, hotspot };
  }

  /** 挑错道具 / 输错密码。软拒绝，只说一句话 */
  private rejectUse(hotspot: HotspotConfig): UseResult {
    if (hotspot.rejectText) this.showLine(hotspot.rejectText);
    this.emitState();
    return { ok: false, reason: 'rejected' };
  }

  /**
   * 密码输错了。**默认和挑错道具一样是软拒绝**；配了 `wrongCooldownSec` 才罚站。
   *
   * 罚站用的是和答题关 `wrongCooldownSec` 同一个冷却计时器，所以 tick() 里
   * 「显示的秒数变了就广播」那条路自动生效，HUD 的倒计时不用另接。
   * 文案把惩罚说清楚（「N 秒后才能再试」），不然玩家只会觉得键盘坏了。
   */
  private rejectCodeUse(hotspot: HotspotConfig): UseResult {
    const cooldownSec = hotspot.wrongCooldownSec ?? 0;
    if (cooldownSec > 0) this.cooldownUntilSec = this.elapsedSec + cooldownSec;

    const text = hotspot.rejectText ?? '不对。';
    this.showLine(cooldownSec > 0 ? `${text}（${Math.ceil(cooldownSec)} 秒后才能再试）` : text);
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

    // 同步给对面：消耗了什么、产出了什么。对面拿这个把背包对齐
    this.emitSync({
      type: 'use',
      nodeId,
      consumed: hotspot.consumes ?? [],
      produced: outputs,
    });

    // use 热点也会揭示下一个节点（第 2 关的岔口链、第 3 关的紫外线链）
    this.revealFrom(hotspot);

    // 用成功后顺便切场景 —— 第 2 关 B 视角把三块碎片拼合完，背景立刻从旧地图
    // 换成新地图。放在 showLine 之前：切场景会把上一句反馈清掉，顺序反了刚写的
    // successText 立刻就没
    if (hotspot.gotoScene) this.goToScene(hotspot.gotoScene);

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
    // 「一人完成 → 全队完成」：谁先完成谁广播，对面收到后也跟着进结算
    this.emitSync({ type: 'result', status: 'success' });
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
    const item = itemConfigOf(this.config.items, itemId);
    this.inventory.push({
      itemId,
      name: item?.name ?? itemId,
      fromNodeId,
      iconKey: item?.iconKey,
      desc: item?.desc,
      hidden: item?.hidden,
    });
  }

  /** 从背包里移除一件。只有第一件 —— 同一 id 不会有多件 */
  private removeItem(itemId: string): void {
    const index = this.inventory.findIndex((item) => item.itemId === itemId);
    if (index !== -1) this.inventory.splice(index, 1);
    // 被消耗掉的那件如果正被选中，选中态要跟着清 —— 不然背包里会出现一个
    // 「选中了但根本不存在」的幽灵状态（面板高亮一个空格子）
    if (this.selectedItemId === itemId && !this.hasItem(itemId)) this.selectedItemId = null;
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
    this.selectedItemId = null;
    this.revealed.clear();
    this.consumed.clear();
    this.status = 'playing';
    this.attempts = 0;
    this.elapsedSec = 0;
    this.hintsUnlocked = 0;
    this.lastLine = null;
    this.cooldownUntilSec = 0;
    this.currentView = this.initialView;
    this.resetScenes();
    this.emitState();
  }

  /** 结算页的线索回顾，只含道具和用时，不含答案 */
  getReview(): LevelReview {
    return {
      levelId: this.config.levelId,
      title: this.config.title,
      status: this.status,
      elapsedSec: this.elapsedSec,
      items: this.getInventory(),
      nextLevelId: nextLevelId(this.config.levelId),
      unlockedNodeIds: this.config.rewards.progress.slice(),
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
    const sceneId = this.scenes[this.currentView];
    for (const hotspot of this.config.views[this.currentView].hotspots) {
      // 多场景视角（sceneId 非 null）：只画本场景的热点。
      // 校验层保证这种视角里每个热点都写了 scene，所以这里不会误杀
      if (sceneId !== null && hotspot.scene !== sceneId) continue;
      if (hotspot.hiddenByDefault && !this.revealed.has(hotspot.nodeId)) continue;
      hotspots.push({
        nodeId: hotspot.nodeId,
        rect: [...hotspot.rect] as [number, number, number, number],
        action: hotspot.action,
        enabled:
          this.hasAllRequired(hotspot) &&
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
