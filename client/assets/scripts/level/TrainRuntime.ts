import { sampleTrainRoute, trainRouteDuration, TRAIN_STATION_NAMES, type TrainRouteId, type TrainStation } from './TrainRoute';

export type TrainPhase = 'round1' | 'round2a' | 'round2b' | 'ready' | 'formal' | 'done';
export type TrainCommand = 'toggleA' | 'toggleC' | 'run' | 'formal';
export interface TrainSnapshot {
  version: 1;
  revision: number;
  a: boolean; b: boolean; c: boolean; d: boolean;
  eightChecked: boolean;
  phase: TrainPhase;
  route: TrainRouteId | null;
  routeTime: number;
  running: boolean;
}
export interface TrainModel extends TrainSnapshot {
  point: readonly [number, number];
  angle: number;
  passed: string[];
  logs: string[];
  operatorStatus: string;
  canFormal: boolean;
  runLabel: string;
}
function includes<T>(values: readonly T[], value: T): boolean { return values.indexOf(value) !== -1; }
const PHASES: TrainPhase[] = ['round1', 'round2a', 'round2b', 'ready', 'formal', 'done'];
const ROUTES: TrainRouteId[] = ['round1', 'round2a', 'round2b', 'formal'];
/** 云端与本机存档都经过同一形状校验，非法路径和时间不能进入采样器。 */
export function parseTrainSnapshot(value: unknown): TrainSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as TrainSnapshot;
  if (s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !includes(PHASES, s.phase) || ![s.a, s.b, s.c, s.d, s.eightChecked, s.running].every(v => typeof v === 'boolean') ||
      (s.route !== null && !includes(ROUTES, s.route)) || !Number.isFinite(s.routeTime) || s.routeTime < 0 ||
      (s.route === null && (s.running || s.routeTime !== 0)) ||
      (s.route !== null && s.routeTime > trainRouteDuration(s.route)) ||
      (s.c && !s.b) || (s.eightChecked && (!s.b || !s.d))) return null;
  if (s.running && s.route !== s.phase) return null;
  if (s.running && ((s.phase === 'round1' && s.a) || (s.phase === 'round2a' && !s.a) ||
      (s.phase === 'round2b' && !s.c))) return null;
  if (!s.running) {
    const completedRoute: Record<TrainPhase, TrainRouteId | null> = {
      round1: null, round2a: 'round1', round2b: 'round2a', ready: 'round2b', formal: null, done: 'formal',
    };
    if (s.route !== completedRoute[s.phase] || (s.route && s.routeTime !== trainRouteDuration(s.route))) return null;
  }
  if (s.phase !== 'round1' && !s.d) return null;
  if (includes(['round2b', 'ready', 'formal', 'done'], s.phase) && !s.b) return null;
  if (includes(['ready', 'formal', 'done'], s.phase) && !s.eightChecked) return null;
  if (includes(['formal', 'done'], s.phase) && (!s.a || !s.c)) return null;
  return { version: 1, revision: s.revision, a: s.a, b: s.b, c: s.c, d: s.d,
    eightChecked: s.eightChecked, phase: s.phase, route: s.route, routeTime: s.routeTime, running: s.running };
}
function initial(revision = 0): TrainSnapshot {
  return { version: 1, revision, a: false, b: false, c: false, d: false,
    eightChecked: false, phase: 'round1', route: null, routeTime: 0, running: false };
}
/** 逻辑独立于 Cocos。动画结束、检测灯和暂停都由同一条路线的时间轴决定。 */
export class TrainRuntime {
  private state = initial();
  snapshot(): TrainSnapshot { return { ...this.state }; }
  restore(snapshot: TrainSnapshot): void { this.state = { ...snapshot }; }
  reset(): void { this.state = initial(this.state.revision + 1); }
  getModel(): TrainModel {
    const s = this.state;
    const sampled = s.route ? sampleTrainRoute(s.route, s.routeTime) : { point: [785, 838] as const, angle: 132, passed: [] };
    const logs: string[] = [];
    if (s.d) logs.push(s.phase === 'round1' ? '经过西操场，D 白→蓝。' : '第一轮：南门→林荫路→思源楼→西操→学活→南门；D 白→蓝。');
    if (s.b) logs.push(s.phase === 'round2a' && s.running ? '经过图书馆：B 白→蓝，C 解锁。' : '第二轮前段：图书馆→学四→机械楼；B 白→蓝，C 解锁。');
    if (s.phase === 'round2b' && !s.running) logs.push(s.c ? 'C 已切蓝，点击继续运行，完成八教区段。' : '停靠机械楼：请手动将 C 切蓝，再继续运行。');
    if (s.eightChecked) logs.push(s.phase === 'round2b' && s.running ? '经过八教：八教区段检测完成，继续测试回库。' : '第二轮后段：机械楼→八教→西操→学活，八教检测完成。');
    if (includes(['ready', 'formal', 'done'], s.phase)) logs.push('第二轮完成：测试回库，保留灯色和道岔状态。');
    if (includes(['formal', 'done'], s.phase)) logs.push('正式模式：学活后通往天佑主展区。');
    if (s.phase === 'done') logs.push('第三轮完成：十站线路测试完成！');
    const operatorStatus = s.running ? '列车运行中，请观察线路。' :
      s.phase === 'round2b' ? '列车停靠机械楼，请与搭档核对维护记录。' :
      s.phase === 'ready' ? '测试列车已回库，请与搭档核对检测结果。' :
      s.phase === 'done' ? '列车已抵达天佑主展区。' : '列车待发，请与搭档核对维护手册。';
    return { ...s, ...sampled, operatorStatus, passed: sampled.passed.map(id => TRAIN_STATION_NAMES[id]), logs,
      canFormal: s.phase === 'ready' && s.a && s.b && s.c && s.d && s.eightChecked,
      runLabel: s.running ? '列车运行中' : ({ round1: '运行第一轮', round2a: '运行到机械楼', round2b: '继续运行',
        ready: '等待正式模式', formal: '运行正式路线', done: '线路测试完成' })[s.phase] };
  }
  command(command: TrainCommand): { ok: boolean; text: string } {
    const s = this.state;
    const reject = (text: string) => ({ ok: false, text });
    if (s.running) return reject('列车运行中，请等本段结束后操作。');
    if (s.phase === 'done') return reject('线路测试已经完成。');
    if (command === 'toggleA') {
      if (s.phase === 'formal') return reject('正式模式已锁定道岔。');
      s.a = !s.a;
    } else if (command === 'toggleC') {
      if (!s.b) return reject('C 尚未解锁，请与搭档核对维护记录。');
      if (s.phase === 'formal') return reject('正式模式已锁定道岔。');
      s.c = !s.c;
    } else if (command === 'formal') {
      if (!this.getModel().canFormal) return reject('正式模式条件尚未满足，请与搭档核对检测记录。');
      s.phase = 'formal'; s.route = null; s.routeTime = 0;
    } else if (command === 'run') {
      if (s.phase === 'ready') return reject('请先启动正式模式。');
      if (s.phase === 'round1' && s.a) return reject('当前线路不符合外环测试要求，请与搭档核对维护手册。');
      if (s.phase === 'round2a' && !s.a) return reject('当前线路不符合内部测试要求，请与搭档核对维护手册。');
      if (s.phase === 'round2b' && !s.c) return reject('八教区段尚未检测，请与搭档核对机械楼出口线路。');
      if (s.phase === 'formal' && (!s.a || !s.c)) return reject('正式路线需要 A、C 都为蓝色。');
      s.route = s.phase; s.routeTime = 0; s.running = true;
    } else return reject('无法识别的操作。');
    s.revision++;
    return { ok: true, text: command === 'formal' ? '正式模式已启动，可以运行完整路线。' : '' };
  }
  /** 返回检测点/阶段是否改变，供同步层只在检查点广播，避免每帧网络请求。 */
  tick(dt: number): boolean {
    const s = this.state;
    if (!s.running || !s.route || !Number.isFinite(dt) || dt <= 0) return false;
    const before = sampleTrainRoute(s.route, s.routeTime).passed.length;
    s.routeTime = Math.min(trainRouteDuration(s.route), s.routeTime + dt);
    const passed: TrainStation[] = sampleTrainRoute(s.route, s.routeTime).passed;
    if (includes(passed, 'library')) s.b = true;
    if (includes(passed, 'westField')) s.d = true;
    if (includes(passed, 'teaching8')) s.eightChecked = true;
    let changed = passed.length !== before;
    if (s.routeTime >= trainRouteDuration(s.route)) {
      s.running = false;
      s.phase = ({ round1: 'round2a', round2a: 'round2b', round2b: 'ready', formal: 'done' } as const)[s.route];
      changed = true;
    }
    if (changed) s.revision++;
    return changed;
  }
}
