/**
 * 关卡界面的共用零件：建节点、写字、做按钮、排按钮格子。
 *
 * 为什么单独拆出来：输入面板（数字键盘、表单）和 LevelView 都要用这些东西，
 * 复制一份的话改一个圆角要改好几处。和 LevelView 一样，本文件 import 了 'cc'，
 * 所以文件名以 View.ts 结尾，被主 typecheck 排除、走 typecheck:view。
 *
 * 这里的所有东西都只用 Graphics + Label + 触摸事件搭 —— 不用 EditBox 之类的
 * 原生输入组件。理由：这样在浏览器预览和真机上表现完全一致，也不用赌某个
 * 组件在微信端的实现差异。
 */

import { Color, Graphics, Label, Layers, Node, UITransform } from 'cc';

export const COLOR = {
  placeholderBg: new Color(28, 36, 52, 255),
  placeholderEdge: new Color(96, 128, 176, 255),
  placeholderText: new Color(150, 172, 200, 255),
  hotspotOn: new Color(90, 220, 140, 220),
  hotspotOff: new Color(140, 140, 140, 160),
  hotspotDone: new Color(90, 140, 220, 180),
  barBg: new Color(0, 0, 0, 140),
  panelBg: new Color(18, 24, 38, 235),
  text: new Color(240, 244, 250, 255),
  textDim: new Color(170, 180, 196, 255),
  success: new Color(120, 230, 150, 255),
  failed: new Color(240, 130, 130, 255),
  button: new Color(58, 84, 128, 235),
  buttonEdge: new Color(130, 170, 220, 255),
  buttonAlt: new Color(38, 54, 82, 235),
  chosen: new Color(74, 132, 96, 245),
};

/**
 * 新建一个带 UITransform 的 UI 节点。
 * layer 必须设成 UI_2D —— 运行时建的节点默认不在这个层，UI 相机就不渲染它。
 */
export function uiNode(name: string, parent: Node, w: number, h: number, ax: number, ay: number): Node {
  const node = new Node(name);
  node.layer = Layers.Enum.UI_2D;
  const ut = node.addComponent(UITransform);
  ut.setAnchorPoint(ax, ay);
  ut.setContentSize(w, h);
  node.parent = parent;
  return node;
}

export function addLabel(
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

export interface ButtonSpec {
  /** 显示文字 */
  text: string;
  /** 回调时的标识。不填就用 text */
  key?: string;
  /** 需要高亮时用（例如表单里已选中的那一项） */
  highlighted?: boolean;
}

/**
 * 一排/一格子按钮。
 *
 * 按钮的宽高由外面定，格子只负责按列数摆放和转发点击 —— 数字键盘和
 * 表单的选项列表都是它，省得两处各写一遍绘制和命中。
 */
export class ButtonGrid {
  readonly node: Node;
  private readonly buttons: Node[] = [];

  constructor(
    parent: Node,
    name: string,
    private readonly cols: number,
    private readonly buttonW: number,
    private readonly buttonH: number,
    private readonly gapX: number,
    private readonly gapY: number,
    private readonly onPick: (key: string) => void,
  ) {
    // 先按 1 行 1 列建，render() 时再撑到实际需要的大小
    this.node = uiNode(name, parent, buttonW, buttonH, 0.5, 0.5);
  }

  /**
   * 重画。每次都清空重建 —— 按钮数量很少（数字键盘 12 个、选项通常不到 6 个），
   * 重建的开销远小于维护「哪些按钮该复用」的复杂度。
   */
  render(specs: ButtonSpec[]): void {
    for (const button of this.buttons) {
      button.removeFromParent();
      button.destroy();
    }
    this.buttons.length = 0;

    const rows = Math.ceil(specs.length / this.cols);
    const totalW = this.cols * this.buttonW + (this.cols - 1) * this.gapX;
    const totalH = rows * this.buttonH + (rows - 1) * this.gapY;

    const gridUt = this.node.getComponent(UITransform)!;
    gridUt.setContentSize(totalW, totalH);

    specs.forEach((spec, index) => {
      const col = index % this.cols;
      const row = Math.floor(index / this.cols);
      const button = this.makeButton(spec);
      // 网格以中心为原点，第一行在最上面
      button.setPosition(
        -totalW / 2 + this.buttonW / 2 + col * (this.buttonW + this.gapX),
        totalH / 2 - this.buttonH / 2 - row * (this.buttonH + this.gapY),
        0,
      );
      this.buttons.push(button);
    });
  }

  private makeButton(spec: ButtonSpec): Node {
    const node = uiNode('btn', this.node, this.buttonW, this.buttonH, 0.5, 0.5);
    const g = node.addComponent(Graphics);
    const fill = spec.highlighted ? COLOR.chosen : COLOR.button;
    const hw = this.buttonW / 2;
    const hh = this.buttonH / 2;

    g.fillColor = fill;
    g.roundRect(-hw, -hh, this.buttonW, this.buttonH, 8);
    g.fill();
    g.strokeColor = COLOR.buttonEdge;
    g.lineWidth = 2;
    g.roundRect(-hw, -hh, this.buttonW, this.buttonH, 8);
    g.stroke();

    // 按钮窄的时候把字缩小：中文一个字大约占一个字号宽，
    // 不缩的话长选项（「社团负责人」「辣椒炒肉」）会撑出按钮外面
    const fitFont = Math.floor((this.buttonW - 16) / Math.max(1, spec.text.length));
    addLabel(node, 'text', spec.text, Math.max(14, Math.min(24, fitFont)), COLOR.text, 0.5, 0.5);
    node.on(Node.EventType.TOUCH_END, () => this.onPick(spec.key ?? spec.text), this);
    return node;
  }

  setVisible(visible: boolean): void {
    this.node.active = visible;
  }
}

/** 一个圆角按钮，点击回调直接挂在节点上 */
export function makeButton(
  parent: Node,
  name: string,
  text: string,
  w: number,
  h: number,
  x: number,
  y: number,
  onClick: () => void,
  highlighted = false,
): Node {
  const node = uiNode(name, parent, w, h, 0.5, 0.5);
  node.setPosition(x, y, 0);

  const g = node.addComponent(Graphics);
  const hw = w / 2;
  const hh = h / 2;
  g.fillColor = highlighted ? COLOR.chosen : COLOR.button;
  g.roundRect(-hw, -hh, w, h, 8);
  g.fill();
  g.strokeColor = COLOR.buttonEdge;
  g.lineWidth = 2;
  g.roundRect(-hw, -hh, w, h, 8);
  g.stroke();

  addLabel(node, 'text', text, 22, COLOR.text, 0.5, 0.5);
  node.on(Node.EventType.TOUCH_END, onClick, node);
  return node;
}

/** 一块带底色的面板，用来托住输入面板的内容。锚点在中心 */
export function makePanel(parent: Node, name: string, width: number, height: number): Node {
  const panel = uiNode(name, parent, width, height, 0.5, 0.5);
  const g = panel.addComponent(Graphics);
  g.fillColor = COLOR.panelBg;
  g.roundRect(-width / 2, -height / 2, width, height, 12);
  g.fill();
  g.strokeColor = COLOR.buttonEdge;
  g.lineWidth = 2;
  g.roundRect(-width / 2, -height / 2, width, height, 12);
  g.stroke();
  return panel;
}
