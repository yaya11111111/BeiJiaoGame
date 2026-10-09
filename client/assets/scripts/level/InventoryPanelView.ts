/**
 * 左下角的背包面板：竖着排一列格子，一格一件道具；点一格就**选中**它，
 * 面板底部显示它的名字（配了说明文字就一起显示）。
 *
 * **它是「先选道具、再点装置」这套玩法的前半截** —— 以前是点装置弹出面板挑一件，
 * 2026-10-10 改成玩家自己在背包里选（见 LevelRuntime 的 selectedItemId）。
 *
 * 几条来自试玩的硬要求（2026-10-11 又调了一轮外观）：
 * 1. **用掉的东西立刻从格子里消失**（运行时的 inventory 就是真相，这里照着画）
 * 2. **`hidden` 的道具根本不出现** —— 像第 2 关的「已归位碎片」
 * 3. 有图标的道具**把图放大了占满格子**，名字就不在格子里重复了 ——
 *    名字只在选中时出现在底部的说明行（"只有点击的时候才有说明"）
 * 4. **面板最高不能顶到「提示」按钮**，超了改成滑动阅览
 * 5. 面板是**浮在上面**的、底色偏透明，不推挤对话框也不挡死场景
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Color, Graphics, Label, Mask, Node, Sprite, UITransform } from 'cc';

import type { InventoryItem } from './LevelRuntime';
import { COLOR, addLabel, uiNode } from './UiKitView';
import type { SpriteFrame } from 'cc';

/** 和 LevelView 那边同一套「取图 + 缓存」的约定 */
export type FrameLoader = (assetKey: string, onDone: (frame: SpriteFrame | null) => void) => void;

/** 面板宽度。LevelView 要拿它算摆放位置，所以导出。窄一点、让出场景 */
export const INVENTORY_PANEL_W = 236;
/** 格子高一些 —— 图标要占大半个格子 */
const SLOT_H = 78;
const GAP = 8;
/** 格子中间那个图标方块的边长 */
const ICON_BOX = 62;
/** 底部那行说明的高度 */
const DESC_H = 44;
const PAD = 12;
/**
 * 面板底色：**比通用面板透明**（`COLOR.panelBg` 是 235）。
 * 背包占着左半边，底色太实就把场景挡没了 —— 玩家是来解谜的，不是来看面板的。
 */
const PANEL_BG = new Color(18, 24, 38, 150);

export class InventoryPanelView {
  readonly node: Node;

  private readonly bg: Graphics;
  private readonly viewport: Node;
  private readonly content: Node;
  private readonly desc: Label;

  private open = false;
  /** 拖动滚动的起点（null = 没在拖）。和对话框那套同一个做法 */
  private dragY: number | null = null;
  private scrollY = 0;

  constructor(
    parent: Node,
    private readonly onSelect: (itemId: string) => void,
    private readonly loadFrame: FrameLoader,
  ) {
    this.node = uiNode('inventoryPanel', parent, INVENTORY_PANEL_W, 200, 0.5, 0.5);
    this.bg = this.node.addComponent(Graphics);

    this.viewport = uiNode('viewport', this.node, INVENTORY_PANEL_W - PAD * 2, SLOT_H, 0.5, 0.5);
    // Mask：格子多了要裁掉露出去的部分才能「滚动」
    const mask = this.viewport.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT;

    // 内容锚点在**顶边**：格子从上往下排，往下拖就是看后面的
    this.content = uiNode('content', this.viewport, INVENTORY_PANEL_W - PAD * 2, SLOT_H, 0.5, 1);

    this.desc = addLabel(this.node, 'desc', '', 18, COLOR.text, 0.5, 0.5);

    // 拖动滚动。面板本身不接监听 —— 免得把「点格子」也吃掉
    this.content.on(Node.EventType.TOUCH_START, (e: { getUILocation(): { y: number } }) => {
      this.dragY = e.getUILocation().y;
    }, this);
    this.content.on(Node.EventType.TOUCH_MOVE, (e: { getUILocation(): { y: number } }) => {
      if (this.dragY === null) return;
      const y = e.getUILocation().y;
      this.scrollBy(y - this.dragY);
      this.dragY = y;
    }, this);
    const endDrag = () => {
      this.dragY = null;
    };
    this.content.on(Node.EventType.TOUCH_END, endDrag, this);
    this.content.on(Node.EventType.TOUCH_CANCEL, endDrag, this);

    this.node.active = false;
  }

  isOpen(): boolean {
    return this.open;
  }

  openPanel(): void {
    this.open = true;
    this.node.active = true;
  }

  close(): void {
    this.open = false;
    this.node.active = false;
    this.dragY = null;
  }

  /**
   * 重画。库存或选中变了就调一次（面板关着时直接返回，不做无用功）。
   *
   * `maxTotalH` 是**面板总高的上限**（由 LevelView 按「提示按钮下面还剩多少」算出来），
   * 超了就把格子区变成可滑动的。
   *
   * **返回这一版的实际高度** —— 面板高度随内容变，LevelView 要靠它把面板的
   * 底边对齐到背包按钮上面（锚点在中心，不先知道高度就没法摆）。
   */
  refresh(items: InventoryItem[], selectedItemId: string | null, maxTotalH: number): number {
    if (!this.open) return 0;

    // **hidden 的道具不进格子**（第 2 关的「已归位碎片」）
    const visible = items.filter((item) => !item.hidden);
    const rows = Math.max(1, visible.length);
    const contentH = rows * SLOT_H + (rows - 1) * GAP;
    const maxViewH = Math.max(SLOT_H, maxTotalH - PAD * 2 - GAP - DESC_H);
    const viewH = Math.min(contentH, maxViewH);
    const panelH = PAD * 2 + viewH + GAP + DESC_H;

    this.node.getComponent(UITransform)!.setContentSize(INVENTORY_PANEL_W, panelH);
    this.drawBackground(panelH);

    const innerW = INVENTORY_PANEL_W - PAD * 2;
    const viewUt = this.viewport.getComponent(UITransform)!;
    viewUt.setContentSize(innerW, viewH);
    this.viewport.setPosition(0, panelH / 2 - PAD - viewH / 2, 0);

    const contentUt = this.content.getComponent(UITransform)!;
    contentUt.setContentSize(innerW, Math.max(viewH, contentH));

    this.rebuildSlots(visible, selectedItemId, innerW);

    // 说明行只有一句：没选中是「空的」，选中了是那件东西的名字（有说明就补一行）
    const selected = visible.filter((item) => item.itemId === selectedItemId)[0];
    this.desc.string = selected ? selected.desc ?? selected.name : visible.length ? '' : '空的';
    this.desc.node.setPosition(0, -panelH / 2 + PAD + DESC_H / 2, 0);

    // 换内容之后把滚动位置归零 —— 不归零会看到半截空白
    this.scrollY = 0;
    this.content.setPosition(0, viewH / 2, 0);
    return panelH;
  }

  /** 每次重画都整批重建 —— 格子最多七八个，重建比维护复用简单得多 */
  private rebuildSlots(items: InventoryItem[], selectedItemId: string | null, innerW: number): void {
    for (const child of this.content.children.slice()) {
      child.removeFromParent();
      child.destroy();
    }
    if (items.length === 0) return;

    items.forEach((item, index) => {
      const slot = this.makeSlot(item, item.itemId === selectedItemId, innerW);
      // 内容锚点在顶边：第一格的中心在 -SLOT_H/2
      slot.setPosition(0, -SLOT_H / 2 - index * (SLOT_H + GAP), 0);
      this.content.addChild(slot);
    });
  }

  private makeSlot(item: InventoryItem, highlighted: boolean, innerW: number): Node {
    const slot = uiNode('slot', this.content, innerW, SLOT_H, 0.5, 0.5);

    const g = slot.addComponent(Graphics);
    const hw = innerW / 2;
    const hh = SLOT_H / 2;
    g.fillColor = highlighted ? COLOR.chosen : COLOR.button;
    g.roundRect(-hw, -hh, innerW, SLOT_H, 8);
    g.fill();
    g.strokeColor = COLOR.buttonEdge;
    g.lineWidth = 2;
    g.roundRect(-hw, -hh, innerW, SLOT_H, 8);
    g.stroke();

    if (item.iconKey) {
      // 图标异步来。回来时这一格可能已经被重画掉了 —— 用 isValid 挡一下，
      // 否则会往一棵已经销毁的树上挂精灵
      this.loadFrame(item.iconKey, (frame) => {
        if (!frame || !slot.isValid) return;
        const box = uiNode('icon', slot, ICON_BOX, ICON_BOX, 0.5, 0.5);
        const sprite = box.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = frame;
      });
    } else {
      // **没图才在格子里显示名字** —— 有图的话名字只在选中时出现在下面那行
      // （试玩要求：「已经有图片就不要显示碎片 1，只有点击的时候才有说明」）
      addLabel(slot, 'name', item.name, 17, COLOR.text, 0.5, 0.5);
    }

    slot.on(Node.EventType.TOUCH_END, () => this.onSelect(item.itemId), this);
    return slot;
  }

  private drawBackground(panelH: number): void {
    const hw = INVENTORY_PANEL_W / 2;
    const hh = panelH / 2;
    this.bg.clear();
    this.bg.fillColor = PANEL_BG;
    this.bg.roundRect(-hw, -hh, INVENTORY_PANEL_W, panelH, 12);
    this.bg.fill();
    this.bg.strokeColor = new Color(COLOR.buttonEdge.r, COLOR.buttonEdge.g, COLOR.buttonEdge.b, 150);
    this.bg.lineWidth = 2;
    this.bg.roundRect(-hw, -hh, INVENTORY_PANEL_W, panelH, 12);
    this.bg.stroke();
  }

  private scrollBy(deltaY: number): void {
    const viewH = this.viewport.getComponent(UITransform)!.height;
    const contentH = this.content.getComponent(UITransform)!.height;
    const max = Math.max(0, contentH - viewH);
    this.scrollY = Math.min(max, Math.max(0, this.scrollY + deltaY));
    this.content.setPosition(0, viewH / 2 + this.scrollY, 0);
  }
}
