import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { fitContain, mapRectIntoBox } from '../assets/scripts/common/Coord';
import { parseLevelConfig } from '../assets/scripts/common/LevelConfig';
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
    Node, UITransform, UIOpacity, Sprite, Graphics, Label, Vec3, Color: class {},
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
  return { load, Node, UIOpacity, animations, complete, viewFor };
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

describe('特写与表单表现', () => {
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
