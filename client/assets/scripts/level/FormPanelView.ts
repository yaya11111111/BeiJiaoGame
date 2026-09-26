/**
 * 逐项选择的表单，用来填「引导关」那种有空要填的题。
 *
 * 为什么是**选**而不是**打字**：引导关三个空里两个是中文（"接线员""南门内侧"），
 * 手机上打中文很别扭，而且打错一个字、多一个空格就判错，玩家会莫名其妙地卡住。
 * 给几个候选项让他选，既不用赌系统输入框在微信端的表现，候选项本身还能当干扰项用
 * —— 选错也是玩法的一部分，这跟设计稿里「红圆章是辨析项」是一个思路。
 *
 * 所有空一屏铺开，不做「点一行弹一层」的跳转：字段少（2~4 个），
 * 铺开更直观，也少一层状态要维护。
 *
 * 本文件 import 了 'cc'，所以文件名以 View.ts 结尾。
 */

import { Node, UITransform } from 'cc';

import type { InputSpec } from '../common/LevelTypes';
import { ButtonGrid, COLOR, addLabel, makeButton, makePanel, uiNode } from './UiKitView';

const PANEL_WIDTH = 640;
const PADDING = 24;
const ROW_HEIGHT = 56;
const ROW_GAP = 12;
const LABEL_WIDTH = 110;
const SUBMIT_HEIGHT = 52;

export class FormPanelView {
  readonly node: Node;

  private readonly body: Node;
  private readonly onSubmit: (values: Record<string, string>) => void;
  private readonly onIncomplete: () => void;

  private fields: { label: string; options: string[] }[] = [];
  /** 每个空当前选了什么。键就是空的名字 */
  private chosen: Record<string, string> = {};

  constructor(
    parent: Node,
    onSubmit: (values: Record<string, string>) => void,
    onIncomplete: () => void,
  ) {
    this.onSubmit = onSubmit;
    this.onIncomplete = onIncomplete;

    this.node = uiNode('formPanel', parent, PANEL_WIDTH, ROW_HEIGHT, 0.5, 0.5);
    // 内容每帧重建，所以单独放一层，重建时只清这一层
    this.body = uiNode('body', this.node, PANEL_WIDTH, ROW_HEIGHT, 0.5, 0.5);
  }

  /** 换关卡时重新配置表单。会清掉已选内容 */
  applySpec(spec: InputSpec): void {
    this.fields = spec.fields;
    this.chosen = {};
    this.render();
    // 显隐不在这里定：面板默认关着，由 LevelView 决定什么时候弹出来
  }

  reset(): void {
    this.chosen = {};
    this.render();
  }

  private render(): void {
    this.clearBody();

    if (this.fields.length === 0) return;

    const bodyHeight = this.fields.length * ROW_HEIGHT + (this.fields.length - 1) * ROW_GAP;
    const panelHeight = PADDING * 2 + bodyHeight + ROW_GAP + SUBMIT_HEIGHT;

    // 外层容器要跟着字段数量变高，点击范围才对
    this.node.getComponent(UITransform)!.setContentSize(PANEL_WIDTH, panelHeight);

    makePanel(this.body, 'bg', PANEL_WIDTH, panelHeight);

    this.fields.forEach((field, index) => {
      const y = panelHeight / 2 - PADDING - ROW_HEIGHT / 2 - index * (ROW_HEIGHT + ROW_GAP);

      const label = addLabel(this.body, `label_${index}`, field.label, 24, COLOR.text, 0, 0.5);
      label.node.setPosition(-PANEL_WIDTH / 2 + PADDING + LABEL_WIDTH / 2, y, 0);

      const optionsLeft = -PANEL_WIDTH / 2 + PADDING + LABEL_WIDTH;
      const optionsWidth = PANEL_WIDTH - PADDING * 2 - LABEL_WIDTH;
      const count = field.options.length;
      const gap = 8;
      const buttonW = count > 0 ? (optionsWidth - (count - 1) * gap) / count : optionsWidth;

      const grid = new ButtonGrid(
        this.body,
        `options_${index}`,
        Math.max(1, count),
        Math.max(60, buttonW),
        ROW_HEIGHT - 10,
        gap,
        gap,
        (value) => this.pick(field.label, value),
      );
      grid.render(
        field.options.map((option) => ({
          text: option,
          key: option,
          highlighted: this.chosen[field.label] === option,
        })),
      );
      // 单选一行，网格左对齐摆到标签右边
      grid.node.setPosition(optionsLeft + optionsWidth / 2, y, 0);
    });

    const allChosen = this.fields.every((field) => this.chosen[field.label] !== undefined);
    const submitY = -panelHeight / 2 + PADDING + SUBMIT_HEIGHT / 2;
    makeButton(
      this.body,
      'submit',
      allChosen ? '提交' : `还差 ${this.fields.length - Object.keys(this.chosen).length} 项`,
      200,
      SUBMIT_HEIGHT,
      0,
      submitY,
      () => this.submit(),
      allChosen,
    );
  }

  private pick(label: string, value: string): void {
    this.chosen[label] = value;
    this.render();
  }

  private submit(): void {
    const allChosen = this.fields.every((field) => this.chosen[field.label] !== undefined);
    if (!allChosen) {
      this.onIncomplete();
      return;
    }
    // 拷贝一份再交出去，避免调用方改了这里的状态
    const values: Record<string, string> = {};
    for (const field of this.fields) values[field.label] = this.chosen[field.label];
    this.onSubmit(values);
  }

  private clearBody(): void {
    // 先摘再销毁：destroy() 是帧末生效的，只调它的话当帧还查得到旧节点，会叠出重复内容
    for (const child of this.body.children.slice()) {
      child.removeFromParent();
      child.destroy();
    }
  }
}
