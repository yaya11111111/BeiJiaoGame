/** 第七站专用画面。只渲染状态，操作交回 LevelRuntime。 */
import { Color, Graphics, Label, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import type { Size } from '../common/Coord';
import { addLabel, makeButton, uiNode, COLOR } from './UiKitView';
import { trainSceneLayout, type TrainSafeInsets } from './TrainLayout';
import { trainRoutePoints, type TrackPoint } from './TrainRoute';
import type { TrainCommand, TrainModel } from './TrainRuntime';
import type { ViewId } from '../common/LevelTypes';

export class TrainView {
  readonly node: Node;
  private readonly map: Node;
  private readonly path: Graphics;
  private readonly train: Node;
  private readonly controls: Node;
  private readonly rules: Node;
  private readonly phase: Label;
  private readonly log: Label;
  private readonly lights = new Map<string, Node>();
  private readonly run: Node;
  private readonly formal: Node;
  private readonly routeLabel: Label;
  private readonly bLog: Label;
  private bLogPage = 0;
  private logModel: TrainModel | null = null;
  private readonly olderLog: Node;
  private readonly newerLog: Node;
  private lastKey = '';

  constructor(parent: Node, box: Size, inset: TrainSafeInsets, rulesText: string,
    load: (key: string, cb: (frame: SpriteFrame | null) => void) => void,
    private readonly command: (command: TrainCommand) => void) {
    this.node = uiNode('campusTrain', parent, box.width, box.height, 0.5, 0.5);
    this.node.setPosition(box.width / 2, box.height / 2);
    const canvas = this.node.addComponent(Graphics);
    canvas.fillColor = new Color(24, 31, 43);
    canvas.rect(-box.width / 2, -box.height / 2, box.width, box.height); canvas.fill();
    const layout = trainSceneLayout(box, inset);
    const scale = layout.map.w / 1536;
    this.map = uiNode('trackMap', this.node, 1536, 864, 0, 1);
    this.map.setPosition(layout.map.x, layout.map.y + layout.map.h);
    this.map.setScale(scale, scale, 1);
    const bg = uiNode('mapImage', this.map, 1536, 864, 0, 1);
    const backdrop = bg.addComponent(Sprite);
    backdrop.sizeMode = Sprite.SizeMode.CUSTOM;
    load('bg/L08_train_A', frame => { if (bg.isValid) backdrop.spriteFrame = frame; });
    const line = uiNode('route', this.map, 1536, 864, 0, 1);
    this.path = line.addComponent(Graphics);
    this.train = uiNode('trainSprite', this.map, 138, 138 * 286 / 1958, 0.5, 0.5);
    const sprite = this.train.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    load('details/L07_train', frame => { if (this.train.isValid) sprite.spriteFrame = frame; });

    const panelH = layout.controls.h;
    this.controls = uiNode('trainControls', this.node, 292, panelH, 0.5, 0.5);
    this.controls.setPosition(layout.controls.x + layout.controls.w / 2, layout.controls.y + panelH / 2);
    const bgPanel = this.controls.addComponent(Graphics);
    bgPanel.fillColor = COLOR.panelBg;
    bgPanel.roundRect(-146, -panelH / 2, 292, panelH, 12); bgPanel.fill();
    this.phase = this.label(this.controls, 'phase', '', 22, 260, 42, 0, panelH / 2 - 28);
    ['A', 'B', 'C', 'D'].forEach((id, i) => {
      const x = i % 2 === 0 ? -69 : 69, y = panelH / 2 - (i < 2 ? 78 : 130);
      const button = makeButton(this.controls, `light${id}`, id, 126, 44, x, y, () => {
        if (id === 'A') this.command('toggleA');
        if (id === 'C') this.command('toggleC');
      });
      if (id === 'B' || id === 'D') button.off(Node.EventType.TOUCH_END);
      this.lights.set(id, button);
    });
    this.label(this.controls, 'legend', 'A/C：道岔　 B/D：自动检测灯', 16, 274, 24, 0, panelH / 2 - 166);
    const logTop = panelH / 2 - 184;
    const logBottom = -panelH / 2 + 121;
    this.log = this.label(this.controls, 'log', '', 16, 268, logTop - logBottom, 0, (logTop + logBottom) / 2);
    this.log.horizontalAlign = Label.HorizontalAlign.LEFT;
    this.log.verticalAlign = Label.VerticalAlign.TOP;
    this.run = makeButton(this.controls, 'runTrain', '', 262, 42, 0, -panelH / 2 + 90, () => this.command('run'));
    this.formal = makeButton(this.controls, 'formalMode', '启动正式模式', 262, 42, 0, -panelH / 2 + 36, () => this.command('formal'));
    this.routeLabel = this.label(this.node, 'passedStations', '', 24, layout.caption.w, layout.caption.h,
      layout.caption.x + layout.caption.w / 2, layout.caption.y + layout.caption.h / 2);

    this.rules = uiNode('trainRules', this.node, box.width - 300, box.height - 220, 0.5, 0.5);
    this.rules.setPosition(0, 20);
    const paper = this.rules.addComponent(Graphics);
    paper.fillColor = COLOR.panelBg;
    paper.roundRect(-(box.width - 300) / 2, -(box.height - 220) / 2, box.width - 300, box.height - 220, 14); paper.fill();
    this.label(this.rules, 'title', '线路测试维护手册', 26, box.width - 340, 46, 0, (box.height - 220) / 2 - 38);
    const rule = this.label(this.rules, 'rulesText', rulesText, 22, (box.width - 360) * 0.58, box.height - 340,
      -(box.width - 360) * 0.20, -10);
    rule.horizontalAlign = Label.HorizontalAlign.LEFT;
    rule.verticalAlign = Label.VerticalAlign.TOP;
    const logX = (box.width - 360) * 0.32;
    this.bLog = this.label(this.rules, 'sharedLog', '', 20, (box.width - 360) * 0.34, box.height - 394,
      logX, 17);
    const pageY = -(box.height - 220) / 2 + 30;
    this.olderLog = makeButton(this.rules, 'olderLog', '较早记录', 122, 38, logX - 65, pageY, () => {
      this.bLogPage++; this.renderLog();
    });
    this.newerLog = makeButton(this.rules, 'newerLog', '较新记录', 122, 38, logX + 65, pageY, () => {
      this.bLogPage--; this.renderLog();
    });
    this.bLog.horizontalAlign = Label.HorizontalAlign.LEFT;
    this.bLog.verticalAlign = Label.VerticalAlign.TOP;
  }

  private label(parent: Node, name: string, text: string, size: number, w: number, h: number, x: number, y: number): Label {
    const label = addLabel(parent, name, text, size, COLOR.text, 0.5, 0.5);
    label.node.getComponent(UITransform)!.setContentSize(w, h);
    label.node.setPosition(x, y);
    label.overflow = Label.Overflow.SHRINK;
    return label;
  }

  render(model: TrainModel, currentView: ViewId, interactive: boolean): void {
    const isA = currentView === 'A';
    this.map.active = isA; this.controls.active = isA; this.routeLabel.node.active = isA; this.rules.active = !isA;
    this.train.setPosition(model.point[0], -model.point[1]);
    this.train.angle = model.angle;
    const key = JSON.stringify([currentView, model.revision, interactive]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.phase.string = model.phase === 'done' ? '十站测试完成' : model.phase === 'formal' ? '第三轮 · 正式模式' :
      model.phase === 'round1' ? '第一轮 · 外环检测' : model.phase === 'ready' ? '第二轮完成 · 已回库' : '第二轮 · 内部检测';
    // A 观察线路与当前状态，操作依据和可回看的记录交给 B。
    this.log.string = model.operatorStatus;
    this.logModel = model;
    this.renderLog();
    this.routeLabel.string = model.route ? `本段经过：${model.route === 'round2b' ? '机械楼' : '南门'} → ${model.passed.join(' → ') || '准备发车'}` : '请与搭档核对维护手册，再进行线路测试。';
    for (const id of ['A', 'B', 'C', 'D']) {
      const node = this.lights.get(id)!;
      const blue = model[id.toLowerCase() as 'a' | 'b' | 'c' | 'd'];
      const locked = id === 'C' && !model.b;
      const label = node.getChildByName('text')!.getComponent(Label)!;
      label.string = `${id} ${blue ? '蓝' : '白'}${locked ? '·锁定' : ''}`;
      label.color = blue ? new Color(22, 79, 145) : new Color(55, 62, 70);
      const g = node.getComponent(Graphics)!;
      g.clear(); g.fillColor = locked ? new Color(157, 162, 170) : blue ? new Color(157, 210, 255) : new Color(244, 246, 249);
      g.roundRect(-63, -22, 126, 44, 8); g.fill();
    }
    this.run.getChildByName('text')!.getComponent(Label)!.string = model.runLabel;
    this.paintAction(this.run, interactive && !model.running && model.phase !== 'ready' && model.phase !== 'done');
    this.paintAction(this.formal, interactive && model.canFormal);
    this.path.clear();
    if (model.route) {
      this.path.strokeColor = new Color(77, 193, 255, 200); this.path.lineWidth = 5;
      const points = trainRoutePoints(model.route);
      points.forEach((point: TrackPoint, index) => index === 0 ? this.path.moveTo(point[0], -point[1]) : this.path.lineTo(point[0], -point[1]));
      this.path.stroke();
    }
  }
  private renderLog(): void {
    const model = this.logModel;
    if (!model) return;
    const pages = Math.max(1, Math.ceil(model.logs.length / 3));
    this.bLogPage = Math.max(0, Math.min(this.bLogPage, pages - 1));
    const end = Math.max(0, model.logs.length - this.bLogPage * 3);
    const entries = model.logs.slice(Math.max(0, end - 3), end);
    this.bLog.string = `检测记录 ${pages - this.bLogPage}/${pages}\nA ${model.a ? '蓝' : '白'}　B ${model.b ? '蓝' : '白'}\nC ${model.c ? '蓝' : '白'}　D ${model.d ? '蓝' : '白'}\n\n${entries.join('\n') || '暂无检测记录。'}`;
    this.olderLog.active = this.bLogPage < pages - 1;
    this.newerLog.active = this.bLogPage > 0;
  }
  private paintAction(node: Node, enabled: boolean): void {
    const g = node.getComponent(Graphics)!;
    g.clear(); g.fillColor = enabled ? COLOR.button : COLOR.buttonAlt;
    g.roundRect(-131, -21, 262, 42, 8); g.fill();
    node.getChildByName('text')!.getComponent(Label)!.color = enabled ? COLOR.text : COLOR.textDim;
    // 置灰按钮仍接收点击，让运行时解释缺少哪项条件；B/D 则完全没有触摸处理。
  }
}
