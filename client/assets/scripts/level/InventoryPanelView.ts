/**
 * 左下角的背包面板：竖着排一列格子，一格一件道具；点一格就**选中**它，
 * 面板底部显示它的名字（以后有说明文字也显示在那儿）。
 *
 * **它是「先选道具、再点装置」这套玩法的前半截** —— 以前是点装置弹出面板挑一件，
 * 2026-10-10 改成玩家自己在背包里选（见 LevelRuntime 的 selectedItemId）。
 *
 * 三条来自试玩的硬要求：
 * 1. **面板最高不能顶到「提示」按钮** —— 顶到就压住 HUD 了，所以有个高度上限，
 *    超了改成**滑动阅览**（物品多的时候）
 * 2. 面板是**浮在上面**的，不推挤对话框
 * 3. 点「背包」两个字收起 —— 由 LevelView 管按钮，这里只管面板本身
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Graphics, Label, Mask, Node, UITransform } from 'cc';

import type { InventoryItem } from './LevelRuntime';
import { ButtonGrid, COLOR, addLabel, uiNode } from './UiKitView';

/** 面板宽度。LevelView 要拿它算摆放位置，所以导出 */
export const INVENTORY_PANEL_W = 300;
const PANEL_W = INVENTORY_PANEL_W;
const SLOT_H = 52;
const GAP = 8;
/** 底部那行「说明」的高度 */
const DESC_H = 46;
const PAD = 16;

export class InventoryPanelView {
  readonly node: Node;

  private readonly bg: Graphics;
  private readonly viewport: Node;
  private readonly content: Node;
  private readonly desc: Label;
  private readonly grid: ButtonGrid;

  private open = false;
  /** 拖动滚动的起点（null = 没在拖）。和对话框那套同一个做法 */
  private dragY: number | null = null;
  private scrollY = 0;

  constructor(parent: Node, private readonly onSelect: (itemId: string) => void) {
    this.node = uiNode('inventoryPanel', parent, PANEL_W, 200, 0.5, 0.5);
    this.bg = this.node.addComponent(Graphics);

    this.viewport = uiNode('viewport', this.node, PANEL_W - PAD * 2, SLOT_H, 0.5, 0.5);
    // Mask：格子多了要裁掉露出去的部分才能「滚动」
    const mask = this.viewport.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT;

    // 内容锚点在**顶边**：格子从上往下排，往下拖就是看后面的
    this.content = uiNode('content', this.viewport, PANEL_W - PAD * 2, SLOT_H, 0.5, 1);
    this.grid = new ButtonGrid(this.content, 'items', 1, PANEL_W - PAD * 2, SLOT_H, 0, GAP, (key) => {
      if (key) this.onSelect(key);
    });

    this.desc = addLabel(this.node, 'desc', '', 20, COLOR.textDim, 0.5, 0.5);

    // 拖动滚动。viewport 上一层的面板不接监听 —— 免得把「点格子」也吃掉
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

    const rows = Math.max(1, items.length);
    const contentH = rows * SLOT_H + (rows - 1) * GAP;
    const maxViewH = Math.max(SLOT_H, maxTotalH - PAD * 2 - GAP - DESC_H);
    const viewH = Math.min(contentH, maxViewH);
    const panelH = PAD * 2 + viewH + GAP + DESC_H;

    this.node.getComponent(UITransform)!.setContentSize(PANEL_W, panelH);
    this.drawBackground(panelH);

    const viewUt = this.viewport.getComponent(UITransform)!;
    viewUt.setContentSize(PANEL_W - PAD * 2, viewH);
    this.viewport.setPosition(0, panelH / 2 - PAD - viewH / 2, 0);

    const contentUt = this.content.getComponent(UITransform)!;
    contentUt.setContentSize(PANEL_W - PAD * 2, Math.max(viewH, contentH));

    // 空背包也给一格，但那格是个提示，不该被当成道具选中
    this.grid.render(
      items.length > 0
        ? items.map((item) => ({
            text: item.name,
            key: item.itemId,
            highlighted: item.itemId === selectedItemId,
          }))
        : [{ text: '背包是空的', key: '', highlighted: false }],
    );
    // 格子从内容顶边往下排；内容锚点在顶边，所以网格中心要往下让半个内容高
    this.grid.node.setPosition(0, -Math.max(viewH, contentH) / 2, 0);

    const selected = items.filter((item) => item.itemId === selectedItemId)[0];
    this.desc.string = selected ? selected.name : '点一件道具选中它';
    this.desc.node.setPosition(0, -panelH / 2 + PAD + DESC_H / 2, 0);

    // 换内容之后把滚动位置归零 —— 不归零会看到半截空白
    this.scrollY = 0;
    this.applyScroll(viewH, Math.max(viewH, contentH));
    return panelH;
  }

  private drawBackground(panelH: number): void {
    const hw = PANEL_W / 2;
    const hh = panelH / 2;
    this.bg.clear();
    this.bg.fillColor = COLOR.panelBg;
    this.bg.roundRect(-hw, -hh, PANEL_W, panelH, 12);
    this.bg.fill();
    this.bg.strokeColor = COLOR.buttonEdge;
    this.bg.lineWidth = 2;
    this.bg.roundRect(-hw, -hh, PANEL_W, panelH, 12);
    this.bg.stroke();
  }

  private scrollBy(deltaY: number): void {
    const viewH = this.viewport.getComponent(UITransform)!.height;
    const contentH = this.content.getComponent(UITransform)!.height;
    const max = Math.max(0, contentH - viewH);
    this.scrollY = Math.min(max, Math.max(0, this.scrollY + deltaY));
    this.applyScroll(viewH, contentH);
  }

  private applyScroll(viewH: number, contentH: number): void {
    // 内容高度不超过视口就没得滚，直接贴顶
    void contentH;
    this.content.setPosition(0, viewH / 2 + this.scrollY, 0);
  }
}
