/** 物品获得提示。不接收触摸，不改变对话、视角或背包选中状态。 */
import { Color, Graphics, Label, Node, UIOpacity, UITransform } from 'cc';
import { COLOR, addLabel, uiNode, type SafeInsets } from './UiKitView';

const SHOW_SEC = 1.6;
const FADE_IN_SEC = 0.12;
const FADE_OUT_SEC = 0.25;

export class ItemNoticeView {
  readonly node: Node;
  private readonly label: Label;
  private readonly opacity: UIOpacity;
  private readonly background: Graphics;
  private pending: string[] = [];
  private elapsed = 0;
  private width = 0;

  constructor(parent: Node) {
    this.node = uiNode('itemNotice', parent, 1, 64, 0.5, 0.5);
    this.background = this.node.addComponent(Graphics);
    this.opacity = this.node.addComponent(UIOpacity);
    this.label = addLabel(this.node, 'text', '', 24, COLOR.text, 0.5, 0.5);
    this.label.lineHeight = 28;
    this.label.overflow = Label.Overflow.SHRINK;
    this.node.active = false;
  }

  enqueue(name: string): void {
    this.pending.push(name);
  }

  /** 同一帧获得多件时合成一句，后续获得的物品排队显示。 */
  update(dt: number, width: number, height: number, inset: SafeInsets): void {
    if (this.node.active) {
      this.elapsed += Math.max(0, dt);
      if (this.elapsed >= SHOW_SEC) this.node.active = false;
    }
    if (!this.node.active && this.pending.length > 0) {
      this.label.string = `获得${this.pending.splice(0).join('、')}！`;
      this.elapsed = 0;
      this.node.active = true;
    }
    if (!this.node.active) return;

    const available = Math.max(160, width - inset.left - inset.right - 320);
    const boxWidth = Math.min(720, available);
    if (this.width !== boxWidth) {
      this.width = boxWidth;
      this.node.getComponent(UITransform)!.setContentSize(boxWidth, 64);
      this.label.node.getComponent(UITransform)!.setContentSize(boxWidth - 32, 56);
      this.background.clear();
      this.background.fillColor = new Color(20, 30, 38, 225);
      this.background.roundRect(-boxWidth / 2, -32, boxWidth, 64, 12);
      this.background.fill();
    }
    // 中央避开两侧的提示、视角按钮；所有场景统一在安全区内的上方显示。
    this.node.setPosition((inset.left - inset.right) / 2, height / 2 - inset.top - 100, 0);
    this.node.setSiblingIndex(this.node.parent!.children.length - 1);
    const fade = Math.min(1, this.elapsed / FADE_IN_SEC, (SHOW_SEC - this.elapsed) / FADE_OUT_SEC);
    this.opacity.opacity = Math.round(255 * Math.max(0, fade));
  }

  remainingSec(): number {
    return (this.node.active ? Math.max(0, SHOW_SEC - this.elapsed) : 0)
      + (this.pending.length > 0 ? SHOW_SEC : 0);
  }

  clear(): void {
    this.pending = [];
    this.elapsed = 0;
    this.node.active = false;
  }
}
