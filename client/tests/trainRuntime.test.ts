import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime, type LevelSyncEvent } from '../assets/scripts/level/LevelRuntime';
import { toSyncEvent } from '../assets/scripts/level/LevelSync';
import { saveDuoSession, loadDuoSession } from '../assets/scripts/ui/DuoSession';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';
import { TrainRuntime, parseTrainSnapshot } from '../assets/scripts/level/TrainRuntime';
import { TRAIN_ROUTES, sampleTrainRoute, trainRouteDuration, trainRoutePoints, type TrainRouteId } from '../assets/scripts/level/TrainRoute';

const config = parseLevelConfig(JSON.parse(readFileSync(new URL('../assets/resources/configs/level.07.json', import.meta.url), 'utf8')));
function atMechanical(): TrainRuntime {
  const train = new TrainRuntime();
  train.command('run'); train.tick(30);
  train.command('toggleA'); train.command('run'); train.tick(30);
  return train;
}
function atReady(): TrainRuntime {
  const train = atMechanical();
  train.command('toggleC'); train.command('run'); train.tick(30);
  return train;
}
describe('第七站列车状态机', () => {
  it('初始四白，C 锁定；错误操作不改变状态', () => {
    const train = new TrainRuntime();
    expect(train.getModel()).toMatchObject({ a: false, b: false, c: false, d: false, phase: 'round1' });
    const before = train.snapshot();
    expect(train.command('toggleC').ok).toBe(false);
    expect(train.command('formal').ok).toBe(false);
    expect(train.snapshot()).toEqual(before);
    train.command('toggleA');
    expect(train.command('run').ok).toBe(false);
    train.command('toggleA');
    expect(train.command('run').ok).toBe(true);
  });
  it('D 在经过西操场时点亮，回库后保留；运行时禁止改道及重复发车', () => {
    const train = new TrainRuntime(); train.command('run');
    expect(train.command('toggleA').ok).toBe(false);
    expect(train.command('run').ok).toBe(false);
    const westTime = TRAIN_ROUTES.round1.slice(0, 3).reduce((sum, leg, i) => sum + leg.duration + (i < 2 ? 0.25 : 0), 0);
    train.tick(westTime - 0.001); expect(train.snapshot().d).toBe(false);
    train.tick(0.002); expect(train.snapshot().d).toBe(true);
    expect(train.snapshot().running).toBe(true);
    train.tick(30);
    expect(train.getModel()).toMatchObject({ point: [785, 838], d: true, b: false, phase: 'round2a', running: false });
    expect(train.command('run').ok).toBe(false);
  });
  it('B 经过图书馆才点亮，解锁 C 但不自动切蓝', () => {
    const train = new TrainRuntime(); train.command('run'); train.tick(30);
    train.command('toggleA'); train.command('run');
    const libraryTime = TRAIN_ROUTES.round2a.slice(0, 3).reduce((sum, leg, i) => sum + leg.duration + (i < 2 ? 0.25 : 0), 0);
    train.tick(libraryTime - 0.001); expect(train.snapshot().b).toBe(false);
    train.tick(0.002);
    expect(train.getModel()).toMatchObject({ b: true, c: false, running: true, phase: 'round2a' });
    expect(train.command('toggleC').ok).toBe(false);
    train.tick(30);
    expect(train.getModel()).toMatchObject({ point: [1104, 449], phase: 'round2b', b: true, c: false, d: true, running: false });
  });
  it('机械楼无限等待手动 C；四灯全蓝仍不能跳过八教和回库', () => {
    const train = atMechanical(); const before = train.snapshot();
    train.tick(300); expect(train.snapshot()).toEqual(before);
    expect(train.command('run').ok).toBe(false);
    train.command('toggleC');
    expect(train.getModel()).toMatchObject({ a: true, b: true, c: true, d: true, canFormal: false });
    expect(train.command('formal').ok).toBe(false);
    train.command('run'); train.tick(30);
    expect(train.getModel()).toMatchObject({ phase: 'ready', eightChecked: true, canFormal: true, point: [785, 838] });
    expect(train.command('run').ok).toBe(false);
  });
  it('正式模式锁住道岔，按完整十站路线抵达天佑，测试路线均不达终点', () => {
    const train = atReady(); train.command('toggleA');
    expect(train.command('formal').ok).toBe(false);
    train.command('toggleA'); train.command('formal');
    expect(train.command('toggleC').ok).toBe(false);
    train.command('run'); train.tick(30);
    expect(train.getModel()).toMatchObject({ phase: 'done', point: [465, 650], running: false });
    expect(['southGate', ...TRAIN_ROUTES.formal.map(leg => leg.station)]).toEqual([
      'southGate', 'shadeRoad', 'siyuan', 'library', 'canteen4', 'mechanical', 'teaching8', 'westField', 'studentCenter', 'mainExhibit',
    ]);
    for (const route of ['round1', 'round2a', 'round2b'] as const) expect(TRAIN_ROUTES[route].some(leg => leg.station === 'mainExhibit')).toBe(false);
  });
  it('A 仅看到停靠状态，B 的记录保留操作依据，经过图书馆时不提前记录机械楼到站', () => {
    const train = new TrainRuntime(); train.command('run'); train.tick(30);
    train.command('toggleA'); train.command('run');
    const libraryTime = TRAIN_ROUTES.round2a.slice(0, 3).reduce((sum, leg, i) => sum + leg.duration + (i < 2 ? 0.25 : 0), 0);
    train.tick(libraryTime + 0.001);
    expect(train.getModel().logs.join('\n')).toContain('经过图书馆：B 白→蓝，C 解锁');
    expect(train.getModel().logs.join('\n')).not.toContain('图书馆→学四→机械楼');
    train.tick(30);
    expect(train.getModel().operatorStatus).toContain('停靠机械楼');
    expect(train.getModel().operatorStatus).not.toContain('切蓝');
    expect(train.getModel().logs.join('\n')).toContain('请手动将 C 切蓝');
    expect(train.command('run').text).not.toContain('切蓝');
  });
  it('重玩清空灯、检测、位置和阶段，同时保持同步版本递增', () => {
    const train = atReady(); const revision = train.snapshot().revision;
    train.reset();
    expect(train.getModel()).toMatchObject({ phase: 'round1', a: false, b: false, c: false, d: false, eightChecked: false, route: null, point: [785, 838] });
    expect(train.snapshot().revision).toBeGreaterThan(revision);
  });
  it('逐帧推进与一次推进在相同时间得到相同位置及检测结果', () => {
    const a = new TrainRuntime(), b = new TrainRuntime();
    a.command('run'); b.command('run');
    a.tick(4);
    for (let i = 0; i < 240; i++) b.tick(1 / 60);
    expect(a.getModel().point[0]).toBeCloseTo(b.getModel().point[0]);
    expect(a.getModel().point[1]).toBeCloseTo(b.getModel().point[1]);
    expect(a.snapshot().d).toBe(b.snapshot().d);
  });
});

describe('列车接入关卡、存档和双人同步', () => {
  it('本地保存并退出的归一化不会丢掉列车状态', () => {
    const store = memoryKeyValueStore();
    const runtime = new LevelRuntime(config, { mode: 'duo', initialView: 'A' });
    runtime.commandTrain('run'); runtime.tick(1.3);
    const progress = runtime.getReview().progress;
    saveDuoSession(store, { roomCode: 'TRAIN1', levelId: 'L07', viewId: 'A', elapsedSec: 1.3, roomStartedAt: 123, progress });
    expect(loadDuoSession(store, 'TRAIN1')?.progress?.train).toEqual(progress.train);
  });
  it.each(['round1', 'round2a', 'round2b', 'formal'] as TrainRouteId[])('%s 运行中退出后，位置及后续流程可以恢复', route => {
    const train = route === 'round1' ? new TrainRuntime() : route === 'round2a' ? (() => {
      const t = new TrainRuntime(); t.command('run'); t.tick(30); t.command('toggleA'); return t;
    })() : route === 'round2b' ? atMechanical() : atReady();
    if (route === 'round2b') train.command('toggleC');
    if (route === 'formal') train.command('formal');
    train.command('run'); train.tick(1.1);
    const runtime = new LevelRuntime(config, { mode: 'solo', restore: {
      inventory: [], revealed: [], doneHotspots: [], wrongCount: 0, stage: '', views: { A: null, B: null }, train: train.snapshot(),
    } });
    expect(runtime.getTrainModel()?.point).toEqual(train.getModel().point);
    const restored = new LevelRuntime(config, { mode: 'solo', restore: runtime.getReview().progress });
    restored.tick(30);
    expect(restored.getTrainModel()?.phase).toBe(({ round1: 'round2a', round2a: 'round2b', round2b: 'ready', formal: 'done' } as const)[route]);
  });
  it('机械楼停靠存档保持白 C；无列车字段的旧存档迁移到适当阶段', () => {
    const progress = new LevelRuntime(config, { mode: 'solo' }).getSnapshot();
    const atPause = new LevelRuntime(config, { mode: 'solo', restore: { ...progress, train: atMechanical().snapshot() } });
    expect(atPause.getTrainModel()).toMatchObject({ phase: 'round2b', c: false, point: [1104, 449] });
    const legacy = { ...progress, train: undefined, doneHotspots: ['hs_a_lap1', 'hs_a_lap2'] };
    const old = new LevelRuntime(config, { mode: 'solo', restore: legacy });
    expect(old.getTrainModel()).toMatchObject({ phase: 'round2b', c: false, point: [1104, 449] });
  });
  it('A 单独控制行车，B 收到检查点和奖励后共同结算；重复和过时事件不倒退状态', () => {
    const a = new LevelRuntime(config, { mode: 'duo', initialView: 'A' });
    const b = new LevelRuntime(config, { mode: 'duo', initialView: 'B' });
    const events: LevelSyncEvent[] = [];
    a.on('sync:out', event => {
      events.push(event);
      const raw = toSyncEvent({ seq: events.length, type: event.type, payload: { ...event, levelId: 'L07' } } as any);
      expect(raw).not.toBeNull();
      b.applyRemote(raw!); a.applyRemote(raw!);
    });
    expect(b.commandTrain('run')).toBe(false);
    a.commandTrain('run'); a.tick(30);
    a.commandTrain('toggleA'); a.commandTrain('run'); a.tick(30);
    expect(b.getTrainModel()).toMatchObject({ phase: 'round2b', c: false, b: true });
    const stale = events[0]; b.applyRemote(stale);
    expect(b.getTrainModel()?.phase).toBe('round2b');
    a.commandTrain('toggleC'); a.commandTrain('run'); a.tick(30);
    a.commandTrain('formal'); a.commandTrain('run'); a.tick(30);
    expect(a.getStatus()).toBe('success'); expect(b.getStatus()).toBe('success');
    expect(b.getInventory().map(item => item.itemId)).toEqual(['card_07', 'route_fragment_3']);
    expect(events.filter(e => e.type === 'result')).toHaveLength(1);
    for (const event of events) b.applyRemote(event);
    expect(b.getInventory()).toHaveLength(2);
  });
  it('切换到维护手册不会停止单人列车，也不能在 B 侧操作道岔', () => {
    const runtime = new LevelRuntime(config, { mode: 'solo' });
    runtime.commandTrain('run'); runtime.switchView('B');
    expect(runtime.commandTrain('toggleA')).toBe(false);
    runtime.tick(30); expect(runtime.getTrainModel()?.phase).toBe('round2a');
  });
  it.each([null, {}, { ...atReady().snapshot(), routeTime: Infinity }, { ...atReady().snapshot(), route: 'missing' },
    { ...atReady().snapshot(), b: false }, { ...atMechanical().snapshot(), phase: 'formal' }])('拒绝异常列车快照 %j', input => {
    expect(parseTrainSnapshot(input)).toBeNull();
    expect(toSyncEvent({ type: 'train', payload: { snapshot: input } } as any)).toBeNull();
  });
});

describe('现图路线几何', () => {
  it('火车底图独立于其他关卡，不能再覆盖机械楼展板谜题', () => {
    expect(config.views.A.assetKey).toBe('bg/L08_train_A');
    const configRoot = new URL('../assets/resources/configs/', import.meta.url);
    for (const file of readdirSync(configRoot).filter(name => /^level\..*\.json$/.test(name) && name !== 'level.07.json')) {
      const other = parseLevelConfig(JSON.parse(readFileSync(new URL(file, configRoot), 'utf8')));
      for (const view of Object.values(other.views)) {
        expect(view.assetKey, `${file} 不应引用火车图`).not.toBe(config.views.A.assetKey);
      }
    }
    const image = readFileSync(new URL('../assets/levels/bg/L08_train_A.jpg', import.meta.url));
    expect(image.readUInt16BE(0)).toBe(0xffd8);
  });
  it.each(Object.keys(TRAIN_ROUTES) as TrainRouteId[])('%s 无瞬移，移动与高亮共用折线，坐标位于 1536×864 内', route => {
    const legs = TRAIN_ROUTES[route];
    legs.forEach((leg, index) => { if (index) expect(leg.points[0]).toEqual(legs[index - 1].points.slice(-1)[0]); });
    for (const [x, y] of trainRoutePoints(route)) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1536);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(864);
    }
    let last = sampleTrainRoute(route, 0).point;
    for (let t = 0.01; t < trainRouteDuration(route); t += 0.01) {
      const { point, angle } = sampleTrainRoute(route, t);
      expect(Math.hypot(point[0] - last[0], point[1] - last[1])).toBeLessThan(15);
      expect(Number.isFinite(angle)).toBe(true); last = point;
    }
  });
});
