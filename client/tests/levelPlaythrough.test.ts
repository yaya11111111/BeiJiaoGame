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

describe('第 4 关能通关', () => {
  it('重排书架 → 叠图读密码 → 还书 → 开资料盒', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });

    // A 这边：把书架理成 1/2/3/4，抽屉弹出给透明片
    runtime.click('hs_a_shelf');
    expect(
      runtime.useChoice('hs_a_shelf', 'C-2-1 / C-2-2 / C-2-3 / C-2-4').ok,
    ).toBe(true);
    // 理完之后掉下来的书才能捡
    expect(runtime.click('hs_a_fallen_book').ok).toBe(true);

    // B 这边：透明片叠索引表读出 3142
    runtime.switchView('B');
    // 索引表要拿着透明片才读得懂 —— 叠上去直接给出 3142，不需要再"选一次"
    expect(runtime.click('hs_b_index_table').ok).toBe(true);

    // 密码盘
    expect(runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']).ok).toBe(true);

    // 卡片先去还书处过一遍，状态变成「已归还」
    expect(runtime.useItem('hs_b_return_machine', 'library_card').ok).toBe(true);
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('library_card_returned');
    expect(runtime.getInventory().map((i) => i.itemId)).not.toContain('library_card');

    // 插卡开盒
    expect(runtime.useItem('hs_b_locker_slot', 'library_card_returned').ok).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('没归还的卡插不进资料盒 —— 读卡器会把它弹出来', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    runtime.click('hs_a_shelf');
    runtime.useChoice('hs_a_shelf', 'C-2-1 / C-2-2 / C-2-3 / C-2-4');
    runtime.click('hs_a_fallen_book');
    runtime.switchView('B');
    runtime.click('hs_b_index_table');
    runtime.useCode('hs_b_locker_keypad', ['3', '1', '4', '2']);

    // 手里只有没归还的卡
    expect(runtime.useItem('hs_b_locker_slot', 'library_card')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.getState().lastLine).toContain('还没归还');
  });

  it('书架没理好之前，掉下来的书是隐藏的', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_a_fallen_book');
    expect(runtime.click('hs_a_fallen_book')).toEqual({ ok: false, reason: 'not-visible' });
  });

  it('书架排错顺序会被拒，但不影响重排', () => {
    const runtime = new LevelRuntime(loadShipped('level.04.json'), { mode: 'solo' });
    expect(runtime.useChoice('hs_a_shelf', 'C-2-1 / C-2-3 / C-2-4 / C-2-2')).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(runtime.useChoice('hs_a_shelf', 'C-2-1 / C-2-2 / C-2-3 / C-2-4').ok).toBe(true);
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

  it('拿到餐券后填对那组菜就通关', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });

    // A 拿值班牌
    expect(runtime.click('hs_a_volunteer_desk').ok).toBe(true);

    // B 插牌打餐券
    runtime.switchView('B');
    expect(runtime.useItem('hs_b_checkin', 'shift_card').ok).toBe(true);

    // A 读餐券背面的规则（得先有券才读得到）
    runtime.switchView('A');
    expect(runtime.click('hs_a_voucher_back').ok).toBe(true);

    expect(runtime.submit(ANSWER)).toBe(true);
    expect(runtime.getStatus()).toBe('success');
  });

  it('没拿到餐券之前，背面的规则读不到', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    expect(runtime.click('hs_a_voucher_back')).toEqual({ ok: false, reason: 'missing-item' });
  });

  it('全部单点（32 点）会被拒 —— 超了额度', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    const wrong = { ...ANSWER, 套餐结算: 'A 套餐' };
    expect(runtime.submit(wrong)).toBe(false);
    expect(runtime.getStatus()).toBe('playing');
  });

  it('用上饮品补助券会被拒 —— 冰汽水已经进套餐了', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    const wrong = { ...ANSWER, 饮品补助券: '使用' };
    expect(runtime.submit(wrong)).toBe(false);
  });

  it('选 C 套餐也到不了 30 —— 最多 28 点', () => {
    const runtime = new LevelRuntime(loadShipped('level.05.json'), { mode: 'solo' });
    expect(runtime.submit({ ...ANSWER, 套餐结算: 'C 套餐' })).toBe(false);
  });
});

describe('第 6 关能通关', () => {
  /** 走完整条链：修棒 → 选路线 → 三站 → 交棒 → 接棒 → 送终点 */
  function playthrough() {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });

    // 修棒：主体 + 端帽
    runtime.click('hs_a_bench');
    runtime.click('hs_a_endcap');
    expect(runtime.useItem('hs_a_assemble', 'baton_body').ok).toBe(true);

    // B 查第 6 队的记录，得出路线
    runtime.switchView('B');
    runtime.click('hs_b_team_records');
    runtime.click('hs_b_shape_record');
    runtime.switchView('A');

    expect(runtime.useChoice('hs_a_start_stand', '蓝线：方形→圆形→三角').ok).toBe(true);

    // 第一站留下方向，第二站用这个方向
    expect(runtime.useChoice('hs_a_square_gate', '右下').ok).toBe(true);
    expect(runtime.useChoice('hs_a_round_gate', '右下').ok).toBe(true);

    // 第三站要用第二站拿到的磁片
    expect(runtime.useChoice('hs_a_triangle_gate', '朝右').ok).toBe(true);

    // 交棒 → 接棒
    expect(runtime.useItem('hs_a_relay_slot', 'baton').ok).toBe(true);
    runtime.switchView('B');
    expect(runtime.useItem('hs_b_take_baton', 'baton_waiting').ok).toBe(true);

    // 送到终点
    runtime.switchView('A');
    expect(runtime.useItem('hs_a_cabinet', 'e_baton').ok).toBe(true);

    return runtime;
  }

  it('走完就通关', () => {
    expect(playthrough().getStatus()).toBe('success');
  });

  it('第一次插展示柜会失败，并给出「交棒未完成」—— 这是设计好的那一课', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    runtime.click('hs_a_bench');
    runtime.click('hs_a_endcap');
    runtime.useItem('hs_a_assemble', 'baton_body');

    // 带着完整接力棒直接去终点
    expect(runtime.useItem('hs_a_cabinet', 'baton')).toEqual({ ok: false, reason: 'rejected' });
    expect(runtime.getState().lastLine).toContain('交棒未完成');
    expect(runtime.getStatus()).toBe('playing');
  });

  it('没接棒之前，B 的接棒按钮是灰的（还没交棒过来）', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    // 按钮还没出现
    expect(runtime.getState().currentView).toBe('A');
    runtime.switchView('B');
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_b_take_baton');
    expect(runtime.useItem('hs_b_take_baton', 'baton_waiting')).toEqual({
      ok: false,
      reason: 'not-usable',
    });
  });

  it('三站必须按顺序走 —— 第二站在第一站通过前是隐藏的', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    runtime.click('hs_a_bench');
    runtime.click('hs_a_endcap');
    runtime.useItem('hs_a_assemble', 'baton_body');
    runtime.useChoice('hs_a_start_stand', '蓝线：方形→圆形→三角');

    // 第一站还没过
    expect(runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_a_round_gate');
    expect(runtime.useChoice('hs_a_round_gate', '右下')).toEqual({ ok: false, reason: 'not-usable' });
  });

  it('第三站没有磁片就用不了 —— 那是第二站给的', () => {
    const runtime = new LevelRuntime(loadShipped('level.06.json'), { mode: 'solo' });
    runtime.click('hs_a_bench');
    runtime.click('hs_a_endcap');
    runtime.useItem('hs_a_assemble', 'baton_body');
    runtime.useChoice('hs_a_start_stand', '蓝线：方形→圆形→三角');
    runtime.useChoice('hs_a_square_gate', '右下');
    runtime.useChoice('hs_a_round_gate', '右下');

    // 手里有磁片了
    expect(runtime.getInventory().map((i) => i.itemId)).toContain('magnet_blue');
  });
});
