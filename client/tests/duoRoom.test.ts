import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CloudApi,
  type CloudEnvelope,
  type CloudInvoker,
  type RoomEvent,
} from '../assets/scripts/common/CloudApi';
import { parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import type { LevelConfig, ViewId } from '../assets/scripts/common/LevelTypes';
import { LevelRuntime } from '../assets/scripts/level/LevelRuntime';
import { LevelSync } from '../assets/scripts/level/LevelSync';

/**
 * **双人房间 ↔ 关卡的衔接**：两个客户端各持一个视角，跑同一关、靠房间事件流水同步。
 *
 * 这一层以前没人测过 —— `levelSync.test.ts` 只测同步器本身（喂事件、断言回放），
 * 而「两个玩家各拿一个视角、一起把关卡打通」要**两个运行时 + 一条共享流水**
 * 才测得出来。真机验收要两个微信号、两台设备（云按 openid 认人），
 * 那部分在这里用内存版房间补上。
 *
 * 为什么用**真实关卡**（`assets/resources/configs/level.02.json`）而不是夹具：
 * 要验的正是「这条路径真的走得通」—— 一片碎片没同步过去，A 就永远进不了左岔路。
 * 夹具只覆盖机制，验不出跨视角的依赖。**关卡改设计了，这里的路径要跟着改。**
 */

const here = dirname(fileURLToPath(import.meta.url));

function loadShipped(file: string): LevelConfig {
  return parseLevelConfig(
    JSON.parse(readFileSync(resolve(here, '../assets/resources/configs', file), 'utf8')),
  );
}

/**
 * 夹具：**只覆盖机制，不跟剧情走**。
 * 真实关卡的文案/触点/答案会随 A/B 的设计一直改，拿它当夹具的话每次设计变更
 * 都会崩一批引擎测试（和 `levelRuntime.test.ts` 同一条理由）。
 * 但「能不能走通」得用真实关卡验 —— 两样各测各的。
 */
function loadFixture(file: string): LevelConfig {
  return parseLevelConfig(JSON.parse(readFileSync(resolve(here, './fixtures', file), 'utf8')));
}

/** 和 LevelSync 里的 PULL_INTERVAL_SEC 一致 —— tick 攒够 1 秒才真去拉一次 */
const PULL_INTERVAL_SEC = 1;

/**
 * 内存版房间服务端。只实现 `event.publish` / `event.pull`，
 * 语义对着 C 的 `server/cloudfunctions/game/src/actions/event.ts` 抄：
 *
 * - 事件**按房间码分桶**（真表里是 `roomId` 字段），换房拉不到别人的东西
 * - seq 由**服务端**按房间统一分配（房间内全序），客户端不能自己编
 * - pull 返回比 sinceSeq 大的全部事件，**包含自己发的那条** ——
 *   服务端不按 senderId 过滤，靠客户端幂等吸收，这正是要一起验的
 */
function roomServer() {
  const logs = new Map<string, RoomEvent[]>();

  const logOf = (code: string): RoomEvent[] => {
    const existing = logs.get(code);
    if (existing) return existing;
    const fresh: RoomEvent[] = [];
    logs.set(code, fresh);
    return fresh;
  };

  const script = (action: string, params: Record<string, unknown>): CloudEnvelope<unknown> => {
    const code = typeof params.code === 'string' ? params.code : '';
    if (action === 'event.publish') {
      const log = logOf(code);
      const seq = log.length + 1;
      log.push({
        seq,
        // 服务端字段：publish 时单独传上来的那个（和 payload 里那份并存）
        levelId: typeof params.levelId === 'string' ? params.levelId : '',
        type: params.type as string,
        senderId: 'op-某个人',
        ts: seq,
        payload: (params.payload ?? {}) as Record<string, unknown>,
      });
      return { ok: true, data: { seq, ts: seq } };
    }
    if (action === 'event.pull') {
      const since = typeof params.sinceSeq === 'number' ? params.sinceSeq : 0;
      const page = logOf(code).filter((event) => event.seq > since);
      return {
        ok: true,
        data: { events: page, lastSeq: page.length > 0 ? page[page.length - 1].seq : since },
      };
    }
    return { ok: false, code: 1, message: `内存房间没实现 ${action}` };
  };

  const invoker: CloudInvoker = async (action, params) => script(action, params);
  return { invoker, logOf };
}

/**
 * 一个双人客户端：运行时 + 同步器。
 *
 * 接线和 `LevelView.mount()` 里那两句**必须一致**（那里是唯一的真实接线）：
 * 运行时发 `sync:out` → 广播；拉回来的事件 → `applyRemote`。
 */
function duoClient(config: LevelConfig, code: string, view: ViewId, invoker: CloudInvoker) {
  const runtime = new LevelRuntime(config, { mode: 'duo', initialView: view });
  const sync = new LevelSync(new CloudApi(invoker), code, config.levelId, (event) =>
    runtime.applyRemote(event),
  );
  runtime.on('sync:out', (event) => sync.send(event));
  return { runtime, sync };
}

/** 等一次异步 pull 落地 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 推进双方的拉取时钟。每轮 1 秒 = 每轮触发一次 pull */
async function pump(syncs: LevelSync[], rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    for (const sync of syncs) sync.tick(PULL_INTERVAL_SEC);
    await flush();
  }
}

/** 背包里的道具 id（升序）。**含 `hidden` 的中间道具** —— getInventory 不过滤，只有背包面板过滤 */
function itemsOf(runtime: LevelRuntime): string[] {
  return runtime
    .getState()
    .inventory.map((item) => item.itemId)
    .slice()
    .sort();
}

describe('双人：视角由服务端指派，客户端切不动', () => {
  const config = loadShipped('level.02.json');

  it('房主是 A、好友是 B，各自锁在自己视角上 —— 两个玩家不会拿到同一个视角', () => {
    const host = new LevelRuntime(config, { mode: 'duo', initialView: 'A' });
    const guest = new LevelRuntime(config, { mode: 'duo', initialView: 'B' });

    expect(host.getCurrentView()).toBe('A');
    expect(guest.getCurrentView()).toBe('B');
    expect(host.getState().canSwitchView).toBe(false);

    // 硬切也不行：切视角那条路在双人模式下整个关着
    expect(host.switchView('B')).toBe(false);
    expect(guest.switchView('A')).toBe(false);
    expect(host.getCurrentView()).toBe('A');
    expect(guest.getCurrentView()).toBe('B');

    // 对面视角的热点连碰都碰不到 —— 信息差就是靠这条成立的
    expect(guest.click('hs_a_frag_1')).toEqual({ ok: false, reason: 'not-visible' });
    expect(host.click('hs_b_slot_sign')).toEqual({ ok: false, reason: 'not-visible' });
  });

  it('单人：同一台设备照常切 A/B，双人那套锁不到它', () => {
    const solo = new LevelRuntime(config, { mode: 'solo' });

    expect(solo.getState().canSwitchView).toBe(true);
    expect(solo.switchView('B')).toBe(true);
    expect(solo.getCurrentView()).toBe('B');
    expect(solo.switchView('A')).toBe(true);
    expect(solo.getCurrentView()).toBe('A');
  });
});

describe('L02 双人协作：跨视角的碎片传递（真实关卡，要能通）', () => {
  /** A 侧：从岔路 1 走进右侧岔路、捡三块碎片、再回岔路 1 */
  function collectFragments(runtime: LevelRuntime): void {
    expect(runtime.click('hs_a_frag_2')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.click('hs_a_roadblock')).toMatchObject({ ok: true, effect: 'scene-changed' });
    expect(runtime.click('hs_a_frag_1')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.click('hs_a_frag_3')).toMatchObject({ ok: true, effect: 'picked' });
    expect(runtime.goToScene('fork1')).toBe(true);
  }

  it('A 捡碎片 → B 归位拼图 → A 才进得了左岔路 → 终点通关，两边同时结算', async () => {
    const { invoker, logOf } = roomServer();
    const config = loadShipped('level.02.json');
    const host = duoClient(config, 'ROOM01', 'A', invoker);
    const guest = duoClient(config, 'ROOM01', 'B', invoker);
    await host.sync.begin();
    await guest.sync.begin();

    // ---- A 侧：三块碎片到手 ----
    collectFragments(host.runtime);
    expect(itemsOf(host.runtime)).toEqual(['frag_1', 'frag_2', 'frag_3']);

    // 这时候还走不进左岔路 —— 路线图在 B 那边，还没拼出来
    expect(host.runtime.click('hs_a_fork1_left')).toMatchObject({
      ok: false,
      reason: 'missing-item',
    });

    // ---- 同步：碎片进 B 的背包（双人共享背包就靠这条）----
    await pump([host.sync, guest.sync]);
    expect(itemsOf(guest.runtime)).toEqual(['frag_1', 'frag_2', 'frag_3']);

    // A 在 A 视角里换场景，不该把 B 拽出自己的视角
    expect(guest.runtime.getCurrentView()).toBe('B');
    expect(guest.runtime.getCurrentScene()).toBe('oldmap');
    expect(host.runtime.getCurrentScene()).toBe('fork1');

    // ---- B 侧：碎片归位 + 拼合 ----
    // 三个缺口是**道具门**（acceptedItems）：按现在的玩法先在左下角背包里选中一件，
    // 再点装置。没选就点只会把 prompt 说出来。
    expect(guest.runtime.click('hs_b_slot_sign')).toMatchObject({ ok: false });
    guest.runtime.selectItem('frag_1');
    expect(guest.runtime.click('hs_b_slot_sign')).toMatchObject({ ok: true, effect: 'used' });
    guest.runtime.selectItem('frag_2');
    expect(guest.runtime.click('hs_b_slot_building')).toMatchObject({ ok: true, effect: 'used' });
    guest.runtime.selectItem('frag_3');
    expect(guest.runtime.click('hs_b_slot_red')).toMatchObject({ ok: true, effect: 'used' });

    // 拼合区只是 requiresItem（没有输入门）= 齐了点一下就成，中间道具 hidden 不进背包面板
    expect(guest.runtime.click('hs_b_assemble')).toMatchObject({ ok: true, effect: 'used' });

    // ---- 同步：拼合结果回到 A，B 的视角换成了新地图 ----
    await pump([host.sync, guest.sync]);
    expect(itemsOf(host.runtime)).toContain('route_map');
    expect(guest.runtime.getCurrentScene()).toBe('newmap');
    expect(host.runtime.getCurrentScene()).toBe('fork1'); // A 自己站着没动

    // ---- A 侧：路线图在手，左岔路终于点得动 ----
    expect(host.runtime.click('hs_a_fork1_left')).toMatchObject({ ok: true });
    expect(host.runtime.click('hs_a_fork1_forward')).toMatchObject({ ok: true });
    expect(host.runtime.click('hs_a_fork2_right')).toMatchObject({ ok: true });
    expect(host.runtime.click('hs_a_fork2_forward')).toMatchObject({ ok: true });
    expect(host.runtime.click('hs_a_fork3_right')).toMatchObject({ ok: true });
    expect(host.runtime.click('hs_a_fork3_forward')).toMatchObject({ ok: true });
    expect(host.runtime.getCurrentScene()).toBe('end');

    // ---- 终点：指路牌是一道**选项门**（先点开面板，再选一个）----
    expect(guest.runtime.getStatus()).toBe('playing');
    expect(host.runtime.click('hs_a_signpost')).toMatchObject({ ok: true, effect: 'use-ready' });
    expect(host.runtime.useChoice('hs_a_signpost', '扶起来看看')).toMatchObject({ ok: true });
    expect(host.runtime.getStatus()).toBe('success');

    await pump([host.sync, guest.sync]);
    expect(guest.runtime.getStatus()).toBe('success');

    // 整条链上确实广播了「拾取 / 使用 / 场景 / 通关结果」四类事件
    const types = logOf('ROOM01').map((event) => event.type);
    expect(types).toContain('start');
    expect(types).toContain('pickup');
    expect(types).toContain('use');
    expect(types).toContain('scene');
    expect(types).toContain('result');
  });

  it('事件只写进自己那个房间，且都标着同一关 —— 换房、换关都不会串台', async () => {
    const { invoker, logOf } = roomServer();
    const config = loadShipped('level.02.json');
    const host = duoClient(config, 'ROOM01', 'A', invoker);
    const guest = duoClient(config, 'ROOM01', 'B', invoker);
    await host.sync.begin();
    await guest.sync.begin();

    collectFragments(host.runtime);
    await pump([host.sync, guest.sync]);

    // 这一关的每条事件都标着自己的 levelId：**payload 里和服务端字段都要有**。
    // payload 那份是客户端回放时按关过滤用的；服务端字段那份是 C 按关过滤/清理用的，
    // 少了它房间里所有事件在 events 表里 levelId 都是空的（2026-10-12 补的）。
    const thisRoom = logOf('ROOM01');
    const withLevel = thisRoom.filter((event) => event.payload?.levelId !== undefined);
    expect(withLevel.length).toBeGreaterThan(0);
    expect(withLevel.every((event) => event.payload.levelId === 'L02')).toBe(true);
    expect(thisRoom.every((event) => event.levelId === 'L02')).toBe(true);

    // 换个房间码 = 另一条流水：新房客拉不到 ROOM01 的事件
    const other = duoClient(config, 'ROOM02', 'B', invoker);
    await other.sync.begin();
    await pump([other.sync]);
    expect(other.runtime.getStatus()).toBe('playing');
    expect(itemsOf(other.runtime)).toEqual([]);
    expect(logOf('ROOM02').map((event) => event.type)).toEqual(['start']);
  });

  it('对面掉线：拉取一直失败也不该拦着一个人把关卡玩完', async () => {
    const config = loadShipped('level.02.json');

    // 一个只让 publish 成功的假房间 —— 拉取永远抛错（断网那种）
    const invoker: CloudInvoker = async (action) => {
      if (action === 'event.publish') return { ok: true, data: { seq: 1, ts: 1 } };
      throw new Error('断网了');
    };
    const runtime = new LevelRuntime(config, { mode: 'duo', initialView: 'A' });
    const sync = new LevelSync(new CloudApi(invoker), 'ROOM01', 'L02', (event) =>
      runtime.applyRemote(event),
    );
    runtime.on('sync:out', (event) => sync.send(event));
    await sync.begin();

    // 拉了几轮全挂，本地照常能操作
    await pump([sync]);
    expect(runtime.click('hs_a_frag_2')).toMatchObject({ ok: true, effect: 'picked' });
    expect(itemsOf(runtime)).toEqual(['frag_2']);
  });
});

describe('引导关双人：一边看线索、一边提交（真实关卡）', () => {
  it('B 提交成功 → result 同步过去，A 那边也进结算', async () => {
    const { invoker, logOf } = roomServer();
    const config = loadShipped('level.guide.json');
    const host = duoClient(config, 'ROOM01', 'A', invoker);
    const guest = duoClient(config, 'ROOM01', 'B', invoker);
    await host.sync.begin();
    await guest.sync.begin();

    // A 只看得见编号那半句，B 手上的登记表要填岗位 / 编号 / 地点
    expect(host.runtime.getCurrentView()).toBe('A');
    expect(host.runtime.click('hs_a_notice')).toMatchObject({ ok: true, effect: 'inspected' });

    // 动手的人只有 B（登记表在 B 的视角里）
    expect(host.runtime.click('hs_b_register')).toEqual({ ok: false, reason: 'not-visible' });
    expect(guest.runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门内侧迎新广场' })).toBe(true);
    expect(guest.runtime.getStatus()).toBe('success');

    await pump([host.sync, guest.sync]);
    expect(host.runtime.getStatus()).toBe('success');
    expect(logOf('ROOM01').some((event) => event.type === 'result')).toBe(true);
  });

  it('答错不跨设备传染 —— 失败不同步（那是自己的容错次数用完）', async () => {
    const { invoker, logOf } = roomServer();
    const config = loadShipped('level.guide.json');
    const host = duoClient(config, 'ROOM01', 'A', invoker);
    const guest = duoClient(config, 'ROOM01', 'B', invoker);
    await host.sync.begin();
    await guest.sync.begin();

    const wrong = { 岗位: '志愿者', 编号: '03', 地点: '明湖餐厅' };
    guest.runtime.submit(wrong);
    guest.runtime.submit(wrong);
    guest.runtime.submit(wrong); // 第 3 次：次数用完，B 判失败
    expect(guest.runtime.getStatus()).toBe('failed');

    await pump([host.sync, guest.sync]);
    expect(host.runtime.getStatus()).toBe('playing');
    expect(logOf('ROOM01').some((event) => event.type === 'result')).toBe(false);
  });
});

describe('夹具关双人：跨视角揭示（A 点信箱 → B 的公告栏才出现）', () => {
  it('reveal 事件同步过去，B 那边才点得到公告栏', async () => {
    const { invoker, logOf } = roomServer();
    const config = loadFixture('level.reveal.json');
    const host = duoClient(config, 'ROOM01', 'A', invoker);
    const guest = duoClient(config, 'ROOM01', 'B', invoker);
    await host.sync.begin();
    await guest.sync.begin();

    // B 这边公告栏是隐藏的，点不动
    expect(guest.runtime.getState().hotspots.map((h) => h.nodeId)).not.toContain('hs_b_board');
    expect(guest.runtime.click('hs_b_board')).toEqual({ ok: false, reason: 'not-visible' });

    // A 点了信箱 → 揭示的是另一视角的公告栏
    expect(host.runtime.click('hs_a_mailbox')).toMatchObject({ ok: true, effect: 'inspected' });
    await pump([host.sync, guest.sync]);
    expect(logOf('ROOM01').some((event) => event.type === 'reveal')).toBe(true);
    expect(guest.runtime.getState().hotspots.map((h) => h.nodeId)).toContain('hs_b_board');

    // A 拿凭证 → 同步到 B → B 交上去，两边通关
    expect(host.runtime.click('hs_a_poster')).toMatchObject({ ok: true, effect: 'picked' });
    await pump([host.sync, guest.sync]);
    expect(itemsOf(guest.runtime)).toEqual(['guide_token']);

    expect(guest.runtime.click('hs_b_slot')).toMatchObject({ ok: true, effect: 'submitted' });
    expect(guest.runtime.getStatus()).toBe('success');

    await pump([host.sync, guest.sync]);
    expect(host.runtime.getStatus()).toBe('success');
  });
});
