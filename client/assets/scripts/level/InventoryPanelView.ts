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
 * 3. 有图标的道具**按比例撑满格子**（contain，**不拉变形**），名字就不在格子里重复了 ——
 *    名字只在选中时出现在底部的说明行（"只有点击的时候才有说明"）。
 *    图比格子扁/窄时，空出来的那圈就是**透明的**：宁可留边，也不要把图拉长压扁
 *    （2026-10-13 改。原先写死 68×68 + CUSTOM，横图会被压成正方形）
 * 4. **面板最高不能顶到「提示」按钮**，超了改成滑动阅览
 * 5. 面板是**浮在上面**的、底色偏透明，不推挤对话框也不挡死场景
 * 6. **双击有图标的格子 = 放大看这张图**（2026-10-13 新增）。第二下**不当
 *    「取消选中」用** —— 玩家是要看图，不是要取消；双击完那件东西仍保持选中。
 *    没接 `onInspectIcon` 时这个手势什么都不做（和没图标的道具一样）
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Color, Graphics, Label, Mask, Node, Sprite, UITransform } from 'cc';

import { fitContain } from '../common/Coord';
import type { InventoryItem } from './LevelRuntime';
import { COLOR, addLabel, uiNode } from './UiKitView';
import type { SpriteFrame } from 'cc';

/** 和 LevelView 那边同一套「取图 + 缓存」的约定 */
export type FrameLoader = (assetKey: string, onDone: (frame: SpriteFrame | null) => void) => void;

/**
 * 面板宽度。LevelView 要拿它算摆放位置，所以导出。
 *
 * **只比图标宽一点** —— 试玩反馈「还是太宽了，比给你的碎片宽一些就够了」。
 * 现在内宽 84、图标 68，两边各留 8 的边。
 */
export const INVENTORY_PANEL_W = 104;
/** 格子高一些 —— 图标要占大半个格子 */
const SLOT_H = 84;
const GAP = 8;
/** 格子中间那个图标方块的边长。内宽 84，两边各留 8 */
const ICON_BOX = 68;
/**
 * 两次点击间隔小于这个数才算「双击」。300ms 是各平台通用的口径 ——
 * 比这宽会把「点一下、过一会儿再点一下」也吞成双击，比这窄则要手指点得飞快
 */
const DOUBLE_TAP_MS = 300;
/** 底部那行说明的高度 */
const DESC_H = 40;
const PAD = 10;
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
  /** 上一次画的内容签名 + 面板高度。一样就跳过重画（见 refresh 里的解释）*/
  private lastSignature = '';
  private lastPanelH = 0;
  /**
   * 双击判定用的「上一次点的是哪一格、什么时候」。
   *
   * 记在**面板**上而不是格子上：选中态一变 `refresh` 会把所有格子重建一遍，
   * 挂在格子上的时间戳会跟着一起没
   */
  private lastTapItemId: string | null = null;
  private lastTapAt = 0;

  constructor(
    parent: Node,
    private readonly onSelect: (itemId: string) => void,
    private readonly loadFrame: FrameLoader,
    /**
     * 双击有图标的道具 → 放大看那张图（外层接成弹特写图）。
     * 不接就只有单击选中，没有这个手势。
     */
    private readonly onInspectIcon: ((iconKey: string) => void) | null = null,
  ) {
    this.node = uiNode('inventoryPanel', parent, INVENTORY_PANEL_W, 200, 0.5, 0.5);
    this.bg = this.node.addComponent(Graphics);

    this.viewport = uiNode('viewport', this.node, INVENTORY_PANEL_W - PAD * 2, SLOT_H, 0.5, 0.5);
    // Mask：格子多了要裁掉露出去的部分才能「滚动」
    const mask = this.viewport.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT;

    // 内容锚点在**顶边**：格子从上往下排，往下拖就是看后面的
    this.content = uiNode('content', this.viewport, INVENTORY_PANEL_W - PAD * 2, SLOT_H, 0.5, 1);

    this.desc = addLabel(this.node, 'desc', '', 15, COLOR.text, 0.5, 0.5);
    // 面板就这么窄，「拼好的新路线图」这种长名字会撑出去 —— 让它自动缩字号
    this.desc.overflow = Label.Overflow.SHRINK;
    this.desc.node.getComponent(UITransform)!.setContentSize(INVENTORY_PANEL_W - PAD * 2, DESC_H);

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
    // 每次打开都从头看起；并且把签名作废，逼下一次 refresh 真画一遍
    this.scrollY = 0;
    this.lastSignature = '';
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

    // 内容签名：库存 + 选中 + 高度上限。**没变就什么都不做**。
    //
    // 为什么必须有这道：refresh 是跟着 state:changed 走的，而限时关卡里
    // state:changed **每秒**都来一次 —— 每次都重建格子 + 把 scrollY 归零的话，
    // 玩家一松手（下一秒）就被弹回最上面（试玩反馈「总是一松手就回到最上面」）。
    const signature = `${visible.map((i) => i.itemId).join(',')}#${selectedItemId ?? ''}#${Math.round(maxTotalH)}`;
    if (signature === this.lastSignature) return this.lastPanelH;
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
    // 内容真的变了才回到顶部 —— 换了一批东西还停在上次的位置会看到半截空白
    this.scrollY = 0;
    this.content.setPosition(0, viewH / 2, 0);
    this.lastSignature = signature;
    this.lastPanelH = panelH;
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
        // contain：按原图比例撑到最大，**不拉变形**（见文件头第 3 条）。
        // 比格子扁/窄的图，空出来的那圈就是透明的 —— 露的是格子自己的底色，
        // 而不是一块被拉长压扁的图
        const fit = fitContain(
          { width: frame.originalSize.width, height: frame.originalSize.height },
          { width: ICON_BOX, height: ICON_BOX },
        );
        const box = uiNode('icon', slot, fit.w, fit.h, 0.5, 0.5);
        const sprite = box.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = frame;
      });
    } else {
      // **没图才在格子里显示名字** —— 有图的话名字只在选中时出现在下面那行
      // （试玩要求：「已经有图片就不要显示碎片 1，只有点击的时候才有说明」）
      addLabel(slot, 'name', item.name, 17, COLOR.text, 0.5, 0.5);
    }

    // `highlighted` 就是「点之前它是不是已经选中」—— 双击那支要用它判断
    // 第一下是不是把选中态切掉了（见 onTapSlot）
    slot.on(Node.EventType.TOUCH_END, () => this.onTapSlot(item, highlighted), this);
    return slot;
  }

  /**
   * 点了某一格。单击 = 选中/取消选中（老行为），**双击 = 放大看这张图**。
   *
   * 为什么要单独一层：运行时的规矩是「再点同一件 = 取消选中」，而双击的
   * **第二下**正好落在同一条规则上 —— 照老写法处理的话，玩家想看个图，
   * 结果东西被取消选中了。所以双击那一支要**绕开切换**，并且在需要时
   * 把选中态补回来（双击的第一下可能刚把它切掉）。
   *
   * 于是不管从哪个状态双击，结果都一样：那件东西**仍然选中**，图弹出来。
   */
  private onTapSlot(item: InventoryItem, wasSelected: boolean): void {
    const now = Date.now();
    const isDoubleTap = this.lastTapItemId === item.itemId && now - this.lastTapAt <= DOUBLE_TAP_MS;
    this.lastTapItemId = item.itemId;
    this.lastTapAt = now;

    if (isDoubleTap && item.iconKey && this.onInspectIcon) {
      // 第一下已经切过一次选中态了，这里补回来 —— 看完图东西得还在手上
      if (!wasSelected) this.onSelect(item.itemId);
      this.onInspectIcon(item.iconKey);
      return;
    }

    this.onSelect(item.itemId);
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
