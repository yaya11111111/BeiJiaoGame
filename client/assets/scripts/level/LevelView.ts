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
  Graphics,
  ImageAsset,
  JsonAsset,
  Label,
  Node,
  Sprite,
  SpriteFrame,
  UITransform,
  resources,
  view,
} from 'cc';

import { levelConfigPath, parseLevelConfig } from '../common/LevelConfig';
import { fitContain, mapRectIntoBox, type LocalRect, type Size } from '../common/Coord';
import type { HotspotRuntime, LevelViewModel } from './LevelRuntime';
import { LevelRuntime } from './LevelRuntime';
import { FormPanelView } from './FormPanelView';
import { NumberPadView } from './NumberPadView';
import { UsePanelView } from './UsePanelView';
import { COLOR, addLabel, makeButton, uiNode } from './UiKitView';
import { CloudApi, type CloudAnswer } from '../common/CloudApi';
import { createWechatCloudInvoker } from '../common/WechatCloud';
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
 * 顶部状态栏和底部信息栏的高度。
 *
 * 输入面板（数字键盘、表单、选项列表）要摆在**两者之间的那条空档里**：
 * 固定摆在某个绝对坐标的话，面板一高（比如第 5 关那个 6 项的表单）
 * 就会盖住底部信息栏，玩家看不见背包和线索。
 */
const HUD_TOP_HEIGHT = 56;
const HUD_BOTTOM_HEIGHT = 132;

@ccclass('LevelView')
export class LevelView extends Component {
  @property({ tooltip: '关卡 ID：GUIDE 或 L01~L10' })
  levelId = 'GUIDE';

  @property({ tooltip: '把每个热点的 rect 画成半透明框并标出 nodeId，A/B 量坐标时打开' })
  debugHotspots = false;

  /** duo 模式下视角由服务端指派，客户端不能切；原型阶段先只跑单人 */
  playMode: PlayMode = 'solo';

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
  private inventoryLabel: Label | null = null;
  private hintButton: Node | null = null;
  private switchButton: Node | null = null;
  private overlay: Node | null = null;
  private numberPad: NumberPadView | null = null;
  private formPanel: FormPanelView | null = null;
  private usePanel: UsePanelView | null = null;
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

  private renderedView: ViewId | null = null;

  /**
   * 云接口。**在浏览器预览 / 离线时是 null** —— 那种情况下游戏照样能玩，
   * 只是不落库。云开发要 E 的 `wx.cloud.init` 跑过才可用。
   *
   * 严格说这类 IO 该单独一层（适配层只该画）；暂时放这里是因为它已经在管
   * `resources.load` 这类外部世界的事。要做双人实时同步时再抽出去。
   */
  private cloud: CloudApi | null = null;

  start(): void {
    this.buildShell();
    const invoker = createWechatCloudInvoker();
    this.cloud = invoker ? new CloudApi(invoker) : null;
    this.loadConfig();
  }

  update(dt: number): void {
    // 核心不起定时器，时间由这里推进 —— 否则单测就得等真实时间
    this.runtime?.tick(dt);
  }

  onDestroy(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
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
    this.runtime = new LevelRuntime(config, { mode: this.playMode });

    // 埋点：后台统计"关卡进入数 / 完成数 / 退出点"就用它（需求 FR 的后台统计）
    this.fireAndForget(() => this.cloud?.report('level:enter', config.levelId));

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
        this.fireAndForget(() => this.cloud?.report('level:finish', this.levelId));
      }),
      this.runtime.on('level:failed', ({ reason }) => {
        this.flash(reason === 'timeout' ? '时间到了。' : '次数用完了。', COLOR.failed);
      }),
    );

    this.applyState(this.runtime.getState());
  }

  // ---------------------------------------------------------------- 渲染

  private applyState(state: LevelViewModel): void {
    // 关卡结束、或者切了视角，输入面板就该收起来：
    // 前者别盖在结算页上，后者那台装置已经不在当前视角了。
    // 顺序要在 applyInputSpec 之前 —— 收起密码门后它会把关卡自己的输入控件重新配回来
    if (state.status !== 'playing' || state.currentView !== this.renderedView) {
      this.closeUsePanel();
      this.closeCodeGate();
      this.closeLevelInput();
    }

    this.applyInputSpec(state);

    // 换视角要换背景图，是重活；其余状态变化只更新热点和 HUD
    if (state.currentView !== this.renderedView) {
      this.renderedView = state.currentView;
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
    }
    this.refreshInputVisibility();
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
      if (!result.ok && result.reason === 'not-usable') {
        this.flash('这里不用输密码。', COLOR.textDim);
      }
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
  }

  /** 现场摆着几个选项，选一个（三条岔路、三张通知）。选项本身是看得见的，哪个对不告诉 */
  private openChoiceGate(nodeId: string, choices: string[], prompt: string): void {
    this.pendingUseNodeId = nodeId;
    this.pendingUseKind = 'choice';
    this.usePanel?.open(prompt || '选哪个？', choices.map((choice) => ({ text: choice, key: choice })));
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
    if (result.ok) return;
    if (result.reason === 'already-done') this.flash('这里已经处理过了。', COLOR.textDim);
    if (result.reason === 'not-usable') this.flash('这里用不了。', COLOR.textDim);
  }

  private closeUsePanel(): void {
    this.pendingUseNodeId = null;
    this.usePanel?.close();
  }

  private onFormSubmit(values: Record<string, string>): void {
    const runtime = this.runtime;
    if (!runtime) return;

    // 表单是**按键**答案（顺序无关），按对象形状交
    this.reportSubmit(values);
    if (runtime.submit(values)) return;

    this.formPanel?.reset();
  }

  private renderView(state: LevelViewModel): void {
    const config = this.config;
    if (!config) return;

    const viewId = state.currentView;
    const viewConfig = config.views[viewId];

    this.loadFrame(viewConfig.assetKey, (frame) => {
      // 换图是异步的。加载期间玩家又切了一次视角的话，这次回调已经过期，
      // 照画下去会把背景换成上一个视角的图 —— 缓存命中时不会发生（同步回调），
      // 只在第一次加载某个视角时才会露出来，属于很难复现的那类 bug。
      if (this.renderedView !== viewId) return;

      // 有真图就以真图的像素为准，没有就用兜底基准 —— 这样 A/B 把图丢进
      // resources/ 之后不需要改任何配置，热点的换算基准会自动跟着变
      this.originalSize = frame
        ? { width: frame.originalSize.width, height: frame.originalSize.height }
        : FALLBACK_ORIGINAL_SIZE;

      this.layoutBackground(frame, viewConfig.assetKey);
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
    debug.active = this.debugHotspots;

    // 点不动的热点在调试模式下也要画出来 —— 那种「配置里写了、界面上却没有」
    // 的节点正是 A/B 量坐标时最需要看见的
    if (this.debugHotspots) {
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

  private buildHud(): void {
    const top = uiNode('hudTop', this.node, this.box.width, HUD_TOP_HEIGHT, 0.5, 1);
    top.setPosition(0, this.box.height / 2, 0);
    const topBg = top.addComponent(Graphics);
    topBg.fillColor = COLOR.barBg;
    topBg.rect(-this.box.width / 2, -HUD_TOP_HEIGHT, this.box.width, HUD_TOP_HEIGHT);
    topBg.fill();
    this.statusLabel = addLabel(top, 'status', '', 24, COLOR.text, 0.5, 0.5);

    const bottom = uiNode('hudBottom', this.node, this.box.width, HUD_BOTTOM_HEIGHT, 0.5, 0);
    bottom.setPosition(0, -this.box.height / 2, 0);
    const bottomBg = bottom.addComponent(Graphics);
    bottomBg.fillColor = COLOR.barBg;
    bottomBg.rect(-this.box.width / 2, 0, this.box.width, HUD_BOTTOM_HEIGHT);
    bottomBg.fill();

    this.inventoryLabel = addLabel(bottom, 'inventory', '', 20, COLOR.text, 0.5, 1);
    this.inventoryLabel.node.setPosition(0, 116, 0);

    this.lineLabel = addLabel(bottom, 'line', '', 22, COLOR.text, 0.5, 0.5);
    this.lineLabel.node.setPosition(0, 74, 0);

    this.hintButton = makeButton(bottom, 'hint', '提示', 140, 44, -170, 26, () => this.onHintClick());
    this.switchButton = makeButton(bottom, 'switch', '切视角', 140, 44, 0, 26, () => this.onSwitchViewClick());
    makeButton(bottom, 'restart', '重玩', 140, 44, 170, 26, () => this.onRestartClick());

    // 输入面板摆在顶栏和底栏之间的空档正中。算法与屏幕高度无关：
    // 空档上下边界是 (boxH/2 - 顶栏) 和 (-boxH/2 + 底栏)，中点就是两者之差的一半
    const inputY = (HUD_BOTTOM_HEIGHT - HUD_TOP_HEIGHT) / 2;

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
  }

  private refreshHud(state: LevelViewModel): void {
    const parts = [state.title];

    if (state.timeLeftSec !== null) {
      const m = Math.floor(state.timeLeftSec / 60);
      const s = state.timeLeftSec % 60;
      parts.push(`⏱ ${m}:${s < 10 ? '0' : ''}${s}`);
    } else {
      parts.push('不限时');
    }

    parts.push(`剩余 ${state.attemptsLeft} 次`);
    if (state.cooldownLeftSec > 0) parts.push(`⏳ 惩罚中 ${state.cooldownLeftSec}s`);
    parts.push(state.canSwitchView ? `视角 ${state.currentView}（可切）` : `视角 ${state.currentView}`);

    if (this.statusLabel) this.statusLabel.string = parts.join('   ·   ');

    if (this.inventoryLabel) {
      const names = state.inventory.map((item) => item.name);
      this.inventoryLabel.string = names.length ? `背包：${names.join(' → ')}` : '背包：空';
      // 背包顺序就是提交顺序，说清楚省得玩家以为顺序无所谓
      this.inventoryLabel.color = names.length ? COLOR.text : COLOR.textDim;
    }

    if (this.hintButton) {
      const label = this.hintButton.getChildByName('text')!.getComponent(Label)!;
      label.string = state.hintsRemaining > 0 ? `提示 (${state.hintsRemaining})` : '提示已用完';
      this.hintButton.active = state.status === 'playing';
    }

    if (this.switchButton) {
      this.switchButton.active = state.canSwitchView && state.status === 'playing';
      const label = this.switchButton.getChildByName('text')!.getComponent(Label)!;
      label.string = `切到 ${state.currentView === 'A' ? 'B' : 'A'}`;
    }

    if (this.lineLabel && state.lastLine === null) {
      this.lineLabel.string = '';
    }
  }

  private showLine(text: string): void {
    if (!this.lineLabel) return;
    this.lineLabel.string = text;
    // 顺手把颜色复位：上一次 flash 的红色可能还挂着定时器没到点，
    // 不复位的话紧接着读到的正常线索会以「报错红」显示
    this.lineLabel.color = COLOR.text;
  }

  private flash(text: string, color: Color): void {
    if (!this.lineLabel) return;
    this.lineLabel.string = text;
    this.lineLabel.color = color;
    // 闪一下再回到常规色，否则「已提示的文字」会一直带着错误提示的红色
    this.scheduleOnce(() => {
      if (this.lineLabel) this.lineLabel.color = COLOR.text;
    }, 1.5);
  }

  private refreshOverlay(state: LevelViewModel): void {
    if (state.status === 'playing') {
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

    const won = state.status === 'success';
    const head = won ? '通关' : state.timeLeftSec === 0 ? '超时' : '失败了';

    addLabel(layer, 'head', head, 52, won ? COLOR.success : COLOR.failed, 0.5, 0.5).node.setPosition(0, 150, 0);
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
        // 惩罚期里点提交，要说清还要等多久 —— 只说「点不动」玩家会以为坏了
        const left = runtime.getState().cooldownLeftSec;
        this.flash(`刚答错过，${left} 秒后才能再试。`, COLOR.failed);
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
    this.renderedView = null; // 逼 applyState 重新走一遍背景图
    this.pendingCodeNodeId = null;
    this.levelInputNodeId = null;
    this.lastInputKey = ''; // 逼 applyInputSpec 重新配一遍输入控件
    this.numberPad?.reset();
    this.formPanel?.reset();
    this.applyState(runtime.getState());
  }
}
