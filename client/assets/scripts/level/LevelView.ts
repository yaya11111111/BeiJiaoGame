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
  Layers,
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
import type { LevelConfig, PlayMode, ViewId } from '../common/LevelTypes';

const { ccclass, property } = _decorator;

/**
 * A/B 出图之前用的兜底原图尺寸。
 *
 * 真实关卡里这个值取自 SpriteFrame.originalSize，所以美术按什么比例出图都行；
 * 但占位阶段没有图，热点又必须有东西可依，就先钉一个基准跑通交互。
 * 1280x720 与 9/22 推荐的画布基准一致，A/B 之后按这个比例出图不会返工。
 */
const FALLBACK_ORIGINAL_SIZE: Size = { width: 1280, height: 720 };

const COLOR = {
  placeholderBg: new Color(28, 36, 52, 255),
  placeholderEdge: new Color(96, 128, 176, 255),
  placeholderText: new Color(150, 172, 200, 255),
  hotspotOn: new Color(90, 220, 140, 220),
  hotspotOff: new Color(140, 140, 140, 160),
  hotspotDone: new Color(90, 140, 220, 180),
  barBg: new Color(0, 0, 0, 140),
  text: new Color(240, 244, 250, 255),
  textDim: new Color(170, 180, 196, 255),
  success: new Color(120, 230, 150, 255),
  failed: new Color(240, 130, 130, 255),
  button: new Color(58, 84, 128, 235),
  buttonEdge: new Color(130, 170, 220, 255),
};

/** 新建一个带 UITransform 的 UI 节点。layer 必须设成 UI_2D，否则 UI 相机不渲染它 —— 运行时建的节点默认不是这个层。 */
function uiNode(name: string, parent: Node, w: number, h: number, ax: number, ay: number): Node {
  const node = new Node(name);
  node.layer = Layers.Enum.UI_2D;
  const ut = node.addComponent(UITransform);
  ut.setAnchorPoint(ax, ay);
  ut.setContentSize(w, h);
  node.parent = parent;
  return node;
}

function addLabel(
  parent: Node,
  name: string,
  text: string,
  fontSize: number,
  color: Color,
  ax: number,
  ay: number,
): Label {
  const node = uiNode(name, parent, 10, fontSize * 1.4, ax, ay);
  const label = node.addComponent(Label);
  label.string = text;
  label.fontSize = fontSize;
  label.lineHeight = fontSize * 1.3;
  label.color = color;
  label.horizontalAlign = Label.HorizontalAlign.CENTER;
  label.verticalAlign = Label.VerticalAlign.CENTER;
  return label;
}

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

  /** 未知 key 用 null 表示「试过、没有」，避免每次切视角都重新 load 一遍必然失败的路径 */
  private frameCache = new Map<string, SpriteFrame | null>();

  private renderedView: ViewId | null = null;

  start(): void {
    this.buildShell();
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

    this.unsubs.push(
      this.runtime.on('state:changed', (state) => this.applyState(state)),
      this.runtime.on('line:shown', ({ text }) => this.showLine(text)),
      // 文案由运行时的 showLine 给 —— 它会区分「还剩 N 次」和「N 秒后才能再试」，
      // 这里再写一遍措辞就会两边不同步。视图只负责把这一行染红。
      this.runtime.on('answer:wrong', () => {
        if (this.lineLabel) this.lineLabel.color = COLOR.failed;
      }),
      this.runtime.on('level:success', () => this.flash('通了！', COLOR.success)),
      this.runtime.on('level:failed', ({ reason }) => {
        this.flash(reason === 'timeout' ? '时间到了。' : '次数用完了。', COLOR.failed);
      }),
    );

    this.applyState(this.runtime.getState());
  }

  // ---------------------------------------------------------------- 渲染

  private applyState(state: LevelViewModel): void {
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
    const top = uiNode('hudTop', this.node, this.box.width, 56, 0.5, 1);
    top.setPosition(0, this.box.height / 2, 0);
    const topBg = top.addComponent(Graphics);
    topBg.fillColor = COLOR.barBg;
    topBg.rect(-this.box.width / 2, -56, this.box.width, 56);
    topBg.fill();
    this.statusLabel = addLabel(top, 'status', '', 24, COLOR.text, 0.5, 0.5);

    const bottom = uiNode('hudBottom', this.node, this.box.width, 132, 0.5, 0);
    bottom.setPosition(0, -this.box.height / 2, 0);
    const bottomBg = bottom.addComponent(Graphics);
    bottomBg.fillColor = COLOR.barBg;
    bottomBg.rect(-this.box.width / 2, 0, this.box.width, 132);
    bottomBg.fill();

    this.inventoryLabel = addLabel(bottom, 'inventory', '', 20, COLOR.text, 0.5, 1);
    this.inventoryLabel.node.setPosition(0, 116, 0);

    this.lineLabel = addLabel(bottom, 'line', '', 22, COLOR.text, 0.5, 0.5);
    this.lineLabel.node.setPosition(0, 74, 0);

    this.hintButton = this.makeButton(bottom, 'hint', '提示', -170, 26, () => this.onHintClick());
    this.switchButton = this.makeButton(bottom, 'switch', '切视角', 0, 26, () => this.onSwitchViewClick());
    this.makeButton(bottom, 'restart', '重玩', 170, 26, () => this.onRestartClick());
  }

  private makeButton(parent: Node, name: string, text: string, x: number, y: number, onClick: () => void): Node {
    const node = uiNode(name, parent, 140, 44, 0.5, 0.5);
    node.setPosition(x, y, 0);

    const g = node.addComponent(Graphics);
    g.fillColor = COLOR.button;
    g.roundRect(-70, -22, 140, 44, 8);
    g.fill();
    g.strokeColor = COLOR.buttonEdge;
    g.lineWidth = 2;
    g.roundRect(-70, -22, 140, 44, 8);
    g.stroke();

    addLabel(node, 'text', text, 22, COLOR.text, 0.5, 0.5);
    node.on(Node.EventType.TOUCH_END, onClick, this);
    return node;
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
      const items = state.inventory.map((item) => item.itemId);
      this.inventoryLabel.string = items.length ? `背包：${items.join(' → ')}` : '背包：空';
      // 背包顺序就是提交顺序，说清楚省得玩家以为顺序无所谓
      this.inventoryLabel.color = items.length ? COLOR.text : COLOR.textDim;
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

    const items = review.items.map((item) => item.itemId);
    addLabel(
      layer,
      'items',
      items.length ? `沿途线索：${items.join(' → ')}` : '没有收集到线索',
      22,
      COLOR.textDim,
      0.5,
      0.5,
    ).node.setPosition(0, -10, 0);

    this.makeButton(layer, 'again', '再来一次', 0, -90, () => this.onRestartClick());

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

    const result = runtime.click(nodeId);
    if (result.ok) return;

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
    this.applyState(runtime.getState());
  }
}
