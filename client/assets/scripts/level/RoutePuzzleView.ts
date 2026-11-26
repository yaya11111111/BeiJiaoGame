import { Color, Graphics, Label, Mask, Node, Sprite, UITransform, view } from 'cc';
import type { EventTouch, SpriteFrame } from 'cc';
import { fitContain, mapRectIntoBox } from '../common/Coord';
import { COLOR, addLabel, makeButton, uiNode } from './UiKitView';
import type { FrameLoader } from './DetailPopupView';
import { routePieceFits, routePuzzleSpec } from './RouteFragments';
import type { RouteBookState } from './RouteFragments';

/** 关内线路拼图。拖动新增残片，接近接口时吸附；随时可以关闭。 */
export class RoutePuzzleView {
  readonly node: Node;
  private request = 0;
  private hiddenExit: Node | null = null;
  private exitWasActive = false;
  private afterClose: (() => void) | null = null;

  constructor(parent: Node, private readonly loadFrame: FrameLoader,
    private readonly complete: (stage: 2 | 3) => boolean) {
    this.node = uiNode('routePuzzle', parent, 1, 1, 0.5, 0.5);
    this.node.active = false;
  }

  isOpen(): boolean { return this.node.active; }

  cancel(): void { this.afterClose = null; this.close(); }

  close(): void {
    this.request += 1;
    if (this.node.isValid) {
      this.node.active = false;
      for (const child of this.node.children.slice()) { child.removeFromParent(); child.destroy(); }
    }
    if (this.hiddenExit?.isValid) this.hiddenExit.active = this.exitWasActive;
    this.hiddenExit = null;
    const callback = this.afterClose; this.afterClose = null;
    callback?.();
  }

  open(state: RouteBookState, onClose?: () => void, readOnly = false): void {
    // 刷新同一个窗口不会误触通关回调。
    this.afterClose = null; this.close(); this.afterClose = onClose ?? null;
    const request = this.request;
    const screen = view.getVisibleSize();
    this.node.getComponent(UITransform)!.setContentSize(screen.width, screen.height);
    this.node.setSiblingIndex(this.node.parent!.children.length - 1);
    const shade = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
    shade.clear(); shade.fillColor = new Color(12, 18, 28, 250);
    shade.rect(-screen.width / 2, -screen.height / 2, screen.width, screen.height); shade.fill();
    this.node.off(Node.EventType.TOUCH_START, this.blockTouch, this);
    this.node.off(Node.EventType.TOUCH_END, this.blockTouch, this);
    this.node.on(Node.EventType.TOUCH_START, this.blockTouch, this);
    this.node.on(Node.EventType.TOUCH_END, this.blockTouch, this);
    this.node.active = true;
    this.hiddenExit = this.node.parent?.parent?.getChildByName('LevelMount.exit') ?? null;
    if (this.hiddenExit) { this.exitWasActive = this.hiddenExit.active; this.hiddenExit.active = false; }
    const stage: 2 | 3 = state.assembled >= 2 && state.fragments.indexOf('route_fragment_3') >= 0 ? 3 : 2;
    const spec = routePuzzleSpec(stage);
    const title = addLabel(this.node, 'title', '线路拼图', 26, COLOR.text, 0.5, 0.5);
    title.node.setPosition(0, screen.height / 2 - 38);
    const hint = addLabel(this.node, 'hint', '', 20, COLOR.text, 0.5, 0.5);
    hint.node.setPosition(-65, -screen.height / 2 + 42);
    hint.enableWrapText = true; hint.overflow = Label.Overflow.SHRINK;
    hint.node.getComponent(UITransform)!.setContentSize(Math.max(240, screen.width - 320), 60);
    const missing = ['route_fragment_1', 'route_fragment_2'].filter(id => state.fragments.indexOf(id) < 0);
    if (missing.length) {
      hint.string = '请在这一关中收集残片！';
      return;
    }
    const area = { width: screen.width - 110, height: screen.height - 160 };
    const fit = fitContain(spec.size, area);
    const board = uiNode('board', this.node, fit.w, fit.h, 0.5, 0.5);
    const valid = () => this.node.isValid && this.node.active && request === this.request && board.isValid;
    const image = (name: string, key: string, rect: [number, number, number, number], done?: (node: Node) => void) => {
      this.loadFrame(key, (frame: SpriteFrame | null) => {
        if (!valid()) return;
        if (!frame) { hint.string = '图片暂时没加载成功，关闭后可重试。'; return; }
        const box = mapRectIntoBox(rect, spec.size, { width: fit.w, height: fit.h });
        const node = uiNode(name, board, box.w, box.h, 0, 0);
        node.setPosition(box.x - fit.w / 2, box.y - fit.h / 2);
        const sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.spriteFrame = frame;
        done?.(node);
      });
    };
    const result = () => {
      image('result', spec.result, [0, 0, spec.size.width, spec.size.height], node => {
        node.setSiblingIndex(board.children.length - 1);
        for (const child of board.children) if (child !== node) child.active = false;
        const caption = stage === 2 ? '残片①②已拼好，下一张残片在第七关。' : '三张残片已拼好，十站路线已补齐。';
        hint.string = caption + '\n点图放大，拖动查看。';
        board.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
        let zoom = 1;
        let last: { x: number; y: number } | null = null;
        let distance = 0;
        node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
          last = event.getUILocation(); distance = 0; event.propagationStopped = true;
        });
        node.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
          if (!last) return;
          const at = event.getUILocation();
          const dx = at.x - last.x; const dy = at.y - last.y; distance += Math.hypot(dx, dy);
          if (zoom > 1) node.setPosition(
            Math.max(fit.w / 2 - fit.w * zoom, Math.min(-fit.w / 2, node.position.x + dx)),
            Math.max(fit.h / 2 - fit.h * zoom, Math.min(-fit.h / 2, node.position.y + dy)));
          last = at; event.propagationStopped = true;
        });
        node.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
          if (!last) return;
          const at = event.getUILocation(); distance += Math.hypot(at.x - last.x, at.y - last.y);
          last = null; event.propagationStopped = true;
          if (distance < 8) this.close();
        });
        node.on(Node.EventType.TOUCH_CANCEL, () => { last = null; });
        if (stage === 2 && state.fragments.indexOf('route_fragment_3') >= 0) {
          makeButton(this.node, 'next', '拼入残片③', 160, 42, 0, screen.height / 2 - 38,
            () => this.open({ ...state, assembled: 2 }, this.afterClose ?? undefined, readOnly));
          title.node.setPosition(-screen.width / 2 + 120, screen.height / 2 - 38);
        }
      });
    };
    if (state.assembled >= stage) { result(); return; }
    hint.string = readOnly ? '双人拼图由A端拖动，完成后会同步结果。' : stage === 2 ? '先拼残片①②：拖动残片②，让边缘和红色路线接上。' : '拖动残片③，补上地图左侧的缺口。';
    image('base', spec.base.key, spec.base.rect, () => {
      // 基底先到，再显示可拖动片，避免网络顺序改变叠放次序。
      image('piece', spec.piece.key, spec.piece.rect, piece => {
        const target = { x: piece.position.x, y: piece.position.y };
        const offsetX = stage === 2 ? fit.w * 0.15 : fit.w * 0.2;
        const offsetY = stage === 2 ? -fit.h * 0.14 : -fit.h * 0.06;
        piece.setPosition(target.x + offsetX, target.y + offsetY);
        if (readOnly) return;
        let last: { x: number; y: number } | null = null;
        let solved = false;
        let moved = 0;
        piece.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
          if (solved) { event.propagationStopped = true; return; } last = event.getUILocation(); moved = 0; event.propagationStopped = true;
        });
        piece.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
          if (!last || solved) return;
          const at = event.getUILocation();
          piece.setPosition(piece.position.x + at.x - last.x, piece.position.y + at.y - last.y);
          moved += Math.hypot(at.x - last.x, at.y - last.y);
          last = at; event.propagationStopped = true;
        });
        const release = (event: EventTouch) => {
          if (!last || solved) return;
          const at = event.getUILocation();
          piece.setPosition(piece.position.x + at.x - last.x, piece.position.y + at.y - last.y);
          moved += Math.hypot(at.x - last.x, at.y - last.y);
          last = null; event.propagationStopped = true;
          if (moved < 8) { this.close(); return; }
          if (routePieceFits(piece.position.x - target.x, piece.position.y - target.y, fit.w, fit.h) && this.complete(stage)) {
            solved = true; piece.setPosition(target.x, target.y);
            if (stage === 2 && state.fragments.indexOf('route_fragment_3') >= 0) this.open({...state,assembled:2},this.afterClose ?? undefined,readOnly);
            else result();
          } else hint.string = '还没对齐，再沿边缘移动一点。';
        };
        piece.on(Node.EventType.TOUCH_END, release);
        piece.on(Node.EventType.TOUCH_CANCEL, () => { last = null; });
      });
    });
  }

  private readonly blockTouch = (event: EventTouch): void => {
    event.propagationStopped = true;
    if (event.type === Node.EventType.TOUCH_END) this.close();
  }
}
