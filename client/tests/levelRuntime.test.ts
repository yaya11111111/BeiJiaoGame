import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { nextLevelId, parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime, type LevelEvents } from '../assets/scripts/level/LevelRuntime';
import type { LevelConfig, PuzzleConfig } from '../assets/scripts/common/LevelTypes';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 引擎测试用 tests/fixtures/ 下的夹具，**不用** assets/resources/configs/ 下的真实关卡。
 *
 * 真实关卡会随 A/B 的设计一直改（文案、触点、答案、机制），拿它们当夹具的话
 * 每次设计变更都会崩一批引擎测试，久而久之就没人敢改设计了。
 * 夹具只覆盖机制，不跟着剧情走。真实关卡的「能不能被解析」另有 smoke 测试。
 */
function loadFixture(file: string) {
  return parseLevelConfig(JSON.parse(readFileSync(resolve(here, './fixtures', file), 'utf8')));
}

/**
 * 从现成的关卡派生一个改了 puzzle 的配置。
 *
 * 默认把 requiredItems 清掉：下面这些用例关心的是「怎么判」和「答错怎么罚」，
 * 不想每次都被「道具没凑齐，交不了」拦在判定之前。
 */
function withPuzzle(base: LevelConfig, puzzle: Partial<PuzzleConfig>): LevelConfig {
  // puzzle 现在是可选的（有的关卡靠 completes 热点通关），这里只对带 puzzle 的夹具用。
  // 展开一个可能为 undefined 的对象会让所有字段都变成可选，类型就对不上了
  if (!base.puzzle) throw new Error('withPuzzle 只能对带 puzzle 的夹具用');
  const merged: PuzzleConfig = { ...base.puzzle, requiredItems: undefined, ...puzzle };
  return { ...base, puzzle: merged };
}

/** 双视角揭示 + 拾取 + 提交，不限时 */
const guideConfig = loadFixture('level.reveal.json');
/** 有序答案 + requiredItems + 干扰项 + 容错次数 + 限时 */
const level01Config = loadFixture('level.route.json');
/** 一次拾取多件 + 道具可重复使用 + 两件合成一件 + 挑错被拒 */
const useConfig = loadFixture('level.use.json');
/** 一关多个输入门：密码门 + 道具门 + 操作通关（没有 puzzle） */
const gateConfig = loadFixture('level.gate.json');

/** 记录一个 runtime 广播出来的所有事件，用来断言「广播了什么」和「没广播什么」。 */
function recordEvents(runtime: LevelRuntime) {
  const events: { name: string; payload: unknown }[] = [];
  const names: (keyof LevelEvents)[] = [
    'view:changed',
    'inventory:changed',
    'hotspot:revealed',
    'line:shown',
    'hint:unlocked',
    'answer:wrong',
    'level:success',
    'level:failed',
    'state:changed',
  ];
  for (const name of names) {
    runtime.on(name, (payload) => events.push({ name, payload }));
  }
  return {
    events,
    of(name: keyof LevelEvents) {
      return events.filter((e) => e.name === name).map((e) => e.payload);
    },
  };
}

describe('引导关 —— 验收口径的那条主路径', () => {
  let runtime: LevelRuntime;

  beforeEach(() => {
    runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
  });

  it('走通：点异常物件 → 揭示另一视角 → 切视角 → 拿道具带过去 → 提交成功', () => {
    // 1. 一开始在 A 视角
    expect(runtime.getState().currentView).toBe('A');

    // 2. 点明显的异常物件（信箱），它在另一视角揭示公告栏
    const first = runtime.click('hs_a_mailbox');
    expect(first).toEqual({ ok: true, effect: 'inspected', text: expect.stringContaining('信箱') });

    // 3. 切到 B，公告栏出现了（初始是隐藏的）
    expect(runtime.switchView('B')).toBe(true);
    const viewB = runtime.getState();
    expect(viewB.assetKey).toBe('bg/GUIDE_B');
    expect(viewB.hotspots.map((h) => h.nodeId)).toContain('hs_b_board');

    // 4. 读卡槽可见但点不动 —— 手里还没有凭证
    const slotLocked = runtime.getState().hotspots.find((h) => h.nodeId === 'hs_b_slot')!;
    expect(slotLocked.enabled).toBe(false);
    expect(runtime.click('hs_b_slot')).toEqual({ ok: false, reason: 'missing-item' });

    // 5. 切回 A 拿凭证
    expect(runtime.switchView('A')).toBe(true);
    expect(runtime.click('hs_a_poster')).toEqual({ ok: true, effect: 'picked', itemId: 'guide_token' });

    // 6. 带过 B 去提交
    expect(runtime.switchView('B')).toBe(true);
    expect(runtime.click('hs_b_slot')).toEqual({ ok: true, effect: 'submitted', correct: true });

    const final = runtime.getState();
    expect(final.status).toBe('success');
  });

  it('背包跨视角保留 —— 切视角不会丢道具', () => {
    runtime.click('hs_a_poster');
    expect(runtime.getState().inventory.map((i) => i.itemId)).toEqual(['guide_token']);

    runtime.switchView('B');
    expect(runtime.getState().currentView).toBe('B');
    expect(runtime.getState().inventory.map((i) => i.itemId)).toEqual(['guide_token']);

    runtime.switchView('A');
    expect(runtime.getState().inventory.map((i) => i.itemId)).toEqual(['guide_token']);
  });

  it('点不到另一视角的热点 —— 客户端拿不到另一视角的物件', () => {
    // 当前在 A，B 的读卡槽点不动
    expect(runtime.click('hs_b_slot')).toEqual({ ok: false, reason: 'not-visible' });
  });

  it('同一个 pickup 热点点两次，第二次不重复入包', () => {
    expect(runtime.click('hs_a_poster').ok).toBe(true);
    expect(runtime.click('hs_a_poster')).toEqual({ ok: false, reason: 'already-done' });
    expect(runtime.getState().inventory).toHaveLength(1);
  });

  it('点不存在的节点返回 unknown-node，不抛异常', () => {
    expect(runtime.click('hs_不存在')).toEqual({ ok: false, reason: 'unknown-node' });
  });

  it('通关后广播 level:success，带回要解锁的地图节点', () => {
    const rec = recordEvents(runtime);
    runtime.click('hs_a_mailbox');
    runtime.switchView('B');
    runtime.switchView('A');
    runtime.click('hs_a_poster');
    runtime.switchView('B');
    runtime.click('hs_b_slot');

    const success = rec.of('level:success') as { progress: string[] }[];
    expect(success).toHaveLength(1);
    expect(success[0].progress).toEqual(['node_campus_gate']);
  });

  it('通关后再操作一律被拒', () => {
    runtime.click('hs_a_poster');
    runtime.switchView('B');
    runtime.click('hs_b_slot');
    expect(runtime.getStatus()).toBe('success');

    expect(runtime.click('hs_a_poster')).toEqual({ ok: false, reason: 'locked' });
    expect(runtime.switchView('A')).toBe(false);
  });
});

describe('第 1 关 —— 顺序敏感的路线重建', () => {
  it('按正确顺序点 → 提交成功', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_north');
    runtime.click('hs_a_road_west');
    runtime.switchView('B');
    expect(runtime.click('hs_b_submit')).toEqual({ ok: true, effect: 'submitted', correct: true });
    expect(runtime.getStatus()).toBe('success');
  });

  it('顺序点反 → 失败一次，背包顺序就是提交顺序', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_west');
    runtime.click('hs_a_road_north');
    expect(runtime.getInventory().map((i) => i.itemId)).toEqual(['road_west', 'road_north']);

    runtime.switchView('B');
    expect(runtime.click('hs_b_submit')).toEqual({ ok: true, effect: 'submitted', correct: false });
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().attemptsLeft).toBe(2);
  });

  it('多拿了干扰项（东路）→ 答案长度不符 → 判错', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_north');
    runtime.click('hs_a_road_east');
    runtime.click('hs_a_road_west');

    runtime.switchView('B');
    expect(runtime.click('hs_b_submit')).toEqual({ ok: true, effect: 'submitted', correct: false });
  });

  it('容错次数用完 → 判失败', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_west');
    runtime.click('hs_a_road_north');
    runtime.switchView('B');

    runtime.click('hs_b_submit'); // 第 1 次错
    runtime.click('hs_b_submit'); // 第 2 次错
    expect(runtime.getStatus()).toBe('playing');
    runtime.click('hs_b_submit'); // 第 3 次错 → 用完

    expect(runtime.getStatus()).toBe('failed');
  });

  it('失败时广播的载荷里不含正确答案', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    const rec = recordEvents(runtime);

    runtime.click('hs_a_road_west');
    runtime.click('hs_a_road_north');
    runtime.switchView('B');
    runtime.click('hs_b_submit');
    runtime.click('hs_b_submit');
    runtime.click('hs_b_submit');

    // 需求要求「服务端只向玩家发送当前视角需要的线索，避免另一视角的完整答案直接出现在客户端」
    for (const payload of [...rec.of('answer:wrong'), ...rec.of('level:failed')]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('"road_north"');
      expect(serialized).not.toContain('"road_west"');
      expect(serialized).not.toContain('"answer"');
    }
  });

  it('限时关卡：时间到 → 判失败，原因是 timeout', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    const rec = recordEvents(runtime);

    runtime.tick(299);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().timeLeftSec).toBe(1);

    runtime.tick(1);
    expect(runtime.getStatus()).toBe('failed');
    expect(rec.of('level:failed')).toEqual([{ reason: 'timeout', elapsedSec: 300 }]);
  });
});

describe('两种模式的视角控制', () => {
  it('单人模式可以自由切换视角', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    expect(runtime.getState().canSwitchView).toBe(true);
    expect(runtime.switchView('B')).toBe(true);
    expect(runtime.switchView('A')).toBe(true);
  });

  it('双人模式视角由服务端指派，客户端切不了', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'duo' });
    expect(runtime.getState().canSwitchView).toBe(false);
    expect(runtime.switchView('B')).toBe(false);
    expect(runtime.getState().currentView).toBe('A');
  });

  it('双人模式可以从服务端指派的视角进入', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'duo', initialView: 'B' });
    expect(runtime.getState().currentView).toBe('B');
    expect(runtime.getState().assetKey).toBe('bg/GUIDE_B');
  });

  it('切到当前视角返回 false，不重复广播', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    const rec = recordEvents(runtime);
    expect(runtime.switchView('A')).toBe(false);
    expect(rec.of('view:changed')).toHaveLength(0);
  });
});

describe('提示与重开', () => {
  it('提示按顺序逐段解锁，用完返回 null', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    expect(runtime.getState().hintsRemaining).toBe(3);

    expect(runtime.requestHint()).toBe(guideConfig.hints[0]);
    expect(runtime.requestHint()).toBe(guideConfig.hints[1]);
    expect(runtime.requestHint()).toBe(guideConfig.hints[2]);
    expect(runtime.requestHint()).toBeNull();
    expect(runtime.getState().hints).toHaveLength(3);
  });

  it('道具没凑齐时点提交不算一次尝试 —— 点不动，也不消耗容错次数', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_north'); // 只拿了一个，答案要两个
    runtime.switchView('B');

    expect(runtime.click('hs_b_submit')).toEqual({ ok: false, reason: 'missing-item' });
    expect(runtime.getState().attemptsLeft).toBe(3);
    expect(runtime.getStatus()).toBe('playing');
  });

  it('失败复盘后重开，状态回到原点', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_west');
    runtime.click('hs_a_road_north'); // 顺序反了，提交必错
    runtime.switchView('B');
    runtime.click('hs_b_submit');
    runtime.click('hs_b_submit');
    runtime.click('hs_b_submit');
    expect(runtime.getStatus()).toBe('failed');

    runtime.reset();
    const state = runtime.getState();
    expect(state.status).toBe('playing');
    expect(state.inventory).toEqual([]);
    expect(state.currentView).toBe('A');
    expect(state.attemptsLeft).toBe(3);
    expect(state.timeLeftSec).toBe(300);
  });

  it('结算回顾只给道具和用时，不给答案', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_north');
    const review = runtime.getReview();
    // 精确比对字段集合：将来谁往结算载荷里塞了会泄露答案的字段，这条会红
    expect(Object.keys(review)).toEqual([
      'levelId',
      'title',
      'status',
      'elapsedSec',
      'items',
      'nextLevelId',
      'unlockedNodeIds',
    ]);
    expect(review.items.map((i) => i.itemId)).toEqual(['road_north']);
    expect(JSON.stringify(review)).not.toContain('road_west');
  });

  it('结算载荷里有 E 结算页要的下一关和解锁节点', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    const review = runtime.getReview();
    // 夹具的 levelId 是 L01
    expect(review.nextLevelId).toBe('L02');
    expect(review.unlockedNodeIds).toEqual(['node_road', 'node_teaching']);
  });

  it('最后一关没有下一关 —— 那样按钮该换成「回到地图」', () => {
    const last = { ...level01Config, levelId: 'L10' };
    expect(new LevelRuntime(last, { mode: 'solo' }).getReview().nextLevelId).toBeNull();
  });
});

describe('关卡顺序', () => {
  it('从引导关一路排到第十关', () => {
    expect(nextLevelId('GUIDE')).toBe('L01');
    expect(nextLevelId('L09')).toBe('L10');
    expect(nextLevelId('L10')).toBeNull();
  });

  it('不在顺序表里的 levelId 返回 null，不抛异常', () => {
    expect(nextLevelId('L99')).toBeNull();
    expect(nextLevelId('')).toBeNull();
  });
});

describe('线索的复读 —— inspect 不是一次性的', () => {
  it('inspect 热点可以反复点，第二次拿到同样的文字', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.switchView('B');

    const first = runtime.click('hs_b_notice');
    const second = runtime.click('hs_b_notice');

    expect(second).toEqual(first);
    expect(second).toEqual({
      ok: true,
      effect: 'inspected',
      text: expect.stringContaining('先北，后西'),
    });
  });

  it('inspect 不会被标成 done，渲染层不会把它变灰导致点不动', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.switchView('B');
    runtime.click('hs_b_notice');

    const notice = runtime.getState().hotspots.find((h) => h.nodeId === 'hs_b_notice')!;
    expect(notice.enabled).toBe(true);
    expect(notice.done).toBe(false);
  });

  it('复读线索不会重复播揭示动画 —— hotspot:revealed 只广播一次', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    const rec = recordEvents(runtime);

    runtime.click('hs_a_mailbox');
    runtime.click('hs_a_mailbox');

    expect(rec.of('hotspot:revealed')).toHaveLength(1);
  });
});

describe('用时的累计与 state:changed 的节流', () => {
  it('不限时关卡也累计用时 —— 结算页的用时回顾和后台统计都取自这里', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    runtime.tick(12.5);

    expect(runtime.getReview().elapsedSec).toBe(12.5);
    expect(runtime.getState().timeLeftSec).toBeNull(); // 仍然没有倒计时
    expect(runtime.getStatus()).toBe('playing');
  });

  it('不限时关卡没有秒数变化，tick 不广播 state:changed', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    const rec = recordEvents(runtime);

    runtime.tick(1);
    runtime.tick(1);

    expect(rec.of('state:changed')).toHaveLength(0);
  });

  it('限时关卡只在显示的秒数变化时广播，而不是每帧一次', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    const rec = recordEvents(runtime);

    runtime.tick(0.25); // 剩余仍是 300 秒 → 不广播
    expect(rec.of('state:changed')).toHaveLength(0);

    // 再走 3 帧共 1 秒，剩余变 299 秒 → 这 4 帧里只广播 1 次
    runtime.tick(0.25);
    runtime.tick(0.25);
    runtime.tick(0.25);
    expect(rec.of('state:changed')).toHaveLength(1);
  });

  it('用时在结算前就累计到位，通关时带回的 elapsedSec 是真实用时', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.tick(4);
    runtime.click('hs_a_road_north');
    runtime.click('hs_a_road_west');
    runtime.switchView('B');

    const rec = recordEvents(runtime);
    runtime.click('hs_b_submit');

    expect(rec.of('level:success')).toEqual([{ progress: ['node_road', 'node_teaching'], elapsedSec: 4 }]);
  });
});

describe('状态快照的隔离性', () => {
  it('外部改快照不影响运行时内部状态', () => {
    const runtime = new LevelRuntime(guideConfig, { mode: 'solo' });
    runtime.click('hs_a_poster');

    const snapshot = runtime.getState();
    snapshot.inventory.push({ itemId: '伪造道具', name: '伪造道具', fromNodeId: 'x' });
    snapshot.hotspots.length = 0;

    expect(runtime.getState().inventory).toHaveLength(1);
    expect(runtime.getState().hotspots.length).toBeGreaterThan(0);
  });
});

describe('两种答案形状 —— 有序 vs 按键', () => {
  /** 引导关的真实形态：填三个空。表单天然无序 */
  const formConfig = withPuzzle(level01Config, {
    answer: { 岗位: '接线员', 编号: '07', 地点: '南门内侧' },
  });

  it('按键答案：全部填对 → 通关', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    expect(runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门内侧' })).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('按键答案：填错一个 → 判错，关卡继续', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    expect(runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门外侧' })).toBe(false);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().attemptsLeft).toBe(2);
  });

  it('按键答案：顺序无关 —— 先填哪个空不该影响对错', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    expect(runtime.submit({ 地点: '南门内侧', 编号: '07', 岗位: '接线员' })).toBe(true);
  });

  it('按键答案：少填一个空 → 判错', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    expect(runtime.submit({ 岗位: '接线员', 编号: '07' })).toBe(false);
  });

  it('按键答案：多填一个空 → 判错（多余字段不能蒙混过关）', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    expect(runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门内侧', 备注: '随便写' })).toBe(false);
  });

  it('有序答案：数字密码顺序敏感 —— 241 和 142 不是一回事', () => {
    const codeConfig = withPuzzle(level01Config, { answer: ['2', '4', '1'] });
    expect(new LevelRuntime(codeConfig, { mode: 'solo' }).submit(['2', '4', '1'])).toBe(true);
    expect(new LevelRuntime(codeConfig, { mode: 'solo' }).submit(['1', '4', '2'])).toBe(false);
  });

  it('有序答案：不传答案时仍然用背包顺序（老行为不变）', () => {
    const runtime = new LevelRuntime(withPuzzle(level01Config, { answer: ['road_north', 'road_west'] }), {
      mode: 'solo',
    });
    runtime.click('hs_a_road_north');
    runtime.click('hs_a_road_west');
    expect(runtime.submit()).toBe(true);
  });

  it('形状对不上（配置是按键、却提交了数组）→ 被忽略，不扣次数也不惩罚', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    expect(runtime.submit(['接线员', '07', '南门内侧'])).toBe(false);
    // 关键：不算一次尝试。这是调用方写错了代码，不该让玩家买单
    expect(runtime.getState().attemptsLeft).toBe(3);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
  });

  it('形状对不上（配置是有序、却提交了对象）→ 同样被忽略', () => {
    const runtime = new LevelRuntime(withPuzzle(level01Config, { answer: ['a'] }), { mode: 'solo' });
    expect(runtime.submit({ a: 'b' })).toBe(false);
    expect(runtime.getState().attemptsLeft).toBe(3);
  });

  it('按键答案不显式传就交不了 —— 点提交热点不是那种关的提交方式', () => {
    const runtime = new LevelRuntime(formConfig, { mode: 'solo' });
    runtime.switchView('B');
    expect(runtime.click('hs_b_submit')).toEqual({ ok: false, reason: 'missing-item' });
  });
});

describe('答错惩罚 —— 锁一段时间不能重交', () => {
  const cdConfig = () => withPuzzle(level01Config, { answer: ['a'], wrongCooldownSec: 10 });

  it('答错后进入惩罚期，cooldownLeftSec 就是配置的秒数', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    runtime.submit(['b']);
    expect(runtime.getState().cooldownLeftSec).toBe(10);
  });

  it('惩罚期内就算提交正确答案也交不进去 —— 这正是「惩罚」的意思', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    runtime.submit(['b']);
    expect(runtime.submit(['a'])).toBe(false);
    expect(runtime.getStatus()).toBe('playing');
  });

  it('惩罚期内点提交热点 → reason 是 cooldown，不是 missing-item', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    runtime.submit(['b']);
    runtime.switchView('B');
    expect(runtime.click('hs_b_submit')).toEqual({ ok: false, reason: 'cooldown' });
  });

  it('惩罚期内的重复点击不消耗容错次数', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    runtime.submit(['b']); // 错 1 次
    runtime.submit(['b']); // 被挡
    runtime.submit(['b']); // 被挡
    expect(runtime.getState().attemptsLeft).toBe(2);
  });

  it('tick 走过惩罚时间后就能重交', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    runtime.submit(['b']);
    runtime.tick(10);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(runtime.submit(['a'])).toBe(true);
  });

  it('惩罚只在「显示的秒数」变化时广播，不是每帧', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    const rec = recordEvents(runtime);
    runtime.submit(['b']);
    rec.events.length = 0;

    runtime.tick(0.4); // 还是 10 秒，不该广播
    expect(rec.of('state:changed')).toHaveLength(0);

    runtime.tick(0.7); // 跨过 1 秒 → 广播
    expect(rec.of('state:changed').length).toBeGreaterThan(0);
  });

  it('不限时关卡也要处理惩罚 —— tick 不能因为「不限时」就早退', () => {
    const untimed: LevelConfig = { ...cdConfig(), timeLimitSec: undefined };
    const runtime = new LevelRuntime(untimed, { mode: 'solo' });
    const rec = recordEvents(runtime);
    runtime.submit(['b']);
    rec.events.length = 0;

    runtime.tick(0.4);
    expect(rec.of('state:changed')).toHaveLength(0);
    runtime.tick(0.7);
    expect(rec.of('state:changed').length).toBeGreaterThan(0);
    expect(runtime.getState().cooldownLeftSec).toBeLessThan(10);
  });

  it('answer:wrong 的载荷带出惩罚秒数，供界面显示倒计时', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    const rec = recordEvents(runtime);
    runtime.submit(['b']);
    expect(rec.of('answer:wrong')[0]).toEqual({ attemptsLeft: 2, cooldownSec: 10 });
  });

  it('没配惩罚的关卡：答错后立刻能重试，cooldownLeftSec 一直是 0', () => {
    const runtime = new LevelRuntime(withPuzzle(level01Config, { answer: ['a'] }), { mode: 'solo' });
    const rec = recordEvents(runtime);
    runtime.submit(['b']);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(rec.of('answer:wrong')[0]).toEqual({ attemptsLeft: 2, cooldownSec: 0 });
    expect(runtime.submit(['a'])).toBe(true);
  });

  it('重开清掉惩罚', () => {
    const runtime = new LevelRuntime(cdConfig(), { mode: 'solo' });
    runtime.submit(['b']);
    expect(runtime.getState().cooldownLeftSec).toBe(10);

    runtime.reset();
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(runtime.submit(['a'])).toBe(true);
  });

  it('惩罚和容错次数可以同时生效：用完次数照样判失败', () => {
    // 配 1 秒惩罚 + 3 次容错，逐次错完
    const runtime = new LevelRuntime(withPuzzle(level01Config, { answer: ['a'], wrongCooldownSec: 1 }), {
      mode: 'solo',
    });
    runtime.submit(['b']);
    expect(runtime.getStatus()).toBe('playing');
    runtime.tick(1); // 等过惩罚
    runtime.submit(['b']);
    runtime.tick(1);
    runtime.submit(['b']); // 第 3 次错 → 用完
    expect(runtime.getStatus()).toBe('failed');
  });
});

describe('界面该画什么输入控件（input）', () => {
  it('没配输入方式的关卡 → kind 是 none，不需要画控件', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    expect(runtime.getState().input).toEqual({ kind: 'none', digitCount: 0, fields: [] });
  });

  it('数字键盘关 → 位数取自答案长度，且不带任何候选值', () => {
    const runtime = new LevelRuntime(
      withPuzzle(level01Config, { input: 'numberpad', answer: ['2', '4', '1'] }),
      { mode: 'solo' },
    );
    // 整个对象精确比对：将来谁往 InputSpec 里塞了会泄露答案的字段，这条会红
    expect(runtime.getState().input).toEqual({ kind: 'numberpad', digitCount: 3, fields: [] });
  });

  it('表单关 → 每个空的名字和候选项都给出来，候选项里混着干扰项', () => {
    const runtime = new LevelRuntime(
      withPuzzle(level01Config, {
        input: 'form',
        answer: { 岗位: '接线员', 编号: '07' },
        fieldOptions: {
          岗位: ['接线员', '志愿者', '社团负责人'],
          编号: ['07', '03', '12'],
        },
      }),
      { mode: 'solo' },
    );
    expect(runtime.getState().input).toEqual({
      kind: 'form',
      digitCount: 0,
      fields: [
        { label: '岗位', options: ['接线员', '志愿者', '社团负责人'] },
        { label: '编号', options: ['07', '03', '12'] },
      ],
    });
  });

  it('输入规格在状态快照里，跟着 state:changed 一起发出去', () => {
    const runtime = new LevelRuntime(
      withPuzzle(level01Config, { input: 'numberpad', answer: ['2', '4', '1'] }),
      { mode: 'solo' },
    );
    const rec = recordEvents(runtime);
    runtime.tick(1);
    const last = rec.of('state:changed').pop() as { input: { kind: string } };
    expect(last.input.kind).toBe('numberpad');
  });
});

describe('在装置上使用道具（action: use）', () => {
  /** 开工具盒拿到三件：蓝章、红章（干扰）、磁吸杆 */
  function opened() {
    const runtime = new LevelRuntime(useConfig, { mode: 'solo' });
    runtime.click('hs_a_toolbox');
    return runtime;
  }

  it('一次拾取多件 —— 工具盒同时给印章和磁吸杆', () => {
    const runtime = new LevelRuntime(useConfig, { mode: 'solo' });
    expect(runtime.click('hs_a_toolbox')).toEqual({ ok: true, effect: 'picked', itemId: 'stamp_blue' });
    expect(runtime.getInventory().map((i) => i.itemId)).toEqual(['stamp_blue', 'stamp_red', 'suction_rod']);
  });

  it('点 use 热点只是「准备用」，不直接判定', () => {
    const runtime = opened();
    // useInput 说该弹哪个面板：'item' 弹背包列表，'code' 弹数字键盘
    expect(runtime.click('hs_a_magnet')).toEqual({
      ok: true,
      effect: 'use-ready',
      nodeId: 'hs_a_magnet',
      useInput: 'item',
      digitCount: 0,
      choices: [],
      prompt: '',
    });
    // 什么都没发生：没消耗、没标 done
    expect(runtime.getInventory()).toHaveLength(3);
    expect(runtime.getState().hotspots.find((h) => h.nodeId === 'hs_a_magnet')?.done).toBe(false);
  });

  it('用对了道具 → 成功，装置标成已用', () => {
    const runtime = opened();
    expect(runtime.useItem('hs_a_magnet', 'suction_rod')).toEqual({ ok: true, produced: [] });
    const hotspot = runtime.getState().hotspots.find((h) => h.nodeId === 'hs_a_magnet');
    expect(hotspot?.done).toBe(true);
    expect(hotspot?.enabled).toBe(false);
  });

  it('可重复使用的道具不会被消耗 —— 磁吸杆用过一次还在背包里', () => {
    const runtime = opened();
    runtime.useItem('hs_a_magnet', 'suction_rod');
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('suction_rod');

    // 还能拿去用第二个地方
    expect(runtime.useItem('hs_a_slot', 'suction_rod')).toEqual({ ok: true, produced: ['blank_ticket'] });
  });

  it('挑错道具 → 被拒，但不算答错：不扣次数、不触发惩罚', () => {
    const runtime = opened();
    const before = runtime.getState().attemptsLeft;

    expect(runtime.useItem('hs_a_magnet', 'stamp_red')).toEqual({ ok: false, reason: 'rejected' });
    // 关键：翻物件是探索，罚重了玩家就不敢点了
    expect(runtime.getState().attemptsLeft).toBe(before);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    // 东西也没少
    expect(runtime.getInventory()).toHaveLength(3);
  });

  it('红圆章是辨析项：用它盖章会被拒，蓝方章才行', () => {
    const runtime = opened();
    runtime.useItem('hs_a_slot', 'suction_rod'); // 先拿到空白券
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_red')).toEqual({ ok: false, reason: 'rejected' });
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue')).toEqual({
      ok: true,
      produced: ['stamped_ticket'],
    });
  });

  it('两件合成一件：消耗掉投入的两件，产出新的那一件', () => {
    const runtime = opened();
    runtime.useItem('hs_a_slot', 'suction_rod'); // 得到 blank_ticket
    runtime.useItem('hs_a_stamp_device', 'stamp_blue');

    const items = runtime.getInventory().map((i) => i.itemId);
    expect(items).toContain('stamped_ticket');
    // blank_ticket 和 stamp_blue 都被吃掉了
    expect(items).not.toContain('blank_ticket');
    expect(items).not.toContain('stamp_blue');
    // 磁吸杆和红章还在
    expect(items).toContain('suction_rod');
    expect(items).toContain('stamp_red');
  });

  it('要消耗的道具不齐 → 用不了，且什么都不消耗', () => {
    const runtime = opened();
    // 还没拿空白券就想盖章
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue')).toEqual({
      ok: false,
      reason: 'missing-item',
    });
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('stamp_blue');
  });

  it('背包里没有那件道具 → missing-item', () => {
    const runtime = opened();
    expect(runtime.useItem('hs_a_magnet', 'not_in_bag')).toEqual({ ok: false, reason: 'missing-item' });
  });

  it('同一台装置只能用一次', () => {
    const runtime = opened();
    runtime.useItem('hs_a_magnet', 'suction_rod');
    expect(runtime.useItem('hs_a_magnet', 'suction_rod')).toEqual({ ok: false, reason: 'already-done' });
    // 再点热点也是 already-done，渲染层据此变灰
    expect(runtime.click('hs_a_magnet')).toEqual({ ok: false, reason: 'already-done' });
  });

  it('不在当前视角的装置用不了 —— 客户端拿不到对面视角的物件', () => {
    const runtime = opened();
    expect(runtime.useItem('hs_b_handbook', 'suction_rod')).toEqual({ ok: false, reason: 'not-usable' });
  });

  it('不是 use 的热点用不了', () => {
    const runtime = new LevelRuntime(useConfig, { mode: 'solo' });
    runtime.switchView('B');
    expect(runtime.useItem('hs_b_handbook', 'suction_rod')).toEqual({ ok: false, reason: 'not-usable' });
  });

  it('结算后不能再操作', () => {
    const runtime = opened();
    runtime.submit({ 凭证: '已盖章的领取券' });
    expect(runtime.getStatus()).toBe('success');
    expect(runtime.useItem('hs_a_magnet', 'suction_rod')).toEqual({ ok: false, reason: 'locked' });
  });

  it('使用成功后广播 inventory:changed，界面据此刷新背包', () => {
    const runtime = opened();
    const rec = recordEvents(runtime);
    runtime.useItem('hs_a_slot', 'suction_rod');
    const last = rec.of('inventory:changed').pop() as { inventory: { itemId: string }[] };
    expect(last.inventory.map((i) => i.itemId)).toContain('blank_ticket');
  });

  it('成功和失败都会把该说的话写进 lastLine', () => {
    const runtime = opened();
    runtime.useItem('hs_a_magnet', 'stamp_red');
    expect(runtime.getState().lastLine).toBe('这东西吸不住磁扣。');

    runtime.useItem('hs_a_magnet', 'suction_rod');
    expect(runtime.getState().lastLine).toBe('磁吸杆吸住磁扣，海报翻开露出 06 号柜。');
  });
});

describe('一关里的多个输入门：密码门 / 道具门 / 操作通关', () => {
  /** 走完整条链：开盒 → 取券 → 盖章 → 开柜 */
  function runFullChain(runtime: LevelRuntime) {
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    runtime.useItem('hs_a_slot', 'suction_rod');
    runtime.useItem('hs_a_stamp_device', 'stamp_blue');
    return runtime.useItem('hs_a_cabinet', 'stamped_ticket');
  }

  it('密码门：点它报的是「该输密码」，不是「该挑道具」', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    expect(runtime.click('hs_a_toolbox')).toEqual({
      ok: true,
      effect: 'use-ready',
      nodeId: 'hs_a_toolbox',
      useInput: 'code',
      digitCount: 3,
      choices: [],
      prompt: '工具盒要密码（3 位）',
    });
  });

  it('密码门：输对了开盒，一次给三件道具', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1'])).toEqual({
      ok: true,
      produced: ['stamp_blue', 'stamp_red', 'suction_rod'],
    });
    expect(runtime.getInventory().map((i) => i.itemId)).toEqual([
      'stamp_blue',
      'stamp_red',
      'suction_rod',
    ]);
  });

  it('密码门：输错了是软拒绝，不扣次数也不锁 —— 设计稿明写「不封锁密码盒」', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    const before = runtime.getState().attemptsLeft;

    expect(runtime.useCode('hs_a_toolbox', ['9', '9', '9'])).toEqual({ ok: false, reason: 'rejected' });
    expect(runtime.getState().attemptsLeft).toBe(before);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(runtime.getState().lastLine).toBe('密码不对，盒子纹丝不动。');

    // 立刻就能重试
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1']).ok).toBe(true);
  });

  it('密码门：位数不对也算错，不会越界崩掉', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    expect(runtime.useCode('hs_a_toolbox', ['2', '4'])).toEqual({ ok: false, reason: 'rejected' });
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1', '1'])).toEqual({ ok: false, reason: 'rejected' });
  });

  it('输入方式用错：对密码门用道具、对道具门输密码 → 都是 not-usable', () => {
    // 用没用过的装置测：用过的装置会先报 already-done，
    // 而那个错更具体、对玩家更有用，所以判断顺序是对的
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    expect(runtime.useItem('hs_a_toolbox', 'stamp_blue')).toEqual({ ok: false, reason: 'not-usable' });
    expect(runtime.useCode('hs_a_slot', ['1', '2', '3'])).toEqual({ ok: false, reason: 'not-usable' });
  });

  it('用过的装置先报 already-done，而不是报输入方式不对', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    expect(runtime.useItem('hs_a_toolbox', 'stamp_blue')).toEqual({ ok: false, reason: 'already-done' });
  });

  it('走完整条链就通关 —— 最后那一下是操作，不是答题', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    const rec = recordEvents(runtime);

    expect(runFullChain(runtime)).toEqual({ ok: true, produced: [] });
    expect(runtime.getStatus()).toBe('success');

    const success = rec.of('level:success') as { progress: string[] }[];
    expect(success).toHaveLength(1);
    expect(success[0].progress).toEqual(['node_welcome_square']);
  });

  it('操作通关走的也是同一条广播 —— E 的地图只认一种载荷', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    const rec = recordEvents(runtime);
    runFullChain(runtime);
    const payload = rec.of('level:success')[0] as { progress: string[]; elapsedSec: number };
    expect(payload.progress).toEqual(['node_welcome_square']);
    expect(typeof payload.elapsedSec).toBe('number');
  });

  it('没有 puzzle 的关卡，答题那条路走不通', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    expect(gateConfig.puzzle).toBeUndefined();
    expect(runtime.submit(['随便'])).toBe(false);
    // 也不必给界面配输入控件
    expect(runtime.getState().input).toEqual({ kind: 'none', digitCount: 0, fields: [] });
  });

  it('中途的顺序不能跳：没开盒就去盖章 → 交不了', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    // 手里什么都没有
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue')).toEqual({ ok: false, reason: 'missing-item' });
  });

  it('开柜前必须先拿到已盖章的券', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    runtime.useItem('hs_a_slot', 'suction_rod');
    // 还没盖章
    expect(runtime.useItem('hs_a_cabinet', 'stamped_ticket')).toEqual({ ok: false, reason: 'missing-item' });
  });

  it('通关后整条链都锁住', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    runFullChain(runtime);
    expect(runtime.getStatus()).toBe('success');
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1'])).toEqual({ ok: false, reason: 'locked' });
    expect(runtime.useItem('hs_a_slot', 'suction_rod')).toEqual({ ok: false, reason: 'locked' });
  });

  it('重开后链条回到起点，装置都能再用', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    runFullChain(runtime);
    runtime.reset();

    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getInventory()).toHaveLength(0);
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1']).ok).toBe(true);
  });
});

describe('固定选项门（use 热点的 choices）—— 三条岔路、三张通知', () => {
  /** 造一个只有选项门的关卡，隔离测试 */
  function forkRuntime() {
    return new LevelRuntime(gateConfig, { mode: 'solo' });
  }

  it('点它报的是「该选一个」，并且把选项带出来 —— 但不带哪个对', () => {
    const runtime = forkRuntime();
    const result = runtime.click('hs_a_fork');
    expect(result).toEqual({
      ok: true,
      effect: 'use-ready',
      nodeId: 'hs_a_fork',
      useInput: 'choice',
      digitCount: 0,
      choices: ['路灯', '花坛', '长凳'],
      prompt: '这个岔口走哪条路？',
    });
    // 关键：结果里不能有 correctChoice —— 那等于把答案摆在界面上
    expect(JSON.stringify(result)).not.toContain('correctChoice');
  });

  it('选对了 → 成功，并且产出配置里写的东西', () => {
    const runtime = forkRuntime();
    expect(runtime.useChoice('hs_a_fork', '路灯')).toEqual({ ok: true, produced: ['path_token'] });
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('path_token');
    expect(runtime.getState().hotspots.find((h) => h.nodeId === 'hs_a_fork')?.done).toBe(true);
  });

  it('选错了 → 软拒绝。岔路是探索动作，罚重了玩家只会在路口发呆', () => {
    const runtime = forkRuntime();
    const before = runtime.getState().attemptsLeft;

    expect(runtime.useChoice('hs_a_fork', '花坛')).toEqual({ ok: false, reason: 'rejected' });
    expect(runtime.getState().attemptsLeft).toBe(before);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(runtime.getState().lastLine).toBe('这条是死胡同，折回来。');

    // 立刻能重选
    expect(runtime.useChoice('hs_a_fork', '路灯').ok).toBe(true);
  });

  it('传了一个不在列表里的值 → not-usable，那是调用方传错了，不是玩家选错', () => {
    const runtime = forkRuntime();
    expect(runtime.useChoice('hs_a_fork', '不存在的选项')).toEqual({ ok: false, reason: 'not-usable' });
    // 装置没被标记用过，还能继续用
    expect(runtime.getState().hotspots.find((h) => h.nodeId === 'hs_a_fork')?.done).toBe(false);
  });

  it('输入方式用错：对选项门挑道具或输密码 → not-usable', () => {
    const runtime = forkRuntime();
    expect(runtime.useItem('hs_a_fork', 'stamp_blue')).toEqual({ ok: false, reason: 'not-usable' });
    expect(runtime.useCode('hs_a_fork', ['1'])).toEqual({ ok: false, reason: 'not-usable' });
  });

  it('选项门也只能用一次', () => {
    const runtime = forkRuntime();
    runtime.useChoice('hs_a_fork', '路灯');
    expect(runtime.useChoice('hs_a_fork', '路灯')).toEqual({ ok: false, reason: 'already-done' });
  });
});

describe('输入面板的提示语（prompt）', () => {
  it('透传给界面 —— 场景里装置长得像的时候，这是唯一的区分', () => {
    const runtime = new LevelRuntime(gateConfig, { mode: 'solo' });
    const toolbox = runtime.click('hs_a_toolbox');
    expect(toolbox.ok && toolbox.effect === 'use-ready' && toolbox.prompt).toBe('工具盒要密码（3 位）');

    const fork = runtime.click('hs_a_fork');
    expect(fork.ok && fork.effect === 'use-ready' && fork.prompt).toBe('这个岔口走哪条路？');
  });

  it('不填 prompt 时是空串，界面回落到自己的默认文案', () => {
    const runtime = new LevelRuntime(useConfig, { mode: 'solo' });
    const magnet = runtime.click('hs_a_magnet');
    expect(magnet.ok && magnet.effect === 'use-ready' && magnet.prompt).toBe('');
  });
});

describe('面板类关卡的提交热点 —— 是「打开面板」的开关，不是提交', () => {
  it('点它回 input-ready，而不是拿背包顺序去判定', () => {
    // 这个夹具的 input 是 form，提交热点是 hs_a_submit
    const runtime = new LevelRuntime(useConfig, { mode: 'solo' });
    expect(runtime.click('hs_a_submit')).toEqual({
      ok: true,
      effect: 'input-ready',
      nodeId: 'hs_a_submit',
    });
    // 关键：什么都没有发生 —— 没扣次数、没判错
    expect(runtime.getState().attemptsLeft).toBe(3);
    expect(runtime.getStatus()).toBe('playing');
  });

  it('input 为 none 的关卡，点提交热点仍然是直接提交', () => {
    const runtime = new LevelRuntime(level01Config, { mode: 'solo' });
    runtime.click('hs_a_road_north');
    runtime.click('hs_a_road_west');
    runtime.switchView('B');
    expect(runtime.click('hs_b_submit')).toEqual({ ok: true, effect: 'submitted', correct: true });
  });
});
