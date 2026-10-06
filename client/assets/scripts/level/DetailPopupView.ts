/**
 * 特写图弹窗：点热点之后弹出一张放大的图，让玩家看清背景图上太小、看不清的物件。
 *
 * **图本身不能互动**，只有关闭 —— 它是个查看器，不是玩法装置。所以这里刻意
 * 不做缩放/拖拽/翻页：做得越像阅读器，玩家越会以为里面藏着可点的东西。
 *
 * 为什么遮罩自己也挂一个触摸监听：本层是**模态**的，弹窗开着的时候下层
 * 一个热点都不该点得到。Cocos 只把触摸派发给最上面那个注册了监听的节点，
 * 所以遮罩挂上监听就顺手把下层挡掉了 —— 一箭双雕，不用额外的拦截组件。
 * （它同时让「点遮罩关闭」成立。）
 *
 * 图片加载走外面传进来的 loader，不自己复制一份：LevelView 已经有一套
 * 「SpriteFrame 取不到就按 ImageAsset 再取一次 + 缓存」的逻辑，
 * 两份迟早会走岔。同时这也让特写图和背景图共用同一个缓存。
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Color, Graphics, Node, Sprite, UITransform, view } from 'cc';

import { fitContain } from '../common/Coord';
import { COLOR, addLabel, makeButton, uiNode } from './UiKitView';
import type { SpriteFrame } from 'cc';

/** 图片最多占屏幕的多大一块。留出边距，免得图贴到屏幕边上、看着像被裁了 */
const MAX_AREA_RATIO = 0.8;
const CLOSE_BUTTON_W = 160;
const CLOSE_BUTTON_H = 48;
/** 关闭按钮离屏幕底边的距离 */
const CLOSE_MARGIN_BOTTOM = 44;

export type FrameLoader = (assetKey: string, onDone: (frame: SpriteFrame | null) => void) => void;

export class DetailPopupView {
  readonly node: Node;

  private readonly body: Node;

  /**
   * 正在加载哪一个 key。
   *
   * 图是异步来的，玩家点得快就可能连着点两个热点：前一张图回来的时候
   * 后一张已经在路上了，照画下去就会把后一张盖成前一张。
   * 和 LevelView.renderView 挡切视角竞态是同一招。
   */
  private pendingKey: string | null = null;

  constructor(parent: Node, private readonly loadFrame: FrameLoader) {
    this.node = uiNode('detailPopup', parent, 10, 10, 0.5, 0.5);
    this.body = uiNode('body', this.node, 10, 10, 0.5, 0.5);
    this.node.active = false;
  }

  isOpen(): boolean {
    return this.node.active;
  }

  /**
   * 弹出某个 key 的特写图。
   *
   * 图找不到时**不弹**，只打日志 —— A/B 漏交一张图不该让玩家卡住：
   * 点这个热点的其他反馈（文字、道具面板）照常发生。
   */
  open(assetKey: string): void {
    this.close();
    this.pendingKey = assetKey;

    this.loadFrame(assetKey, (frame) => {
      // 加载期间又点了别的热点，这次回调已经过期
      if (this.pendingKey !== assetKey) return;
      this.pendingKey = null;

      if (!frame) {
        console.warn(
          `[DetailPopup] 找不到特写图 ${assetKey}，这次不弹。` +
            'A/B 把图按这个 key 命名放进 assets/resources/details/ 下即可。',
        );
        return;
      }
      this.render(frame);
    });
  }

  close(): void {
    this.pendingKey = null;
    this.node.active = false;
    this.clearBody();
  }

  private render(frame: SpriteFrame): void {
    const screen = view.getVisibleSize();
    // 先抬到最上层：HUD、数字键盘、道具面板都是 this.node 的兄弟节点，
    // 弹窗是模态的，必须在它们上面（退出按钮在桥接层，那个另说）
    this.node.setSiblingIndex(this.node.parent!.children.length - 1);

    const ut = this.node.getComponent(UITransform)!;
    ut.setContentSize(screen.width, screen.height);

    const area = {
      width: screen.width * MAX_AREA_RATIO,
      height: screen.height * MAX_AREA_RATIO,
    };
    // contain：整张图都看得见。**这里允许放大** —— 特写图存在的意义就是放大，
    // 所以不能用「超过原尺寸就不放大」那种夹法
    const content = fitContain(
      { width: frame.originalSize.width, height: frame.originalSize.height },
      area,
    );

    const bodyUt = this.body.getComponent(UITransform)!;
    bodyUt.setContentSize(screen.width, screen.height);

    const backdrop = uiNode('backdrop', this.body, screen.width, screen.height, 0.5, 0.5);
    const g = backdrop.addComponent(Graphics);
    g.fillColor = new Color(0, 0, 0, 205);
    g.rect(-screen.width / 2, -screen.height / 2, screen.width, screen.height);
    g.fill();
    // 点哪儿都关（包括点图片本身——它没有别的用处）
    backdrop.on(Node.EventType.TOUCH_END, () => this.close(), this);

    const holder = uiNode('image', this.body, content.w, content.h, 0.5, 0.5);
    const sprite = holder.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.spriteFrame = frame;

    makeButton(
      this.body,
      'close',
      '关闭',
      CLOSE_BUTTON_W,
      CLOSE_BUTTON_H,
      0,
      -screen.height / 2 + CLOSE_MARGIN_BOTTOM,
      () => this.close(),
    );

    // 读屏/无障碍：说明这是一张放大的图，不是可点的东西
    addLabel(this.body, 'hint', '点击任意处关闭', 18, COLOR.textDim, 0.5, 0.5)
      .node.setPosition(0, -screen.height / 2 + CLOSE_MARGIN_BOTTOM + CLOSE_BUTTON_H, 0);

    this.node.active = true;
  }

  private clearBody(): void {
    // 先摘再销毁：destroy() 帧末才生效，只调它的话当帧还查得到旧节点
    for (const child of this.body.children.slice()) {
      child.removeFromParent();
      child.destroy();
    }
  }
}
