/**
 * 把关卡挂到外层界面（E 的地图页）上的那一个入口。
 *
 * 在此之前，D 的关卡模块只有「自己挂自己」的开发入口（LevelBootView 的
 * AUTO_BOOT_LEVEL），没有任何一条路能从 E 的地图点进来 —— 地图点节点之后
 * 只会进一个占位页。这个文件就是那条缝：建节点、挂 LevelView、把结果递回外层。
 *
 * E 那边只要调一次：
 *
 * ```ts
 * mountLevel({
 *   levelId: node.levelId,
 *   hideWhileMounted: this.root,   // 外层这一层先藏起来，退出时自动恢复
 *   onComplete: (r) => this.setState(completeLevel(this.state, r.levelId, r.elapsedSec, r.unlockedNodeIds)),
 * });
 * ```
 *
 * 分工边界：本文件**不碰外层的任何节点内容** —— 只把 E 给的那个节点整个藏起来，
 * 以及把关卡的结果原样递出去。结算页长什么样、进度怎么存，是 E 和 C 的事。
 *
 * 命名注意：本文件 import 了 'cc'，所以文件名必须以 View.ts 结尾
 * （理由见 LevelView.ts 顶部的注释）。
 */

import { Graphics, Node, director, view } from 'cc';

import { LevelView } from './LevelView';
import type { LevelReview } from './LevelRuntime';
import { COLOR, CORNER_BUTTON_H, CORNER_MARGIN, cornerY, makeButton, safeInsets, uiNode } from './UiKitView';
import type { PlayMode } from '../common/LevelTypes';

/**
 * 兜底底色。
 *
 * A/B 的关卡图还没进 resources/，LevelView 的背景图加载不到时是**透明的** ——
 * 不铺这一层，E 的地图会整个透上来，看起来像关卡没挂上。
 * 这和 LevelView 自己画占位热点用的是同一个底色，视觉上是接续的。
 */
const BACKDROP = COLOR.placeholderBg;

/**
 * 通关后多久自动交回外层（秒）。
 *
 * 让玩家看清关卡自己的结算层（通关 + 用时 + 沿途线索），再切到 E 的结算页。
 * 传 0 就是立刻切。
 *
 * 2026-10-07 从 1.2 调到 **3.5**：1.2 秒根本来不及读「用时 + 沿途线索」，
 * 玩家反馈「一闪而过」。要再调就改这一个数（外层也能用 `handoffDelaySec` 覆盖）。
 *
 * **失败不自动交回** —— 超时/次数用完时关卡还停在「再来一次」那个界面上，
 * 拆掉就没法重试了。那种情况只能靠玩家点「退出」。
 */
const DEFAULT_HANDOFF_DELAY_SEC = 3.5;

const ROOT_NAME = 'LevelMount';
const STAGE_NAME = 'LevelMount.stage';
const EXIT_NAME = 'LevelMount.exit';

const EXIT_BUTTON_W = 132;
/**
 * 退出按钮的位置。
 *
 * 和 LevelView 里的「重玩」共用同一套角落算法（`safeInsets` + `cornerY`）：
 * 退出占 slot 0（最下面那个），重玩占 slot 1（它上面）。**两个文件必须用同一个
 * 函数算** —— 各写各的绝对坐标，改一边就错位了。
 */
const EXIT_SLOT = 0;

export interface LevelMountOptions {
  /** 关卡 id：GUIDE 或 L01~L10 */
  levelId: string;
  /** 默认 solo。duo 要等 C 的房间服务就绪 */
  playMode?: PlayMode;
  /** 画热点调试框，A/B 量坐标时打开 */
  debugHotspots?: boolean;
  /**
   * 外层那一层界面（E 传 `this.root`）—— **挂载期间整个藏起来，退出时自动恢复**。
   *
   * 为什么必须藏：两层 UI 同屏时，E 的按钮只是被「盖住」而**没被挡住** ——
   * Cocos 只把触摸派发给最上面那个**注册了监听**的节点，而 E 的按钮都挂着
   * TOUCH_END。不藏的话关卡里的点击会顺手把地图上的按钮也点掉。
   * 不传就只能靠背面那层底色挡视觉，点击挡不住。
   *
   * 注意它**不是挂载点**：关卡节点一律建在 Canvas 下（见 canvasHost），
   * 建成它的子节点再把它藏起来，关卡会跟着一起没。
   */
  hideWhileMounted?: Node | null;
  /** **只有通关**才调。E 在这里接 completeLevel */
  onComplete?: (review: LevelReview) => void;
  /** 超时 / 次数用完才调。**不该在这里记通关进度** */
  onFailed?: (review: LevelReview) => void;
  /**
   * 玩家**没打完就**点「退出」时调，`review.status` 是 `'playing'`。
   *
   * 结算层上那颗「退出」不会触发它（那是「知道了」）。用不上可以不传 ——
   * 退出本身就是拆关卡，外层界面自动露出来，不需要额外切页面。
   */
  onExit?: (review: LevelReview) => void;
  /** 退出按钮的文字。默认「退出」 */
  exitText?: string;
  /** 通关后多久自动交回外层，默认 1.2 秒。见 DEFAULT_HANDOFF_DELAY_SEC */
  handoffDelaySec?: number;
}

interface MountedLevel {
  root: Node;
  view: LevelView;
  options: LevelMountOptions;
  /** 挂载期间被藏起来的外层节点，拆的时候要恢复 */
  hiddenHost: Node | null;
  /** 藏它之前本来就是 active 的吗 —— 不是的话拆的时候别擅自打开 */
  hostWasActive: boolean;
  /** 通关后自动交回外层的回调；玩家自己点了退出就取消它 */
  handoff: (() => void) | null;
}

/** 同一时间只允许挂一关 —— 换关就是整棵拆掉重挂 */
let mounted: MountedLevel | null = null;

/**
 * 挂载点：场景里的 Canvas。
 *
 * 必须挂在 Canvas 子树里 —— UI 相机只渲 Canvas 子树，挂到 Scene 根上什么都看不见。
 * 这和外层界面（AppShellView 也挂在 Canvas 上）是同一层，靠**后建的在上面**盖住它。
 *
 * 找不到就返回 null、让调用方走自己的兜底界面，而不是退回场景根 ——
 * 退回去只会得到「白屏、毫无线索」，不如直接说清楚。
 */
function canvasHost(): Node | null {
  return director.getScene()?.getChildByName('Canvas') ?? null;
}

/**
 * 挂一关。返回 false 表示没挂上（拿不到挂载点），调用方该退回自己的兜底界面。
 *
 * 已经挂着别的关就直接换掉：换关连配置都换了，走 reset 清不干净。
 */
export function mountLevel(options: LevelMountOptions): boolean {
  unmountLevel();

  const host = canvasHost();
  if (!host || !host.isValid) {
    console.error('[LevelMount] 场景里找不到 Canvas，关卡没挂上');
    return false;
  }

  const size = view.getVisibleSize();

  const root = uiNode(ROOT_NAME, host, size.width, size.height, 0.5, 0.5);
  root.setPosition(0, 0, 0);

  const backdrop = root.addComponent(Graphics);
  backdrop.fillColor = BACKDROP;
  backdrop.rect(-size.width / 2, -size.height / 2, size.width, size.height);
  backdrop.fill();

  const stage = uiNode(STAGE_NAME, root, size.width, size.height, 0.5, 0.5);
  stage.setPosition(0, 0, 0);

  const levelView = stage.addComponent(LevelView);
  levelView.levelId = options.levelId;
  levelView.playMode = options.playMode ?? 'solo';
  levelView.debugHotspots = options.debugHotspots ?? false;

  const outer = options.hideWhileMounted && options.hideWhileMounted.isValid ? options.hideWhileMounted : null;
  const record: MountedLevel = {
    root,
    view: levelView,
    options,
    hiddenHost: outer,
    hostWasActive: outer ? outer.active : false,
    handoff: null,
  };

  levelView.onFinish = (review) => reportResult(record, review);

  // 退出按钮挂在 root 上、而不是 stage 下面：LevelView 的 start() 是**下一帧**才跑的，
  // 它的 HUD 那时候才建出来，挂在它子树里会被后建的 HUD 盖住、点不到。
  // root 的子节点里 stage 先建、按钮后建，所以按钮在最上面，盖住关卡的结算层也对。
  buildExitButton(root, record);

  // mounted 和藏外层都放在最后：前面任何一步抛错，都不该留下
  // 「已经算挂上了」或者「外层被藏起来了」这种半截状态
  if (outer) outer.active = false;
  mounted = record;

  return true;
}

/**
 * 拆掉当前这关并恢复外层。重复调用是安全的。
 *
 * 通关后是自动调的（见 reportResult），玩家点「退出」也是调的它。
 */
export function unmountLevel(): void {
  const record = mounted;
  if (!record) return;
  mounted = null;

  if (record.handoff && record.view.isValid) {
    record.view.unschedule(record.handoff);
  }
  record.handoff = null;
  // 拆的过程中 runtime 可能还在跑（销毁要等帧末），别让它再打回来
  record.view.onFinish = null;

  // removeFromParent + destroy 必须成对：destroy() 是帧末才生效的，
  // 只调它的话当帧 getChildByName 照样查得到（交接文档里记着的坑）
  if (record.root.isValid) {
    record.root.removeFromParent();
    record.root.destroy();
  }

  if (record.hiddenHost && record.hiddenHost.isValid) {
    record.hiddenHost.active = record.hostWasActive;
  }
}

/** 现在挂着哪一关（没挂返回 null）。E 要防重复进入时用它 */
export function mountedLevelId(): string | null {
  return mounted ? mounted.view.levelId : null;
}

/**
 * 关卡出结果了 —— 分清通关和失败，再决定要不要自动交回外层。
 *
 * **不加「只报一次」的旗标**：同一关里「失败 → 再来一次 → 通关」是正常路径，
 * 加了旗标第二次就再也报不出去了。重复回调本来也不会发生 ——
 * LevelRuntime 每个结果只发一次（succeed 和 tick 里都有 status 守卫）。
 *
 * 这个函数是在 runtime 的事件派发**当中**被调用的（LevelView.notifyFinish），
 * 所以任何一步都不能就地拆节点：runtime 紧接着还要发一次 state:changed，
 * 就地拆的话适配层会在一棵已经拆掉的树上重绘。要走也排到下一帧再走。
 */
function reportResult(record: MountedLevel, review: LevelReview): void {
  const won = review.status === 'success';
  const callback = won ? record.options.onComplete : record.options.onFailed;
  if (callback) {
    try {
      callback(review);
    } catch (err) {
      console.error('[LevelMount] 结算回调抛错：', err);
    }
  }

  // 失败不自动走：关卡还停在「再来一次」那个界面上，拆掉就没法重试了
  if (!won) return;

  if (record.handoff && record.view.isValid) {
    record.view.unschedule(record.handoff);
  }

  const delay = Math.max(0, record.options.handoffDelaySec ?? DEFAULT_HANDOFF_DELAY_SEC);
  const handoff = () => {
    // 定时器到点时玩家可能已经自己点了退出，mounted 就不是这一关了
    if (mounted === record) unmountLevel();
  };
  record.handoff = handoff;
  record.view.scheduleOnce(handoff, delay);
}

/**
 * 玩家自己点了「退出」。
 *
 * onExit **只在还没打完时**（`status === 'playing'`）才调：结算层上那颗「退出」
 * 是「知道了」的意思，不是「中途退出」，不该报给外层的埋点。
 * 两种情况都照拆不误 —— 拆完外层自动露出来，就是回地图。
 */
function exitLevel(record: MountedLevel): void {
  if (mounted !== record) return;

  const review = record.view.getReview();
  const callback = record.options.onExit;
  if (review && review.status === 'playing' && callback) {
    try {
      callback(review);
    } catch (err) {
      console.error('[LevelMount] onExit 回调抛错：', err);
    }
  }
  unmountLevel();
}

/**
 * 退出按钮。
 *
 * 做成一眼能看出是关卡界面的样子（跟关卡的按钮同一套配色），但**不能省** ——
 * 玩家进关卡之后没有别的路回地图：外层的界面这会儿正被藏着。
 */
function buildExitButton(root: Node, record: MountedLevel): void {
  const size = view.getVisibleSize();
  const inset = safeInsets(size.width, size.height);
  makeButton(
    root,
    EXIT_NAME,
    record.options.exitText ?? '退出',
    EXIT_BUTTON_W,
    CORNER_BUTTON_H,
    // 右边缘同样按安全区往里让
    size.width / 2 - inset.right - CORNER_MARGIN - EXIT_BUTTON_W / 2,
    cornerY(size.height, inset, EXIT_SLOT),
    () => exitLevel(record),
  );
}
