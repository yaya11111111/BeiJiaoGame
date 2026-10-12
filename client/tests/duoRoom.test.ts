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
 *
 * `initialElapsedSec` 对应统一开局：`LevelView` 拿 `Date.now() - startedAtMs` 算出来，
 * 所以**加载慢的那台一开始就已经流逝了更多秒**，但两边仍在同一根时间轴上。
 */
function duoClient(
  config: LevelConfig,
  code: string,
  view: ViewId,
  invoker: CloudInvoker,
  initialElapsedSec = 0,
) {
  const runtime = new LevelRuntime(config, { mode: 'duo', initialView: view, initialElapsedSec });
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

// ---- L02 那条通关链，拆成三段给多个用例复用（**关卡改设计了这三段要一起改**）----

/** A 侧：从岔路 1 走进右侧岔路、捡三块碎片、再回岔路 1 */
function collectFragments(runtime: LevelRuntime): void {
  expect(runtime.click('hs_a_frag_2')).toMatchObject({ ok: true, effect: 'picked' });
  expect(runtime.click('hs_a_roadblock')).toMatchObject({ ok: true, effect: 'scene-changed' });
  expect(runtime.click('hs_a_frag_1')).toMatchObject({ ok: true, effect: 'picked' });
  expect(runtime.click('hs_a_frag_3')).toMatchObject({ ok: true, effect: 'picked' });
  expect(runtime.goToScene('fork1')).toBe(true);
}

/** B 侧：三块碎片归位 + 拼出路线图（三个缺口是道具门，要先从背包选中） */
function assembleMap(runtime: LevelRuntime): void {
  // 没选就点只会把 prompt 说出来，不会动手
  expect(runtime.click('hs_b_slot_sign')).toMatchObject({ ok: false });
  runtime.selectItem('frag_1');
  expect(runtime.click('hs_b_slot_sign')).toMatchObject({ ok: true, effect: 'used' });
  runtime.selectItem('frag_2');
  expect(runtime.click('hs_b_slot_building')).toMatchObject({ ok: true, effect: 'used' });
  runtime.selectItem('frag_3');
  expect(runtime.click('hs_b_slot_red')).toMatchObject({ ok: true, effect: 'used' });
  // 拼合区只是 requiresItem（没有输入门）= 齐了点一下就成，中间道具 hidden 不进背包面板
  expect(runtime.click('hs_b_assemble')).toMatchObject({ ok: true, effect: 'used' });
}

/** A 侧：拿着路线图一路走到终点（**不开最后那块指路牌** —— 由调用方决定什么时候通关） */
function walkToEnd(runtime: LevelRuntime): void {
  expect(runtime.click('hs_a_fork1_left')).toMatchObject({ ok: true });
  expect(runtime.click('hs_a_fork1_forward')).toMatchObject({ ok: true });
  expect(runtime.click('hs_a_fork2_right')).toMatchObject({ ok: true });
  expect(runtime.click('hs_a_fork2_forward')).toMatchObject({ ok: true });
  expect(runtime.click('hs_a_fork3_right')).toMatchObject({ ok: true });
  expect(runtime.click('hs_a_fork3_forward')).toMatchObject({ ok: true });
  expect(runtime.getCurrentScene()).toBe('end');
}

/** A 侧：终点指路牌 —— 一道**选项门**（先点开面板，再选一个），选对即通关 */
function finishAtSignpost(runtime: LevelRuntime): void {
  expect(runtime.click('hs_a_signpost')).toMatchObject({ ok: true, effect: 'use-ready' });
  expect(runtime.useChoice('hs_a_signpost', '扶起来看看')).toMatchObject({ ok: true });
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
    assembleMap(guest.runtime);

    // ---- 同步：拼合结果回到 A，B 的视角换成了新地图 ----
    await pump([host.sync, guest.sync]);
    expect(itemsOf(host.runtime)).toContain('route_map');
    expect(guest.runtime.getCurrentScene()).toBe('newmap');
    expect(host.runtime.getCurrentScene()).toBe('fork1'); // A 自己站着没动

    // ---- A 侧：路线图在手，左岔路终于点得动，一路走到终点 ----
    walkToEnd(host.runtime);

    // ---- 终点 ----
    expect(guest.runtime.getStatus()).toBe('playing');
    finishAtSignpost(host.runtime);
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

// ------------------------------------------------------------------ 统一开局
//
// `room.start`（服务端）给一个 `startedAt`，客户端按 `startedAt - serverNow` 换算成本机
// 的等待时间，到点自动进关卡；`LevelView` 再把 `Date.now() - startedAtMs` 当作
// `initialElapsedSec` 交给运行时。下面是这条链**在客户端这一侧**的性质。

/**
 * 按 `room.start` 的契约换算「本机的统一开局时刻」（`AppShellView.applyRoomSnapshot` 那一行）。
 *
 * 两台设备的本机时钟可以差很多，但**同一份快照**算出来的是同一个物理瞬间 ——
 * 因为用的是 `startedAt - serverNow` 这个**差值**，不是绝对时间戳。
 * 这个函数在源码里是内联的（`AppShellView` import 'cc'，测不到），
 * 所以这里把契约单独钉住：改换算方式必须回来改这里。
 */
function localStartAt(startedAt: number, serverNow: number, localNow: number): number {
  return localNow + Math.max(0, startedAt - serverNow);
}

describe('统一开局：startedAt / serverNow → 本机等待时间', () => {
  const STARTED_AT = 1_700_000_000_000;
  /** 房主按下「开始游戏」那一刻的服务端时间；START_DELAY_MS = 3000 */
  const SERVER_NOW = STARTED_AT - 3000;

  it('本机时钟差多少都不影响 —— 换算出来的是同一个物理瞬间', () => {
    // 设备 A 的钟快 5 分钟，设备 B 的钟慢 90 秒
    const localNowA = SERVER_NOW + 5 * 60 * 1000;
    const localNowB = SERVER_NOW - 90 * 1000;

    const startA = localStartAt(STARTED_AT, SERVER_NOW, localNowA);
    const startB = localStartAt(STARTED_AT, SERVER_NOW, localNowB);

    // 各自「距离开局还有多久」相等 —— 这才是两侧同时进关卡的原因
    expect(startA - localNowA).toBe(3000);
    expect(startB - localNowB).toBe(3000);
  });

  it('startedAt 已经过去（重复点开始 / 轮询晚了）→ 等待时间归零，立刻进关卡', () => {
    const late = STARTED_AT + 5000;
    expect(localStartAt(STARTED_AT, late, late)).toBe(late);
  });
});

describe('统一计时与结算同步（延迟加载 / 轮询延迟都不影响结算用时）', () => {
  type Client = ReturnType<typeof duoClient>;

  /**
   * 一关一轮的双人验证：`winner` 决定谁动手通关，`loadSec` 是两端各自的加载耗时
   * （**慢的那台一开始就已经流逝了更多秒**，但两边仍在同一根时间轴上）。
   */
  async function verifySharedClock(
    file: string,
    winner: 'host' | 'guest',
    loadSec: { host: number; guest: number },
    clear: (host: Client, guest: Client) => void | Promise<void>,
  ): Promise<void> {
    const { invoker, logOf } = roomServer();
    const config = loadShipped(file);
    const host = duoClient(config, 'ROOM01', 'A', invoker, loadSec.host);
    const guest = duoClient(config, 'ROOM01', 'B', invoker, loadSec.guest);
    await host.sync.begin();
    await guest.sync.begin();

    // ---- 1. 延迟加载：B 比 A 晚 `delay` 秒才加载完 ----
    // 从统一开局时刻算起，两边各自的已流逝时间 = 「开局时的初始秒数」+「之后各自 tick 的秒数」。
    // B 晚加载多少，就对应少 tick 多少 —— 两个数加起来才会落到同一堵墙的同一刻上。
    const delay = loadSec.guest - loadSec.host;
    const spanSec = 4;
    host.runtime.tick(spanSec);
    guest.runtime.tick(spanSec - delay);

    const hostElapsed = host.runtime.getReview().elapsedSec;
    expect(hostElapsed).toBeCloseTo(loadSec.host + spanSec);
    // **这就是「计时仍以同一个 startedAt 为起点」**：加载慢两秒不会让 B 的用时少两秒
    expect(guest.runtime.getReview().elapsedSec).toBeCloseTo(hostElapsed);

    // 限时关卡：同一瞬间剩下的时间也一致（L01 有 300 秒限制；不限时的关两边都是 null）
    const hostLeft = host.runtime.getState().timeLeftSec;
    const guestLeft = guest.runtime.getState().timeLeftSec;
    expect(guestLeft === null).toBe(hostLeft === null);
    if (hostLeft !== null && guestLeft !== null) expect(guestLeft).toBeCloseTo(hostLeft);

    // ---- 2. 一方通关 ----
    await clear(host, guest);
    const actor = winner === 'host' ? host.runtime : guest.runtime;
    expect(actor.getStatus()).toBe('success');
    const atWin = actor.getReview().elapsedSec;

    // ---- 3. 网络/轮询有延迟：对面又走了 0.6 秒才知道 ----
    const receiver = winner === 'host' ? guest.runtime : host.runtime;
    receiver.tick(0.6);
    expect(receiver.getStatus()).toBe('playing');
    // 它自己的本地计时确实已经跑过了 —— 不取事件里的 elapsedSec 就会结算成这个数
    expect(receiver.getReview().elapsedSec).toBeCloseTo(atWin + 0.6);

    // ---- 4. 收到 result：用**事件里的**用时进结算 ----
    await pump([host.sync, guest.sync]);
    expect(receiver.getStatus()).toBe('success');
    expect(host.runtime.getReview().elapsedSec).toBeCloseTo(atWin);
    expect(guest.runtime.getReview().elapsedSec).toBeCloseTo(atWin);

    // result 事件里带着 elapsedSec（服务端和两端看到的是同一个数）
    const result = logOf('ROOM01').filter((event) => event.type === 'result');
    expect(result).toHaveLength(1);
    expect(result[0].payload.elapsedSec).toBeCloseTo(atWin);
  }

  it('GUIDE：B 交表通关（登记表在 B 视角），A 结算时间与 B 完全一致', async () => {
    await verifySharedClock('level.guide.json', 'guest', { host: 0.4, guest: 1.4 }, (_host, guest) => {
      expect(guest.runtime.submit({ 岗位: '接线员', 编号: '07', 地点: '南门内侧迎新广场' })).toBe(true);
    });
  });

  it('L01：A 走完装置链通关（B 只能看手册），B 结算时间与 A 完全一致', async () => {
    await verifySharedClock('level.01.json', 'host', { host: 0.3, guest: 2.3 }, (host) => {
      // 密码门 → 磁吸杆勾券 → 盖章 → 开柜。装置门都是 acceptedItems，
      // 所以走的是「先在背包里选中、再点装置」那条真实交互路径
      expect(host.runtime.click('hs_a_toolbox')).toMatchObject({ ok: true, effect: 'use-ready' });
      expect(host.runtime.useCode('hs_a_toolbox', ['2', '4', '1'])).toMatchObject({ ok: true });
      host.runtime.selectItem('suction_rod');
      expect(host.runtime.click('hs_a_slot')).toMatchObject({ ok: true, effect: 'used' });
      host.runtime.selectItem('stamp_blue');
      expect(host.runtime.click('hs_a_stamp_device')).toMatchObject({ ok: true, effect: 'used' });
      host.runtime.selectItem('stamped_ticket');
      expect(host.runtime.click('hs_a_cabinet')).toMatchObject({ ok: true, effect: 'used' });
    });
  });

  it('L02：A 走完多场景链通关（碎片要过 B 的手），B 结算时间与 A 完全一致', async () => {
    await verifySharedClock('level.02.json', 'host', { host: 0.5, guest: 1.2 }, async (host, guest) => {
      // 碎片是 A 捡的、地图是 B 拼的 —— 「延迟加载」和「跨视角传递」在这条链上叠在一起。
      // 两次 pump 就是中间那条缝：碎片先过去，route_map 再回来，A 才走得动。
      collectFragments(host.runtime);
      await pump([host.sync, guest.sync]);
      assembleMap(guest.runtime);
      await pump([host.sync, guest.sync]);
      walkToEnd(host.runtime);
      expect(guest.runtime.getCurrentScene()).toBe('newmap');
      finishAtSignpost(host.runtime);
    });
  });

  it('同一房间开第二轮：上一轮的 result 不会被重放（一进关就"通关"那个坑）', async () => {
    const { invoker, logOf } = roomServer();
    const config = loadShipped('level.02.json');
    const cloud = new CloudApi(invoker);

    // 上一轮在房间流水里留下的痕迹：进关 → A 通关 → 双方退出
    const round1 = { levelId: 'L02' };
    await cloud.publish({ code: 'ROOM01', type: 'start', ...round1, payload: round1 });
    await cloud.publish({
      code: 'ROOM01',
      type: 'result',
      ...round1,
      payload: { ...round1, status: 'success', elapsedSec: 12 },
    });
    await cloud.publish({ code: 'ROOM01', type: 'close', ...round1, payload: round1 });
    // 顺带放一条上一关的，换关时也不能被带偏
    await cloud.publish({ code: 'ROOM01', type: 'start', levelId: 'L01', payload: { levelId: 'L01' } });

    // 第二轮：房主重新 room.start，两端重进（各自广播新的 start）
    const host = duoClient(config, 'ROOM01', 'A', invoker);
    const guest = duoClient(config, 'ROOM01', 'B', invoker);
    await host.sync.begin();
    await guest.sync.begin();
    await pump([host.sync, guest.sync]);

    // 两边都还好端端在玩 —— 上一轮的 result 没被当成本轮的
    expect(host.runtime.getStatus()).toBe('playing');
    expect(guest.runtime.getStatus()).toBe('playing');
    expect(itemsOf(guest.runtime)).toEqual([]);
    expect(logOf('ROOM01').filter((event) => event.type === 'result')).toHaveLength(1);
  });

  it('双人用时不从 0 起算，单人从 0 起算 —— startedAt 只影响双人', () => {
    const config = loadShipped('level.01.json');

    const duo = new LevelRuntime(config, { mode: 'duo', initialView: 'A', initialElapsedSec: 3.5 });
    expect(duo.getReview().elapsedSec).toBe(3.5);

    // 单人：LevelView 传的 startedAtMs 是 0 → initialElapsedSec 0
    const solo = new LevelRuntime(config, { mode: 'solo', initialElapsedSec: 0 });
    expect(solo.getReview().elapsedSec).toBe(0);
    expect(solo.getState().canSwitchView).toBe(true);
  });
});
