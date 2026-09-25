import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime } from '../assets/scripts/level/LevelRuntime';

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

describe('引导关能通关', () => {
  it('A 看编号、B 看岗位和起点，填表提交', () => {
    const runtime = new LevelRuntime(loadShipped('level.guide.json'), { mode: 'solo' });

    // 两边各看一半
    runtime.click('hs_a_notice');
    runtime.switchView('B');
    runtime.click('hs_b_terminal');

    // 合起来填三个空
    expect(runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门内侧' })).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });
});

describe('第 1 关能通关', () => {
  it('开工具盒 → 移磁扣 → 取券 → 盖章 → 开柜', () => {
    const runtime = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo' });

    // 密码门：流程图给数字、B 的手册给顺序
    runtime.click('hs_a_flowchart');
    expect(runtime.useCode('hs_a_toolbox', ['2', '4', '1']).ok).toBe(true);

    // 红圆章是干扰项，捡了也不影响通关
    runtime.click('hs_a_red_stamp');

    // 磁吸杆反复用：海报和投递口各一次
    expect(runtime.useItem('hs_a_poster', 'suction_rod').ok).toBe(true);
    expect(runtime.useItem('hs_a_slot', 'suction_rod').ok).toBe(true);

    // 合成：空白券 + 蓝方章 → 已盖章的券
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue').ok).toBe(true);

    // 最后一步是操作，不是答题
    expect(runtime.useItem('hs_a_cabinet', 'stamped_ticket').ok).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('红圆章会被拒，但不影响后面的通关', () => {
    const runtime = new LevelRuntime(loadShipped('level.01.json'), { mode: 'solo' });
    runtime.click('hs_a_flowchart');
    runtime.useCode('hs_a_toolbox', ['2', '4', '1']);
    runtime.click('hs_a_red_stamp');
    runtime.useItem('hs_a_slot', 'suction_rod');

    expect(runtime.useItem('hs_a_stamp_device', 'stamp_red')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    // 换蓝章就对了
    expect(runtime.useItem('hs_a_stamp_device', 'stamp_blue').ok).toBe(true);
    expect(runtime.useItem('hs_a_cabinet', 'stamped_ticket').ok).toBe(true);
  });
});

describe('第 2 关能通关', () => {
  /** 走完整条链：A 找三张碎片 → B 归位并拼合 → A 走三个岔路 → 扶指路牌 */
  function playthrough() {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });

    runtime.click('hs_a_roadblock');
    runtime.click('hs_a_frag_sign');
    runtime.click('hs_a_frag_forest');
    runtime.click('hs_a_frag_bench');

    runtime.switchView('B');
    runtime.click('hs_b_map');
    expect(runtime.useItem('hs_b_slot_sign', 'frag_sign').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_forest', 'frag_forest').ok).toBe(true);
    expect(runtime.useItem('hs_b_slot_bench', 'frag_bench').ok).toBe(true);
    // 拼合时挑哪一块都行 —— 之前只认第一块，那是个假选择
    expect(runtime.useItem('hs_b_assemble', 'map_bit_2').ok).toBe(true);

    runtime.switchView('A');
    // 三个岔口靠「揭示下一个」串起来，走错顺序点不到
    expect(runtime.useChoice('hs_a_fork_1', '路灯').ok).toBe(true);
    expect(runtime.useChoice('hs_a_fork_2', '花坛').ok).toBe(true);
    expect(runtime.useChoice('hs_a_fork_3', '长凳').ok).toBe(true);
    expect(runtime.useChoice('hs_a_signpost', '扶起来看看').ok).toBe(true);

    return runtime;
  }

  it('走完就通关，并且带回要解锁的地图节点', () => {
    const runtime = playthrough();
    expect(runtime.getStatus()).toBe('success');
  });

  it('地图没拼好之前，第一个岔口点不动 —— 前置条件真的生效', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    expect(runtime.useChoice('hs_a_fork_1', '路灯')).toEqual({ ok: false, reason: 'missing-item' });
  });

  it('岔口顺序不能跳 —— 第二个岔口在第一个走通前是隐藏的', () => {
    const runtime = new LevelRuntime(loadShipped('level.02.json'), { mode: 'solo' });
    // 先把地图拼出来
    runtime.click('hs_a_frag_sign');
    runtime.click('hs_a_frag_forest');
    runtime.click('hs_a_frag_bench');
    runtime.switchView('B');
    runtime.useItem('hs_b_slot_sign', 'frag_sign');
    runtime.useItem('hs_b_slot_forest', 'frag_forest');
    runtime.useItem('hs_b_slot_bench', 'frag_bench');
    runtime.useItem('hs_b_assemble', 'map_bit_1');
    runtime.switchView('A');

    // 第二个岔口还没露出来
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_a_fork_2');
    expect(runtime.useChoice('hs_a_fork_2', '花坛')).toEqual({ ok: false, reason: 'not-usable' });
  });
});

describe('第 3 关能通关', () => {
  it('认通知 → 开工具柜 → 紫外线拼出末位 → 方位对齐 → 提交', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });

    // B 这边：查版本记录，认出该处理通知 03
    runtime.switchView('B');
    runtime.click('hs_b_records');
    expect(runtime.useChoice('hs_b_notice_choice', '通知 03').ok).toBe(true);

    // 生效通知的日期 10月12日 → MMDD 密码
    expect(runtime.useCode('hs_b_cabinet', ['1', '0', '1', '2']).ok).toBe(true);

    // A 这边：用紫外线灯读末位
    runtime.switchView('A');
    runtime.click('hs_a_notices');
    expect(runtime.useChoice('hs_a_uv_last_digit', '9').ok).toBe(true);

    // 方位对齐：A 的展板位置 + B 的指北箭头
    runtime.switchView('B');
    runtime.click('hs_b_uv_vertical');
    runtime.switchView('A');
    expect(runtime.useChoice('hs_a_uv_place', '西侧').ok).toBe(true);

    // 提交完整安排
    expect(runtime.useChoice('hs_a_terminal', '09:39 · 九教西侧展板区').ok).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('选那两张作废通知的安排会被拒 —— 干扰项真的起了作用', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    runtime.switchView('B');
    runtime.useChoice('hs_b_notice_choice', '通知 03');
    runtime.useCode('hs_b_cabinet', ['1', '0', '1', '2']);
    runtime.switchView('A');
    runtime.useChoice('hs_a_uv_last_digit', '9');
    runtime.useChoice('hs_a_uv_place', '西侧');

    expect(runtime.useChoice('hs_a_terminal', '09:00 · 九教北侧')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.useChoice('hs_a_terminal', '09:39 · 九教西侧展板区').ok).toBe(true);
  });

  it('没有紫外线灯就用不了紫外线那道门', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    // 还没开柜，手里没有灯
    expect(runtime.useChoice('hs_a_uv_last_digit', '9')).toEqual({
      ok: false,
      reason: 'missing-item',
    });
  });

  it('紫外线门在拿到灯之前是灰的 —— 界面上点不动', () => {
    const runtime = new LevelRuntime(loadShipped('level.03.json'), { mode: 'solo' });
    const gate = runtime.getState().hotspots.find((h) => h.nodeId === 'hs_a_uv_last_digit');
    expect(gate?.enabled).toBe(false);
  });
});
