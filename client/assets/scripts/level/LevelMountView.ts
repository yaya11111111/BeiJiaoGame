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

import { Color, Graphics, Node, director, view } from 'cc';

import { LevelView } from './LevelView';
import type { LevelReview } from './LevelRuntime';
import { COLOR, CORNER_BUTTON_H, CORNER_MARGIN, addLabel, cornerY, makeButton, makePanel, safeInsets, uiNode } from './UiKitView';
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
 * **0 = 立刻切到 E 的结算页。** 2026-10-07 试玩后定的：D 不再画自己的通关结算层，
 * 通关就直接交给 E 那页（它已经有「本次用时 / 最好用时 / 收集线索」）。
 * 中间不要再垫任何秒数 —— 关卡里已经没有结算层可看了，垫出来的只是一张定格的场景图。
 *
 * 想恢复「关卡内先看一眼再切」的话：把 LevelView.refreshOverlay 里
 * `if (state.status === 'success') return;` 那行去掉，再把这里调回 3.5 左右。
 *
 * **失败不自动交回** —— 超时/次数用完时关卡还停在「再来一次」那个界面上，
 * 拆掉就没法重试了。那种情况只能靠玩家点「退出」。
 */
const DEFAULT_HANDOFF_DELAY_SEC = 0;

const ROOT_NAME = 'LevelMount';
const STAGE_NAME = 'LevelMount.stage';
const EXIT_NAME = 'LevelMount.exit';

const EXIT_BUTTON_W = 132;

/**
 * 「队友退出了关卡」那条通知停留多久再自动回房间（秒）。
 *
 * **不能立刻走** —— 立刻拆关卡的话玩家什么都看不到，只会莫名其妙发现自己
 * 回到房间页了，第一反应是「游戏坏了」。
 */
const PEER_LEFT_EXIT_SEC = 1.6;

/** 两个模态面板（退出确认 / 队友退出通知）的尺寸 */
const MODAL_W = 460;
const MODAL_H_CONFIRM = 250;
const MODAL_H_NOTICE = 190;
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
  /** 双人房间码，用于服务端校验 level.submit。 */
  roomCode?: string;
  /** 双人房间由服务端分配的初始视角。 */
  initialView?: 'A' | 'B';
  /** 双人房间由服务端生成的统一开局时间。 */
  startedAtMs?: number;
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
   * 玩家自己点「退出」拆关卡时调一次 —— **没打完 / 失败了 / 通关了都会调**，
   * `review.status` 告诉你当时是什么状态。
   *
   * **「该不该报埋点」由调用方看 `status` 决定**：只有 `'playing'` 才算中途退出，
   * 结算页上那颗「退出」是「知道了」的意思，不该报。
   * （以前这个判断做在挂载层里，结果双人「退出该回房间页」在失败/通关那两种
   * 情况下根本轮不到回调 —— 埋点口径顺手把导航也管死了，属于越权。）
   *
   * 用不上可以不传 —— 退出本身就是拆关卡，外层界面自动露出来。
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
  levelView.roomCode = options.roomCode ?? '';
  levelView.initialView = options.initialView ?? 'A';
  levelView.startedAtMs = options.startedAtMs ?? 0;
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
  // 队友中途退出了关卡 → 提示一句、一起回房间页
  levelView.onPeerLeft = () => openPeerLeftNotice(root, record);

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
  record.view.onPeerLeft = null;

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

  // 取两边大的：外层传的 handoffDelaySec，和**关卡自己配的完结图停留**
  // （第 1 关是 2 秒，让玩家看清 06 号柜里那张卡）。图还没停够就不该拆关 ——
  // 拆了图跟着一起没，玩家只看到一闪
  const delay = Math.max(
    0,
    record.options.handoffDelaySec ?? DEFAULT_HANDOFF_DELAY_SEC,
    record.view.finishHoldSec(),
  );
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
  // **无条件调**（见 onExit 的注释）：这里只负责「谁想知道了」，不替调用方
  // 判断该不该报 —— 双人的「退出回房间页」在失败/通关后也得走这条路
  if (review && callback) {
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
    () => {
      // **双人先问一句**：退出会把队友一个人晾在关卡里，不是能顺手点错的操作。
      // 单人不用问 —— 那只是回地图，没有第二个人受影响。
      if (record.options.playMode === 'duo') openExitConfirm(root, record);
      else exitLevel(record);
    },
  );
}

/**
 * 铺一层全屏模态层：压暗背景 + **吃掉所有点击**。
 *
 * 遮罩自己挂触摸监听这一招和 `DetailPopupView` 是同一个 —— Cocos 只把触摸
 * 派发给最上面那个注册了监听的节点，所以它顺手把下层的热点、HUD、退出按钮
 * 全挡掉了，不用额外的拦截组件。传了 `onBackdrop` 的话点遮罩就调它
 * （确认框用「点空白 = 取消」，通知层不给，点哪儿都不关）。
 */
function openModalLayer(
  root: Node,
  name: string,
  /** 点空白处关不关。确认框要（= 取消，安全的那一侧），通知层不要（它自己会走） */
  backdropCloses = true,
): { layer: Node; close: () => void } {
  const size = view.getVisibleSize();
  const layer = uiNode(name, root, size.width, size.height, 0.5, 0.5);
  layer.setPosition(0, 0, 0);

  // close 定义在挂监听之前，免得闭包自己引用自己
  const close = () => {
    if (!layer.isValid) return;
    // removeFromParent + destroy 必须成对：destroy() 帧末才生效，只调它当帧还查得到
    layer.removeFromParent();
    layer.destroy();
  };

  const back = uiNode('backdrop', layer, size.width, size.height, 0.5, 0.5);
  const g = back.addComponent(Graphics);
  g.fillColor = new Color(0, 0, 0, 170);
  g.rect(-size.width / 2, -size.height / 2, size.width, size.height);
  g.fill();
  back.on(Node.EventType.TOUCH_END, () => {
    if (backdropCloses) close();
  }, layer);

  return { layer, close };
}

/**
 * 双人退出前的确认框。
 *
 * 确认之后：① 广播一条 `leave` 告诉队友（他那边会收到提示、一起回房间页）；
 * ② 走正常的退出流程（`exitLevel` → 外层的 `onExit` → 回房间页）。
 * **房间本身不退** —— 「离开房间」是房间页那颗按钮，是另一回事。
 */
function openExitConfirm(root: Node, record: MountedLevel): void {
  const { layer, close } = openModalLayer(root, 'exitConfirm');

  const panel = makePanel(layer, 'panel', MODAL_W, MODAL_H_CONFIRM);
  addLabel(panel, 'title', '要退出关卡吗？', 26, COLOR.text, 0.5, 0.5).node.setPosition(0, 74, 0);
  addLabel(panel, 'hint1', '队友会收到提示，你们一起回房间', 18, COLOR.textDim, 0.5, 0.5)
    .node.setPosition(0, 28, 0);
  addLabel(panel, 'hint2', '（房间不会解散）', 18, COLOR.textDim, 0.5, 0.5).node.setPosition(0, 0, 0);

  makeButton(panel, 'cancel', '继续玩', 170, 52, -95, -72, () => close());
  makeButton(panel, 'confirm', '退出', 170, 52, 95, -72, () => {
    close();
    // 先告诉队友（他这会儿还在关卡里），再走正常退出流程
    record.view.leaveForPeer();
    exitLevel(record);
  }, true);
}

/**
 * 「队友退出了关卡」的通知（对面点了退出并确认）。
 *
 * 停一下再走（`PEER_LEFT_EXIT_SEC`）—— 立刻拆关卡的话这条通知玩家根本看不到，
 * 只会莫名其妙发现自己回到房间页。按「默认返回房间」做的，所以不给按钮自己走。
 */
function openPeerLeftNotice(root: Node, record: MountedLevel): void {
  const { layer, close } = openModalLayer(root, 'peerLeft', false);

  const panel = makePanel(layer, 'panel', MODAL_W, MODAL_H_NOTICE);
  addLabel(panel, 'title', '队友退出了关卡', 26, COLOR.text, 0.5, 0.5).node.setPosition(0, 42, 0);
  addLabel(panel, 'hint', '正在返回房间…', 20, COLOR.textDim, 0.5, 0.5).node.setPosition(0, -8, 0);

  // 用 view 的调度：它这会儿还活着，而且**拆掉之后会自动取消**，
  // 不会留下一个对已销毁节点的回调（用全局 setTimeout 就得自己管这件事）
  record.view.scheduleOnce(() => {
    close();
    exitLevel(record);
  }, PEER_LEFT_EXIT_SEC);
}
