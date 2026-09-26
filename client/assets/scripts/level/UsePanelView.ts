/**
 * 道具选择面板：点了一个「使用类」装置之后，列出背包里的东西让玩家挑一件。
 *
 * 为什么要让玩家挑、而不是自动用对的那件：挑错是有意义的。
 * 设计稿里桌上摆着红圆章和蓝方章，玩家手上有两枚章 —— 他得先拿到 B 的排除线索
 * 才知道该用蓝的。自动帮玩家用对，这一步判断就整没了，辨析项也就白设了。
 *
 * 面板**只列背包里已有的道具**，不告诉玩家哪件对 —— 那等于把答案摆在界面上。
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Node, UITransform } from 'cc';

import { ButtonGrid, COLOR, addLabel, makeButton, makePanel, uiNode } from './UiKitView';

const PANEL_WIDTH = 620;
const PADDING = 24;
const HINT_HEIGHT = 40;
const BUTTON_H = 56;
const GAP = 12;
const CANCEL_HEIGHT = 48;

/**
 * 选项少于等于 4 个就排两列，多了排三列。
 *
 * 第 6 关的「3×3 方向板」「九个补给格」各有 9 个选项 —— 挤在 2 列里
 * 会变成 5 行，既高又不像那块板子。
 */
function columnsFor(count: number): number {
  return count <= 4 ? 2 : 3;
}

export class UsePanelView {
  readonly node: Node;

  private readonly body: Node;
  private readonly onPick: (itemId: string) => void;
  private readonly onCancel: () => void;

  constructor(parent: Node, onPick: (itemId: string) => void, onCancel: () => void) {
    this.onPick = onPick;
    this.onCancel = onCancel;
    this.node = uiNode('usePanel', parent, PANEL_WIDTH, BUTTON_H, 0.5, 0.5);
    this.body = uiNode('body', this.node, PANEL_WIDTH, BUTTON_H, 0.5, 0.5);
    this.node.active = false;
  }

  /**
   * 打开面板。
   *
   * `options` 的 `text` 是给玩家看的（道具名、路口名），`key` 是交回给运行时的值
   * （道具 id、选项原文）—— **两者刻意分开**：玩家看到的该是「磁吸杆」，
   * 而不是 `suction_rod`。
   */
  open(hint: string, options: { text: string; key: string }[]): void {
    this.node.active = true;
    this.render(hint, options);
  }

  close(): void {
    this.node.active = false;
    this.clearBody();
  }

  private render(hint: string, options: { text: string; key: string }[]): void {
    this.clearBody();

    const cols = columnsFor(options.length);
    // 按钮宽度按列数算，不然 3 列会撑出面板外面
    const buttonW = (PANEL_WIDTH - PADDING * 2 - (cols - 1) * GAP) / cols;
    const rows = Math.max(1, Math.ceil(options.length / cols));
    const gridH = rows * BUTTON_H + (rows - 1) * GAP;
    const panelH = PADDING * 2 + HINT_HEIGHT + gridH + GAP + CANCEL_HEIGHT;

    this.node.getComponent(UITransform)!.setContentSize(PANEL_WIDTH, panelH);
    makePanel(this.body, 'bg', PANEL_WIDTH, panelH);

    const hintLabel = addLabel(this.body, 'hint', hint, 22, COLOR.text, 0.5, 0.5);
    hintLabel.node.setPosition(0, panelH / 2 - PADDING - HINT_HEIGHT / 2, 0);

    const grid = new ButtonGrid(
      this.body,
      'items',
      cols,
      buttonW,
      BUTTON_H,
      GAP,
      GAP,
      // 空背包时那个占位按钮的 key 是空串，别把它当道具交上去
      (key) => {
        if (key) this.onPick(key);
      },
    );
    grid.render(
      options.length > 0
        ? options.map((option) => ({ text: option.text, key: option.key }))
        : [{ text: '没有可用的东西', key: '', highlighted: false }],
    );
    grid.node.setPosition(
      0,
      panelH / 2 - PADDING - HINT_HEIGHT - GAP - gridH / 2,
      0,
    );

    makeButton(
      this.body,
      'cancel',
      '算了',
      160,
      CANCEL_HEIGHT,
      0,
      -panelH / 2 + PADDING + CANCEL_HEIGHT / 2,
      () => this.onCancel(),
    );
  }

  private clearBody(): void {
    // 先摘再销毁：destroy() 帧末才生效，只调它的话当帧还查得到旧节点
    for (const child of this.body.children.slice()) {
      child.removeFromParent();
      child.destroy();
    }
  }
}
