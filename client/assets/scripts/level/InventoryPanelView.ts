/**
 * 左下角的背包面板：竖着排一列格子，一格一件道具；点一格就**选中**它，
 * 面板底部显示它的名字（配了说明文字就一起显示）。
 *
 * **它是「先选道具、再点装置」这套玩法的前半截** —— 以前是点装置弹出面板挑一件，
 * 2026-10-10 改成玩家自己在背包里选（见 LevelRuntime 的 selectedItemId）。
 *
 * 几条来自试玩的硬要求：
 * 1. **用掉的东西立刻从格子里消失**（运行时的 inventory 就是真相，这里照着画）
 * 2. **`hidden` 的道具根本不出现** —— 像第 2 关的「已归位碎片」，
 *    它们是拼合的原料，摆出来只会让玩家以为"还得自己动手拼"
 * 3. 有图标的道具（配置里配了 `iconKey`）**把图缩小放进格子里**
 * 4. **面板最高不能顶到「提示」按钮**，超了改成滑动阅览
 * 5. 面板是**浮在上面**的，不推挤对话框
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Graphics, Label, Mask, Node, Sprite, UITransform } from 'cc';

import type { InventoryItem } from './LevelRuntime';
import { COLOR, addLabel, uiNode } from './UiKitView';
import type { SpriteFrame } from 'cc';

/** 和 LevelView 那边同一套「取图 + 缓存」的约定 */
export type FrameLoader = (assetKey: string, onDone: (frame: SpriteFrame | null) => void) => void;

/** 面板宽度。LevelView 要拿它算摆放位置，所以导出 */
export const INVENTORY_PANEL_W = 300;
const SLOT_H = 56;
const GAP = 8;
/** 格子左边那个图标方块的边长 */
const ICON_BOX = 42;
/** 底部那行「说明」的高度 */
const DESC_H = 52;
const PAD = 16;

export class InventoryPanelView {
  readonly node: Node;

  private readonly bg: Graphics;
  private readonly viewport: Node;
  private readonly content: Node;
  private readonly desc: Label;
  private readonly hint: Label;

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

    this.desc = addLabel(this.node, 'desc', '', 20, COLOR.text, 0.5, 0.5);
    this.hint = addLabel(this.node, 'hint', '', 16, COLOR.textDim, 0.5, 0.5);

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

    this.rebuildSlots(visible, selectedItemId, innerW, Math.max(viewH, contentH));

    const selected = visible.filter((item) => item.itemId === selectedItemId)[0];
    this.desc.string = selected ? selected.name : '背包是空的';
    this.hint.string = selected ? selected.desc ?? '选中了 —— 去点要用它的地方' : '点一件道具选中它';
    this.desc.node.setPosition(0, -panelH / 2 + PAD + DESC_H * 0.62, 0);
    this.hint.node.setPosition(0, -panelH / 2 + PAD + DESC_H * 0.26, 0);

    // 换内容之后把滚动位置归零 —— 不归零会看到半截空白
    this.scrollY = 0;
    this.content.setPosition(0, viewH / 2, 0);
    return panelH;
  }

  /** 每次重画都整批重建 —— 格子最多七八个，重建比维护复用简单得多 */
  private rebuildSlots(
    items: InventoryItem[],
    selectedItemId: string | null,
    innerW: number,
    contentH: number,
  ): void {
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
    void contentH;
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

    const textX = -hw + 12 + ICON_BOX + 12;
    if (item.iconKey) {
      // 图标异步来。回来时这一格可能已经被重画掉了 —— 用 isValid 挡一下，
      // 否则会往一棵已经销毁的树上挂精灵
      this.loadFrame(item.iconKey, (frame) => {
        if (!frame || !slot.isValid) return;
        const box = uiNode('icon', slot, ICON_BOX, ICON_BOX, 0.5, 0.5);
        box.setPosition(-hw + 12 + ICON_BOX / 2, 0, 0);
        const sprite = box.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = frame;
      });
    }
    // 名字从左边缘开始排（有图标时让开图标那一段）
    const nameLabel = addLabel(slot, 'name', item.name, 22, COLOR.text, 0, 0.5);
    nameLabel.node.setPosition(textX, 0, 0);

    slot.on(Node.EventType.TOUCH_END, () => this.onSelect(item.itemId), this);
    return slot;
  }

  private drawBackground(panelH: number): void {
    const hw = INVENTORY_PANEL_W / 2;
    const hh = panelH / 2;
    this.bg.clear();
    this.bg.fillColor = COLOR.panelBg;
    this.bg.roundRect(-hw, -hh, INVENTORY_PANEL_W, panelH, 12);
    this.bg.fill();
    this.bg.strokeColor = COLOR.buttonEdge;
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
