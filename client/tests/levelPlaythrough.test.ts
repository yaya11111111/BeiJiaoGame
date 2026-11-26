import { playL09 } from './playL09';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LEVEL_ORDER, parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime } from '../assets/scripts/level/LevelRuntime';
import { completeLevelFromReview, createInitialAppState, MAP_NODES } from '../assets/scripts/ui/AppState';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';
import { loadPlayerLibrary, savePlayerLibrary } from '../assets/scripts/ui/PlayerLibrary';

/**
 * 每一关都要能真的通关 —— 这是自动化的「可解性检查」。
 *
 * 为什么单独一个文件、而且**故意和关卡设计耦合**：
 * 引擎测试（levelRuntime.test.ts）用夹具、不碰真实关卡，是为了让设计变更不拖崩它们。
 * 但**「这关到底能不能通」只有拿真实关卡走一遍才知道** —— 漏一个道具、
 * 一个热点忘了标 revealsNode、顺序串错了，配置校验全都能过，
 * 玩家却会卡死在中间。这类错是我最怕的，因为它只在有人玩到那儿才暴露。
 *
 * 所以：**改动关卡设计时，这个文件里的对应路径要一起改**。
 * 它红了不代表引擎坏了，代表「按配置走，这一关通不了」。
 */

const here = dirname(fileURLToPath(import.meta.url));

function loadShipped(file: string) {
  return parseLevelConfig(
    JSON.parse(readFileSync(resolve(here, '../assets/resources/configs', file), 'utf8')),
  );
}

it.each(['06', '07', '08', '09', '10'])('L%s 热点位于画面范围内且有中文标签', (id) => {
  const config = loadShipped(`level.${id}.json`);
  // 06 已换成 A/B 的真图（1672×941，打开墙那张是 1671×940，这里按大的算）；
  // 其余几关还是占位基准尺寸。
  const shippedSize: Record<string, [number, number]> = { '06': [1672, 941], '08': [1672,941], '09': [1672,941] };
  const [imageW, imageH] = shippedSize[id]
    ?? (config.mechanic === 'campusTrain' ? [1536, 864] : [1280, 720]);
  for (const view of Object.values(config.views)) {
    for (const spot of view.hotspots) {
      const [x, y, width, height] = spot.rect;
      const bounds = id === '10' ? spot.scene === 'f2_archive' ? [1671, 941] : spot.scene === 'cards' ? [1536, 1536] : spot.scene === 'desk' || spot.scene === 'desk_open' ? [1254, 1254] : [1536, 864] : [imageW, imageH];
      expect(spot.placeholderLabel, spot.nodeId).toMatch(/[\u4e00-\u9fff]/);
      expect(x, spot.nodeId).toBeGreaterThanOrEqual(0);
      expect(y, spot.nodeId).toBeGreaterThanOrEqual(0);
      expect(x + width, spot.nodeId).toBeLessThanOrEqual(bounds[0]);
      expect(y + height, spot.nodeId).toBeLessThanOrEqual(bounds[1]);
    }
  }
});

describe('正式关卡限时', () => {
  it.each([
    ['01', 480], ['02', 600], ['03', 720], ['04', 900], ['05', 900],
    // L06 开发卡写 18—22 分钟，1500 秒留出首次游玩的余量
    ['06', 1500], ['07', 600], ['08', 1200], ['09', 2100], ['10', 3600],
  ] as const)('第 %s 关限时 %i 秒，到点失败且重开恢复完整时间', (level, limit) => {
    const runtime = new LevelRuntime(loadShipped(`level.${level}.json`), { mode: 'solo' });
    expect(runtime.getState().timeLeftSec).toBe(limit);
    runtime.tick(limit - 1);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().timeLeftSec).toBe(1);
    runtime.tick(1);
    expect(runtime.getState().timeLeftSec).toBe(0);
    expect(runtime.getReview()).toMatchObject({
      status: 'failed', failureReason: 'timeout', elapsedSec: limit,
      nextLevelId: null, unlockedNodeIds: [],
    });
    runtime.reset();
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().timeLeftSec).toBe(limit);
  });

  it('引导关保持不限时', () => {
    const runtime = new LevelRuntime(loadShipped('level.guide.json'), { mode: 'solo' });
    runtime.tick(3600);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().timeLeftSec).toBeNull();
  });
});

describe('引导关能通关', () => {
  it('A 看编号、B 看岗位和起点，填表提交', () => {
    const runtime = new LevelRuntime(loadShipped('level.guide.json'), { mode: 'solo' });

    // 两边各看一半
    runtime.click('hs_a_notice');
    runtime.switchView('B');
    runtime.click('hs_b_terminal');

    // 合起来填三个空。地点 2026-10-05 跟更新的初稿文档 / E 的地图 / B 的终端特写图，
    // 从「南门广场」改回「南门内侧迎新广场」
    expect(runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门内侧迎新广场' })).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('登记表答错 3 次就判失败 —— 容错次数用完（maxAttempts: 3）', () => {
    const runtime = new LevelRuntime(loadShipped('level.guide.json'), { mode: 'solo' });
    const wrong = { 岗位: '志愿者', 编号: '03', 地点: '明湖餐厅' };
    expect(runtime.getState().attemptsLeft).toBe(3);

    expect(runtime.submit(wrong)).toBe(false);
    expect(runtime.getState().attemptsLeft).toBe(2);
    expect(runtime.getStatus()).toBe('playing');

    expect(runtime.submit(wrong)).toBe(false);
    expect(runtime.getState().attemptsLeft).toBe(1);
    expect(runtime.getStatus()).toBe('playing');

    // 第 3 次还错：次数用完，直接判失败（不是「还能继续错」）
    expect(runtime.submit(wrong)).toBe(false);
    expect(runtime.getStatus()).toBe('failed');

    // 「再来一次」要把次数也复位，不然复活的关卡一进去就剩 0 次
    runtime.reset();
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().attemptsLeft).toBe(3);
  });
});

describe('第 1 关能通关', () => {
  it('点击海报解锁 → 开工具盒 → 取券 → 盖章 → 开柜', () => {
    const runtime = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo' });

    // 海报不需要磁吸杆，也不占背包；可以反复阅读。
    expect(runtime.click('hs_a_poster')).toMatchObject({ ok: true, effect: 'inspected' });
    expect(runtime.click('hs_a_poster')).toMatchObject({ ok: true, effect: 'inspected' });
    expect(runtime.getInventory()).toHaveLength(0);

    // 密码门：流程图给数字、B 的手册给顺序
    runtime.click('hs_a_flowchart');
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1']).ok).toBe(true);

    // 红圆章是干扰项，捡了也不影响通关
    runtime.click('hs_a_red_stamp');

    // 磁吸杆只用于从投递口取券。
    expect(runtime.useItem('hs_a_slot', 'suction_rod').ok).toBe(true);
    expect(runtime.getInventory().some(item=>item.itemId==='suction_rod')).toBe(false);

    // 合成：空白券 + 蓝方章 → 已盖章的券
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue').ok).toBe(true);

    // 最后一步是操作，不是答题
    expect(runtime.useItem('hs_a_cabinet', 'stamped_ticket').ok).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('BUG-016：读档后通关，已消耗的道具仍写入结算和图鉴', () => {
    const config = loadShipped('level.01.json');
    const runtime = new LevelRuntime(config, { mode: 'solo' });
    runtime.click('hs_a_poster');
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    runtime.useItem('hs_a_slot', 'suction_rod');
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue').ok).toBe(true);

    const resumed = new LevelRuntime(config, { mode: 'solo', restore: runtime.getReview().progress });
    expect(resumed.useItem('hs_a_cabinet', 'stamped_ticket').ok).toBe(true);
    const review = resumed.getReview();
    const consumedIds = ['blank_ticket', 'stamp_blue', 'stamped_ticket'];
    expect(review.items.some((item) => consumedIds.indexOf(item.itemId) >= 0)).toBe(false);

    const state = completeLevelFromReview(createInitialAppState(), review, 100);
    const store = memoryKeyValueStore();
    savePlayerLibrary(store, state.library);
    const clues = loadPlayerLibrary(store).clues;
    const usedClues = clues.filter((clue) => consumedIds.indexOf(clue.itemId) >= 0);
    expect(usedClues.map((clue) => clue.itemId).sort()).toEqual(consumedIds.slice().sort());
    expect(state.lastResult?.collectedItems).toEqual(expect.arrayContaining(usedClues.map((clue) => clue.name)));
  });

  it('红圆章会被拒，但不影响后面的通关', () => {
    const runtime = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo' });
    runtime.click('hs_a_flowchart');
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    runtime.click('hs_a_red_stamp');
    runtime.click('hs_a_poster');
    runtime.useItem('hs_a_slot', 'suction_rod');

    expect(runtime.useItem('hs_a_stamp_device', 'stamp_red')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    // 换蓝章就对了
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue').ok).toBe(true);
    expect(runtime.useItem('hs_a_cabinet', 'stamped_ticket').ok).toBe(true);
  });

  it('已盖章的券不能跳过海报解锁，解锁后保存恢复也能提交', () => {
    const runtime = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo' });
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    runtime.useItem('hs_a_slot', 'suction_rod');
    runtime.useItem('hs_a_stamp_device', 'stamp_blue');

    // 券是齐的，但查看海报之前，提交热点仍锁着；柜子保留明确的提示。
    expect(runtime.click('hs_a_cabinet_locked').ok).toBe(true);
    expect(runtime.getState().lastLine).toContain('先看看公告栏上的海报');
    expect(runtime.useItem('hs_a_cabinet', 'stamped_ticket')).toMatchObject({ ok: false, reason: 'not-usable' });
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getInventory().map((item) => item.itemId)).toContain('stamped_ticket');

    expect(runtime.click('hs_a_poster')).toMatchObject({ ok: true, effect: 'inspected' });
    const restored = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo', restore: runtime.getSnapshot() });
    expect(restored.useItem('hs_a_cabinet', 'stamped_ticket').ok).toBe(true);
    expect(restored.getStatus()).toBe('success');
  });

  it('第 1 关工具盒输错可以立即重试，错误不会产出道具', () => {
    const runtime = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo' });
    expect(runtime.useCode('hs_a_toolbox', ['1', '1', '1']).ok).toBe(false);
    expect(runtime.getInventory()).toEqual([]);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1']).ok).toBe(true);
  });

  it('连续两次输错后先显示失败反馈，再沿用手动提示梯度', () => {
    const config = loadShipped('level.01.json');
    const runtime = new LevelRuntime(config, { mode: 'solo' });
    const wrong = ['1', '1', '1'];
    runtime.useCode('hs_a_toolbox', wrong);
    runtime.tick(3);
    expect(runtime.getState().hints).toEqual([]);
    runtime.useCode('hs_a_toolbox', wrong);
    runtime.tick(2);
    expect(runtime.getState().hints).toEqual([]);
    runtime.tick(1);
    expect(runtime.getState().lastLine).toBe('小轨：' + config.hints[0]);
    expect(runtime.requestHint()).toBe(config.hints[1]);
    expect(runtime.getInventory()).toEqual([]);
  });

  it('password 门不配 wrongCooldownSec 就完全不罚 —— 别把老配置误伤成有惩罚', () => {
    // 第 3 关的管理员密码箱也没配罚站：输错只软拒绝
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    runtime.switchView('B');
    expect(runtime.click('hs_b_right').ok).toBe(true);
    expect(runtime.useCode('hs_b_cabinet', ['0', '0', '0', '0']).ok).toBe(false);
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    // 没有罚站，立刻再输就对
    expect(runtime.useCode('hs_b_cabinet', ['1', '0', '1', '2']).ok).toBe(true);
  });
});

describe('第 2 关能通关', () => {
  /**
   * 走完整条链（2026-10-09 起是多场景版）：
   * A 在岔路 1 拿碎片 → 点右侧封闭道路进放大图拿碎片 1、3 → B 归位并拼合
   * → A 按地图走：岔路 1 左、岔路 2 右、岔路 3 右 → 终点扶指路牌
   */
  function playthrough() {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });

    // 岔路 1：碎片 2 就在场景里；点右侧那条封闭道路会进放大图
    runtime.click('hs_a_frag_2');
    expect(runtime.click('hs_a_roadblock').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('fork1_right');
    runtime.click('hs_a_frag_1');
    runtime.click('hs_a_frag_3');
    // 拿完从放大图退回岔路 1（界面上的「返回」按钮走的就是这条）
    expect(runtime.goToScene('fork1')).toBe(true);

    // B：三块缺口归位 → 拼合。拼完背景自己切到新地图
    runtime.switchView('B');
    // 点地图读说明（拼合区盖住整张地图，没凑齐时点它就念那段说明）
    expect(runtime.useItem('hs_b_slot_sign', 'frag_1').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_building', 'frag_2').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_red', 'frag_3').ok).toBe(true);
    // 拼合：三块齐了点一下就成（**不涉及选择** —— 「已归位碎片」根本不进背包）
    expect(runtime.click('hs_b_assemble').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('newmap');

    // 回 A：切视角不丢 A 自己的场景（还在岔路 1）
    runtime.switchView('A');
    expect(runtime.getState().sceneId).toBe('fork1');
    expect(runtime.click('hs_a_fork1_left').ok).toBe(true);
    expect(runtime.click('hs_a_fork1_forward').ok).toBe(true);
    expect(runtime.click('hs_a_fork2_right').ok).toBe(true);
    expect(runtime.click('hs_a_fork2_forward').ok).toBe(true);
    expect(runtime.click('hs_a_fork3_right').ok).toBe(true);
    expect(runtime.click('hs_a_fork3_forward').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('end');
    expect(runtime.useChoice('hs_a_signpost', '扶起来看看').ok).toBe(true);

    return runtime;
  }

  it('走完就通关，并且带回要解锁的地图节点', () => {
    const runtime = playthrough();
    expect(runtime.getStatus()).toBe('success');
    expect(runtime.getReview().unlockedNodeIds).toEqual(['node_teaching']);
  });

  it('**没拼出路线图之前，岔路 1 的左侧走不了** —— 通关链卡在 B 手里', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });

    // 手里什么都没有：左边的路点不动（界面会提示「还差点东西，先去找找」）
    const blocked = runtime.click('hs_a_fork1_left');
    expect(blocked.ok).toBe(false);
    expect(blocked).toEqual({
      ok: false,
      reason: 'missing-item',
      // 配了 requireText：说清缺的是「拼好的路线图」，不是那句通用的「还差点东西」
      text: '路还没通 —— 得先把碎片拼成一张完整的路线图。',
    });

    // 但右侧那条**封闭道路不拦** —— 碎片 1、3 就藏在它进去的那张放大图里，
    // 拦了这里就死锁了（拿不到碎片 → 拼不出图 → 永远进不去）
    expect(runtime.click('hs_a_roadblock').ok).toBe(true);
    runtime.click('hs_a_frag_1');
    runtime.click('hs_a_frag_3');
    runtime.goToScene('fork1');
    runtime.click('hs_a_frag_2');

    // 碎片交给 B 拼合出 route_map 之后，左边的路才通
    runtime.switchView('B');
    expect(runtime.useItem('hs_b_slot_sign', 'frag_1').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_building', 'frag_2').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_red', 'frag_3').ok).toBe(true);
    expect(runtime.click('hs_b_assemble').ok).toBe(true);
    runtime.switchView('A');
    expect(runtime.click('hs_a_fork1_left').ok).toBe(true);
  });

  it('走到错误的一侧没有惩罚 —— 看到那条路的图，退回来重选就行', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    // 岔路 2 的正确侧是右边（花坛），先故意走左边
    runtime.goToScene('fork2');
    expect(runtime.click('hs_a_fork2_left').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('fork2_left');
    // 死路：没有「往前走」，只能返回
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_a_fork2_forward');
    expect(runtime.goToScene('fork2')).toBe(true);
    // 状态一点没变：没扣次数、没用道具、还能接着走对的那条
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.click('hs_a_fork2_right').ok).toBe(true);
  });

  it('侧路场景配了「返回」出口，岔路场景没有 —— 界面按它决定显不显示返回按钮', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    expect(runtime.getState().sceneId).toBe('fork1');
    expect(runtime.getState().backSceneId).toBe(null);
    // 直接切场景，绕过岔路的前置检查 —— 这条测的是场景机制，不是那道门
    runtime.goToScene('fork1_left');
    expect(runtime.getState().backSceneId).toBe('fork1');
  });

  it('别的场景的热点点了不算数 —— 视同不可见', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    // 人在岔路 1，岔路 2 的道路不该能点（哪怕节点 id 是对的）
    expect(runtime.click('hs_a_fork2_left')).toEqual({ ok: false, reason: 'not-visible' });
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_a_fork2_left');
  });

  it('拼合要三块齐 —— 只放两块时点拼合区会被拦，并说清差什么', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    runtime.click('hs_a_roadblock');
    runtime.click('hs_a_frag_1');
    runtime.click('hs_a_frag_3');
    runtime.switchView('B');
    expect(runtime.useItem('hs_b_slot_sign', 'frag_1').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_building', 'frag_2').ok).toBe(false); // 碎片 2 还没拿

    // 只归位了一块 → 拼合区点不动，而且会说清「三个缺口都补上之后才能拼」
    const blocked = runtime.click('hs_b_assemble');
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({
      ok: false,
      reason: 'missing-item',
      text: expect.stringContaining('三处缺口'),
    });
  });

  it('「已归位碎片」标记成 hidden，碎片带图标 —— 背包面板照这两个字段画', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    // 碎片 1 在右侧那张放大图里，先进去
    runtime.click('hs_a_roadblock');
    runtime.click('hs_a_frag_1');
    const frag = runtime.getInventory()[0];
    expect(frag.itemId).toBe('frag_1');
    expect(frag.iconKey).toBe('details/frag_1');
    expect(frag.hidden).toBeUndefined();

    runtime.switchView('B');
    runtime.useItem('hs_b_slot_sign', 'frag_1');
    const bit = runtime.getInventory().filter((i) => i.itemId === 'map_bit_1')[0];
    // 中间道具照样进 inventory（拼合要按它判），但**带 hidden 标记** ——
    // 背包面板会把它滤掉，玩家看不见「已归位的什么」
    expect(bit.hidden).toBe(true);
  });

  it('场景按视角各记一份 —— 切到 B 再切回来，A 还停在原处', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    runtime.goToScene('fork1_left'); // A 进岔路 1 左侧（绕过前置检查）
    runtime.switchView('B');
    expect(runtime.getState().sceneId).toBe('oldmap');
    runtime.switchView('A');
    expect(runtime.getState().sceneId).toBe('fork1_left');
  });
});

describe('第 3 关能通关', () => {
  const ANSWER = { 集合时间: '09:39', 集合地点: '思源楼西侧展板区' };

  /** 从 B 的右侧打开密码箱、取走紫外线灯（之后会自动切到 right_v2） */
  function obtainLamp(runtime: LevelRuntime) {
    runtime.switchView('B');
    expect(runtime.click('hs_b_right').ok).toBe(true);
    expect(runtime.useCode('hs_b_cabinet', ['1', '0', '1', '2']).ok).toBe(true);
    expect(runtime.click('hs_b_lamp')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.getInventory().map((item) => item.itemId)).toContain('uv_lamp');
  }

  it('开密码箱拿灯 → 两边紫外线 → 方位合并 → 终端填表通关', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });

    // A 的公告栏：三张通知里只有 03 当前生效
    expect(runtime.click('hs_a_board').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v1');
    // 还没拿到灯，紫外线热点是灰的
    expect(runtime.click('hs_a_uv_note')).toMatchObject({ ok: false, reason: 'missing-item' });
    expect(runtime.goToScene('square')).toBe(true);

    // B：右侧 → 密码箱（03 的日期 10月12日 = 1012）→ 拿灯
    obtainLamp(runtime);
    expect(runtime.getState().sceneId).toBe('right_v2');

    // 拿走灯之后主场景里的「右侧」入口被揭示，并且直接通往 right_v2
    expect(runtime.goToScene('square')).toBe(true);
    const squareHotspots = runtime.getState().hotspots.map((h) => h.nodeId);
    expect(squareHotspots).toContain('hs_b_right_open');
    expect(runtime.click('hs_b_right_open').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('right_v2');

    // 只有灯、还没照过任何公告栏 —— 终端不接
    expect(runtime.click('hs_b_terminal')).toMatchObject({ ok: false, reason: 'missing-item' });

    // B 照自己的公告栏
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.click('hs_b_board').ok).toBe(true);
    runtime.selectItem('uv_lamp');
    expect(runtime.click('hs_b_uv_note').ok).toBe(true);
    // 先在 board_v1 上播 v2 淡入（视图负责），淡完才由视图调 goToScene
    expect(runtime.getState().sceneId).toBe('board_v1');
    expect(runtime.goToScene('board_v2', true)).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v2');
    // 动画淡完才切场景，那句「紫外线下……」说的就是新场景，不能被清掉
    expect(runtime.getState().lastLine).toContain('紫外线下');

    // A 照自己的公告栏（灯是队伍道具，切视角后还在背包里）
    runtime.switchView('A');
    expect(runtime.click('hs_a_board').ok).toBe(true);
    // 灯还在选中状态（队伍道具不消耗），直接照
    expect(runtime.click('hs_a_uv_note').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v1');
    expect(runtime.goToScene('board_v2', true)).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v2');

    // 照过之后再回主场景，公告栏入口直接打开「已揭示」那张，不再回到涂改图
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).toContain('hs_a_board_found');
    expect(runtime.click('hs_a_board_found').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v2');
    // 揭示图整张可点，线索可以反复看（inspect 不会被消耗）
    expect(runtime.click('hs_a_board_v2_note')).toMatchObject({ ok: true, effect: 'inspected' });
    expect(runtime.click('hs_a_board_v2_note')).toMatchObject({ ok: true, effect: 'inspected' });
    expect(runtime.goToScene('square')).toBe(true);

    // 回 B 的终端：先答错一次（软拒绝、不罚站），再答对
    runtime.switchView('B');
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).toContain('hs_b_board_found');
    expect(runtime.click('hs_b_board_found').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v2');
    const found: string[] = [];
    runtime.on('egg:found', ({ eggId }) => found.push(eggId));
    runtime.click('hs_b_board_v2_note');
    runtime.click('hs_b_board_v2_note');
    expect(found).toEqual(['L03_blue_signature']);
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.click('hs_b_right_open').ok).toBe(true);
    expect(runtime.submit({ 集合时间: '09:30', 集合地点: '思源楼北侧展板区' })).toBe(false);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getState().cooldownLeftSec).toBe(0);

    expect(runtime.submit(ANSWER)).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('终端要 A、B 两侧线索都看过才收 —— 只看一侧交不了', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    obtainLamp(runtime);

    // 只照 A 侧
    runtime.switchView('A');
    expect(runtime.click('hs_a_board').ok).toBe(true);
    runtime.selectItem('uv_lamp');
    expect(runtime.click('hs_a_uv_note').ok).toBe(true);

    runtime.switchView('B');
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.click('hs_b_right_open').ok).toBe(true);
    expect(runtime.click('hs_b_terminal')).toMatchObject({ ok: false, reason: 'missing-item' });
    // 直接调 submit 也拦住（puzzle.requiredItems 那一层），而且不算答错次数
    expect(runtime.submit(ANSWER)).toBe(false);
    expect(runtime.getState().attemptsLeft).toBe(5);
    expect(runtime.getStatus()).toBe('playing');

    // 补上 B 侧就能交了
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.click('hs_b_board').ok).toBe(true);
    // A 侧照完灯仍选中，直接照
    expect(runtime.click('hs_b_uv_note').ok).toBe(true);
    expect(runtime.goToScene('square')).toBe(true);
    expect(runtime.click('hs_b_right_open').ok).toBe(true);
    expect(runtime.submit(ANSWER)).toBe(true);
  });

  it('开箱场景没有返回出口 —— 防止「开门后不拿灯就退出」把灯锁死', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    runtime.switchView('B');
    runtime.click('hs_b_right');
    runtime.useCode('hs_b_cabinet', ['1', '0', '1', '2']);

    // 密码热点是一次性的：这里要是能退出，回来就再也进不去、灯永远拿不到
    expect(runtime.getState().sceneId).toBe('lockbox_open');
    expect(runtime.getState().backSceneId).toBe(null);

    // 拿走灯之后自动切到 right_v2，这时候才有返回
    expect(runtime.click('hs_b_lamp').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('right_v2');
    expect(runtime.getState().backSceneId).toBe('square');
  });

  it('没有灯时紫外线热点在界面上是灰的', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    runtime.click('hs_a_board');
    const gate = runtime.getState().hotspots.find((h) => h.nodeId === 'hs_a_uv_note');
    expect(gate?.enabled).toBe(false);
  });

  it('有灯但没在背包里选中 → 点了不切换（要先把灯选中再照）', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    obtainLamp(runtime);
    runtime.switchView('A');
    expect(runtime.click('hs_a_board').ok).toBe(true);

    // 只是「手上有灯」，没选它 —— 不能直接照，场景也不该切
    expect(runtime.click('hs_a_uv_note')).toMatchObject({ ok: false, reason: 'no-item-selected' });
    expect(runtime.getState().sceneId).toBe('board_v1');

    // 选中之后才照得动；v2 由视图淡入后再切，运行时这里仍停在 v1
    runtime.selectItem('uv_lamp');
    expect(runtime.click('hs_a_uv_note').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('board_v1');
  });
});

describe('第 4、5 关盆栽彩蛋', () => {
  it.each([
    ['04', 'B', 'hs_b_plant_egg', '借书条上的箭头', 'solo'],
    ['04', 'B', 'hs_b_plant_egg', '借书条上的箭头', 'duo'],
    ['05', 'A', 'hs_a_plant_egg', '请勿倒剩汤', 'solo'],
    ['05', 'A', 'hs_a_plant_egg', '请勿倒剩汤', 'duo'],
  ] as const)('第 %s 关 %s 视角 %s %s %s：可重复读文案，发现只记一次', (level, view, node, title, mode) => {
    const config = loadShipped(`level.${level}.json`);
    const runtime = new LevelRuntime(config, { mode, initialView: view });
    const before = runtime.getSnapshot();
    const found: unknown[] = []; const sync: unknown[] = [];
    runtime.on('egg:found', (egg) => found.push(egg));
    runtime.on('sync:out', (event) => sync.push(event));
    expect(runtime.click(node)).toMatchObject({ ok: true, effect: 'inspected' });
    const firstLine = runtime.getState().lastLine;
    expect(firstLine).toBeTruthy();
    expect(runtime.click(node)).toMatchObject({ ok: true, effect: 'inspected' });
    expect(runtime.getState().lastLine).toBe(firstLine);
    expect(found).toHaveLength(1); expect(sync).toEqual([]);
    expect(runtime.getSnapshot()).toMatchObject(before);
    expect(runtime.getState().timeLeftSec).toBe(900);
    expect(runtime.getReview().eggs).toMatchObject({ found: 1, total: 1, titles: [title] });
    const restored = new LevelRuntime(config, { mode, initialView: view, restore: runtime.getSnapshot() });
    const discoveredAgain: unknown[] = [];
    restored.on('egg:found', (egg) => discoveredAgain.push(egg));
    restored.click(node); expect(discoveredAgain).toEqual([]);
  });
});

describe('第 4 关能通关', () => {
  const CORRECT_SHELF = 'C-2-1 / C-2-2 / C-2-3 / C-2-4 / C-2-5';

  /** A 侧：书架排序 → 抽屉打开 → 拿透明片 → 看借阅记录（顺带揭开 B 的还书处入口） */
  function sortShelfAndReadRecord(runtime: LevelRuntime) {
    expect(runtime.click('hs_a_shelf_entry').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('shelf_detail');
    expect(runtime.useChoice('hs_a_shelf_order', CORRECT_SHELF).ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('drawer_open');

    expect(runtime.click('hs_a_stencil')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('transparent_sheet');

    expect(runtime.click('hs_a_book_entry').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('book_fallen');
    expect(runtime.click('hs_a_book_record')).toMatchObject({ ok: true, effect: 'inspected' });
    expect(runtime.getState().lastLine).toContain('C 区还书处');
  }

  /** B 侧：拿到借阅卡 → 打开密码盒，停在「密码正确、等已归还的卡」这一步 */
  function unlockBox(runtime: LevelRuntime) {
    runtime.switchView('B');
    expect(runtime.click('hs_b_card')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.click('hs_b_locker_entry').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('box_locked');
    expect(runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']).ok).toBe(true);
    // 表现层淡入完成后才切场景；这里模拟 Cocos 的完成回调。
    expect(runtime.getState().sceneId).toBe('box_locked');
    expect(runtime.goToScene('box_code_correct', true, false)).toBe(true);
    expect(runtime.getState().sceneId).toBe('box_code_correct');
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('safe_unlocked');
  }

  it('整理书架 → 叠图读 3142 → 还书 → 开资料盒', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    sortShelfAndReadRecord(runtime);

    runtime.switchView('B');
    expect(runtime.click('hs_b_card')).toMatchObject({ ok: true, effect: 'picked' });
    // 索引表：镂空片要先在背包里选中，再点表 —— 不是拿着就自动生效
    expect(runtime.click('hs_b_grid_entry').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('grid_plain');
    expect(runtime.useItem('hs_b_overlay_entry', 'transparent_sheet').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('grid_plain');
    expect(runtime.goToScene('grid_overlay', true, false)).toBe(true);
    expect(runtime.getState().sceneId).toBe('grid_overlay');
    // 用掉就没了
    expect(runtime.getInventory().map((i) => i.itemId)).not.toContain('transparent_sheet');
    expect(runtime.click('hs_b_read_overlay')).toMatchObject({ ok: true, effect: 'inspected' });
    // 叠图场景本身不再把密码写在对话框里 —— 数字在图上，玩家自己看
    expect(runtime.getState().lastLine).not.toContain('3142');

    // 叠图的「返回」直接回主场景 —— 只按一次，不用先退回那张没叠图的表
    expect(runtime.getState().backSceneId).toBe('main');
    expect(runtime.goToScene('main')).toBe(true);
    // 主场景的索引表入口已经换成「叠好的那张」，再点直接显示叠图
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).toContain('hs_b_grid_entry_overlay');
    expect(runtime.click('hs_b_grid_entry_overlay').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('grid_overlay');
    expect(runtime.goToScene('main')).toBe(true);

    // 资料盒密码盘
    expect(runtime.click('hs_b_locker_entry').ok).toBe(true);
    expect(runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']).ok).toBe(true);

    // 未归还的卡会被弹回来，卡还在背包里
    expect(runtime.goToScene('box_code_correct', true, false)).toBe(true);
    expect(runtime.useItem('hs_b_locker_slot', 'library_card')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.getState().lastLine).toContain('还没归还');
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('library_card');

    // 去 C 区还书处过一遍
    expect(runtime.goToScene('main')).toBe(true);
    expect(runtime.click('hs_b_return_area').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('return_machine');
    expect(runtime.useItem('hs_b_return_slot', 'library_card').ok).toBe(true);
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('library_card_returned');
    expect(runtime.getInventory().map((i) => i.itemId)).not.toContain('library_card');

    // 还书处的「返回」直接回主场景，不是资料盒
    expect(runtime.getState().backSceneId).toBe('main');
    expect(runtime.goToScene('main')).toBe(true);
    // 主场景的资料盒入口已经被替换成「已开锁」那个，进去就是卡槽
    expect(runtime.click('hs_b_locker_entry_open').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('box_code_correct');
    expect(runtime.useItem('hs_b_locker_slot', 'library_card_returned').ok).toBe(true);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getInventory().some(item => item.itemId === 'route_fragment_1')).toBe(false);
    expect(runtime.click('hs_b_archive_record').ok).toBe(true);
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.click('hs_b_collect_fragment').ok).toBe(true);
    expect(runtime.getStatus()).toBe('success');
    expect(runtime.getState().sceneId).toBe('box_open_reward');

    // 三件奖励和通关解锁的节点
    const inventory = runtime.getInventory().map((i) => i.itemId);
    expect(inventory).toContain('card_04');
    expect(inventory).toContain('route_fragment_1');
    expect(runtime.getReview().collectedItems).toContainEqual({ itemId: 'route_fragment_1', name: '线路图残片①' });
    expect(runtime.getInventory().find(item => item.itemId === 'route_fragment_1')?.iconKey).toBe('details/L04_route_fragment_01');
    expect(inventory).toContain('archive_anomaly_1');
    expect(runtime.getReview().unlockedNodeIds).toEqual(['node_canteen']);
  });

  it('索引表要走「先选中道具、再点表」—— 没选只弹一句反问，选错软拒绝', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    runtime.switchView('B');
    expect(runtime.click('hs_b_grid_entry').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('grid_plain');

    // 还没选东西：只出一句提示，不切场景
    expect(runtime.click('hs_b_overlay_entry')).toEqual({
      ok: false,
      reason: 'no-item-selected',
      text: '这张表……是不是还缺了什么，要放上去才能读？',
    });
    expect(runtime.getState().sceneId).toBe('grid_plain');

    // 选错东西：软拒绝，不消耗、不切场景
    expect(runtime.goToScene('main')).toBe(true);
    expect(runtime.click('hs_b_card')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.click('hs_b_grid_entry').ok).toBe(true);
    expect(runtime.useItem('hs_b_overlay_entry', 'library_card')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.getState().lastLine).toBe('这张表不认这个。');
    expect(runtime.getState().sceneId).toBe('grid_plain');
    // 软拒绝不算答错，不扣次数
    expect(runtime.getState().attemptsLeft).toBe(3);
  });

  it('还书处入口要 A 先看借阅记录才出现，而且密码锁没开也进不去', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });

    // 还没看记录：B 主场景里根本没这个入口
    runtime.switchView('B');
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_b_return_area');
    expect(runtime.click('hs_b_return_area')).toEqual({ ok: false, reason: 'not-visible' });

    // A 看过借阅记录之后入口出现（跨视角揭示）
    runtime.switchView('A');
    sortShelfAndReadRecord(runtime);
    runtime.switchView('B');
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).toContain('hs_b_return_area');

    // 但资料盒的密码锁还没开 —— 点它只说一句前提，不切场景
    const blocked = runtime.click('hs_b_return_area');
    expect(blocked).toEqual({
      ok: false,
      reason: 'missing-item',
      text: '先打开资料盒的密码锁，再前往 C 区还书处。',
    });
    expect(runtime.getState().sceneId).toBe('main');

    // 开了锁就能进
    runtime.click('hs_b_locker_entry');
    runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']);
    expect(runtime.goToScene('main')).toBe(true);
    expect(runtime.click('hs_b_return_area').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('return_machine');
  });

  it('还书口只认未归还的卡 —— 拿别的东西会被拒，不消耗', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    sortShelfAndReadRecord(runtime);
    unlockBox(runtime);
    runtime.goToScene('main');
    expect(runtime.click('hs_b_return_area').ok).toBe(true);

    expect(runtime.useItem('hs_b_return_slot', 'transparent_sheet')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.getState().lastLine).toBe('这个归还口只认未归还的借阅卡。');
    // 透明片没被吞掉
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('transparent_sheet');
    expect(runtime.getStatus()).toBe('playing');
  });

  it('书架排错顺序会被拒，还能接着排对', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    runtime.click('hs_a_shelf_entry');

    // 第二个选项是初始书脊顺序（C-2-1 / C-2-3 / C-2-4 / C-2-2 / C-2-5）
    expect(runtime.useChoice('hs_a_shelf_order', 'C-2-1 / C-2-3 / C-2-4 / C-2-2 / C-2-5')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.getState().lastLine).toBe('这一排还是乱的，编号对不上。');
    // 软拒绝：不扣次数、不切场景
    expect(runtime.getState().sceneId).toBe('shelf_detail');

    expect(runtime.useChoice('hs_a_shelf_order', CORRECT_SHELF).ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('drawer_open');
  });

  it('资料盒密码输错只软拒绝，不罚站；输对才出隐藏标记', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    runtime.switchView('B');
    runtime.click('hs_b_locker_entry');

    expect(runtime.useCode('hs_b_locker_keypad', ['0', '0', '0', '0']).ok).toBe(false);
    expect(runtime.getState().lastLine).toBe('四位数字不对，资料盒没有反应。');
    expect(runtime.getState().cooldownLeftSec).toBe(0);
    expect(runtime.getState().sceneId).toBe('box_locked');
    expect(runtime.getInventory().map((i) => i.itemId)).not.toContain('safe_unlocked');

    expect(runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']).ok).toBe(true);
  });

  it('开锁后主场景的资料盒入口直接进「密码正确」场景，不退回锁着的密码盘', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    runtime.switchView('B');
    runtime.click('hs_b_locker_entry');
    runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']);

    // 从密码正确场景返回主场景后，多了一个盖住原入口的「已开锁」热点
    expect(runtime.goToScene('main')).toBe(true);
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).toContain('hs_b_locker_entry_open');
    expect(runtime.click('hs_b_locker_entry_open').ok).toBe(true);
    expect(runtime.getState().sceneId).toBe('box_code_correct');
  });

  it('抽屉打开后没有返回出口，掉落的书回到抽屉场景 —— 不会掉进只有一次性热点的书脊图', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    runtime.click('hs_a_shelf_entry');
    runtime.useChoice('hs_a_shelf_order', CORRECT_SHELF);
    // 书架排序热点是一次性的：能退回书脊图就再也点不动它，也回不了抽屉
    expect(runtime.getState().sceneId).toBe('drawer_open');
    expect(runtime.getState().backSceneId).toBe(null);

    runtime.click('hs_a_book_entry');
    expect(runtime.getState().sceneId).toBe('book_fallen');
    expect(runtime.getState().backSceneId).toBe('drawer_open');
  });

  it('借阅卡在背包里区分两个状态 —— 未还书 / 已归还', () => {
    const config = loadShipped('level.04.json');
    expect(config.items?.library_card).toMatchObject({ name: '借阅卡（未还书）' });
    expect(config.items?.library_card_returned).toMatchObject({ name: '借阅卡（已归还）' });
  });
});

describe('第 5 关能通关', () => {
  /**
   * 唯一的那组解：轨道饭 12 + 冰汽水 6 组成 B 套餐（减 2）= 16，
   * 辣椒炒肉 8 + 水果杯 6 单点 → 16+8+6 = 30。冰汽水已进套餐，所以不用饮品补助券。
   */
  const ANSWER = {
    主食: '轨道饭',
    配菜: '辣椒炒肉',
    小食: '水果杯',
    饮品: '冰汽水',
    套餐结算: 'B 套餐',
    饮品补助券: '不使用',
  };

  /** 走完前置：A 拿值班牌 → B 插牌打印餐券，停在 B 视角 */
  function toVoucher() {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    runtime.click('hs_a_volunteer_desk');
    runtime.switchView('B');
    runtime.useItem('hs_b_checkin', 'shift_card');
    return runtime;
  }

  it('值班牌 → 签到台 → 餐券 → 结算机，整条链能通关', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });

    // A 在 07 号志愿者桌拿到值班牌
    expect(runtime.click('hs_a_volunteer_desk').ok).toBe(true);
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('shift_card');

    // B 把牌插进签到台：牌被消耗，打印出餐券
    runtime.switchView('B');
    expect(runtime.useItem('hs_b_checkin', 'shift_card').ok).toBe(true);
    expect(runtime.getInventory().map((i) => i.itemId)).not.toContain('shift_card');
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('meal_voucher');

    // A 可随时查看右侧餐券的使用规则
    runtime.switchView('A');
    expect(runtime.click('hs_a_ticket_pickup').ok).toBe(true);

    // B 点结算机屏幕打开六项表单，填对就通关
    runtime.switchView('B');
    expect(runtime.click('hs_b_order_terminal')).toEqual({
      ok: true,
      effect: 'input-ready',
      nodeId: 'hs_b_order_terminal',
    });
    expect(runtime.submit(ANSWER)).toBe(true);
    expect(runtime.getStatus()).toBe('success');
    expect(runtime.getInventory().some(item=>item.itemId==='meal_voucher')).toBe(false);
    expect(runtime.getReview().collectedItems.some(item=>item.itemId==='meal_voucher')).toBe(true);
  });

  it('结算成功同步到同伴时，餐券同样移出背包且收集记录仍在', () => {
    const host=toVoucher();
    const peer=new LevelRuntime(loadShipped('level.05.json'),{mode:'duo',initialView:'A',restore:host.getSnapshot()});
    host.on('sync:out',event=>peer.applyRemote(event));
    expect(host.submit(ANSWER)).toBe(true);
    expect(peer.getStatus()).toBe('success');
    expect(peer.getInventory().some(item=>item.itemId==='meal_voucher')).toBe(false);
    expect(peer.getReview().collectedItems.some(item=>item.itemId==='meal_voucher')).toBe(true);
  });

  it('A 没拿餐券也能查看规则，查看不会代替 B 的打印步骤', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });

    expect(runtime.click('hs_a_ticket_pickup').ok).toBe(true);
    expect(runtime.getState().lastLine).toContain('餐券使用规则');
    expect(runtime.getState().lastLine).toContain('餐补 30 点');
    expect(runtime.getState().lastLine).toContain('主食、配菜、小食、饮品各选一份');
    expect(runtime.getState().lastLine).toContain('不能再用补助券');
    expect(runtime.getInventory()).toHaveLength(0);
    runtime.switchView('B');
    expect(runtime.click('hs_b_order_terminal')).toEqual({
      ok: false,
      reason: 'missing-item',
      text: '结算机还没亮。\n先在签到台打印志愿者餐券。',
    });
  });

  it('签到台只认值班牌，挑错是软拒绝、不消耗东西', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    runtime.switchView('B');
    // 背包里还没有值班牌就去插 —— 点不动，不会打印餐券
    expect(runtime.useItem('hs_b_checkin', 'shift_card')).toEqual({ ok: false, reason: 'missing-item' });
    expect(runtime.getInventory()).toHaveLength(0);
    expect(runtime.getStatus()).toBe('playing');
  });

  it('菜单墙和套餐牌的文字与开发卡一致', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    runtime.switchView('B');

    runtime.click('hs_b_menu_wall');
    expect(runtime.getState().lastLine).toContain('轨道饭 12');
    expect(runtime.getState().lastLine).toContain('辣椒炒肉 8');
    expect(runtime.getState().lastLine).toContain('冰汽水 6');

    runtime.click('hs_b_combo_board');
    expect(runtime.getState().lastLine).toContain('减 3 点');
    expect(runtime.getState().lastLine).toContain('减 2 点');
    expect(runtime.getState().lastLine).toContain('减 4 点');
    expect(runtime.getState().lastLine).toContain('只能使用一种套餐结算方式');
  });

  it('全部单点 / A 套餐（32 点）会被拒 —— 超了额度', () => {
    const runtime = toVoucher();
    const wrong = { ...ANSWER, 套餐结算: 'A 套餐' };
    expect(runtime.submit(wrong)).toBe(false);
    expect(runtime.getStatus()).toBe('playing');
  });

  it('用上饮品补助券会被拒 —— 冰汽水已经进套餐了', () => {
    const runtime = toVoucher();
    const wrong = { ...ANSWER, 饮品补助券: '使用' };
    expect(runtime.submit(wrong)).toBe(false);
    expect(runtime.getStatus()).toBe('playing');
    // 错一次只是软拒绝：餐券还在，能接着改
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('meal_voucher');
  });

  it('选 C 套餐也到不了 30 —— 最多 28 点', () => {
    const runtime = toVoucher();
    expect(runtime.submit({ ...ANSWER, 套餐结算: 'C 套餐' })).toBe(false);
  });

  it('提交热点挂在 B 的结算机上，成功图就是结算成功那张', () => {
    const config = loadShipped('level.05.json');
    expect(config.views.A.assetKey).toBe('bg/L05_A_scene');
    expect(config.views.B.assetKey).toBe('bg/L05_B_scene');
    expect(config.puzzle?.submitNodeId).toBe('hs_b_order_terminal');
    expect(config.finishHoldSec).toBe(2);

    const submit = config.views.B.hotspots.find((h) => h.nodeId === 'hs_b_order_terminal');
    expect(submit?.action).toBe('submit');
    expect(submit?.requiresItem).toBe('meal_voucher');
    expect(submit?.detailKey).toBe('details/L05_receipt_success');

    // 值班牌和餐券都有图标，背包里不会只显示技术名
    expect(config.items?.shift_card).toMatchObject({ name: '07 号值班牌', iconKey: 'details/L05_badge_07' });
    expect(config.items?.meal_voucher).toMatchObject({ name: '07 号志愿者餐券' });
  });
});

describe('第 8 关现图接力', () => {
  it('交棒入口只存在于终点特写的绿色区域', () => {
    const config=loadShipped('level.08.json');
    const slot=config.views.A.hotspots.find(h=>h.nodeId==='hs_a_relay_slot')!;
    expect(slot.scene).toBe('scan');expect(slot.buttonLabel).toBeUndefined();
    expect(slot.rect).toEqual([1048,740,218,108]);
  });

  it('B 未收到实体交棒时明确提示另一侧先交棒', () => {
    const r = new LevelRuntime(loadShipped('level.08.json'), {mode:'solo', initialView:'B'});
    expect(r.click('hs_b_receiver_entry').ok).toBe(true);
    expect(r.click('hs_b_take_baton')).toMatchObject({ok:false, reason:'missing-item', text: expect.stringContaining('右侧绿色区域交棒')});
  });
  it('B 可独立在图中选方向，A 未完成外围时仍不能交棒',()=>{
    const r=new LevelRuntime(loadShipped('level.08.json'),{mode:'solo',initialView:'B'});
    expect(r.click('hs_b_pattern_entry').ok).toBe(true);
    expect(r.click('hs_b_pattern_up')).toMatchObject({ok:false,reason:'rejected'});
    expect(r.click('hs_a_triangle_gate')).toMatchObject({ok:true,effect:'used'});
    r.switchView('A');expect(r.click('hs_a_relay_slot').ok).toBe(false);
  });

  function playthrough() {
    const r = new LevelRuntime(loadShipped('level.08.json'), {mode:'solo'});
    const events: any[] = []; r.on('sync:out', e => events.push(e));
    const click = (id:string) => expect(r.click(id).ok,id).toBe(true);
    const go = (id:string) => expect(r.goToScene(id),id).toBe(true);
    click('hs_a_workbench'); click('hs_a_bench'); expect(r.click('hs_a_assemble').ok).toBe(false); click('hs_a_endcap'); click('hs_a_assemble'); expect(r.getCurrentScene()).toBe('main'); expect(r.getInventory().filter(i=>['baton_body','baton_cap','baton'].includes(i.itemId)).map(i=>i.itemId)).toEqual(['baton']); click('hs_a_route_entry');
    expect(r.useChoice('hs_a_start_stand','蓝线：方形→圆形→三角').ok).toBe(false);
    r.switchView('B'); click('hs_b_records_entry'); expect(r.getInventory().some(i=>i.itemId==='team_read')).toBe(true); click('hs_b_team_records'); r.switchView('A');
    expect(r.useChoice('hs_a_start_stand','蓝线：方形→圆形→三角').ok).toBe(true); go('main'); click('hs_a_route_entry'); expect(r.click('hs_a_start_stand')).toMatchObject({ok:false,reason:'already-done'}); go('main'); click('hs_a_square_entry'); expect(r.useChoice('hs_a_square_gate','右下').ok).toBe(true); go('main'); expect(r.useChoice('hs_a_round_gate','右下').ok).toBe(true);
    expect(r.click('hs_a_install_magnet').ok).toBe(false); click('hs_a_pickup_magnet'); expect(r.useItem('hs_a_install_magnet','magnet_blue').ok).toBe(true); go('main'); click('hs_a_triangle_entry');
    for(let n=1;n<=4;n++) click('hs_a_outer_'+n);
    expect(r.click('hs_a_pattern_finish').ok).toBe(false);
    r.switchView('B'); go('main'); click('hs_b_pattern_entry'); expect(r.useChoice('hs_a_triangle_gate','朝右').ok).toBe(true);
    r.switchView('A'); click('hs_a_pattern_finish'); go('main'); click('hs_a_scan'); expect(r.getCurrentScene()).toBe('scan'); expect(r.selectItem('baton_magnet')).toBe(true); click('hs_a_relay_slot');
    r.switchView('B'); go('main'); click('hs_b_receiver_entry'); click('hs_b_take_baton'); r.selectItem('e_baton'); click('hs_a_cabinet'); expect(r.getInventory().some(item=>item.itemId==='e_baton')).toBe(false); expect(r.getReview().collectedItems.some(item=>item.itemId==='e_baton')).toBe(true);
    return {r,events};
  }
  it('逐段复位、A 交棒、B 接收后提交终点，不能跳步',()=>{expect(playthrough().r.getReview().nextLevelId).toBe('L09');});
  it('双人另一端重放全部操作后同步成功和奖励',()=>{const {events}=playthrough();const peer=new LevelRuntime(loadShipped('level.08.json'),{mode:'duo',initialView:'B'});for(const e of events)peer.applyRemote(e);expect(peer.getStatus()).toBe('success');expect(peer.getReview().collectedItems.some(i=>i.itemId==='card_08')).toBe(true);});
});
describe('引导关和第 5 关的输入面板要点热点才弹出', () => {
  it('引导关：点 B 的登记处才弹表单，不点就什么都不显示', () => {
    const runtime = new LevelRuntime(loadShipped('level.guide.json'), { mode: 'solo' });
    runtime.switchView('B');

    const config = loadShipped('level.guide.json');
    expect(config.puzzle?.submitNodeId).toBe('hs_b_register');
    expect(runtime.click('hs_b_register')).toEqual({
      ok: true,
      effect: 'input-ready',
      nodeId: 'hs_b_register',
    });
    // 面板只是打开，没有判定
    expect(runtime.getStatus()).toBe('playing');
  });

  it('第 5 关：点餐机是打开点餐单的开关（在 B 视角）', () => {
    const config = loadShipped('level.05.json');
    expect(config.puzzle?.submitNodeId).toBe('hs_b_order_terminal');

    const runtime = new LevelRuntime(config, { mode: 'solo' });
    runtime.click('hs_a_volunteer_desk');
    runtime.switchView('B');
    runtime.useItem('hs_b_checkin', 'shift_card');

    expect(runtime.click('hs_b_order_terminal')).toEqual({
      ok: true,
      effect: 'input-ready',
      nodeId: 'hs_b_order_terminal',
    });
  });
});

describe('解锁链条（跨关的结构检查）', () => {
  const SHIPPED = [
    'level.guide.json',
    'level.01.json',
    'level.02.json',
    'level.03.json',
    'level.04.json',
    'level.05.json',
    'level.08.json',
    'level.06.json',
    'level.07.json',
    'level.09.json',
    'level.10.json',
  ];

  it('同一个节点不会被两关重复解锁', () => {
    // 这类错配置校验看不出来 —— 只有把 7 关放一起看才发现。
    // 我之前就把 node_road 在 L01 和 L02 各解锁了一次
    const seen = new Map<string, string>();
    const dupes: string[] = [];

    for (const file of SHIPPED) {
      const config = loadShipped(file);
      for (const nodeId of config.rewards.progress) {
        const owner = seen.get(nodeId);
        if (owner) dupes.push(`${nodeId} 被 ${owner} 和 ${config.levelId} 各解锁了一次`);
        else seen.set(nodeId, config.levelId);
      }
    }

    expect(dupes).toEqual([]);
  });

  it('每关解锁的地图节点不超过一个', () => {
    // 约定：通关本关 → 解锁下一关的站点。多个元素说明链条没理清
    for (const file of SHIPPED) {
      const config = loadShipped(file);
      expect(config.rewards.progress.length, `${config.levelId} 解锁了多个节点`).toBeLessThanOrEqual(1);
    }
  });

  it('节点 id 都是 node_ 开头 —— E 的地图按这个前缀识别', () => {
    for (const file of SHIPPED) {
      const config = loadShipped(file);
      for (const nodeId of config.rewards.progress) {
        expect(nodeId.startsWith('node_'), `${config.levelId} 的 ${nodeId} 命名不合约定`).toBe(true);
      }
    }
  });

  it('解锁的节点就是 E 地图上「下一关」那一站', () => {
    // D↔E 的接口守护。E 的地图拿 unlockedProgress 去比 MAP_NODES 的 nodeId，
    // 对不上就永远不亮 —— 关卡明明通了、地图上还是灰的，看起来像关卡没通。
    // 踩过：两边各起了一套 id，10 个里有 5 个对不上（D 叫 node_avenue、
    // E 叫 node_road），单看任何一边都正常，只有放一起比才发现。
    //
    // 比的是**相对位置**而不是写死一串 id：A/B 的正式节点清单来了以后，
    // 两边一起换名字这条照样过；只改一边才会红。
    expect(MAP_NODES.map((node) => node.levelId)).toEqual(LEVEL_ORDER);
    expect(MAP_NODES.slice(6, 9).map((node) => [node.levelId, node.place])).toEqual([
      ['L06', '机械楼'], ['L07', '八教'], ['L08', '西操场'],
    ]);
    const indexByLevel = new Map(MAP_NODES.map((node, index) => [node.levelId, index]));
    const problems: string[] = [];

    for (const file of SHIPPED) {
      const config = loadShipped(file);
      const index = indexByLevel.get(config.levelId);

      if (index === undefined) {
        problems.push(`${config.levelId} 在 E 的 MAP_NODES 里没有对应的地图节点`);
        continue;
      }

      const next = MAP_NODES[index + 1];
      const expected = next ? next.nodeId : null;
      const actual = config.rewards.progress[0] ?? null;

      if (actual !== expected) {
        problems.push(
          `${config.levelId} 解锁的是 ${actual ?? '(空)'}，E 地图上下一关那一站是 ${expected ?? '(没有下一关)'}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('第 6 关机械楼能通关', () => {
  /** 桌面上的六块展板（开发卡 4.2） */
  const BOARDS: [string, string][] = [
    ['hs_a_board_comic', 'board_comic'],
    ['hs_a_board_site', 'board_site'],
    ['hs_a_board_route', 'board_route'],
    ['hs_a_board_full', 'board_full'],
    ['hs_a_board_recovery', 'board_recovery'],
    ['hs_a_board_station', 'board_station'],
  ];
  /** 开发卡的答案：上排漫画 / 站点 / 线路，下排总展 / 回收 / 分站（不是时间顺序） */
  const LAYOUT: [string, string][] = [
    ['hs_a_slot_tl', 'board_comic'],
    ['hs_a_slot_tm', 'board_site'],
    ['hs_a_slot_tr', 'board_route'],
    ['hs_a_slot_bl', 'board_full'],
    ['hs_a_slot_bm', 'board_recovery'],
    ['hs_a_slot_br', 'board_station'],
  ];

  function pickUpAll(runtime: LevelRuntime) {
    for (const [nodeId, itemId] of BOARDS) {
      expect(runtime.click(nodeId).ok, `${nodeId} 应该能拾取`).toBe(true);
      expect(runtime.getInventory().some((item) => item.itemId === itemId)).toBe(true);
    }
  }

  it('拾取六块展板、放回 2×3 展墙、拉开墙拿到卡 06 通关', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    pickUpAll(runtime);

    // B 的两个终端都可读，A 的三张背景按「空槽 → 归位 → 打开」切换
    expect(runtime.switchView('B')).toBe(true);
    expect(runtime.click('hs_b_index').ok).toBe(true);
    expect(runtime.click('hs_b_legend').ok).toBe(true);
    expect(runtime.switchView('A')).toBe(true);
    expect(runtime.getCurrentScene()).toBe('wall');

    for (const [nodeId, itemId] of LAYOUT) {
      expect(runtime.useItem(nodeId, itemId).ok, `${nodeId} 应该能放下 ${itemId}`).toBe(true);
    }
    expect(runtime.click('hs_a_wall').ok).toBe(true);
    expect(runtime.getCurrentScene()).toBe('placed');
    expect(runtime.click('hs_a_wall_open').ok).toBe(true);
    expect(runtime.getCurrentScene()).toBe('open');

    expect(runtime.click('hs_a_draft').ok).toBe(true);
    // 没拿残片之前卡 06 不给
    expect(runtime.click('hs_a_card06')).toEqual({ ok: false, reason: 'missing-item', text: '先取出夹层里的线路图残片。' });
    expect(runtime.click('hs_a_fragment_02').ok).toBe(true);
    expect(runtime.click('hs_a_card06').ok).toBe(true);

    expect(runtime.getStatus()).toBe('success');
    expect(runtime.getReview().collectedItems.map((item) => item.itemId)).toEqual(
      expect.arrayContaining(['card_06', 'route_fragment_2', 'curation_draft']),
    );
  });

  it('放上去的展板从背包消失，「已就位」标记是 hidden 的', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    pickUpAll(runtime);
    expect(runtime.useItem('hs_a_slot_tl', 'board_comic').ok).toBe(true);

    const inventory = runtime.getInventory();
    // 展板被消耗，已经不在背包里
    expect(inventory.some((item) => item.itemId === 'board_comic')).toBe(false);
    // 中间标记照样进 inventory（墙要按它判），但背包面板会滤掉 —— 玩家看不见「已就位」
    expect(inventory.filter((item) => item.itemId === 'placed_tl')[0].hidden).toBe(true);
    // 背包里只剩 5 块还没放上去的板
    expect(inventory.filter((item) => !item.hidden).map((item) => item.itemId)).toHaveLength(5);
  });

  it('挑错展板是软拒绝：不消耗、不扣次数、不锁，换对的还能放', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    pickUpAll(runtime);
    const before = runtime.getState().attemptsLeft;

    // 下排左槽按时间顺序摆「分站试摆」是设计稿写的陷阱
    expect(runtime.useItem('hs_a_slot_bl', 'board_station')).toEqual({ ok: false, reason: 'rejected' });
    expect(runtime.getState().attemptsLeft).toBe(before);
    expect(runtime.getState().cooldownLeftSec).toBe(0);

    expect(runtime.useItem('hs_a_slot_bl', 'board_full').ok).toBe(true);
  });

  it('六块板没放齐之前展墙打不开', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    pickUpAll(runtime);
    expect(runtime.useItem('hs_a_slot_tl', 'board_comic').ok).toBe(true);
    expect(runtime.useItem('hs_a_slot_tm', 'board_site').ok).toBe(true);

    expect(runtime.click('hs_a_wall')).toEqual({ ok: false, reason: 'missing-item', text: '先把六块展板放进对应的槽位。' });
    expect(runtime.getStatus()).toBe('playing');
    expect(runtime.getCurrentScene()).toBe('wall');
  });

  it('没拾取的展板不能直接放进槽位', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    expect(runtime.useItem('hs_a_slot_tl', 'board_comic')).toEqual({ ok: false, reason: 'missing-item' });
  });

  it('没到对应场景的热点是点不动的', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    expect(runtime.click('hs_a_fragment_02')).toEqual({ ok: false, reason: 'not-visible' });
    expect(runtime.click('hs_a_wall_open')).toEqual({ ok: false, reason: 'not-visible' });
  });
});

describe('第 7 关八教能通关', () => {
  it('三轮沿轨运行，在机械楼手动切 C，再完成正式十站路线', () => {
    const runtime = new LevelRuntime(loadShipped('level.07.json'), { mode: 'solo' });
    expect(runtime.commandTrain('run')).toBe(true);
    runtime.tick(30);
    expect(runtime.getTrainModel()).toMatchObject({ phase: 'round2a', d: true, b: false });
    runtime.commandTrain('toggleA');
    runtime.commandTrain('run');
    runtime.tick(30);
    expect(runtime.getTrainModel()).toMatchObject({ phase: 'round2b', b: true, c: false, running: false });
    expect(runtime.commandTrain('run')).toBe(false);
    runtime.commandTrain('toggleC');
    expect(runtime.commandTrain('formal')).toBe(false);
    runtime.commandTrain('run');
    runtime.tick(30);
    expect(runtime.getTrainModel()?.canFormal).toBe(true);
    runtime.commandTrain('formal');
    runtime.commandTrain('run');
    runtime.tick(30);
    expect(runtime.getStatus()).toBe('success');
    expect(runtime.getReview().nextLevelId).toBe('L08');
    expect(runtime.getReview().collectedItems.map(item => item.itemId)).toEqual(['card_07', 'route_fragment_3']);
  });
});

describe('第 9 关现图档案',()=>{
  it('两份原稿、四项扫描、五槽证据和双端确认均完成才通关',async()=>{const r=new LevelRuntime(loadShipped('level.09.json'),{mode:'solo'});await playL09(r);expect(r.getReview().unlockedNodeIds).toEqual(['node_main_exhibit']);});
  it('恢复存档保留纸页查看记录，未查看齐不能开始归档',()=>{const config=loadShipped('level.09.json');const r=new LevelRuntime(config,{mode:'solo'});r.click('hs_a_paper_A1');const restored=new LevelRuntime(config,{mode:'solo',restore:r.getSnapshot()});expect(restored.click('hs_a_paper_sort').ok).toBe(false);expect(restored.getInventory().some(i=>i.itemId==='seen_A1')).toBe(true);});
});
describe('第 10 关现图流程', () => {
  it('钥匙必须先选中，点错道具不开门；开门后退包且门保持解锁', () => {
    const config=loadShipped('level.10.json');const r=new LevelRuntime(config,{mode:'solo',restore:{inventory:['basement_key','pliers'],revealed:[],doneHotspots:[],wrongCount:0,stage:'f1',views:{A:'f1',B:'f2_west'}}});
    expect(r.click('hs_a_stairs_b1')).toMatchObject({ok:false,reason:'no-item-selected'});
    expect(r.getCurrentScene()).toBe('f1');
    r.selectItem('pliers');expect(r.click('hs_a_stairs_b1')).toMatchObject({ok:false,reason:'rejected'});
    expect(r.getInventory().some(i=>i.itemId==='basement_key')).toBe(true);
    r.selectItem('basement_key');expect(r.click('hs_a_stairs_b1').ok).toBe(true);
    expect(r.getCurrentScene()).toBe('down');expect(r.getInventory().some(i=>i.itemId==='basement_key')).toBe(false);
    r.goToScene('f1');r.selectItem(null);expect(r.click('hs_a_stairs_reopen').ok).toBe(true);
  });

  it('旧存档开柜后仍使用新主场景，钥匙退包但地下室保持解锁', () => {
    const config=loadShipped('level.10.json');
    const r=new LevelRuntime(config,{mode:'solo',restore:{inventory:['basement_key','power_on','release_ready'],revealed:[],doneHotspots:[],wrongCount:0,stage:'f1',views:{A:'f1',B:'terminal_open'}}});
    expect(r.getCurrentScene()).toBe('released');expect(r.getState().backSceneId).toBeNull();
    expect(r.getInventory().some(i=>i.itemId==='basement_key')).toBe(false);
    expect(r.click('hs_a_stairs_reopen_released').ok).toBe(true);expect(r.getCurrentScene()).toBe('down');
    expect(r.goToScene('f1')).toBe(true);expect(r.getCurrentScene()).toBe('released');
    expect(r.getState().hotspots.map(h=>h.nodeId)).toEqual(expect.arrayContaining(['hs_a_take_card10','hs_a_slot_entry_released']));
  });

  it('领取权限卡后退出电脑仍可重进领取同步指令卡，旧存档也能恢复入口', () => {
    const config=loadShipped('level.10.json');
    const r=new LevelRuntime(config,{mode:'solo',initialView:'B'});r.goToScene('f2_archive');
    expect(r.useCode('hs_b_terminal',['5','1','8','6']).ok).toBe(true);
    r.goToScene('office');
    expect(r.click('hs_b_office_desk_open').ok).toBe(true);expect(r.getCurrentScene()).toBe('terminal_open');
    const snapshot=r.getSnapshot();snapshot.revealed=snapshot.revealed.filter(id=>id!=='hs_b_office_desk_open');
    const restored=new LevelRuntime(config,{mode:'solo',initialView:'B',restore:snapshot});restored.goToScene('office');
    expect(restored.click('hs_b_office_desk_open').ok).toBe(true);
    expect(restored.click('hs_b_notes_entry').ok).toBe(true);
    expect(restored.useChoice('hs_b_sync','参观者逐站体验 → 完成挑战领取漫画卡 → 收齐带回主展区按路线陈列 → 完成拼接读取结语').ok).toBe(true);
    for(const id of ['access_card','light_path_map','sync_card']) expect(restored.getInventory().filter(i=>i.itemId===id)).toHaveLength(1);
  });

  const SYNC = '参观者逐站体验 → 完成挑战领取漫画卡 → 收齐带回主展区按路线陈列 → 完成拼接读取结语';
  function play(duo = false) {
    const config = loadShipped('level.10.json');
    const r = new LevelRuntime(config, { mode: 'solo' });
    const events: any[] = []; r.on('sync:out', e => events.push(e));
    const click = (id: string) => expect(r.click(id).ok, id).toBe(true);
    const go = (id: string) => expect(r.goToScene(id), id).toBe(true);
    const code = (id: string, value: string) => expect(r.useCode(id, value.split('')).ok, id).toBe(true);
    click('hs_a_entrance'); click('hs_a_desk_entry'); code('hs_a_keycabinet', '4628');
    go('f1'); r.selectItem('basement_key'); click('hs_a_stairs_b1'); click('hs_a_power_room'); click('hs_a_b1_control');
    expect(r.click('hs_a_b1_clamp').ok).toBe(false);
    r.switchView('B'); code('hs_b_toolbox', '376'); click('hs_b_note');
    r.switchView('A'); expect(r.useChoice('hs_a_b1_switch', '断开总闸').ok).toBe(true);
    r.selectItem('pliers'); click('hs_a_b1_clamp'); r.selectItem('spare_fuse'); click('hs_a_b1_fuse');
    expect(r.click('hs_a_b1_main').ok).toBe(false);
    expect(r.useChoice('hs_a_b1_wire_tri', '档案系统').ok).toBe(false);
    for (const [id, answer] of [['hs_a_b1_wire_tri', '应急照明'], ['hs_a_b1_wire_sqr', '档案系统'], ['hs_a_b1_wire_cir', '展板系统']]) expect(r.useChoice(id, answer).ok).toBe(true);
    click('hs_a_b1_main'); go('f1'); click('hs_a_projection');
    r.switchView('B'); go('f2_west'); click('hs_b_archive_door'); click('hs_b_office_desk'); code('hs_b_terminal', '5186'); click('hs_b_notes_entry'); expect(r.useChoice('hs_b_sync', SYNC).ok).toBe(true);
    r.switchView('A'); go('down'); r.selectItem('access_card'); click('hs_a_equipment_room'); expect(r.getInventory().some(i=>i.itemId==='access_card')).toBe(false); go('down'); click('hs_a_equipment_reopen'); click('hs_a_b1_vault'); click('hs_a_pick_crank'); r.selectItem('crank'); click('hs_a_b1_crank'); go('f1'); click('hs_a_prism_entry'); expect(r.useItem('hs_a_install_prism', 'prism').ok).toBe(true); expect(r.useChoice('hs_a_prism', '三角标记朝上').ok).toBe(true);
    click('hs_a_slot_entry'); r.selectItem('sync_card'); click('hs_a_sync_slot'); expect(r.click('hs_a_cards_entry').ok).toBe(false);
    r.switchView('B'); click('hs_b_confirm_sync'); r.switchView('A'); click('hs_a_cards_entry');
    expect(r.useItem('hs_a_card_slot_1', 'card_02').ok).toBe(false);
    for (let n = 1; n <= 9; n++) expect(r.useItem(`hs_a_card_slot_${n}`, `card_${String(n).padStart(2, '0')}`).ok).toBe(true);
    click('hs_a_console'); r.switchView('B'); go('terminal_open'); click('hs_b_release');
    r.switchView('A'); expect(r.getCurrentScene()).toBe('released'); click('hs_a_take_card10'); expect(r.getState().backSceneId).toBeNull(); expect(r.getState().hotspots.some(h=>h.nodeId==='hs_a_final_slot')).toBe(true);
    const remaining = r.getInventory().map(item => item.itemId);
    for (const id of ['pliers','spare_fuse','prism','crank','sync_card','access_card','basement_key',...Array.from({length:9},(_,i)=>`card_${String(i+1).padStart(2,'0')}`)]) expect(remaining).not.toContain(id);
    expect(remaining).toEqual(expect.arrayContaining(['maintenance_note','light_path_map']));
    expect(r.getReview().collectedItems.some(item=>item.itemId==='card_10')).toBe(true);
    expect(r.submit({ 最终结语: '知行相伴谜站终有答案' })).toBe(true); expect(r.getInventory().some(i=>i.itemId==='card_10')).toBe(false);
    if (duo) {
      const peer = new LevelRuntime(config, { mode: 'duo', initialView: 'B' });
      for (const e of events) peer.applyRemote(e);
      expect(peer.getStatus()).toBe('success');
    }
    return r;
  }
  it('从刷卡到结语完整通关，电路与同步门槛不能跳过', () => { expect(play().getReview().unlockedNodeIds).toEqual([]); });
  it('本地操作能通过事件重放到双人另一端', () => { play(true); });
});


describe('第九关纸质确认与电脑导航', () => {
  it('恢复任务单仍留在证据板，返回后点击完整印章区域即可盖章', () => {
    const config=loadShipped('level.09.json');
    const r=new LevelRuntime(config,{mode:'solo',restore:{inventory:['placed_0','placed_1','placed_2','placed_3','placed_4'],revealed:[],doneHotspots:[],wrongCount:0,stage:'evidence',views:{A:'evidence',B:'main'}}});
    expect(r.click('hs_a_check').ok).toBe(true);expect(r.getCurrentScene()).toBe('evidence');
    expect(r.getInventory().find(i=>i.itemId==='restored_task')?.name).toBe('完整任务单');
    r.goToScene('main');r.selectItem('restored_task'); expect(r.click('hs_a_stamp').ok).toBe(true);
    expect(r.getInventory().some(i=>i.itemId==='paper_confirmed')).toBe(true);
    expect(r.click('hs_a_stamp_done')).toMatchObject({ok:true,effect:'inspected',text:expect.stringContaining('已盖章')});
  });
  it('侧栏文件查看不切走电脑场景，版本与轨迹可直接切换', () => {
    const config=loadShipped('level.09.json');const r=new LevelRuntime(config,{mode:'solo',initialView:'B'});
    r.click('hs_b_versions');expect(r.click('hs_b_versions_files').ok).toBe(true);expect(r.getCurrentScene()).toBe('versions');
    r.click('hs_b_versions_track');expect(r.getCurrentScene()).toBe('track');
    r.click('hs_b_track_versions');expect(r.getCurrentScene()).toBe('versions');
  });
});

it.each([
  ['hs_a_b1_crank','crank','equipment',['crank']],
  ['hs_a_b1_clamp','pliers','b1',['pliers','power_off']],
  ['hs_a_b1_fuse','spare_fuse','b1',['spare_fuse','burnt_fuse']],
  ['hs_a_sync_slot','sync_card','slot',['sync_card','prism_ok','crank_ok']],
] as const)('第十关 %s 必须选中正确道具才执行', (nodeId,item,scene,required) => {
  const config=loadShipped('level.10.json');
  const r=new LevelRuntime(config,{mode:'solo',restore:{inventory:(required as readonly string[]).concat('maintenance_note'),revealed:['hs_a_b1_fuse'],doneHotspots:[],wrongCount:0,stage:scene,views:{A:scene,B:'f2_west'}}});
  expect(r.click(nodeId)).toMatchObject({ok:false,reason:'no-item-selected'});
  r.selectItem('maintenance_note');expect(r.click(nodeId)).toMatchObject({ok:false,reason:'rejected'});
  expect(r.getInventory().some(i=>i.itemId===item)).toBe(true);
  r.selectItem(item);expect(r.click(nodeId).ok).toBe(true);expect(r.getInventory().some(i=>i.itemId===item)).toBe(false);
});

it('旧版已插入卡10的存档仍能直接提交结语', () => {
  const r=new LevelRuntime(loadShipped('level.10.json'),{mode:'solo',restore:{inventory:['release_ready','card_10_placed'],revealed:[],doneHotspots:['hs_a_take_card10','hs_a_place_final_card'],wrongCount:0,stage:'released',views:{A:'released',B:'terminal_open'}}});
  expect(r.getInventory().some(i=>i.itemId==='card_10')).toBe(true);
  expect(r.getState().hotspots.some(h=>h.nodeId==='hs_a_final_slot')).toBe(true);
  expect(r.submit({最终结语:'知行相伴谜站终有答案'})).toBe(true);
});
