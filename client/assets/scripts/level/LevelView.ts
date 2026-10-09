/**
 * 关卡适配层 —— 把 LevelRuntime 的状态画到 Cocos 节点上。
 *
 * 这是关卡模块里唯一 import 'cc' 的文件，所以文件名必须以 View.ts 结尾：
 * tests/tsconfig.json 靠一条 `exclude: **\/*View.ts` 把它挡在单测的类型检查之外，
 * 否则 Node 解析不到 'cc'，npm run typecheck 会直接报 TS2307 挂掉。
 * 它的类型检查走单独的 tests/tsconfig.view.json（npm run typecheck:view）。
 *
 * 分工边界：
 *   LevelRuntime 只算不画（能在 Node 里跑单测），本文件只画不算。
 *   任何需要判断胜负、扣次数、累计用时的逻辑都不许写在这里 —— 写在这里就等于
 *   绕过了单测覆盖，而且是真机上才暴露。
 *
 * 坐标口径见 common/Coord.ts：配置里的 rect 是原图左上原点，本文件负责换算。
 * 热点的换算用 mapRectIntoBox，一次性把 contain 留边也加进去。
 */

import {
  _decorator,
  Color,
  Component,
  EventTouch,
  Graphics,
  ImageAsset,
  JsonAsset,
  Label,
  Mask,
  Node,
  Sprite,
  SpriteFrame,
  UITransform,
  resources,
  view,
} from 'cc';

import { levelConfigPath, parseLevelConfig } from '../common/LevelConfig';
import { fitContain, mapRectIntoBox, type LocalRect, type Size } from '../common/Coord';
import type { HotspotRuntime, LevelReview, LevelViewModel } from './LevelRuntime';
import { LevelRuntime } from './LevelRuntime';
import { DetailPopupView } from './DetailPopupView';
import { LevelSync } from './LevelSync';
import { FormPanelView } from './FormPanelView';
import { NumberPadView } from './NumberPadView';
import { UsePanelView } from './UsePanelView';
import {
  COLOR,
  CORNER_BUTTON_H,
  CORNER_MARGIN,
  addLabel,
  cornerY,
  makeButton,
  makeCircleButton,
  safeInsets,
  uiNode,
  type SafeInsets,
} from './UiKitView';
import { CloudApi, type CloudAnswer } from '../common/CloudApi';
import { createWechatCloudInvoker } from '../common/CloudInvoker';
import type { InputSpec, LevelConfig, PlayMode, ViewId } from '../common/LevelTypes';

const { ccclass, property } = _decorator;

/**
 * A/B 出图之前用的兜底原图尺寸。
 *
 * 真实关卡里这个值取自 SpriteFrame.originalSize，所以美术按什么比例出图都行；
 * 但占位阶段没有图，热点又必须有东西可依，就先钉一个基准跑通交互。
 * 1280x720 与 9/22 推荐的画布基准一致，A/B 之后按这个比例出图不会返工。
 */
const FALLBACK_ORIGINAL_SIZE: Size = { width: 1280, height: 720 };

/**
 * 底部对话框的尺寸。
 *
 * 对话框是关卡里**唯一放文字的地方**（点一下东西才出现的那句反馈）。
 * 高度按「放得下 4~5 行」定；宽做成「屏幕宽减去右侧那列按钮」，屏幕再宽也不超过上限 ——
 * 不然右边会压到「重玩 / 退出」上。
 *
 * 文字用 `Overflow.SHRINK`（字号自适应），**不做上下滑动** ——
 * 滑动需要一个遮罩来裁切内容，而 `mask` 模块在上次的引擎裁剪里被关掉了（省包体）。
 * 真要滑动就得把 mask 勾回来 + 用 ScrollView + 重新构建，现在这些说明都不到那个程度。
 */
const DIALOG_MAX_W = 1080;
const DIALOG_H = 170;
/** 对话框离屏幕底边（安全区之外）的留白 */
const DIALOG_MARGIN_BOTTOM = 16;
/** 右侧那列角落按钮占的宽度（给对话框让位用）：按钮宽 + 边距 + 一点间隙 */
const CORNER_COLUMN_W = 132;

/**
 * 左上角那一列：第一行是「会变的数字」（倒计时 / 剩余次数），第二行才是提示按钮。
 * 这两个数决定两行之间的间距 —— 数字那行按 22 号字量，留一点余量给「⏱ 2:59」这种长串。
 */
const STATUS_LINE_H = 32;
const STATUS_GAP = 6;

/** 右上角那个圆形「切换视角」按钮的直径 */
const SWITCH_BUTTON_SIZE = 96;

@ccclass('LevelView')
export class LevelView extends Component {
  @property({ tooltip: '关卡 ID：GUIDE 或 L01~L10' })
  levelId = 'GUIDE';

  /**
   * 把每个热点的 rect 画成半透明框并标出 nodeId，A/B 量坐标时打开。
   *
   * **没有美术图时会自动打开**（见 hasBackdrop）：那种情况下热点是全隐形的，
   * 不画出来玩家只能瞎点。图进了 resources/ 就自动恢复成这个开关说了算。
   */
  @property({ tooltip: '把每个热点的 rect 画成半透明框并标出 nodeId，A/B 量坐标时打开' })
  debugHotspots = false;

  /** duo 模式下视角由服务端指派，客户端不能切；原型阶段先只跑单人 */
  playMode: PlayMode = 'solo';
  initialView: ViewId = 'A';
  roomCode = '';

  /**
   * 关卡有结果时回调一次（通关和失败都会调），参数就是 `getReview()`。
   *
   * 给外层（E 的地图页）接结算用 —— 外面拿它点亮地图节点、切结算页。
   * **失败也会来这一趟**，调用方自己看 `review.status` 分辨。
   *
   * 为什么是属性而不是 Emitter：Emitter 得两边共享同一个实例，而 runtime 是
   * LevelView 自己建的，外层拿不到。挂载方本来就是运行时才决定的，属性最直接。
   *
   * 注意：这个回调是在 runtime 的事件派发**当中**被调用的（见 notifyFinish），
   * 里面不要就地销毁关卡节点 —— 派发还没结束，销毁要排到下一帧（LevelMountView 就是这么做的）。
   */
  onFinish: ((review: LevelReview) => void) | null = null;

  private runtime: LevelRuntime | null = null;
  private config: LevelConfig | null = null;
  private unsubs: Array<() => void> = [];

  private box: Size = { width: 0, height: 0 };
  private originalSize: Size = FALLBACK_ORIGINAL_SIZE;

  private bgSprite: Sprite | null = null;
  private bgNode: Node | null = null;
  private boardLayer: Node | null = null;
  private hotspotNodes = new Map<string, Node>();

  private statusLabel: Label | null = null;
  private lineLabel: Label | null = null;
  /** 对话框整块。平时藏着，点到东西有文字了才出现（见 setDialogText） */
  private dialogNode: Node | null = null;
  /** 对话框里带遮罩的视口 + 可拖动的内容节点，两者配合做「长说明上下滑」 */
  private dialogViewport: Node | null = null;
  private dialogContent: Node | null = null;
  /** 对话框上沿的 y。输入面板只能摆在它上面，不能压上去 */
  private dialogTopY = 0;
  /** 已向下滚了多少（0 = 在最顶上）；拖动过程中上一帧的触点 y */
  private dialogScrollY = 0;
  private dialogDragY: number | null = null;
  private hintButton: Node | null = null;
  private switchButton: Node | null = null;
  /** 右下角的「重玩」。留引用是为了结算层建出来之后能把它抬回最上面（见 refreshOverlay） */
  private restartButton: Node | null = null;
  /**
   * 左下角的「返回」。**只在当前场景配了 backScene 时才出现**（第 2 关的左右岔路图）。
   * 位置是界面定的固定按钮 —— 不占原图坐标，A/B 不用为它量位置。
   */
  private backButton: Node | null = null;
  private overlay: Node | null = null;
  private numberPad: NumberPadView | null = null;
  private formPanel: FormPanelView | null = null;
  private usePanel: UsePanelView | null = null;
  private detailPopup: DetailPopupView | null = null;
  /**
   * nodeId → 特写图的资源 key。
   *
   * 在 mount 时一次收好：`applyState` 每秒都可能来，不该每次都去两个视角的
   * hotspot 数组里翻一遍。
   */
  private detailKeys = new Map<string, string>();
  /** 正在挑东西的那台装置。挑完要把它交回给运行时 */
  private pendingUseNodeId: string | null = null;
  /** 挑的是背包里的道具，还是现场摆着的几个选项 —— 决定挑完调哪个方法 */
  private pendingUseKind: 'item' | 'choice' = 'item';
  /** 正在输密码的那台装置。一关可以有多个密码门，所以记的是「哪一台」而不是「是不是在输密码」 */
  private pendingCodeNodeId: string | null = null;
  /**
   * 打开「关卡自己的输入面板」的那个热点。
   *
   * 面板**默认关着** —— 常驻会挡住大半个场景（第 5 关那个 6 项表单尤其明显），
   * 玩家看不清该点哪儿。点这个热点才弹出来。null 表示没开。
   */
  private levelInputNodeId: string | null = null;
  /** 上次从运行时拿到的输入规格，refreshInputVisibility 要用 */
  private currentSpec: InputSpec | null = null;

  /**
   * 上次配给数字键盘的输入规格。
   *
   * 必须记下来：state:changed 每秒都可能来（倒计时、答错惩罚），
   * 每次都无脑 applySpec 会把玩家刚输的数字清空 —— 输到一半全没了。
   * 只在规格真的变了（换关、重开）时才重新配置。
   */
  private lastInputKey = '';

  /** 未知 key 用 null 表示「试过、没有」，避免每次切视角都重新 load 一遍必然失败的路径 */
  private frameCache = new Map<string, SpriteFrame | null>();

  /**
   * 已经画出来的「视角:场景」，用来判断背景要不要重画。
   *
   * 记的是**场景**而不是视角：第 2 关的 A 视角有 7 张图，视角没变、场景变了
   * 一样得换背景。单场景视角的场景段是空串，等价于以前的「记视角」。
   */
  private renderedSceneKey: string | null = null;

  /**
   * 当前视角有没有真的美术图。
   *
   * 没有图时热点是**完全隐形**的（只挂透明命中框，什么都不画）—— 玩家看到一块
   * 占位底色、不知道该点哪儿，看起来就是「关卡坏了」。所以这种时候无论如何都把
   * 调试框画上（见 paintHotspot）。A/B 的图进了 resources/ 之后自动消失，
   * 不用谁记得回来改开关。
   */
  private hasBackdrop = false;

  /**
   * 云接口。**在浏览器预览 / 离线时是 null** —— 那种情况下游戏照样能玩，
   * 只是不落库。云开发要 E 的 `wx.cloud.init` 跑过才可用。
   *
   * 严格说这类 IO 该单独一层（适配层只该画）；暂时放这里是因为它已经在管
   * `resources.load` 这类外部世界的事。要做双人实时同步时再抽出去。
   */
  private cloud: CloudApi | null = null;

  /**
   * 双人同步。**只有 `playMode === 'duo'` 且拿到房间码时才建**，其余情况是 null。
   *
   * 单人模式下它一直是 null —— 运行时照常发 `sync:out`，没人订阅，等于空转，
   * 行为和加同步之前完全一样（老关卡、单机调试都不受影响）。
   */
  private sync: LevelSync | null = null;

  start(): void {
    this.buildShell();
    const invoker = createWechatCloudInvoker();
    this.cloud = invoker ? new CloudApi(invoker) : null;
    this.loadConfig();
  }

  update(dt: number): void {
    // 核心不起定时器，时间由这里推进 —— 否则单测就得等真实时间
    this.runtime?.tick(dt);
    // 双人同步的拉取节奏也挂在这根时间轴上（每 1 秒一次），单人时 sync 是 null
    this.sync?.tick(dt);
  }

  onDestroy(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
    // 先停同步再退订 —— 反了的话最后那几个操作还没广播出去就被掐了
    this.sync?.stop();
    this.sync = null;
  }

  /**
   * 当前这一关的结算回顾（`LevelRuntime.getReview()` 的转发）。
   * 配置还没加载完时返回 null —— 外层（LevelMountView）拿它处理「中途退出」。
   */
  getReview(): LevelReview | null {
    return this.runtime ? this.runtime.getReview() : null;
  }

  // ---------------------------------------------------------------- 装配

  private buildShell(): void {
    const visible = view.getVisibleSize();
    this.box = { width: visible.width, height: visible.height };

    const ut = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    ut.setAnchorPoint(0.5, 0.5);
    ut.setContentSize(this.box.width, this.box.height);

    // 背景只负责显示，不参与命中判定
    this.bgNode = uiNode('bg', this.node, this.box.width, this.box.height, 0.5, 0.5);
    this.bgSprite = this.bgNode.addComponent(Sprite);
    this.bgSprite.sizeMode = Sprite.SizeMode.CUSTOM;

    // 命中层铺满整屏、原点在屏幕左下角，热点用绝对坐标放进来。
    // 不把热点挂在背景节点下面，是为了让热点位置只依赖「屏幕」这一个参考系：
    // 背景换图、留边变化都不会连带把热点带偏。
    this.boardLayer = uiNode('board', this.node, this.box.width, this.box.height, 0, 0);
    this.boardLayer.setPosition(-this.box.width / 2, -this.box.height / 2, 0);

    // 铺一层「点空白」的接听层，**必须是 board 的第一个子节点**（热点是后面才建的，
    // 所以永远盖在它上面）。
    //
    // 作用是：点在没有热点的地方 → 把对话框收起来。不收的话，上一句反馈（比如
    // 「磁吸杆吸住磁扣…」）会一直挂在屏幕上，玩家点了别处也散不掉。
    //
    // 为什么这样不会误伤热点：Cocos 的触摸只派发给**最上面那个注册了监听的节点**，
    // 热点盖在上面就轮不到这一层。HUD（提示/重玩/切视角/对话框）和输入面板都是
    // 后建的兄弟节点，也都在它上面。
    const emptyClick = uiNode('emptyClick', this.boardLayer, this.box.width, this.box.height, 0, 0);
    emptyClick.on(Node.EventType.TOUCH_END, () => this.setDialogText(''), this);

    this.buildHud();
  }

  private loadConfig(): void {
    const path = levelConfigPath(this.levelId);

    resources.load(path, JsonAsset, null, (err, asset) => {
      if (err || !asset) {
        console.error(`[LevelView] 关卡配置加载失败：${path}`, err);
        this.showFatal(`配置加载失败\n${path}`);
        return;
      }

      let config: LevelConfig;
      try {
        config = parseLevelConfig(asset.json, this.levelId);
      } catch (e) {
        // 配置校验失败在编辑器里是静音的，不打日志会变成「真机白屏、毫无线索」
        console.error('[LevelView] 关卡配置校验失败', e);
        this.showFatal(`配置校验失败\n${(e as Error).message}`);
        return;
      }

      this.config = config;
      this.mount(config);
    });
  }

  private mount(config: LevelConfig): void {
    this.runtime = new LevelRuntime(config, { mode: this.playMode, initialView: this.initialView });
    this.collectDetailKeys(config);

    // 双人同步：本地操作广播出去、对面的操作拉回来应用。
    // **单人（或没拿到房间码 / 离线）时 sync 是 null** —— 那样 `sync:out` 没人收，
    // 运行时照常发，等于空转，行为和不做同步时一模一样。
    if (this.playMode === 'duo' && this.roomCode && this.cloud) {
      this.sync = new LevelSync(
        this.cloud,
        this.roomCode,
        config.levelId,
        (event) => this.runtime?.applyRemote(event),
        (message, error) => console.warn(message, error),
      );
      // begin 是异步的（要广播 start + 探一次流水），探测完之前不会回放任何东西 ——
      // 否则会把上一轮的 result 当成自己的，一进关卡就"通关"
      void this.sync.begin();
    }

    // 注意：这里**不报** level:enter / level:finish 的埋点。
    //
    // event.report 归外层（E 的 AppShellView）—— 只有外层知道 mode 和 roomCode，
    // 双人统计要用；而关卡里报的话两边会各报一次，C 那边一次进关卡记两行。
    // 这个模块只负责**业务上报** level.submit（答案、背包、耗时只有关卡知道）。

    this.unsubs.push(
      this.runtime.on('state:changed', (state) => this.applyState(state)),
      this.runtime.on('line:shown', ({ text }) => this.showLine(text)),
      // 文案由运行时的 showLine 给 —— 它会区分「还剩 N 次」和「N 秒后才能再试」，
      // 这里再写一遍措辞就会两边不同步。视图只负责把这一行染红。
      this.runtime.on('answer:wrong', () => {
        if (this.lineLabel) this.lineLabel.color = COLOR.failed;
      }),
      this.runtime.on('level:success', () => {
        this.flash('通了！', COLOR.success);
        // 操作通关的关（没有 puzzle）：服务端没有可判的答案，靠客户端上报通关。
        // 答题通关的关在提交那一刻已经报过了，这里不重复报
        if (!this.config?.puzzle) this.reportSubmit();
        this.notifyFinish();
      }),
      this.runtime.on('level:failed', ({ reason }) => {
        this.flash(reason === 'timeout' ? '时间到了。' : '次数用完了。', COLOR.failed);
        this.notifyFinish();
      }),
      // 本地操作 → 广播给房间。失败/**对面没人在线**都不影响自己玩下去。
      // 「一人完成 → 全队完成」就是靠对面收到 result 后自己也 succeed 实现的
      this.runtime.on('sync:out', (event) => this.sync?.send(event)),
    );

    this.applyState(this.runtime.getState());
  }

  /**
   * 把结果递给外层。**必须是这两个事件处理里的最后一步。**
   *
   * 顺序上 runtime 发完 level:success / level:failed 之后紧接着还会发一次
   * state:changed（见 LevelRuntime.succeed / tick），所以外层不能在这个回调里
   * 就地拆掉关卡节点 —— 那样 applyState 会在一棵已经拆掉的树上重绘。
   * 要拆就排到下一帧，LevelMountView 就是这么做的。
   *
   * 回调抛错只记日志：外层的问题不该让关卡自己炸掉。
   */
  private notifyFinish(): void {
    const runtime = this.runtime;
    const callback = this.onFinish;
    if (!runtime || !callback) return;
    try {
      callback(runtime.getReview());
    } catch (err) {
      console.error('[LevelView] onFinish 回调抛错：', err);
    }
  }

  // ---------------------------------------------------------------- 渲染

  private applyState(state: LevelViewModel): void {
    // 关卡结束、或者换了画面（切视角 / 换场景），输入面板就该收起来：
    // 前者别盖在结算页上，后者那台装置已经不在当前画面上了。
    // 顺序要在 applyInputSpec 之前 —— 收起密码门后它会把关卡自己的输入控件重新配回来
    const sceneKey = this.sceneKeyOf(state);
    const viewChanged = sceneKey !== this.renderedSceneKey;
    if (state.status !== 'playing' || viewChanged) {
      this.closeUsePanel();
      this.closeCodeGate();
      this.closeLevelInput();
      // 特写图是模态的，本来就挡着换画面；关卡结束时更要收掉，别压在结算层下面
      this.detailPopup?.close();
      // 换了画面：把上一个画面的对话框收起来。那句话是**那边**看到的反馈，
      // 换过来还挂在屏幕上，玩家会以为新画面也有这条线索。
      // **只清换画面这一支** —— 「结束后」那支不能清，结算前的「通了！」flash
      // 就是在那之后写进对话框的，一起清会把它抹掉
      if (viewChanged) this.setDialogText('');
    }

    this.applyInputSpec(state);

    // 换画面（视角或场景）要换背景图，是重活；其余状态变化只更新热点和 HUD
    if (sceneKey !== this.renderedSceneKey) {
      this.renderedSceneKey = sceneKey;
      this.renderView(state);
      return;
    }

    this.syncHotspots(state.hotspots);
    this.refreshHud(state);
    this.refreshOverlay(state);
  }

  /**
   * 把一次提交报给服务端。
   *
   * **失败只记日志，绝不拦玩家** —— 离线、没 init、云函数挂了，游戏都得能玩完。
   * 服务的判定是"落库"和"防改包"的事，不是"能不能玩"的事。
   */
  private reportSubmit(answer?: CloudAnswer): void {
    const runtime = this.runtime;
    this.fireAndForget(() =>
      this.cloud?.submit({
        levelId: this.levelId,
        ...(answer === undefined ? {} : { answer }),
        // 服务端拿不到背包，配了 requiredItems 的关要客户端如实上报
        inventory: runtime ? runtime.getInventory().map((item) => item.itemId) : [],
        // 服务端按毫秒算；本次用时取结算回顾里的值
        elapsedMs: runtime ? Math.round(runtime.getReview().elapsedSec * 1000) : undefined,
        ...(this.roomCode ? { code: this.roomCode } : {}),
      }),
    );
  }

  /** 发一个不阻塞游玩的请求：失败了记一条日志就完 */
  private fireAndForget(send: () => Promise<unknown> | undefined): void {
    try {
      const pending = send();
      if (pending) {
        pending.catch((err) => console.warn('[LevelView] 云请求失败（不影响本地游玩）', err));
      }
    } catch (err) {
      console.warn('[LevelView] 云请求抛异常（不影响本地游玩）', err);
    }
  }

  /** 输入控件的重配只在规格真的变了时才做，见 lastInputKey 的注释 */
  private applyInputSpec(state: LevelViewModel): void {
    const spec = state.input;
    // 键里带上空名：字段数量一样但名字换了（换关）时也要重配
    const key = `${spec.kind}:${spec.digitCount}:${spec.fields.map((f) => f.label).join(',')}`;
    if (key !== this.lastInputKey) {
      this.lastInputKey = key;
      this.currentSpec = spec;
      // 关卡自己的键盘不能「返回」关掉（它不是密码门）—— closable 传 false
      this.numberPad?.applySpec(spec, false);
      this.formPanel?.applySpec(spec);
      // 面板尺寸是 applySpec 时才定下来的（字段数决定高度），所以摆位要跟在后面
      if (this.numberPad) this.layoutInputPanel(this.numberPad.node);
      if (this.formPanel) this.layoutInputPanel(this.formPanel.node);
    }
    this.refreshInputVisibility();
  }

  /**
   * 把输入面板摆进「屏幕顶 → 对话框顶」这块空档，**放不下就整体缩一点**。
   *
   * 为什么不能只居中：设计分辨率是 Cocos 默认的 960×640，对话框占了底下 170，
   * 剩下的空间装不下所有面板 —— 第 5 关那个 6 项表单有 508 高，比空档还高，
   * 居中的结果就是**上面顶出屏幕、下面压住对话框**。
   *
   * 缩放而不是改面板内部尺寸：面板的高度是它自己的布局算出来的（按钮行数 × 行高），
   * 在关卡层改不了；整体缩一下最简单，也不会让面板内部的排版走样。
   * 缩到 0.7 左右按钮还有 40 多像素高，点得动。
   */
  private layoutInputPanel(node: Node): void {
    const top = this.box.height / 2 - this.insets().top;
    const bottom = this.dialogTopY;
    const available = Math.max(1, top - bottom);
    const height = Math.max(1, node.getComponent(UITransform)!.height);
    const scale = height > available ? available / height : 1;
    node.setScale(scale, scale, 1);
    node.setPosition(0, (top + bottom) / 2, 0);
  }

  /**
   * 输入面板的显隐统一在这里决定。
   *
   * **默认全关着**：面板常驻会挡住大半个场景，玩家看不清该点哪儿。
   * 密码门优先 —— 它开着的时候，关卡自己的面板让位。
   */
  private refreshInputVisibility(): void {
    if (!this.numberPad || !this.formPanel) return;

    if (this.pendingCodeNodeId) {
      this.numberPad.node.active = true;
      this.formPanel.node.active = false;
      return;
    }

    const kind = this.currentSpec ? this.currentSpec.kind : 'none';
    const open = this.levelInputNodeId !== null;
    this.numberPad.node.active = open && kind === 'numberpad';
    this.formPanel.node.active = open && kind === 'form';
  }

  private openLevelInput(nodeId: string): void {
    this.closeUsePanel();
    this.closeCodeGate();
    this.levelInputNodeId = nodeId;
    this.refreshInputVisibility();
  }

  private closeLevelInput(): void {
    if (this.levelInputNodeId === null) return;
    this.levelInputNodeId = null;
    this.refreshInputVisibility();
  }

  private onNumberPadSubmit(digits: string[]): void {
    const runtime = this.runtime;
    if (!runtime) return;

    // 键盘可能是在给某台装置输密码（一关可以有多个密码门），
    // 也可能是在答关卡自己的题 —— 靠 pendingCodeNodeId 区分
    const codeNodeId = this.pendingCodeNodeId;
    if (codeNodeId) {
      const result = runtime.useCode(codeNodeId, digits);

      // 输错了就把位数清空、键盘留着 —— 玩家直接重输就行。
      // 收掉键盘的话他得再点一次那个装置，白多一步
      if (!result.ok && result.reason === 'rejected') {
        this.numberPad?.reset();
        return;
      }

      this.closeCodeGate();
      if (!result.ok) {
        if (result.reason === 'not-usable') this.flash('这里不用输密码。', COLOR.textDim);
        // 罚站期间提交（键盘还没关）—— 明说还剩几秒，不然玩家以为键盘坏了
        if (result.reason === 'cooldown') {
          this.flash(`还要等 ${this.runtime?.getState().cooldownLeftSec ?? 0} 秒。`, COLOR.textDim);
        }
        return;
      }
      // 密码对了：这台装置配了特写图的话弹出来（和道具门那条路一致）
      this.openDetail(codeNodeId);
      return;
    }

    // 数字密码是**有序**答案，所以按数组形状交
    this.reportSubmit(digits);
    if (runtime.submit(digits)) return;

    // 没通过就把键盘清空：密码盒的惯例是错一次全部重输，
    // 而且清空后玩家能立刻看出「可以重来了」
    this.numberPad?.reset();
  }

  /**
   * 打开一台带密码的装置。复用同一个数字键盘，只是把提交目标换成那台装置。
   *
   * 位数由运行时给（`digitCount`）—— 界面拿不到 code 本身，也不该拿。
   */
  private openCodeGate(nodeId: string, digitCount: number, prompt: string): void {
    this.closeUsePanel();
    this.pendingCodeNodeId = nodeId;
    this.numberPad?.applySpec({ kind: 'numberpad', digitCount, fields: [] }, true);
    // **必须自己刷一次可见性。**
    //
    // 光设 pendingCodeNodeId 不够：键盘节点是在 buildHud 里被置成 active=false 的，
    // 只有 refreshInputVisibility 会把它点亮。而这条路不会再等来一次 state:changed ——
    // 运行时的 click() 处理 use 热点时是提前 return 的（只报「可以输入了」，不广播状态），
    // tick() 又只在**显示的秒数变化**时才广播，可现在 10 关一个倒计时都没有。
    // 少了这一行，点密码门就是永远弹不出键盘。
    this.refreshInputVisibility();
    // 键盘面板没有标题位，所以把那句话写进线索栏 —— 不然玩家不知道在给什么输密码
    if (prompt) this.showLine(prompt);
  }

  private closeCodeGate(): void {
    if (!this.pendingCodeNodeId) return;
    this.pendingCodeNodeId = null;
    // 密码门关掉后要把键盘还给关卡自己：逼 applyInputSpec 重新配一遍。
    // 不重置 lastInputKey 的话它以为规格没变，会一直显示密码门的位数
    this.lastInputKey = '';
    const state = this.runtime?.getState();
    if (state) this.applyInputSpec(state);
    this.numberPad?.reset();
  }

  /** 列出背包里的道具让玩家挑。不告诉玩家哪件对 —— 那等于把答案摆在界面上 */
  private openUsePanel(nodeId: string, prompt: string): void {
    const runtime = this.runtime;
    if (!runtime) return;
    this.pendingUseNodeId = nodeId;
    this.pendingUseKind = 'item';
    // text 给玩家看名字，key 才是交回去的 id
    const options = runtime.getInventory().map((item) => ({ text: item.name, key: item.itemId }));
    this.usePanel?.open(prompt || '用哪件东西？', options);
    // 面板高度随选项个数变，所以摆位要跟在 open 之后（同一套：摆进空档、放不下就缩）
    if (this.usePanel) this.layoutInputPanel(this.usePanel.node);
  }

  /** 现场摆着几个选项，选一个（三条岔路、三张通知）。选项本身是看得见的，哪个对不告诉 */
  private openChoiceGate(nodeId: string, choices: string[], prompt: string): void {
    this.pendingUseNodeId = nodeId;
    this.pendingUseKind = 'choice';
    this.usePanel?.open(prompt || '选哪个？', choices.map((choice) => ({ text: choice, key: choice })));
    if (this.usePanel) this.layoutInputPanel(this.usePanel.node);
  }

  private onUsePick(value: string): void {
    const runtime = this.runtime;
    const nodeId = this.pendingUseNodeId;
    const kind = this.pendingUseKind;
    this.closeUsePanel();
    if (!runtime || !nodeId) return;

    // 挑错时运行时已经把 rejectText 写进 lastLine 了，这里不再补一句。
    // 只有它不吭声的几种情况才需要界面出声
    const result = kind === 'choice' ? runtime.useChoice(nodeId, value) : runtime.useItem(nodeId, value);
    if (result.ok) {
      // 用成功了才弹特写图（「翻开之后才看得清」那种场景，见 detailKey 的注释）
      this.openDetail(nodeId);
      return;
    }
    if (result.reason === 'already-done') this.flash('这里已经处理过了。', COLOR.textDim);
    if (result.reason === 'not-usable') this.flash('这里用不了。', COLOR.textDim);
    if (result.reason === 'cooldown') {
      this.flash(`还要等 ${runtime.getState().cooldownLeftSec} 秒。`, COLOR.textDim);
    }
  }

  private closeUsePanel(): void {
    this.pendingUseNodeId = null;
    this.usePanel?.close();
  }

  /** 把配置里所有配了 detailKey 的热点收成一张表，点击时按 nodeId 查 */
  private collectDetailKeys(config: LevelConfig): void {
    this.detailKeys.clear();
    for (const viewId of ['A', 'B'] as ViewId[]) {
      const view = config.views[viewId];
      if (!view) continue;
      for (const hotspot of view.hotspots) {
        if (hotspot.detailKey) this.detailKeys.set(hotspot.nodeId, hotspot.detailKey);
      }
    }
  }

  /**
   * 弹某个热点的特写图。
   *
   * 两处触发（见 LevelTypes 里 detailKey 的注释）：
   * - `inspect` 点击时 —— 在 onHotspotClick 里
   * - `use` **操作成功后** —— 在 onUsePick / 密码门那支里
   * 所以这个方法只负责「有就弹」，不管时机。没配就什么都不做。
   */
  private openDetail(nodeId: string): void {
    const key = this.detailKeys.get(nodeId);
    if (key) this.detailPopup?.open(key);
  }

  private onFormSubmit(values: Record<string, string>): void {
    const runtime = this.runtime;
    if (!runtime) return;

    // 表单是**按键**答案（顺序无关），按对象形状交
    this.reportSubmit(values);
    if (runtime.submit(values)) return;

    this.formPanel?.reset();
  }

  /** 「视角:场景」——背景重画的判据（见 renderedSceneKey） */
  private sceneKeyOf(state: LevelViewModel): string {
    return `${state.currentView}:${state.sceneId ?? ''}`;
  }

  private renderView(state: LevelViewModel): void {
    const config = this.config;
    if (!config) return;

    // 背景图由运行时按「当前场景」算好放在 state.assetKey 里，界面不自己去翻配置
    const assetKey = state.assetKey;
    const sceneKey = this.sceneKeyOf(state);

    this.loadFrame(assetKey, (frame) => {
      // 换图是异步的。加载期间玩家又换了一次画面（切视角或走岔路）的话，
      // 这次回调已经过期 —— 照画下去会把背景换成上一张图。
      // 缓存命中时不会发生（同步回调），只在第一次加载某张图时才会露出来
      if (this.renderedSceneKey !== sceneKey) return;

      // 有真图就以真图的像素为准，没有就用兜底基准 —— 这样 A/B 把图丢进
      // resources/ 之后不需要改任何配置，热点的换算基准会自动跟着变
      this.originalSize = frame
        ? { width: frame.originalSize.width, height: frame.originalSize.height }
        : FALLBACK_ORIGINAL_SIZE;
      // 必须在 syncHotspots 之前 —— 它要靠这个决定画不画调试框
      this.hasBackdrop = frame !== null;

      this.layoutBackground(frame, assetKey);
      this.syncHotspots(state.hotspots);
      this.refreshHud(state);
      this.refreshOverlay(state);
    });
  }

  private layoutBackground(frame: SpriteFrame | null, assetKey: string): void {
    const bg = this.bgNode;
    if (!bg) return;

    // contain：整张图都看得见。不能用 cover，被裁掉的区域热点就点不到了
    const content = fitContain(this.originalSize, this.box);
    const ut = bg.getComponent(UITransform)!;
    ut.setContentSize(content.w, content.h);

    // 屏幕中心为原点，把图摆到 contain 算出来的位置
    bg.setPosition(
      content.x + content.w / 2 - this.box.width / 2,
      content.y + content.h / 2 - this.box.height / 2,
      0,
    );

    if (frame && this.bgSprite) {
      this.bgSprite.spriteFrame = frame;
      this.clearNodes(bg, ['placeholder']);
      return;
    }

    this.drawPlaceholder(bg, content, assetKey);
  }

  /**
   * 美术还没出图时的占位：一块底色 + 期望的 assetKey + 四角标记。
   * 四角标记是为了让「坐标系有没有搞反」一眼可见 —— 光看一个纯色块，
   * 上下颠倒和正常渲染长得一模一样。
   */
  private drawPlaceholder(bg: Node, content: LocalRect, assetKey: string): void {
    if (this.bgSprite) this.bgSprite.spriteFrame = null;
    this.clearNodes(bg, ['placeholder']);

    const holder = uiNode('placeholder', bg, content.w, content.h, 0.5, 0.5);
    const g = holder.addComponent(Graphics);

    g.fillColor = COLOR.placeholderBg;
    g.rect(-content.w / 2, -content.h / 2, content.w, content.h);
    g.fill();

    g.strokeColor = COLOR.placeholderEdge;
    g.lineWidth = 3;
    g.rect(-content.w / 2, -content.h / 2, content.w, content.h);
    g.stroke();

    // 四角各画一个 L 形标记：方向对不对看这个。
    // 光看一块纯色，上下颠倒在视觉上没有区别，而翻 y 恰好是这套换算里最容易错的一步。
    const arm = Math.min(content.w, content.h) * 0.06;
    g.strokeColor = COLOR.placeholderEdge;
    g.lineWidth = 8;
    const hw = content.w / 2;
    const hh = content.h / 2;
    // [角点 x, 角点 y, 指向图内的 x 方向, 指向图内的 y 方向]
    const corners: Array<[number, number, number, number]> = [
      [-hw, -hh, 1, 1],
      [hw, -hh, -1, 1],
      [-hw, hh, 1, -1],
      [hw, hh, -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      g.moveTo(cx + dx * arm, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy + dy * arm);
    }
    g.stroke();

    addLabel(holder, 'placeholderHint', `占位图\n${assetKey}`, 26, COLOR.placeholderText, 0.5, 0.5);
  }

  private loadFrame(assetKey: string, onDone: (frame: SpriteFrame | null) => void): void {
    const cached = this.frameCache.get(assetKey);
    if (cached !== undefined) {
      onDone(cached);
      return;
    }

    resources.load(assetKey, SpriteFrame, null, (err, frame) => {
      if (!err && frame) {
        this.frameCache.set(assetKey, frame);
        onDone(frame);
        return;
      }

      // 图存在但导入类型不是 sprite-frame 时会走到这里。再按 ImageAsset 取一次
      // 并手工包成 SpriteFrame，省得 A/B 为了一个导入类型去编辑器里点一遍。
      resources.load(assetKey, ImageAsset, null, (imgErr, image) => {
        if (imgErr || !image) {
          console.warn(
            `[LevelView] 找不到图 ${assetKey}，先用占位图顶上。` +
              'A/B 把图按这个 key 命名放进 assets/resources/ 下即可自动替换。',
            err,
          );
          this.frameCache.set(assetKey, null);
          onDone(null);
          return;
        }

        const wrapped = SpriteFrame.createWithImage(image);
        this.frameCache.set(assetKey, wrapped);
        onDone(wrapped);
      });
    });
  }

  /**
   * 只增删变化了的热点，不整层重建。
   * state:changed 在倒计时关卡里每秒都会来一次，每次重建一遍节点会白白抖一屏。
   */
  private syncHotspots(spots: HotspotRuntime[]): void {
    const layer = this.boardLayer;
    if (!layer) return;

    const alive = new Set<string>();

    for (const spot of spots) {
      alive.add(spot.nodeId);

      let node = this.hotspotNodes.get(spot.nodeId);
      if (!node) {
        node = this.createHotspotNode(spot);
        this.hotspotNodes.set(spot.nodeId, node);
      }

      const rect = mapRectIntoBox(spot.rect, this.originalSize, this.box);
      node.setPosition(rect.x, rect.y, 0);
      node.getComponent(UITransform)!.setContentSize(rect.w, rect.h);

      this.paintHotspot(node, spot);
    }

    for (const [nodeId, node] of this.hotspotNodes) {
      if (alive.has(nodeId)) continue;
      this.destroyNode(node);
      this.hotspotNodes.delete(nodeId);
    }
  }

  private createHotspotNode(spot: HotspotRuntime): Node {
    const layer = this.boardLayer!;
    const node = uiNode(`hs_${spot.nodeId}`, layer, 10, 10, 0, 0);

    // 热点的调试框挂在热点自己身上：这样它天然跟着热点走，不用另外同步一遍坐标
    const debug = uiNode('debug', node, 10, 10, 0, 0);
    debug.addComponent(Graphics);
    addLabel(debug, 'debugId', spot.nodeId, 18, COLOR.text, 0, 1);

    node.on(Node.EventType.TOUCH_END, () => this.onHotspotClick(spot.nodeId), this);
    return node;
  }

  private paintHotspot(node: Node, spot: HotspotRuntime): void {
    const ut = node.getComponent(UITransform)!;
    const w = ut.width;
    const h = ut.height;

    const debug = node.getChildByName('debug')!;
    // 没有真图时强制画出来：那种情况下热点是全隐形的，不画玩家就只能瞎点。
    // 有图时按 debugHotspots 走 —— 那是 A/B 量坐标用的开关，不受这里影响。
    const showBox = this.debugHotspots || !this.hasBackdrop;
    debug.active = showBox;

    // 点不动的热点在调试模式下也要画出来 —— 那种「配置里写了、界面上却没有」
    // 的节点正是 A/B 量坐标时最需要看见的
    if (showBox) {
      const idLabel = debug.getChildByName('debugId')!.getComponent(Label)!;
      idLabel.string = spot.enabled ? spot.nodeId : `${spot.nodeId}（点不动）`;
      idLabel.color = spot.enabled ? COLOR.text : COLOR.textDim;
      debug.getComponent(UITransform)!.setContentSize(w, h);
      debug.setPosition(0, 0, 0);
      debug.getChildByName('debugId')!.setPosition(2, h - 2, 0);

      const g = debug.getComponent(Graphics)!;
      g.clear();
      g.fillColor = spot.done ? COLOR.hotspotDone : spot.enabled ? COLOR.hotspotOn : COLOR.hotspotOff;
      g.rect(0, 0, w, h);
      g.fill();
      g.strokeColor = spot.enabled ? COLOR.hotspotOn : COLOR.hotspotOff;
      g.lineWidth = 2;
      g.rect(0, 0, w, h);
      g.stroke();
    }

    node.active = true;
  }

  // ---------------------------------------------------------------- HUD

  /**
   * 屏幕安全区（刘海 / 状态栏 / home 指示条）。
   *
   * HUD 一律按它往里让 —— 横屏手机上，贴着屏幕最上沿的控件会压在状态栏里看不见、
   * 最下沿的会跟 home 指示条抢，这是「关卡不适配」的主要来源。
   */
  private insets(): SafeInsets {
    return safeInsets(this.box.width, this.box.height);
  }

  /**
   * 界面骨架。
   *
   * 布局是「一框 + 四角」，没有横贯屏幕的栏：
   *
   * ```
   * ┌──────────────────────────────────────┐
   * │ ⏱ 1:23                     ╭───╮    │ ← 左上第一行：会变的数字（无底色）
   * │ 提示                        │切换│    │ ← 左上第二行：提示按钮
   * │                            │视角│    │ ← 右上：圆形切视角
   * │            （场景图）                  │
   * │                                      │
   * │   ╭──────────────────────────╮       │
   * │   │  磁吸杆吸住磁扣，海报翻起来…  │       │ ← 底部：对话框
   * │   ╰──────────────────────────╯ 重玩   │ ← 右下：重玩在「退出」上面
   * │                                 退出   │
   * └──────────────────────────────────────┘
   * ```
   *
   * 左上角是**上下两行**（2026-10-07 试玩要求）：数字在上、提示在下。
   * 原来是并排的（数字挤在提示右边），倒计时一上线，玩家第一眼该看到的就是剩余时间，
   * 所以把它提到最上面一行、提示往下让。
   *
   * **对话框平时是藏着的**，只有点到东西（有反馈文字）才出现 —— 见 setDialogText。
   *
   * 原来那条顶部灰栏删掉了：它把「关卡名 / 倒计时 / 剩余次数 / 视角」全挤在一条上，
   * 而其中一半是没有意义的 —— 10 关没有一个配了倒计时，而「剩余 N 次」对
   * **操作通关**的关更是误导（那种关没有可答错的提交，次数永远是满的）。
   * 现在只把**真会变、且玩家必须看到**的两个数留在左上角：限时关的倒计时、
   * 有答案的关的剩余次数。视角不显示 —— 玩家看画面就知道自己在哪个视角。
   */
  private buildHud(): void {
    const inset = this.insets();
    const w = this.box.width;
    const h = this.box.height;

    // 左上角竖着两行：**数字在上、提示按钮在下**（2026-10-07 试玩要求）。
    // 两者左边缘对齐（leftX），看起来是一列
    const leftX = -w / 2 + inset.left + CORNER_MARGIN;
    const topY = h / 2 - inset.top - CORNER_MARGIN;

    // 会变的数字（倒计时 / 剩余次数 / 罚站），无底色。没数字时整个隐藏（见 refreshHud）。
    // 用 (0, 0.5) 锚点：左边缘贴齐 leftX，往下长
    this.statusLabel = addLabel(this.node, 'status', '', 22, COLOR.text, 0, 0.5);
    this.statusLabel.node.setPosition(leftX, topY - STATUS_LINE_H / 2, 0);

    // 提示按钮：在数字下面一行（和右侧那列按钮同一套尺寸和边距）。
    // 固定摆在这个位置，不随「有没有数字」上下跳 —— 跳来跳去比留一行空白更烦人
    this.hintButton = makeButton(
      this.node,
      'hint',
      '提示',
      CORNER_COLUMN_W,
      CORNER_BUTTON_H,
      leftX + CORNER_COLUMN_W / 2,
      topY - STATUS_LINE_H - STATUS_GAP - CORNER_BUTTON_H / 2,
      () => this.onHintClick(),
    );

    // 右上角：圆形「切换视角」。不写 A / B —— 那是内部标识，玩家从画面就能分辨视角
    this.switchButton = makeCircleButton(
      this.node,
      'switch',
      '切换视角',
      SWITCH_BUTTON_SIZE,
      w / 2 - inset.right - CORNER_MARGIN - SWITCH_BUTTON_SIZE / 2,
      h / 2 - inset.top - CORNER_MARGIN - SWITCH_BUTTON_SIZE / 2,
      () => this.onSwitchViewClick(),
    );

    // 底部：对话框。宽度从屏幕宽里扣掉右边那列按钮的位置，再取个上限
    const dialogW = Math.min(
      w - 2 * (inset.left + CORNER_MARGIN + CORNER_COLUMN_W + 16),
      DIALOG_MAX_W,
    );
    const dialogY = -h / 2 + inset.bottom + DIALOG_MARGIN_BOTTOM + DIALOG_H / 2;
    // 输入面板要摆在「屏幕顶 → 对话框顶」之间，这里记下上界给 layoutInputPanel 用
    this.dialogTopY = dialogY + DIALOG_H / 2;

    const dialog = uiNode('dialog', this.node, dialogW, DIALOG_H, 0.5, 0.5);
    dialog.setPosition(0, dialogY, 0);
    // **平时是藏着的**：只有点到东西、有反馈文字时才出现（见 setDialogText）
    dialog.active = false;
    this.dialogNode = dialog;
    const dg = dialog.addComponent(Graphics);
    dg.fillColor = COLOR.panelBg;
    dg.roundRect(-dialogW / 2, -DIALOG_H / 2, dialogW, DIALOG_H, 14);
    dg.fill();
    dg.strokeColor = COLOR.buttonEdge;
    dg.lineWidth = 2;
    dg.roundRect(-dialogW / 2, -DIALOG_H / 2, dialogW, DIALOG_H, 14);
    dg.stroke();

    // 反馈文字放在一个**带遮罩的视口**里，可以上下拖 —— 说明太长就滑着看。
    //
    // 结构：dialog（圆角面板）→ viewport（Mask 裁切）→ content（拖它就是在滚）→ 文字。
    //
    // 为什么手写拖动、不用 ScrollView：ScrollView 对节点结构有要求（view / content
    // 的名字和层级），从代码里搭就得赌它的内部约定，而我没法在这里验。
    // 这点滚动自己写只要十几行，行为完全可控。
    const pad = 20;
    const viewW = dialogW - pad * 2;
    const viewH = DIALOG_H - pad * 2;

    this.dialogViewport = uiNode('viewport', dialog, viewW, viewH, 0.5, 0.5);
    const mask = this.dialogViewport.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT;

    // 内容节点锚点在**顶边**：文字从上往下长，往下拖就是看后面的
    this.dialogContent = uiNode('content', this.dialogViewport, viewW, viewH, 0.5, 1);
    this.dialogContent.setPosition(0, viewH / 2, 0);

    this.lineLabel = addLabel(this.dialogContent, 'line', '', 24, COLOR.text, 0.5, 1);
    const lineUt = this.lineLabel.node.getComponent(UITransform)!;
    lineUt.setContentSize(viewW, 10);
    // RESIZE_HEIGHT：宽度定死、高度随内容长（配合遮罩就是「能滚的长文本」）
    this.lineLabel.overflow = Label.Overflow.RESIZE_HEIGHT;
    this.lineLabel.enableWrapText = true;
    // **靠左对齐**（`addLabel` 默认是居中，这里改掉）。
    // 对话框的正文一律左对齐：折行之后每行的起头在同一个地方，比居中的参差边缘好读
    this.lineLabel.horizontalAlign = Label.HorizontalAlign.LEFT;

    // 拖动滚动。**顺带挡掉盖住的热点** —— 对话框压着的地方不该还能点到东西
    dialog.on(
      Node.EventType.TOUCH_START,
      (event: EventTouch) => {
        this.dialogDragY = event.getUILocation().y;
      },
      this,
    );
    dialog.on(
      Node.EventType.TOUCH_MOVE,
      (event: EventTouch) => {
        if (this.dialogDragY === null) return;
        const y = event.getUILocation().y;
        this.scrollDialog(y - this.dialogDragY);
        this.dialogDragY = y;
      },
      this,
    );
    const endDrag = () => {
      this.dialogDragY = null;
    };
    dialog.on(Node.EventType.TOUCH_END, endDrag, this);
    dialog.on(Node.EventType.TOUCH_CANCEL, endDrag, this);

    // 右下角：「重玩」。**要在「退出」上面** —— 退出是挂载层放的（同一套角落算法，
    // 它占 slot 0，这里占 slot 1），两个文件用同一个 cornerY 算，位置才对得上
    this.restartButton = makeButton(
      this.node,
      'restart',
      '重玩',
      132,
      CORNER_BUTTON_H,
      w / 2 - inset.right - CORNER_MARGIN - 66,
      cornerY(h, inset, 1),
      () => this.onRestartClick(),
    );

    // 左下角：「返回」（第 2 关的左右岔路图用）。和「重玩」同一行高度、左右对称。
    // 显隐由 refreshHud 按 state.backSceneId 决定 —— 没有返回出口的场景不显示
    this.backButton = makeButton(
      this.node,
      'back',
      '返回',
      132,
      CORNER_BUTTON_H,
      -w / 2 + inset.left + CORNER_MARGIN + 66,
      cornerY(h, inset, 1),
      () => this.onBackClick(),
    );
    this.backButton.active = false;

    // 输入面板（数字键盘 / 表单 / 道具列表）摆在「屏幕顶到对话框顶」这条空档的正中。
    // 不写死绝对坐标：面板一高（第 5 关那个 6 项表单）就会压到对话框上
    const inputY = (h / 2 + (dialogY + DIALOG_H / 2)) / 2;

    this.numberPad = new NumberPadView(
      this.node,
      (digits) => this.onNumberPadSubmit(digits),
      () => this.closeCodeGate(),
    );
    this.numberPad.node.setPosition(0, inputY, 0);
    this.numberPad.node.active = false;

    this.formPanel = new FormPanelView(
      this.node,
      (values) => this.onFormSubmit(values),
      () => this.flash('还有空没选。', COLOR.textDim),
    );
    this.formPanel.node.setPosition(0, inputY, 0);
    this.formPanel.node.active = false;

    // 道具选择面板也是按下才出现，而且平时不占位置
    this.usePanel = new UsePanelView(
      this.node,
      (itemId) => this.onUsePick(itemId),
      () => this.closeUsePanel(),
    );
    this.usePanel.node.setPosition(0, 0, 0);

    // 特写图弹窗。图片加载直接借用本文件的 loadFrame —— 缓存和
    // 「SpriteFrame 取不到就按 ImageAsset 再取一次」那套兜底都是现成的
    this.detailPopup = new DetailPopupView(this.node, (key, onDone) => this.loadFrame(key, onDone));
  }

  private refreshHud(state: LevelViewModel): void {
    // 左上角只放**会变、且玩家必须看到**的数字，没有就整条不显示。
    // 刻意不显示的三样：
    //   - 关卡名：进场时玩家看得见（结算层也会显示），常驻是噪音
    //   - 「不限时」：绝大多关都没有时限，写「不限时」等于占地方
    //   - 视角：画面本身就是两个视角的区别，写「视角 A」是把内部标识给玩家看
    const bits: string[] = [];
    if (state.timeLeftSec !== null) {
      const m = Math.floor(state.timeLeftSec / 60);
      const s = state.timeLeftSec % 60;
      bits.push(`⏱ ${m}:${s < 10 ? '0' : ''}${s}`);
    }
    // 剩余次数只对**有答案的关**有意义。操作通关的关没有可答错的提交，
    // 次数永远是满的 —— 显示出来只会让玩家以为「我还有几次能瞎点」
    if (this.config?.puzzle) bits.push(`剩余 ${state.attemptsLeft} 次`);
    // 罚站倒计时**和 puzzle 无关**：第 1 关的工具盒也会罚站（hotspot.wrongCooldownSec），
    // 那一关没有 puzzle —— 不单独拎出来，玩家被罚了却看不见还剩几秒
    if (state.cooldownLeftSec > 0) bits.push(`⏳ ${state.cooldownLeftSec}s`);

    if (this.statusLabel) {
      this.statusLabel.string = bits.join('   ');
      this.statusLabel.node.active = bits.length > 0;
    }

    if (this.hintButton) {
      const label = this.hintButton.getChildByName('text')!.getComponent(Label)!;
      label.string = state.hintsRemaining > 0 ? `提示 (${state.hintsRemaining})` : '提示已用完';
      this.hintButton.active = state.status === 'playing';
    }

    // 「切换视角」四个字是固定的，不显示切到哪个视角（也就没有要刷的文案）
    if (this.switchButton) {
      this.switchButton.active = state.canSwitchView && state.status === 'playing';
    }

    // 「返回」只在当前场景配了 backScene 时出现（第 2 关的左右岔路图）
    if (this.backButton) {
      this.backButton.active = state.status === 'playing' && state.backSceneId !== null;
    }

    // 运行时说「没有当前这句话了」（重开、切视角）→ 把对话框收起来，
    // 屏幕上不留一个空框
    if (this.lineLabel && state.lastLine === null) {
      this.setDialogText('');
    }
  }

  /**
   * 往对话框写一句话；空串把整个对话框收起来。
   *
   * **对话框只在点到东西之后才出现** —— 玩家什么都没点的时候，屏幕上不该挂着一个空框。
   * 所以所有写文字的地方（运行时推来的 line:shown、界面的 flash）都走这里，
   * 由它统一决定显隐。
   */
  private setDialogText(text: string, color?: Color): void {
    if (!this.lineLabel) return;
    this.lineLabel.string = text;
    if (color) this.lineLabel.color = color;
    if (this.dialogNode) this.dialogNode.active = text.length > 0;
    this.resetDialogScroll(text);
  }

  /**
   * 估一段文字排完有多高。
   *
   * **为什么要估、不让 Label 自己算**：`Overflow.RESIZE_HEIGHT` 是**渲染时**才更新
   * 节点高度的 —— 设完 `string` 当场读到的还是旧值，而滚动范围必须立刻知道（不然
   * 换一句新的话，上一次的滚动位置还在，玩家会看到半截空白）。
   *
   * 估法：汉字按「一个字宽 = 一个字号」算，显式换行也算一行，最后**多估半行** ——
   * 底部多留一点空白无害，少估了最后一行会被遮罩裁掉。
   */
  private estimateTextHeight(text: string, width: number, fontSize: number): number {
    const lineHeight = fontSize * 1.3;
    const perLine = Math.max(1, Math.floor(width / fontSize));
    let lines = 0;
    for (const paragraph of text.split('\n')) {
      lines += Math.max(1, Math.ceil(paragraph.length / perLine));
    }
    return (lines + 0.5) * lineHeight;
  }

  /** 换了一句新的话：内容高度重算、滚动位置回到顶部 */
  private resetDialogScroll(text: string): void {
    const content = this.dialogContent;
    const viewport = this.dialogViewport;
    if (!content || !viewport) return;
    const viewUt = viewport.getComponent(UITransform)!;
    const contentUt = content.getComponent(UITransform)!;
    const height = this.estimateTextHeight(text, viewUt.width, this.lineLabel?.fontSize ?? 24);
    contentUt.setContentSize(viewUt.width, Math.max(viewUt.height, height));
    this.dialogScrollY = 0;
    content.setPosition(0, viewUt.height / 2, 0);
  }

  /** 按拖动量滚动内容。往上拖 = 看后面的，滚到两头就停住 */
  private scrollDialog(deltaY: number): void {
    const content = this.dialogContent;
    const viewport = this.dialogViewport;
    if (!content || !viewport) return;
    const viewH = viewport.getComponent(UITransform)!.height;
    const contentH = content.getComponent(UITransform)!.height;
    const max = Math.max(0, contentH - viewH);
    this.dialogScrollY = Math.min(max, Math.max(0, this.dialogScrollY + deltaY));
    content.setPosition(0, viewH / 2 + this.dialogScrollY, 0);
  }

  private showLine(text: string): void {
    if (!this.lineLabel) return;
    // 颜色一起复位：上一次 flash 的红色可能还挂着定时器没到点，
    // 不复位的话紧接着读到的正常线索会以「报错红」显示
    this.setDialogText(text, COLOR.text);
  }

  private flash(text: string, color: Color): void {
    if (!this.lineLabel) return;
    this.setDialogText(text, color);
    // 闪一下再回到常规色，否则「已提示的文字」会一直带着错误提示的红色
    this.scheduleOnce(() => {
      if (this.lineLabel) this.lineLabel.color = COLOR.text;
    }, 1.5);
  }

  private refreshOverlay(state: LevelViewModel): void {
    // **只有失败才画 D 自己的结算层**：
    // - playing：本来就不该有
    // - success：2026-10-07 试玩要求删掉了 —— 通关直接交给 E 的结算页
    //   （`LevelMountView` 的 handoff 延时是 0）。E 那页已经有「本次用时 /
    //   最好用时 / 收集线索」，D 这层本来要显的东西它都有
    // 失败这支**必须留着**：上面那颗「再来一次」是唯一的重试入口，拆掉就只能退出
    if (state.status !== 'failed') {
      if (this.overlay) {
        this.destroyNode(this.overlay);
        this.overlay = null;
      }
      return;
    }

    if (this.overlay) return; // 已经画过就不再重建，否则每秒的 state:changed 会闪

    const runtime = this.runtime;
    if (!runtime) return;
    const review = runtime.getReview();

    const layer = uiNode('overlay', this.node, this.box.width, this.box.height, 0.5, 0.5);
    const g = layer.addComponent(Graphics);
    g.fillColor = new Color(0, 0, 0, 190);
    g.rect(-this.box.width / 2, -this.box.height / 2, this.box.width, this.box.height);
    g.fill();

    // 走到这里一定是失败 —— 通关那一支在上面就 return 了
    const head = state.timeLeftSec === 0 ? '超时' : '失败了';

    addLabel(layer, 'head', head, 52, COLOR.failed, 0.5, 0.5).node.setPosition(0, 150, 0);
    addLabel(layer, 'title', review.title, 28, COLOR.text, 0.5, 0.5).node.setPosition(0, 88, 0);
    addLabel(
      layer,
      'time',
      `用时 ${Math.round(review.elapsedSec)} 秒`,
      24,
      COLOR.textDim,
      0.5,
      0.5,
    ).node.setPosition(0, 40, 0);

    const items = review.items.map((item) => item.name);
    addLabel(
      layer,
      'items',
      items.length ? `沿途线索：${items.join(' → ')}` : '没有收集到线索',
      22,
      COLOR.textDim,
      0.5,
      0.5,
    ).node.setPosition(0, -10, 0);

    makeButton(layer, 'again', '再来一次', 160, 48, 0, -90, () => this.onRestartClick());

    this.overlay = layer;

    // 结算层是全屏的、建在最后 → 会盖住右下角的「重玩」。把它抬回最上面：
    // 失败时玩家第一个想按的就是重玩，不能因为结算层压着就点不到。
    // （退出按钮在挂载层、本来就比这一层高，不受影响）
    if (this.restartButton) {
      this.restartButton.setSiblingIndex(this.node.children.length - 1);
    }
  }

  private showFatal(message: string): void {
    const layer = uiNode('fatal', this.node, this.box.width, 300, 0.5, 0.5);
    const g = layer.addComponent(Graphics);
    g.fillColor = new Color(40, 0, 0, 220);
    g.rect(-this.box.width / 2, -150, this.box.width, 300);
    g.fill();
    addLabel(layer, 'msg', message, 24, COLOR.failed, 0.5, 0.5);
    this.overlay = layer;
  }

  /**
   * 销毁节点必须先 removeFromParent 再 destroy。
   *
   * destroy() 是帧末才真正生效的，只调它的话节点在当帧仍然是父节点的子节点，
   * getChildByName 照样查得到 —— 紧接着用同名建新节点，就会叠出第二个，
   * 而且之后查到的永远是那个正在死的旧节点。
   */
  private destroyNode(node: Node): void {
    node.removeFromParent();
    node.destroy();
  }

  private clearNodes(parent: Node, names: string[]): void {
    for (const name of names) {
      const child = parent.getChildByName(name);
      if (child) this.destroyNode(child);
    }
  }

  // ---------------------------------------------------------------- 交互

  private onHotspotClick(nodeId: string): void {
    const runtime = this.runtime;
    if (!runtime) return;

    // 点任何热点都先把「不属于它」的输入面板收起来。
    // 不收的话会出现「密码键盘还开着、同时另一条线索的文字也出来了」——
    // 玩家分不清哪句是面板的、哪句是场景的。
    // 点回同一个装置时不收，这样输到一半再点它不会把已输的位数清掉。
    if (this.pendingCodeNodeId !== nodeId) this.closeCodeGate();
    if (this.pendingUseNodeId !== nodeId) this.closeUsePanel();
    if (this.levelInputNodeId !== nodeId) this.closeLevelInput();

    const result = runtime.click(nodeId);
    if (result.ok) {
      // 点到「使用类」装置 → 按它的输入方式弹面板。
      // 弹哪个由运行时给（useInput），界面不猜
      // 点面板类关卡的提交热点 → 弹出关卡自己的输入面板
      if (result.effect === 'input-ready') this.openLevelInput(result.nodeId);
      // inspect 热点：文字已经由运行时的 showLine 写进线索栏了，
      // 界面这边只负责把特写图弹出来（配了才弹）。
      // pickup 也一样 —— 第 2 关的碎片点一下既进背包、也弹放大的碎片图
      if (result.effect === 'inspected' || result.effect === 'picked') this.openDetail(nodeId);
      // 点提交热点**直接判**的关（puzzle.input 不写 / 'none'）：答案就是背包顺序。
      // 这条路以前没上报 —— 本地判了、服务端不知道，通关记录和次数都不会落库。
      // 必须把**同一份候选**报上去（运行时本地判题用的就是它），
      // 服务端判题要求 answer 必填，不传直接回 400。
      // 成功那一支不会重复报：level:success 里那句有 `!puzzle` 守卫。
      if (result.effect === 'submitted') {
        this.reportSubmit(runtime.getInventory().map((item) => item.itemId));
        return;
      }
      if (result.effect === 'use-ready') {
        if (result.useInput === 'code') this.openCodeGate(result.nodeId, result.digitCount, result.prompt);
        else if (result.useInput === 'choice') {
          this.openChoiceGate(result.nodeId, result.choices, result.prompt);
        } else this.openUsePanel(result.nodeId, result.prompt);
      }
      return;
    }

    // 点不动的原因要说出来。否则玩家只会觉得「点了没反应」，
    // 而这类反馈在真机上完全看不到，只能靠这里主动播报。
    switch (result.reason) {
      case 'missing-item':
        this.flash('还差点东西，先去找找。', COLOR.textDim);
        break;
      case 'not-visible':
        this.flash('这里现在点不到。', COLOR.textDim);
        break;
      case 'already-done':
        this.flash('这个已经拿走了。', COLOR.textDim);
        break;
      case 'cooldown': {
        // 惩罚期里点装置/提交，要说清还要等多久 —— 只说「点不动」玩家会以为坏了。
        // 这条现在既覆盖答题关答错，也覆盖密码门输错（第 1 关的工具盒）
        const left = runtime.getState().cooldownLeftSec;
        this.flash(`还在罚站，${left} 秒后才能再试。`, COLOR.failed);
        break;
      }
      default:
        break;
    }
  }

  private onHintClick(): void {
    const text = this.runtime?.requestHint();
    if (text) {
      this.showLine(text);
      return;
    }
    this.flash('提示已经用完了。', COLOR.textDim);
  }

  /**
   * 左下角「返回」：回到当前场景配的 backScene。
   *
   * 走的是运行时的 `goToScene`（和点岔路同一套），所以「返回」本身不会留下
   * 任何痕迹 —— 不消耗道具、不计次数、状态机不知道玩家是点哪条路来的。
   */
  private onBackClick(): void {
    const runtime = this.runtime;
    const back = runtime?.getState().backSceneId;
    if (!runtime || !back) return;
    runtime.goToScene(back);
  }

  private onSwitchViewClick(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    runtime.switchView(runtime.getCurrentView() === 'A' ? 'B' : 'A');
  }

  private onRestartClick(): void {
    const runtime = this.runtime;
    if (!runtime) return;

    if (this.overlay) {
      this.destroyNode(this.overlay);
      this.overlay = null;
    }
    runtime.reset();
    this.renderedSceneKey = null; // 逼 applyState 重新走一遍背景图
    this.pendingCodeNodeId = null;
    this.levelInputNodeId = null;
    this.detailPopup?.close();
    this.lastInputKey = ''; // 逼 applyInputSpec 重新配一遍输入控件
    this.numberPad?.reset();
    this.formPanel?.reset();
    this.applyState(runtime.getState());
  }
}
