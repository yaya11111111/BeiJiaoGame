/**
 * 屏幕上的数字键盘，用来输数字密码（第 1 关的 241、第 3 关的 1012）。
 *
 * 为什么不用系统的输入框（EditBox）：密码盒是「按盒子上的键盘」这个意象，
 * 自绘的数字键盘更贴，而且预览和真机表现完全一致，不用赌原生组件在微信端的差异。
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Label, Node, UITransform } from 'cc';

import type { InputSpec } from '../common/LevelTypes';
import { ButtonGrid, COLOR, addLabel, makePanel, type ButtonSpec } from './UiKitView';

const PANEL_WIDTH = 400;
const BUTTON_W = 108;
const BUTTON_H = 62;
const GAP = 10;
const PADDING = 22;

/**
 * 键盘上的按键排布。'' 是删除，'back' 是返回。
 *
 * **没有提交键**：输满位数就直接提交 —— 真的密码盘就是这样，
 * 玩家少按一次，也不会出现「输完了还愣在那儿」。
 * 底行右边那个位置原本是提交，现在是返回。
 */
const KEYS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'back'],
];

function keyLabel(key: string): string {
  if (key === '') return '删除';
  if (key === 'back') return '返回';
  return key;
}

export class NumberPadView {
  readonly node: Node;

  private readonly slots: Label;
  private readonly grid: ButtonGrid;
  private readonly onSubmit: (digits: string[]) => void;
  private readonly onCancel: () => void;

  private entered: string[] = [];
  private digitCount = 3;
  /**
   * 这个键盘能不能「返回」关掉。
   *
   * 密码门（点某个装置弹出来的）能关；关卡自己的输入键盘（配置里写了
   * `input: 'numberpad'`）是常驻的，关不掉 —— 那种情况返回键根本不用画，
   * 画了就是个按不动的死键。
   */
  private closable = false;

  constructor(parent: Node, onSubmit: (digits: string[]) => void, onCancel: () => void) {
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    const rows = KEYS.length;
    const gridH = rows * BUTTON_H + (rows - 1) * GAP;
    const height = PADDING * 2 + 54 + GAP + gridH;

    const panel = makePanel(parent, 'numberPad', PANEL_WIDTH, height);
    this.node = panel;

    this.slots = addLabel(panel, 'slots', '', 40, COLOR.text, 0.5, 0.5);
    this.slots.node.setPosition(0, height / 2 - PADDING - 27, 0);

    this.grid = new ButtonGrid(panel, 'keys', 3, BUTTON_W, BUTTON_H, GAP, GAP, (key) => this.onKey(key));
    this.renderKeys();

    // renderKeys 之后再量格子的大小 —— 尺寸是 render 时才定下来的
    const gridUt = this.grid.node.getComponent(UITransform)!;
    gridUt.setContentSize(3 * BUTTON_W + 2 * GAP, gridH);
    this.grid.node.setPosition(0, height / 2 - PADDING - 54 - GAP - gridH / 2, 0);

    this.renderSlots();
  }

  /** 换关卡时重新配置位数。closable 见字段注释 */
  applySpec(spec: InputSpec, closable = false): void {
    this.digitCount = spec.digitCount;
    this.closable = closable;
    this.entered = [];
    this.renderSlots();
    this.renderKeys();
    // 显隐不在这里定：面板默认关着，由 LevelView 决定什么时候弹出来
  }

  reset(): void {
    this.entered = [];
    this.renderSlots();
  }

  /** 当前已输入的数字，给界面外层做高亮之类的用 */
  getEntered(): string[] {
    // 用 slice 而不是展开：展开在本项目的构建管线下有坑，见 common/Collections.ts
    return this.entered.slice();
  }

  private onKey(key: string): void {
    if (key === '') {
      this.entered.pop();
      this.renderSlots();
      return;
    }
    if (key === 'back') {
      this.onCancel();
      return;
    }
    if (this.entered.length >= this.digitCount) return; // 输满了再按数字无效

    this.entered.push(key);
    this.renderSlots();

    // 输满最后一位就直接交 —— 不等玩家再找提交键
    if (this.entered.length === this.digitCount) {
      this.onSubmit(this.entered.slice());
    }
  }

  private renderKeys(): void {
    const specs: ButtonSpec[] = [];
    for (const row of KEYS) {
      for (const key of row) {
        // 不能返回的键盘不画返回键，省得留一个按不动的死键
        if (key === 'back' && !this.closable) continue;
        specs.push({ text: keyLabel(key), key });
      }
    }
    this.grid.render(specs);
  }

  /** 显示成 «2 4 _» 这样的占位，位数一眼可见 */
  private renderSlots(): void {
    const cells: string[] = [];
    for (let i = 0; i < this.digitCount; i += 1) {
      cells.push(i < this.entered.length ? this.entered[i] : '_');
    }
    this.slots.string = cells.join('  ');
    this.slots.color = this.entered.length === this.digitCount ? COLOR.success : COLOR.text;
  }
}
