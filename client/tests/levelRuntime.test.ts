import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime, type LevelEvents } from '../assets/scripts/level/LevelRuntime';
import type { LevelConfig, PuzzleConfig } from '../assets/scripts/common/LevelTypes';

const here = dirname(fileURLToPath(import.meta.url));

function loadLevel(file: string) {
  return parseLevelConfig(JSON.parse(readFileSync(resolve(here, '../assets/resources/configs', file), 'utf8')));
}

/**
 * 从现成的关卡派生一个改了 puzzle 的配置。
 *
 * 默认把 requiredItems 清掉：下面这些用例关心的是「怎么判」和「答错怎么罚」，
 * 不想每次都被「道具没凑齐，交不了」拦在判定之前。
 */
function withPuzzle(base: LevelConfig, puzzle: Partial<PuzzleConfig>): LevelConfig {
  const merged: PuzzleConfig = { ...base.puzzle, requiredItems: undefined, ...puzzle };
  return { ...base, puzzle: merged };
}

const guideConfig = loadLevel('level.guide.json');
const level01Config = loadLevel('level.01.json');

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
    expect(Object.keys(review)).toEqual(['levelId', 'title', 'status', 'elapsedSec', 'items']);
    expect(review.items.map((i) => i.itemId)).toEqual(['road_north']);
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
    snapshot.inventory.push({ itemId: '伪造道具', fromNodeId: 'x' });
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
