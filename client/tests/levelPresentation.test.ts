import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { fitContain, mapRectIntoBox } from '../assets/scripts/common/Coord';
import { levelConfigPath, parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime } from '../assets/scripts/level/LevelRuntime';

const here = dirname(fileURLToPath(import.meta.url));
const configOf = (level: string) => parseLevelConfig(JSON.parse(readFileSync(resolve(here, `../assets/resources/configs/level.${level}.json`), 'utf8')));

// 执行真正的 View 方法，替换 Cocos 节点、Tween 和绘图接口。
// 手动推进 Tween 用于检查异步回调顺序，不模拟 GPU 渲染。
function harness() {
  class Vec3 { constructor(public x = 0, public y = 0, public z = 0) {} }
  class UITransform { width = 0; height = 0; setContentSize(w: number, h: number) { this.width = w; this.height = h; } }
  class UIOpacity { opacity = 255; }
  class Sprite { static SizeMode = { CUSTOM: 0 }; }
  class Graphics { rect() {} roundRect() {} clear() {} fill() {} }
  class Label { static Overflow = { SHRINK: 0 }; }
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
    static EventType = { TOUCH_END: 'touch-end' };
    children: Node[] = []; parent: Node | null = null; active = true; isValid = true;
    position = new Vec3(); scale = new Vec3(1, 1, 1); components = new Map<any, any>();
    constructor(public name = '') {}
    addComponent(Type: any): any { const value = new Type(); this.components.set(Type, value); return value; }
    getComponent(Type: any): any { return this.components.get(Type) ?? null; }
    setPosition(x: number | Vec3, y = 0, z = 0) { this.position = x instanceof Vec3 ? x : new Vec3(x, y, z); }
    setScale(x: number, y: number, z: number) { this.scale = new Vec3(x, y, z); }
    setSiblingIndex() {} on() {}
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
    Node, UITransform, UIOpacity, Sprite, SpriteFrame, ImageAsset, Graphics, Label, Vec3, Color: class {},
    resources: { load: (key: string, _type: any, _progress: any, done: (err: Error | null, asset: any) => void) => loads.push({ key, done }) },
    Component: class { node = new Node('level'); },
    _decorator: { ccclass: () => (Type: any) => Type, property: () => () => {} },
    Tween: { stopAllByTarget: (target: any) => { for (const a of animations) if (a.target === target) a.active = false; } },
    tween, view: { getVisibleSize: () => ({ width: 1280, height: 720 }) },
  };
  const kit = {
    uiNode, COLOR: {}, addLabel: (parent: Node, name: string) => ({ node: uiNode(name, parent) }),
    makePanel() {}, makeButton() {},
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
  return { load, Node, UITransform, UIOpacity, SpriteFrame, ImageAsset, loads, animations, complete, viewFor };
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
    view.itemNotice.enqueue('漫画卡'); expect(view.finishTotalHoldSec()).toBe(4.4);
    view.config = { ...configOf('04'), finishCard: undefined, finishHoldSec: undefined };
    expect(view.finishTotalHoldSec()).toBe(1.6);
  });
});

describe('关卡图片的加载与退出', () => {
  it('同一张图并发加载只占一份缓存引用，退出一个关卡不会释放另一个关卡的引用', () => {
    vi.useFakeTimers();
    try {
      const h = harness(); const View = h.load('LevelView');
      const first = new View(); const second = new View();
      const onFirst = vi.fn(); const onSecond = vi.fn(); const frame = new h.SpriteFrame();
      first.loadFrame('badge', onFirst); first.loadFrame('badge', onSecond);
      expect(h.loads).toHaveLength(1);
      h.loads[0].done(null, frame);
      expect(onFirst).toHaveBeenCalledWith(frame); expect(onSecond).toHaveBeenCalledWith(frame);
      expect(frame.refs).toBe(1);
      second.loadFrame('badge', () => {}); h.loads[1].done(null, frame);
      first.onDestroy(); vi.runAllTimers(); expect(frame.refs).toBe(1);
      second.onDestroy(); vi.runAllTimers(); expect(frame.refs).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('退出后图片和配置才返回，不访问已被 Cocos 清空的缓存，也不再挂载关卡', () => {
    vi.useFakeTimers();
    try {
      const h = harness(); const View = h.load('LevelView'); const view = new View();
      const done = vi.fn(); view.mount = vi.fn(); const mount = view.mount;
      view.loadFrame('late', done); view.loadConfig(); view.onDestroy();
      view.frameCache = null; view.frameLoads = null; view.config = null;
      const frame = new h.SpriteFrame();
      expect(() => h.loads[0].done(null, frame)).not.toThrow();
      expect(() => h.loads[1].done(null, { json: configOf('05') })).not.toThrow();
      expect(done).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled();
      vi.runAllTimers(); expect(frame.refs).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('图片降级加载生成的纹理一并释放；退出后的降级结果不再生成纹理', () => {
    vi.useFakeTimers();
    try {
      const h = harness(); const View = h.load('LevelView'); const view = new View(); const done = vi.fn();
      view.loadFrame('image-only', done); h.loads[0].done(new Error('not a SpriteFrame'), null);
      const image = new h.ImageAsset(); h.loads[1].done(null, image);
      const frame = done.mock.calls[0][0]; expect(image.refs).toBe(1);
      view.onDestroy(); vi.runAllTimers();
      expect(frame.destroy).toHaveBeenCalledOnce(); expect(frame.texture.destroy).toHaveBeenCalledOnce();
      expect(image.refs).toBe(0);

      const lateView = new View(); const lateDone = vi.fn();
      lateView.loadFrame('late-image', lateDone); h.loads[2].done(new Error('not a SpriteFrame'), null);
      lateView.onDestroy(); lateView.frameCache = null; lateView.frameLoads = null;
      const lateImage = new h.ImageAsset();
      expect(() => h.loads[3].done(null, lateImage)).not.toThrow();
      expect(lateImage.refs).toBe(0); expect(lateDone).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('对话框与倒计时', () => {
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
    expect(view.dialogNode.active).toBe(false);
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
