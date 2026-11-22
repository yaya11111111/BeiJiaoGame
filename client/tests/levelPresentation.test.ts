import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { fitContain, mapRectIntoBox } from '../assets/scripts/common/Coord';
import { levelConfigPath, parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime } from '../assets/scripts/level/LevelRuntime';
import * as trainLayout from '../assets/scripts/level/TrainLayout';
import { trainRoutePoints } from '../assets/scripts/level/TrainRoute';
import { TrainRuntime } from '../assets/scripts/level/TrainRuntime';
import * as dialoguePortrait from '../assets/scripts/common/DialoguePortrait';

const here = dirname(fileURLToPath(import.meta.url));
const configOf = (level: string) => parseLevelConfig(JSON.parse(readFileSync(resolve(here, `../assets/resources/configs/level.${level}.json`), 'utf8')));

// 执行真正的 View 方法，替换 Cocos 节点、Tween 和绘图接口。
// 手动推进 Tween 用于检查异步回调顺序，不模拟 GPU 渲染。
function harness(richTextAvailable = false) {
  class Vec3 { constructor(public x = 0, public y = 0, public z = 0) {} }
  class UITransform { width = 0; height = 0; setContentSize(w: number, h: number) { this.width = w; this.height = h; } }
  class UIOpacity { opacity = 255; }
  class Mask { static Type = { GRAPHICS_RECT: 0, GRAPHICS_ELLIPSE: 1 }; enabled = true; }
  class Sprite { static SizeMode = { CUSTOM: 0 }; }
  class Graphics { rect() {} roundRect() {} clear() {} fill() {} stroke() {} }
  class Label { static Overflow = { SHRINK: 0, CLAMP: 1 }; static HorizontalAlign = { LEFT: 0, CENTER: 1 }; static VerticalAlign = { TOP: 0, CENTER: 1 }; }
  class ImageAsset {
    refs = 0;
    addRef() { this.refs += 1; return this; }
    decRef(_autoRelease = true) { this.refs -= 1; return this; }
  }
  class SpriteFrame extends ImageAsset {
    originalSize = { width: 100, height: 100 };
    texture = { destroy: vi.fn() };
    destroy = vi.fn();
    static createWithImage(_image: ImageAsset) { return new SpriteFrame(); }
  }
  const loads: { key: string; done: (err: Error | null, asset: any) => void }[] = [];
  class Node {
    static EventType = { TOUCH_START: 'touch-start', TOUCH_MOVE: 'touch-move', TOUCH_END: 'touch-end', TOUCH_CANCEL: 'touch-cancel' };
    children: Node[] = []; parent: Node | null = null; active = true; isValid = true;
    position = new Vec3(); scale = new Vec3(1, 1, 1); components = new Map<any, any>();
    private listeners = new Map<string, Set<(...args: any[]) => void>>();
    constructor(public name = '') {}
    addComponent(Type: any): any { const value = new Type(); value.node = this; this.components.set(Type, value); return value; }
    addChild(child: Node) { if (child.parent === this) return; child.parent = this; this.children.push(child); }
    getChildByName(name: string) { return this.children.find(child => child.name === name) ?? null; }
    getComponent(Type: any): any { return this.components.get(Type) ?? null; }
    setPosition(x: number | Vec3, y = 0, z = 0) { this.position = x instanceof Vec3 ? x : new Vec3(x, y, z); }
    setScale(x: number, y: number, z: number) { this.scale = new Vec3(x, y, z); }
    setSiblingIndex() {}
    on(type: string, callback: (...args: any[]) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(callback);
    }
    off(type: string) { this.listeners.delete(type); }
    emit(type: string, ...args: any[]) { this.listeners.get(type)?.forEach(callback => callback(...args)); }
    removeFromParent() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    destroy() { this.isValid = false; }
  }
  const animations: { target: any; steps: (() => void)[]; active: boolean }[] = [];
  const tween = (target: any) => {
    const a = { target, steps: [] as (() => void)[], active: true };
    const chain = {
      to(_sec: number, props: object) { a.steps.push(() => Object.assign(target, props)); return chain; },
      call(callback: () => void) { a.steps.push(callback); return chain; },
      start() { animations.push(a); return chain; },
    }; return chain;
  };
  const complete = () => {
    for (const a of animations.slice()) { for (const step of a.steps) { if (!a.active) break; step(); } a.active = false; }
  };
  const uiNode = (name: string, parent: Node, w = 1, h = 1) => {
    const node = new Node(name); node.parent = parent; parent.children.push(node);
    node.addComponent(UITransform).setContentSize(w, h); return node;
  };
  const cc = {
    Node, UITransform, UIOpacity, Sprite, SpriteFrame, ImageAsset, Graphics, Label, Mask, Vec3, Color: class {},
    ...(richTextAvailable ? { RichText: class {} } : {}),
    resources: { load: (key: string, _type: any, _progress: any, done: (err: Error | null, asset: any) => void) => loads.push({ key, done }) },
    Component: class { node = new Node('level'); },
    _decorator: { ccclass: () => (Type: any) => Type, property: () => () => {} },
    Tween: { stopAllByTarget: (target: any) => { for (const a of animations) if (a.target === target) a.active = false; } },
    tween, view: { getVisibleSize: () => ({ width: 1280, height: 720 }) },
  };
  const kit = {
    uiNode, COLOR: { buttonEdge: { r: 0, g: 0, b: 0 }, button: {}, chosen: {}, text: {}, textDim: {} }, addLabel: (parent: Node, name: string, text: string, size: number) => { const label = uiNode(name, parent).addComponent(Label); label.string = text; label.fontSize = size; return label; },
    makePanel() {}, makeButton(parent: Node, name: string, _text: string, w: number, h: number, x: number, y: number, callback: () => void) {
      const node = uiNode(name, parent, w, h); node.setPosition(x, y); node.addComponent(Graphics);
      uiNode('text', node).addComponent(Label); node.on(Node.EventType.TOUCH_END, callback); return node;
    },
    ButtonGrid: class { node: Node; constructor(parent: Node, name: string) { this.node = uiNode(name, parent); } render() {} },
  };
  const load = (name: string): any => {
    const code = transpileModule(readFileSync(resolve(here, `../assets/scripts/level/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2017, experimentalDecorators: true },
    }).outputText;
    const exports: any = {};
    new Function('require', 'exports', code)((id: string) => {
      if (id === 'cc') return cc;
      if (id === './UiKitView') return kit;
      if (id === './LevelAssetsView') return { loadLevelImage: (key: string) => new Promise(resolve => {
        loads.push({ key, done: (_err, asset) => resolve(asset ? asset instanceof SpriteFrame ? { frame: asset } : { image: asset } : null) });
      }) };
      if (id === '../common/DialoguePortrait') return dialoguePortrait;
      if (id === './TrainLayout') return trainLayout;
      if (id === './TrainRoute') return { trainRoutePoints };
      if (id === '../common/Coord') return { fitContain, mapRectIntoBox };
      if (id === '../common/LevelConfig') return { levelConfigPath, parseLevelConfig };
      return {};
    }, exports);
    return exports[name];
  };
  const viewFor = (runtime: LevelRuntime, config = configOf('04')) => {
    const View = load('LevelView'); const view = new View();
    view.runtime = runtime; view.config = config; view.collectDetailKeys(config);
    view.box = { width: 1280, height: 720 }; view.originalSize = { width: 1672, height: 941 };
    view.effectLayer = uiNode('effects', view.node);
    view.loadFrame = (_key: string, done: (frame: any) => void) => done({ originalSize: view.originalSize });
    runtime.on('hotspot:used', (event) => view.onHotspotUsed(event));
    runtime.on('state:changed', (state) => view.syncRevealOverlays(state, false));
    return view;
  };
  return { load, Node, UITransform, UIOpacity, SpriteFrame, ImageAsset, Label, Mask, loads, animations, complete, viewFor };
}

function overlayRuntime() {
  return new LevelRuntime(configOf('04'), { mode: 'solo', initialView: 'B', restore: {
    inventory: ['transparent_sheet'], revealed: [], doneHotspots: [], wrongCount: 0,
    stage: 'grid_plain', views: { A: 'main', B: 'grid_plain' },
  } });
}

describe('上方物品通报', () => {
  it('批量获得合成一句，新物品排队，显示在安全区内上方并自动消失', () => {
    const h = harness(); const Notice = h.load('ItemNoticeView'); const notice = new Notice(new h.Node());
    const inset = { top: 20, bottom: 0, left: 40, right: 0 };
    notice.enqueue('蓝章'); notice.enqueue('磁吸杆'); notice.update(0, 1280, 720, inset);
    expect(notice.label.string).toBe('获得蓝章、磁吸杆！');
    expect(notice.node.position.y).toBe(240); expect(notice.node.position.x).toBe(20);
    notice.update(0.2, 1280, 720, inset);
    expect(notice.opacity.opacity).toBe(255);
    notice.enqueue('空白券'); expect(notice.label.string).toBe('获得蓝章、磁吸杆！');
    notice.update(1.5, 1280, 720, inset); expect(notice.label.string).toBe('获得空白券！');
    notice.update(2, 1280, 720, inset); expect(notice.node.active).toBe(false);
    notice.enqueue('旧局物品'); notice.clear(); notice.update(0.2, 1280, 720, inset);
    expect(notice.node.active).toBe(false); expect(notice.remainingSec()).toBe(0);
  });

  it('最后一步的物品提示能够显示完，已有较长的漫画卡展示时不额外延长', () => {
    const h = harness(); const runtime = overlayRuntime(); const view = h.viewFor(runtime);
    const Notice = h.load('ItemNoticeView'); view.itemNotice = new Notice(view.node);
    view.itemNotice.enqueue('漫画卡'); expect(view.finishTotalHoldSec()).toBe(10.4);
    view.config = { ...configOf('04'), finishCard: undefined, finishHoldSec: undefined, closingText: undefined };
    expect(view.finishTotalHoldSec()).toBe(1.6);
  });
});

describe('背包面板', () => {
  const bagItems = (n: number) => Array.from({ length: n }, (_, i) => ({
    itemId: `i${i}`, name: `道具${i}`, fromNodeId: 'n',
  }));

  it('道具多于可视高度时可以拖动滚动，state:changed 重绘不会跳回顶部', () => {
    const h = harness();
    const Panel = h.load('InventoryPanelView');
    const panel = new Panel(new h.Node('root'), () => {}, () => {});
    panel.openPanel();
    const panelH = panel.refresh(bagItems(10), null, 400);
    expect(panelH).toBeLessThanOrEqual(400);

    const content = panel.content;
    const contentH = content.getComponent(h.UITransform).height;
    const viewH = panel.viewport.getComponent(h.UITransform).height;
    // 格子区比可视区高，多出来的部分靠上下拖动看
    expect(contentH).toBeGreaterThan(viewH);

    const startY = content.position.y;
    content.emit(h.Node.EventType.TOUCH_START, { getUILocation: () => ({ y: 100 }) });
    content.emit(h.Node.EventType.TOUCH_MOVE, { getUILocation: () => ({ y: 180 }) });
    expect(content.position.y).toBeGreaterThan(startY);

    // 限时关每秒一次 state:changed —— 内容没变时不能把滚动位置归零
    const scrolledY = content.position.y;
    panel.refresh(bagItems(10), null, 400);
    expect(content.position.y).toBe(scrolledY);
  });

  it('hidden 的道具不画进格子', () => {
    const h = harness();
    const Panel = h.load('InventoryPanelView');
    const panel = new Panel(new h.Node('root'), () => {}, () => {});
    panel.openPanel();
    panel.refresh([
      { itemId: 'a', name: '展板', fromNodeId: 'n' },
      { itemId: 'b', name: '已就位', fromNodeId: 'n', hidden: true },
    ], null, 400);
    expect(panel.content.children).toHaveLength(1);
  });
});

describe('关卡图片的加载与退出', () => {
  it('同一张图并发加载只占一份缓存引用，退出一个关卡不会释放另一个关卡的引用', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); const View = h.load('LevelView');
      const first = new View(); const second = new View();
      const onFirst = vi.fn(); const onSecond = vi.fn(); const frame = new h.SpriteFrame();
      first.loadFrame('badge', onFirst); first.loadFrame('badge', onSecond);
      expect(h.loads).toHaveLength(1);
      h.loads[0].done(null, frame); await Promise.resolve();
      expect(onFirst).toHaveBeenCalledWith(frame); expect(onSecond).toHaveBeenCalledWith(frame);
      expect(frame.refs).toBe(1);
      second.loadFrame('badge', () => {}); h.loads[1].done(null, frame); await Promise.resolve();
      first.onDestroy(); vi.runAllTimers(); expect(frame.refs).toBe(1);
      second.onDestroy(); vi.runAllTimers(); expect(frame.refs).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('退出后图片和配置才返回，不访问已被 Cocos 清空的缓存，也不再挂载关卡', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); const View = h.load('LevelView'); const view = new View();
      const done = vi.fn(); view.mount = vi.fn(); const mount = view.mount;
      view.loadFrame('late', done); view.loadConfig(); view.onDestroy();
      view.frameCache = null; view.frameLoads = null; view.config = null;
      const frame = new h.SpriteFrame();
      expect(() => h.loads[0].done(null, frame)).not.toThrow();
      expect(() => h.loads[1].done(null, { json: configOf('05') })).not.toThrow();
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled();
      vi.runAllTimers(); expect(frame.refs).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('图片降级加载生成的纹理一并释放；退出后的降级结果不再生成纹理', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); const View = h.load('LevelView'); const view = new View(); const done = vi.fn();
      view.loadFrame('image-only', done);
      const image = new h.ImageAsset(); h.loads[0].done(null, image); await Promise.resolve();
      const frame = done.mock.calls[0][0]; expect(image.refs).toBe(1);
      view.onDestroy(); vi.runAllTimers();
      expect(frame.destroy).toHaveBeenCalledOnce(); expect(frame.texture.destroy).toHaveBeenCalledOnce();
      expect(image.refs).toBe(0);

      const lateView = new View(); const lateDone = vi.fn();
      lateView.loadFrame('late-image', lateDone);
      lateView.onDestroy(); lateView.frameCache = null; lateView.frameLoads = null;
      const lateImage = new h.ImageAsset();
      expect(() => h.loads[1].done(null, lateImage)).not.toThrow();
      await Promise.resolve(); vi.runAllTimers();
      expect(lateImage.refs).toBe(0); expect(lateDone).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('对话框与倒计时', () => {
  it('BB-129：第 1 关双人操作通关两端都发 level.submit（claimRun 幂等），两端仍进入结算', async () => {
    const h = harness();
    const config = configOf('01');
    const host = new LevelRuntime(config, { mode: 'duo', initialView: 'A' });
    const guest = new LevelRuntime(config, { mode: 'duo', initialView: 'B' });
    host.restoreSnapshot({ ...host.getSnapshot(), inventory: ['stamped_ticket'], revealed: ['hs_a_cabinet'] });

    const views = [host, guest].map((runtime) => {
      const levelView = h.viewFor(runtime, config);
      levelView.levelId = config.levelId;
      levelView.roomCode = 'ROOM01';
      levelView.scheduleOnce = vi.fn();
      levelView.flash = vi.fn();
      levelView.cloud = { submit: vi.fn().mockResolvedValue({}) };
      levelView.onFinish = vi.fn();
      runtime.on('level:success', ({ source }) => levelView.onLevelSuccess(source));
      return levelView;
    });
    host.on('sync:out', (event) => guest.applyRemote(event));
    host.tick(1);
    host.selectItem('stamped_ticket');
    expect(host.click('hs_a_cabinet')).toMatchObject({ ok: true, effect: 'used' });

    const [hostView, guestView] = views;
    // 动手的一端先报；对面收到 result 后也补一条 —— 恢复进度 / 丢包时
    // 只要有一条落到服务端，双人榜和搭档档案就都写得进去。两端的用时必须一致，
    // 否则后到的那条会把成绩算成另一个数。
    for (const levelView of views) {
      expect(levelView.cloud.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        code: 'ROOM01', levelId: 'L01', elapsedMs: 1000,
      }));
    }
    await new Promise(resolve => setImmediate(resolve));
    for (const levelView of views) {
      expect(levelView.onFinish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'success', elapsedSec: 1 }));
    }
  });

  it('双人归零时显示正在确认结果，已排队的表单和键盘回调不能提交', () => {
    const h = harness();
    const config = configOf('05');
    const runtime = new LevelRuntime(config, { mode: 'duo', initialView: 'B' });
    const view = h.viewFor(runtime, config);
    view.statusLabel = { string: '', node: new h.Node('status') };
    view.reportSubmit = vi.fn();
    runtime.on('state:changed', (state) => view.refreshHud(state));

    runtime.tick(config.timeLimitSec!);
    view.onFormSubmit({});
    view.onNumberPadSubmit(['1']);

    expect(view.statusLabel.string).toBe('正在确认结果');
    expect(view.reportSubmit).not.toHaveBeenCalled();
  });

  it('海报直接弹特写，可重复查看，且只有查看后才开放领奖券提交', () => {
    const h = harness(); const config = configOf('01');
    const runtime = new LevelRuntime(config, { mode: 'solo' }); const view = h.viewFor(runtime, config);
    view.openDetail = vi.fn();
    expect(runtime.getState().hotspots.some((spot) => spot.nodeId === 'hs_a_cabinet')).toBe(false);
    view.onHotspotClick('hs_a_poster'); view.onHotspotClick('hs_a_poster');
    expect(view.openDetail).toHaveBeenCalledTimes(2);
    expect(view.openDetail).toHaveBeenLastCalledWith('hs_a_poster');
    expect(runtime.getInventory()).toHaveLength(0);
    expect(runtime.getState().hotspots.find((spot) => spot.nodeId === 'hs_a_cabinet')?.enabled).toBe(true);
  });

  it('大字长文能拖动到末尾，倒计时刷新不会重置阅读位置；短文不显示拖动提示', () => {
    const h = harness(); const config = configOf('05');
    const runtime = new LevelRuntime(config, { mode: 'solo' }); const view = h.viewFor(runtime, config);
    const rect = (name: string, w: number, height: number) => {
      const node = new h.Node(name); node.addComponent(h.UITransform).setContentSize(w, height); return node;
    };
    view.lineLabel = { string: '', fontSize: 28, lineHeight: 38 };
    view.dialogNode = new h.Node('dialog'); view.dialogViewport = rect('viewport', 720, 156);
    view.dialogContent = rect('content', 720, 156); view.dialogScrollHint = { node: new h.Node('scrollHint') };
    runtime.on('line:shown', ({ text }) => view.showLine(text));
    runtime.on('state:changed', (state) => view.refreshHud(state));
    runtime.click('hs_a_ticket_pickup');
    expect(view.dialogScrollHint.node.active).toBe(true);
    view.dialogDragY = 100;
    view.endDialogDrag({ getUILocation: () => ({ y: 160 }) });
    expect(view.dialogScrollY).toBe(60); expect(view.dialogDragY).toBeNull();
    view.scrollDialog(10000);
    const contentHeight = view.dialogContent.getComponent(h.UITransform).height;
    expect(view.dialogContent.position.y - contentHeight).toBeCloseTo(-78);
    const scroll = view.dialogScrollY; runtime.tick(1); expect(view.dialogScrollY).toBe(scroll);
    runtime.say('签到成功。');
    expect(view.dialogScrollHint.node.active).toBe(false); expect(view.dialogScrollY).toBe(0);
    expect(view.lineLabel.fontSize).toBe(28);
  });

  it('放宽后的点餐表单仍能完整放进较窄的屏幕', () => {
    const h = harness(); const config = configOf('05');
    const runtime = new LevelRuntime(config, { mode: 'solo' }); const view = h.viewFor(runtime, config);
    const Form = h.load('FormPanelView'); const form = new Form(view.node, () => {}, () => {});
    form.applySpec(runtime.getState().input);
    view.box = { width: 640, height: 720 }; view.dialogTopY = -164;
    view.insets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
    view.layoutInputPanel(form.node);
    const size = form.node.getComponent(h.UITransform);
    expect(size.width * form.node.scale.x).toBeLessThanOrEqual(592);
    expect(size.height * form.node.scale.y).toBeLessThanOrEqual(524);
    expect(form.node.scale.x).toBe(form.node.scale.y);
  });

  function dialogView() {
    const h = harness(); const config = configOf('05');
    const runtime = new LevelRuntime(config, { mode: 'solo' });
    const view = h.viewFor(runtime, config);
    view.lineLabel = { string: '', color: null };
    view.dialogNode = new h.Node('dialog');
    view.scheduleOnce = vi.fn();
    runtime.on('line:shown', ({ text }) => view.showLine(text));
    runtime.on('state:changed', (state) => view.refreshHud(state));
    return { runtime, view };
  }

  it('缺少餐券时的提示保留到下一次操作，不被倒计时清掉', () => {
    const { runtime, view } = dialogView();
    runtime.switchView('B');
    view.onHotspotClick('hs_b_order_terminal');
    expect(view.lineLabel.string).toContain('先在签到台');
    runtime.tick(1);
    expect(view.dialogNode.active).toBe(true);
    expect(view.lineLabel.string).toBe(runtime.getState().lastLine);
    runtime.switchView('A');
    expect(view.dialogNode.active).toBe(false);
  });

  it('还没有读过线索时查看提示，提示不会在下一秒消失', () => {
    const { runtime, view } = dialogView();
    view.onHintClick();
    runtime.tick(1);
    expect(view.lineLabel.string).toBe(configOf('05').hints[0]);
    expect(view.dialogNode.active).toBe(true);
    expect(runtime.getState().hintsRemaining).toBe(2);
    runtime.reset();
    expect(view.lineLabel.string).toBe(configOf('05').openingText);
  });

  it('自动提示等待无操作阈值，关闭新手提示后仍能手动查看', () => {
    const { runtime, view } = dialogView();
    view.update(89);
    expect(runtime.getState().hintsRemaining).toBe(3);
    runtime.noteActivity();
    view.update(89);
    expect(runtime.getState().hintsRemaining).toBe(3);
    view.update(1);
    expect(runtime.getState().hintsRemaining).toBe(2);

    view.autoHintsEnabled = false;
    view.update(90);
    expect(runtime.getState().hintsRemaining).toBe(2);
    view.onHintClick();
    expect(view.lineLabel.string).toBe(configOf('05').hints[1]);
  });
});

describe('特写与表单表现', () => {
  it('子节点先被 Cocos 销毁后，关卡清理仍能完成退订和资源释放', () => {
    const h = harness(); const config = configOf('05');
    const view = h.viewFor(new LevelRuntime(config, { mode: 'solo' }), config);
    const Popup = h.load('DetailPopupView'); const Form = h.load('FormPanelView');
    const Notice = h.load('ItemNoticeView');
    view.detailPopup = new Popup(view.node, (_key: string, done: (frame: any) => void) => done({ originalSize: { width: 100, height: 100 } }));
    view.detailPopup.open('badge', 'pop');
    view.formPanel = new Form(view.node, () => {}, () => {});
    view.itemNotice = new Notice(view.node); view.itemNotice.enqueue('值班牌');
    const off = vi.fn(); const stop = vi.fn();
    view.unsubs = [off]; view.sync = { stop }; view.releaseAllFrames = vi.fn();

    // 对应真实 Cocos 的销毁顺序：子节点已析构，父组件才收到 onDestroy。
    const destroyChild = (node: any): void => {
      for (const child of node.children.slice()) destroyChild(child);
      node.children = null; node.isValid = false;
      node.setPosition = () => { throw new Error('访问了已销毁节点的位置'); };
      node.getComponent = () => { throw new Error('访问了已销毁节点的组件'); };
      Object.defineProperty(node, 'active', { set() { throw new Error('修改了已销毁节点的显隐'); } });
    };
    for (const child of view.node.children.slice()) destroyChild(child);

    expect(() => view.onDestroy()).not.toThrow();
    expect(stop).toHaveBeenCalledOnce(); expect(off).toHaveBeenCalledOnce();
    expect(view.releaseAllFrames).toHaveBeenCalledOnce();
    expect(view.detailPopup.image).toBeNull();
    expect(view.itemNotice.pending).toEqual([]);
  });

  it('第 4 关书架使用明显放大回弹，其他特写保持原来的入场方式', () => {
    const config = configOf('04');
    const shelf = config.views.A.hotspots.find((h) => h.nodeId === 'hs_a_shelf_order')!;
    expect(shelf.detailAnimation).toBe('zoom');
    expect(config.views.B.hotspots.find((h) => h.nodeId === 'hs_b_return_slot')?.detailAnimation).toBe('pop');
    const h = harness(); const Popup = h.load('DetailPopupView');
    const popup = new Popup(new h.Node(), (_key: string, done: (frame: any) => void) => done({ originalSize: { width: 100, height: 100 } }));
    popup.open(shelf.detailKey, shelf.detailAnimation);
    expect(popup.image.scale.x).toBe(0.72);
    h.animations[0].steps[0](); expect(popup.image.scale.x).toBe(1.04);
    h.complete(); expect(popup.image.scale.x).toBe(1);
    expect(popup.image.getComponent(h.UIOpacity).opacity).toBe(255);
  });

  it('关闭、连续打开同一图片时，旧加载回调和旧 Tween 均失效', () => {
    const h = harness(); const Popup = h.load('DetailPopupView');
    const pending: ((frame: any) => void)[] = [];
    const popup = new Popup(new h.Node(), (_key: string, done: (frame: any) => void) => pending.push(done));
    const frame = { originalSize: { width: 100, height: 100 } };
    popup.open('same', 'pop'); popup.open('same', 'rise'); pending[0](frame);
    expect(popup.isOpen()).toBe(false);
    pending[1](frame); expect(popup.isOpen()).toBe(true);
    const holder = popup.image; expect(holder.position.y).toBe(-16);
    popup.close(); h.complete();
    expect(popup.isOpen()).toBe(false); expect(holder.position.y).toBe(-16);
    popup.open('late', 'pop'); popup.close(); pending[2](frame);
    expect(popup.isOpen()).toBe(false);
  });

  it('旧特写直接显示；配置缩放淡入时完成态大小和透明度正确', () => {
    const h = harness(); const Popup = h.load('DetailPopupView');
    const popup = new Popup(new h.Node(), (_key: string, done: (frame: any) => void) => done({ originalSize: { width: 100, height: 100 } }));
    popup.open('old'); expect(h.animations).toHaveLength(0);
    popup.open('new', 'pop'); expect(popup.image.scale.x).toBe(0.92);
    h.complete(); expect(popup.image.scale.x).toBe(1);
    expect(popup.image.getComponent(h.UIOpacity).opacity).toBe(255);
  });

  it('点餐答错保留选项；抖动不改变布局，关闭立即停止', () => {
    const h = harness(); const Form = h.load('FormPanelView'); const config = configOf('05');
    const form = new Form(new h.Node(), () => {}, () => {});
    const runtime = new LevelRuntime(config, { mode: 'solo', restore: {
      inventory: ['meal_voucher'], revealed: [], doneHotspots: [], wrongCount: 0, stage: '', views: { A: null, B: null },
    } });
    form.applySpec(runtime.getState().input);
    const chosen = { ...config.puzzle!.answer, 套餐结算: 'A 套餐' };
    for (const [label, value] of Object.entries(chosen)) form.pick(label, value);
    form.node.setPosition(0, 80, 0); form.node.setScale(0.7, 0.7, 1);
    const view = h.viewFor(runtime, config); view.levelId = 'L05'; view.formPanel = form; view.reportSubmit = vi.fn();
    runtime.on('answer:wrong', () => form.shake()); view.onFormSubmit(chosen);
    expect(runtime.getState().attemptsLeft).toBe(4); expect(form.chosen).toEqual(chosen);
    form.setVisible(false); h.complete();
    expect(form.body.position.x).toBe(0); expect(form.node.position.y).toBe(80); expect(form.node.scale.x).toBe(0.7);
  });
});

describe('显影动画与场景一致性', () => {
  it('背景图加载晚于叠图时，不清掉正在播放的淡入动画', () => {
    const h = harness(); const runtime = overlayRuntime(); const view = h.viewFor(runtime);
    const pending: ((frame: any) => void)[] = [];
    view.loadFrame = (_key: string, done: (frame: any) => void) => pending.push(done);
    view.touchBackdrop = vi.fn(); view.layoutBackground = vi.fn();
    view.syncHotspots = vi.fn(); view.refreshHud = vi.fn(); view.syncEggOverlays = vi.fn();
    view.renderedSceneKey = 'B:grid_plain'; view.renderView(runtime.getState());
    runtime.useItem('hs_b_overlay_entry', 'transparent_sheet');
    const frame = { originalSize: { width: 1672, height: 941 } };
    pending[1](frame); pending[0](frame);
    expect(runtime.getCurrentScene()).toBe('grid_plain');
    expect(view.revealOverlayNodes.has('hs_b_overlay_entry')).toBe(true);
    h.complete(); expect(runtime.getCurrentScene()).toBe('grid_overlay');
  });

  it('资料盒通关时由成功事件打开完结图，操作回调不能再打开一次', () => {
    const h = harness(); const runtime = new LevelRuntime(configOf('04'), { mode: 'solo', initialView: 'B', restore: {
      inventory: ['library_card_returned'], revealed: [], doneHotspots: [], wrongCount: 0,
      stage: 'box_code_correct', views: { A: 'main', B: 'box_code_correct' },
    } });
    const view = h.viewFor(runtime); const open = vi.fn(); view.detailPopup = { open };
    runtime.on('level:success', () => open('details/L04_archive_paper'));
    view.pendingUseNodeId = 'hs_b_locker_slot'; view.pendingUseKind = 'item';
    view.onUsePick('library_card_returned');
    expect(runtime.getStatus()).toBe('success'); expect(open).toHaveBeenCalledTimes(1);
  });

  it('操作成功只播放一次，倒计时刷新不重播，淡入完成才切场景', () => {
    const h = harness(); const runtime = overlayRuntime(); h.viewFor(runtime);
    expect(runtime.useItem('hs_b_overlay_entry', 'transparent_sheet').ok).toBe(true);
    expect(runtime.getCurrentScene()).toBe('grid_plain');
    runtime.tick(1); runtime.tick(1); expect(h.animations).toHaveLength(1);
    h.complete(); expect(runtime.getCurrentScene()).toBe('grid_overlay'); expect(runtime.getInventory()).toEqual([]);
  });

  it.each(['leave', 'timeout'] as const)('%s 打断后旧动画不能把玩家带回目标场景', (action) => {
    const h = harness(); const runtime = overlayRuntime(); const view = h.viewFor(runtime);
    runtime.useItem('hs_b_overlay_entry', 'transparent_sheet');
    if (action === 'leave') runtime.goToScene('main'); else runtime.tick(900);
    view.clearRevealOverlays(); h.complete();
    expect(runtime.getCurrentScene()).toBe(action === 'leave' ? 'main' : 'grid_plain');
    expect(runtime.getStatus()).toBe(action === 'leave' ? 'playing' : 'failed');
  });

  it('动画中保存后恢复，直接显示完成场景，不重播、不重复消耗', () => {
    const runtime = overlayRuntime(); runtime.useItem('hs_b_overlay_entry', 'transparent_sheet');
    const restored = new LevelRuntime(configOf('04'), { mode: 'solo', initialView: 'B', restore: runtime.getSnapshot() });
    const h = harness(); const view = h.viewFor(restored); view.syncRevealOverlays(restored.getState(), false);
    expect(restored.getCurrentScene()).toBe('grid_overlay'); expect(restored.getInventory()).toEqual([]);
    expect(h.animations).toHaveLength(0);
  });

  it('重复远端 use 不重播；其他视角不显示叠图，切回后直接显示完成态', () => {
    const h = harness(); const runtime = overlayRuntime(); runtime.switchView('A'); const view = h.viewFor(runtime);
    const event = { type: 'use' as const, nodeId: 'hs_b_overlay_entry', consumed: ['transparent_sheet'], produced: [] };
    runtime.applyRemote(event); runtime.applyRemote(event); expect(h.animations).toHaveLength(0);
    runtime.switchView('B'); view.syncRevealOverlays(runtime.getState(), false);
    expect(runtime.getCurrentScene()).toBe('grid_overlay'); expect(runtime.getInventory()).toEqual([]);
  });
});

describe('结算成绩异步返回', () => {
  it('透传服务端成绩且不重复触发通关；旧局的迟到结果不能污染重玩', async () => {
    const config = configOf('05');
    const h = harness();
    const runtime = new LevelRuntime(config, { mode: 'solo', restore: {
      inventory: ['meal_voucher'], revealed: [], doneHotspots: [], wrongCount: 0, stage: '', views: { A: null, B: null },
    } });
    const view = h.viewFor(runtime, config);
    const responses: ((result: object) => void)[] = [];
    view.cloud = { submit: vi.fn(() => new Promise(resolve => responses.push(resolve))) };
    view.onFinish = vi.fn(); view.onScore = vi.fn(); view.levelId = 'L05';
    view.reportSubmit(config.puzzle!.answer); runtime.submit(config.puzzle!.answer); view.notifyFinish();
    responses[0]({ correct: true, score: 980, rank: 3, isNewBest: true }); await new Promise(resolve => setImmediate(resolve));
    expect(view.onScore).toHaveBeenCalledWith(expect.objectContaining({ score: 980, rank: 3 }));
    expect(view.onFinish).toHaveBeenCalledTimes(1);
    expect(view.onFinish).toHaveBeenCalledWith(expect.objectContaining({ score: 980, rank: 3 }));
    view.reportSubmit(config.puzzle!.answer);
    runtime.reset(); view.onScore.mockClear();
    responses[1]({ correct: true, score: 999, rank: 1 }); await Promise.resolve();
    expect(view.onScore).not.toHaveBeenCalled(); expect(runtime.getReview().rank).toBeUndefined();
  });
});

describe('结算请求与收尾展示并行', () => {
  function successfulView() {
    const config = configOf('05'); const h = harness();
    const runtime = new LevelRuntime(config, { mode: 'solo', restore: {
      inventory: ['meal_voucher'], revealed: [], doneHotspots: [], wrongCount: 0, stage: '', views: { A: null, B: null },
    } });
    const view = h.viewFor(runtime, config);
    let respond!: (result: object) => void;
    view.cloud = { submit: () => new Promise(resolve => { respond = resolve; }) };
    view.onFinish = vi.fn(); view.onScore = vi.fn(); view.flash = vi.fn(); view.scheduleOnce = vi.fn();
    view.finishDetail = 'details/L05_receipt_success';
    view.levelId = 'L05'; view.reportSubmit(config.puzzle!.answer); runtime.submit(config.puzzle!.answer);
    view.onLevelSuccess('local');
    return { view, respond };
  }
  it('云请求用掉的 2 秒不会再次加到奖励图、卡片与结尾文字之后', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    try {
      const { view, respond } = successfulView();
      const total = view.finishTotalHoldSec(); expect(total).toBeCloseTo(10.4);
      await vi.advanceTimersByTimeAsync(2000);
      respond({ correct: true, score: 980, rank: 3 }); await Promise.resolve(); await Promise.resolve();
      expect(view.onFinish).toHaveBeenCalledOnce();
      expect(view.finishRemainingHoldSec() + 2).toBeCloseTo(total);
      expect(view.getReview()).toMatchObject({ score: 980, rank: 3 });
    } finally { vi.useRealTimers(); }
  });
  it('服务端超时仍在同一展示期限内交接；迟到成绩只补发且不重复结算', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    try {
      const { view, respond } = successfulView();
      await vi.advanceTimersByTimeAsync(3000);
      expect(view.onFinish).toHaveBeenCalledOnce();
      expect(view.finishRemainingHoldSec()).toBeCloseTo(7.4);
      await vi.advanceTimersByTimeAsync(2000);
      respond({ correct: true, score: 980, rank: 3 }); await Promise.resolve(); await Promise.resolve();
      expect(view.onFinish).toHaveBeenCalledOnce(); expect(view.onScore).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('已经消退的道具通报不会被重复扣除展示时间', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    try {
      const { view, respond } = successfulView();
      view.config = { ...view.config, finishCard: undefined, closingText: undefined }; view.finishDetail = null;
      view.itemNotice = { remainingSec: () => 1.5 };
      await vi.advanceTimersByTimeAsync(2000);
      expect(view.finishRemainingHoldSec()).toBe(1.5);
      respond({ correct: true }); await Promise.resolve(); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
});

describe('第七关 B 侧书页', () => {
  it('按原图右页热点来回翻页，异步加载失败可重试；切换视角和看记录不改变列车', () => {
    const h = harness(); const View = h.load('TrainView'); const model = new TrainRuntime(); const before = model.snapshot();
    const pending: { key: string; done: (frame: any) => void }[] = []; const command = vi.fn();
    const book = new View(new h.Node(), { width: 1280, height: 720 }, { left: 0, right: 0, top: 0, bottom: 0 },
      '维护手册文字说明', (key: string, done: (frame: any) => void) => pending.push({ key, done }), command);
    book.render(model.getModel(), 'B', true);
    const manual = book.rules.getChildByName('manualBook'); const turn = manual.getChildByName('turnManualPage');
    expect(turn.position).toMatchObject({ x: 803 + 684 / 2, y: -115 - 623 / 2 });
    expect(turn.getComponent(h.UITransform)).toMatchObject({ width: 684, height: 623 });
    const requests = () => pending.filter(request => request.key.startsWith('bg/L07_B_page'));
    const first = new h.SpriteFrame(); const second = new h.SpriteFrame();
    expect(requests().map(request => request.key)).toEqual(['bg/L07_B_page1']);
    turn.emit(h.Node.EventType.TOUCH_END); expect(requests()).toHaveLength(1);
    requests()[0].done(first); expect(book.manualSprite.spriteFrame).toBe(first);
    expect(book.manualText.node.active).toBe(false);
    turn.emit(h.Node.EventType.TOUCH_END); expect(book.manualPage).toBe(1);
    requests()[1].done(null); expect(book.manualText.node.active).toBe(true);
    book.render(model.getModel(), 'B', true); expect(requests()).toHaveLength(2);
    turn.emit(h.Node.EventType.TOUCH_END); expect(requests().map(request => request.key)).toEqual([
      'bg/L07_B_page1', 'bg/L07_B_page2', 'bg/L07_B_page2',
    ]);
    requests()[2].done(second); expect(book.manualSprite.spriteFrame).toBe(second);
    book.render(model.getModel(), 'A', true); expect(book.rules.active).toBe(false);
    book.render(model.getModel(), 'B', true); expect(book.manualPage).toBe(1);
    turn.emit(h.Node.EventType.TOUCH_END); expect(book.manualPage).toBe(0);
    expect(book.manualSprite.spriteFrame).toBe(first); expect(requests()).toHaveLength(3);
    book.rules.getChildByName('manualRecords').getChildByName('manualTextToggle').emit(h.Node.EventType.TOUCH_END);
    expect(book.manualText.node.active).toBe(true); expect(book.manualSprite.node.active).toBe(false);
    expect(command).not.toHaveBeenCalled(); expect(model.snapshot()).toEqual(before);
  });
});

describe('第七关长文字与对话人物', () => {
  it('手册固定大字号可上下滚动，滚动不翻页；短检测记录居中', () => {
    const h = harness(); const View = h.load('TrainView'); const model = new TrainRuntime();
    const book = new View(new h.Node(), { width: 1280, height: 720 }, { left: 0, right: 0, top: 0, bottom: 0 },
      '维护手册内容。'.repeat(160), () => {}, vi.fn());
    book.render(model.getModel(), 'B', true);
    expect(book.manualText.fontSize).toBe(26);
    expect(book.manualText.overflow).toBe(h.Label.Overflow.CLAMP);
    const viewport = book.manualTextPanel.node;
    const top = book.manualText.node.position.y;
    const event = (y: number) => ({ getUILocation: () => ({ y }) });
    viewport.emit(h.Node.EventType.TOUCH_START, event(100));
    viewport.emit(h.Node.EventType.TOUCH_MOVE, event(400));
    viewport.emit(h.Node.EventType.TOUCH_END, event(500));
    expect(book.manualText.node.position.y).toBe(top + 400); expect(book.manualPage).toBe(0);
    book.render(model.getModel(), 'B', true);
    expect(book.manualText.node.position.y).toBe(top + 400);
    viewport.emit(h.Node.EventType.TOUCH_START, event(500));
    viewport.emit(h.Node.EventType.TOUCH_END, event(-10000));
    expect(book.manualText.node.position.y).toBe(top);
    expect(book.bLog.fontSize).toBe(22);
    expect(book.bLog.horizontalAlign).toBe(h.Label.HorizontalAlign.CENTER);
    expect(book.bLog.verticalAlign).toBe(h.Label.VerticalAlign.CENTER);
  });
  it('小轨使用较大的智能头像；无台词时人物消失，旧图片不能覆盖新人物', () => {
    const h = harness(); const View = h.load('DialoguePortraitView');
    const pending: { key: string; done: (frame: any) => void }[] = [];
    const portraits = new View(new h.Node(), dialoguePortrait.dialoguePortraitLayout(
      { width: 1280, height: 720 }, { left: 0, right: 0, top: 0, bottom: 0 }),
      (key: string, done: (frame: any) => void) => pending.push({ key, done }));
    portraits.render('小轨：收到。\n海海：出发吧。', 'A');
    expect(pending.map(item => item.key)).toEqual(['overlays/A', 'overlays/XiaoGui']);
    const head = new h.SpriteFrame(); head.originalSize = { width: 935, height: 850 };
    pending[1].done(head);
    expect(portraits.slots[1].image.getComponent(h.Mask)).toMatchObject({ enabled: true, type: h.Mask.Type.GRAPHICS_ELLIPSE });
    expect(portraits.slots[1].image.getComponent(h.UITransform).height).toBeGreaterThan(190);
    portraits.render('海海和小明在学四餐厅停下来吃饭。', 'A');
    expect(portraits.slots.every((slot: any) => !slot.node.active)).toBe(true);
    portraits.render('小明：先吃饭。\n海海：好。', 'B');
    pending[0].done(new h.SpriteFrame());
    expect(portraits.slots[0].node.active).toBe(false);
    expect(portraits.slots[0].role).toBe('B'); expect(portraits.slots[1].role).toBe('XiaoMing');
    portraits.render('', 'B');
    pending[2].done(new h.SpriteFrame()); pending[3].done(new h.SpriteFrame());
    expect(portraits.slots.every((slot: any) => !slot.node.active)).toBe(true);
  });
});

it('对话显示姓名粗体，运行时原始台词保持不变；实际图片脚部对齐底边', () => {
  const h = harness(true); const runtime = new LevelRuntime(configOf('05'), { mode: 'solo' });
  const view = h.viewFor(runtime); view.lineLabel = { string: '', fontColor: null, fontSize: 28, lineHeight: 38 };
  runtime.on('line:shown', ({ text }) => view.showLine(text));
  const text = '小轨：归档完成。\n海海：收到。'; runtime.say(text);
  expect(view.lineLabel.string).toBe('<b>小轨：</b>归档完成。\n<b>海海：</b>收到。');
  expect(runtime.getState().lastLine).toBe(text);
  const View = h.load('DialoguePortraitView'); const pending: ((frame: any) => void)[] = [];
  const layout = dialoguePortrait.dialoguePortraitLayout({ width: 1280, height: 720 }, { left: 0, right: 0, top: 0, bottom: 0 });
  const portraits = new View(new h.Node(), layout, (_key: string, done: (frame: any) => void) => pending.push(done));
  portraits.render('海海：出发。', 'A');
  const frame = new h.SpriteFrame(); frame.originalSize = { width: 257, height: 868 }; pending[0](frame);
  const slot = portraits.slots[0]; const image = slot.image.getComponent(h.UITransform);
  expect(image.height).toBeGreaterThan(550);
  expect(slot.node.position.y - image.height / 2).toBeCloseTo(layout.bottom);
});

it.each([false, true])('进关引擎富文本可用=%s：对话组件初始化成功，后续背景仍能开始加载', (available) => {
  const h = harness(available); const config = configOf('05'); const runtime = new LevelRuntime(config, { mode: 'solo' });
  const view = h.viewFor(runtime, config);
  view.dialogContent = new h.Node('dialogContent'); view.dialogNode = new h.Node('dialog');
  expect(() => view.createDialogueLabel(904)).not.toThrow();
  view.setDialogText('小轨：归档完成。');
  expect(view.lineLabel.string).toBe(available ? '<b>小轨：</b>归档完成。' : '小轨：归档完成。');
  view.renderedSceneKey = 'A:main';
  view.touchBackdrop = vi.fn(); view.layoutBackground = vi.fn(); view.syncHotspots = vi.fn(); view.refreshHud = vi.fn();
  view.syncRevealOverlays = vi.fn(); view.syncEggOverlays = vi.fn();
  view.loadFrame = vi.fn();
  expect(() => view.renderView(runtime.getState())).not.toThrow();
  expect(view.loadFrame).toHaveBeenCalledWith('bg/L05_A_scene', expect.any(Function));
});
