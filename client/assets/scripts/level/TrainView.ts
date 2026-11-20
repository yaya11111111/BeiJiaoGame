/** 第七站专用画面。只渲染状态，操作交回 LevelRuntime。 */
import { Color, Graphics, Label, Mask, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import type { EventTouch } from 'cc';
import type { Size } from '../common/Coord';
import { addLabel, makeButton, uiNode, COLOR } from './UiKitView';
import { trainSceneLayout, TRAIN_MANUAL_PAGES, TRAIN_MANUAL_TURN_RECT, type TrainSafeInsets } from './TrainLayout';
import { trainRoutePoints, type TrackPoint } from './TrainRoute';
import type { TrainCommand, TrainModel } from './TrainRuntime';
import type { ViewId } from '../common/LevelTypes';

/** 固定字号的长文本：遮罩裁切、纵向拖动，内容变化才重置位置。 */
function scrollableText(parent: Node, name: string, width: number, height: number, x: number, y: number,
  fontSize: number, centered: boolean) {
  const node = uiNode(name, parent, width, height, 0.5, 0.5);
  node.setPosition(x, y);
  node.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
  const label = addLabel(node, 'text', '', fontSize, COLOR.text, 0.5, 1);
  label.lineHeight = Math.round(fontSize * 1.45);
  label.overflow = Label.Overflow.CLAMP;
  label.enableWrapText = true;
  label.horizontalAlign = centered ? Label.HorizontalAlign.CENTER : Label.HorizontalAlign.LEFT;
  let offset = 0, maxOffset = 0;
  let previous = '', dragY: number | null = null;
  const scroll = (delta: number) => {
    offset = Math.max(0, Math.min(maxOffset, offset + delta));
    label.node.setPosition(0, height / 2 + offset);
  };
  node.on(Node.EventType.TOUCH_START, (event: EventTouch) => { dragY = event.getUILocation().y; });
  node.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
    if (dragY === null) return;
    const next = event.getUILocation().y; scroll(next - dragY); dragY = next;
  });
  const end = (event: EventTouch) => {
    if (dragY !== null) scroll(event.getUILocation().y - dragY);
    dragY = null;
  };
  node.on(Node.EventType.TOUCH_END, end); node.on(Node.EventType.TOUCH_CANCEL, end);
  const setText = (text: string) => {
    if (text === previous) return;
    previous = text; label.string = text;
    const perLine = Math.max(1, Math.floor(width / fontSize));
    const lines = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / perLine)), 0);
    const contentHeight = Math.max(height, (lines + 0.5) * label.lineHeight);
    label.node.getComponent(UITransform)!.setContentSize(width, contentHeight);
    label.verticalAlign = centered && contentHeight === height ? Label.VerticalAlign.CENTER : Label.VerticalAlign.TOP;
    maxOffset = contentHeight - height; offset = 0; scroll(0);
  };
  return { node, label, setText };
}

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
  private readonly bLogPanel: ReturnType<typeof scrollableText>;
  private bLogPage = 0;
  private logModel: TrainModel | null = null;
  private readonly olderLog: Node;
  private readonly newerLog: Node;
  private lastKey = '';
  private manualPage = 0;
  private manualTextMode = false;
  private readonly manualFrames: (SpriteFrame | null)[] = [null, null];
  private readonly manualLoading = [false, false];
  private readonly manualFailed = [false, false];
  private readonly manualSprite: Sprite;
  private readonly manualText: Label;
  private readonly manualTextPanel: ReturnType<typeof scrollableText>;
  private readonly manualHint: Label;
  private readonly manualLoadingHint: Label;

  constructor(parent: Node, box: Size, inset: TrainSafeInsets, rulesText: string,
    private readonly load: (key: string, cb: (frame: SpriteFrame | null) => void) => void,
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
    const imageHint = this.label(this.map, 'imageLoading', '线路图加载中…', 30, 900, 70, 768, -432);
    let loadingImages = false;
    let mapReady = false;
    let trainReady = false;
    const loadImages = (): void => {
      if (loadingImages) return;
      loadingImages = true;
      imageHint.string = '线路图加载中…';
      let remaining = 2;
      const done = (): void => {
        if (!imageHint.isValid) return;
        if (--remaining) return;
        loadingImages = false;
        imageHint.node.active = !mapReady || !trainReady;
        imageHint.string = '图片暂未加载，点击重试';
      };
      load('bg/L08_train_A', frame => {
        if (bg.isValid) { backdrop.spriteFrame = frame; mapReady = !!frame; }
        done();
      });
      load('details/L07_train', frame => {
        if (this.train.isValid) { sprite.spriteFrame = frame; trainReady = !!frame; }
        done();
      });
    };
    imageHint.node.on(Node.EventType.TOUCH_END, loadImages);
    const line = uiNode('route', this.map, 1536, 864, 0, 1);
    this.path = line.addComponent(Graphics);
    this.train = uiNode('trainSprite', this.map, 138, 138 * 286 / 1958, 0.5, 0.5);
    const sprite = this.train.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    loadImages();

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

    this.rules = uiNode('trainRules', this.node, box.width, box.height, 0.5, 0.5);
    const manual = uiNode('manualBook', this.rules, 1536, 864, 0, 1);
    manual.setPosition(layout.map.x, layout.map.y + layout.map.h);
    manual.setScale(scale, scale, 1);
    const paper = manual.addComponent(Graphics);
    paper.fillColor = COLOR.panelBg;
    paper.rect(0, -864, 1536, 864); paper.fill();
    const manualImage = uiNode('manualImage', manual, 1536, 864, 0, 1);
    this.manualSprite = manualImage.addComponent(Sprite);
    this.manualSprite.sizeMode = Sprite.SizeMode.CUSTOM;
    const textRect = layout.manualText;
    this.manualTextPanel = scrollableText(this.rules, 'manualTextViewport', textRect.w, textRect.h,
      textRect.x + textRect.w / 2, textRect.y + textRect.h / 2, 26, false);
    this.manualText = this.manualTextPanel.label;
    this.manualTextPanel.setText(rulesText);
    this.manualLoadingHint = this.label(this.rules, 'manualLoading', '', 20, textRect.w, 30,
      textRect.x + textRect.w / 2, textRect.y + textRect.h + 21);
    this.manualLoadingHint.node.on(Node.EventType.TOUCH_END, () => this.showManualPage(true));
    const [turnX, turnY, turnW, turnH] = TRAIN_MANUAL_TURN_RECT;
    const turn = uiNode('turnManualPage', manual, turnW, turnH, 0.5, 0.5);
    turn.setPosition(turnX + turnW / 2, -turnY - turnH / 2);
    turn.on(Node.EventType.TOUCH_END, () => {
      if (this.manualTextMode) return;
      // 当前页加载失败时点击重试，避免在空白页之间来回切换。
      if (this.manualFrames[this.manualPage]) this.manualPage = (this.manualPage + 1) % TRAIN_MANUAL_PAGES.length;
      this.showManualPage(true);
    });
    this.manualHint = this.label(this.rules, 'manualHint', '', 22, layout.caption.w, layout.caption.h,
      layout.caption.x + layout.caption.w / 2, layout.caption.y + layout.caption.h / 2);
    const records = uiNode('manualRecords', this.rules, 292, panelH, 0.5, 0.5);
    records.setPosition(layout.controls.x + 146, layout.controls.y + panelH / 2);
    const recordsBg = records.addComponent(Graphics);
    recordsBg.fillColor = COLOR.panelBg;
    recordsBg.roundRect(-146, -panelH / 2, 292, panelH, 12); recordsBg.fill();
    this.label(records, 'recordsTitle', '线路检测记录', 24, 260, 36, 0, panelH / 2 - 26);
    makeButton(records, 'manualTextToggle', '图片 / 文字说明', 250, 36, 0, panelH / 2 - 67, () => {
      this.manualTextMode = !this.manualTextMode;
      this.showManualPage(true);
    });
    this.bLogPanel = scrollableText(records, 'sharedLog', 268, panelH - 174, 0, -7, 22, true);
    this.bLog = this.bLogPanel.label;
    const pageY = -panelH / 2 + 30;
    this.olderLog = makeButton(records, 'olderLog', '较早记录', 122, 38, -65, pageY, () => {
      this.bLogPage++; this.renderLog();
    });
    this.newerLog = makeButton(records, 'newerLog', '较新记录', 122, 38, 65, pageY, () => {
      this.bLogPage--; this.renderLog();
    });

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
    if (!isA) this.showManualPage();
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
  private showManualPage(retry = false): void {
    const page = this.manualPage;
    if (retry) this.manualFailed[page] = false;
    this.paintManualPage(this.manualFailed[page]);
    if (this.manualTextMode || this.manualFrames[page] || this.manualLoading[page] || this.manualFailed[page]) return;
    this.manualLoading[page] = true;
    this.load(TRAIN_MANUAL_PAGES[page], frame => {
      if (!this.rules.isValid) return;
      this.manualLoading[page] = false;
      this.manualFailed[page] = !frame;
      this.manualFrames[page] = frame;
      if (page === this.manualPage) this.paintManualPage(!frame);
    });
  }

  private paintManualPage(failed = false): void {
    const frame = this.manualFrames[this.manualPage];
    this.manualSprite.spriteFrame = frame;
    this.manualSprite.node.active = !!frame && !this.manualTextMode;
    this.manualText.node.active = !frame || this.manualTextMode;
    this.manualTextPanel.node.active = this.manualText.node.active;
    this.manualLoadingHint.node.active = !frame && !this.manualTextMode;
    this.manualLoadingHint.string = failed ? '手册图片暂未加载，点击此处重试' : '手册图片加载中…';
    this.manualHint.string = this.manualTextMode ? '维护手册 · 文字说明（可上下滑动）' :
      `手册 ${this.manualPage + 1} / ${TRAIN_MANUAL_PAGES.length} · 点击右页${this.manualPage === 0 ? '翻页' : '返回第一页'}`;
  }

  private renderLog(): void {
    const model = this.logModel;
    if (!model) return;
    const pages = Math.max(1, Math.ceil(model.logs.length / 3));
    this.bLogPage = Math.max(0, Math.min(this.bLogPage, pages - 1));
    const end = Math.max(0, model.logs.length - this.bLogPage * 3);
    const entries = model.logs.slice(Math.max(0, end - 3), end);
    this.bLogPanel.setText(`检测记录 ${pages - this.bLogPage}/${pages}\nA ${model.a ? '蓝' : '白'}　B ${model.b ? '蓝' : '白'}\nC ${model.c ? '蓝' : '白'}　D ${model.d ? '蓝' : '白'}\n\n${entries.join('\n') || '暂无检测记录。'}`);
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
