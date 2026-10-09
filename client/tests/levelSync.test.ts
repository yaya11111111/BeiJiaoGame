import { describe, expect, it } from 'vitest';

import { CloudApi, type CloudEnvelope, type CloudInvoker, type RoomEvent } from '../assets/scripts/common/CloudApi';
import { LevelSync, currentRunStartSeq, toSyncEvent } from '../assets/scripts/level/LevelSync';
import type { LevelSyncEvent } from '../assets/scripts/level/LevelRuntime';

/**
 * 双人同步这一层**不联网也能测** —— 云调用是注入进来的。
 * 和 cloudApi.test.ts 同一个套路：塞个假 invoker，记下每次调用、按剧本返回。
 */

function fakeInvoker(script: (action: string, params: Record<string, unknown>) => CloudEnvelope<unknown>) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const invoke: CloudInvoker = async (action, params) => {
    calls.push({ action, params });
    return script(action, params);
  };
  return { invoke, calls };
}

/** 造一条服务端风格的事件 */
function roomEvent(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  senderId = 'op-对面',
): RoomEvent {
  return { seq, type, senderId, ts: 1000 + seq, payload };
}

/** 造一份「房间流水」，publish 时依次分配 seq */
function roomScript(initial: RoomEvent[] = []) {
  const log = [...initial];
  return {
    log,
    script: (action: string, params: Record<string, unknown>): CloudEnvelope<unknown> => {
      if (action === 'event.publish') {
        const seq = log.length === 0 ? 1 : log[log.length - 1].seq + 1;
        log.push(
          roomEvent(seq, params.type as string, params.payload as Record<string, unknown>, 'op-我'),
        );
        return { ok: true, data: { seq, ts: 1000 + seq } };
      }
      if (action === 'event.pull') {
        const since = (params.sinceSeq as number) ?? 0;
        const events = log.filter((e) => e.seq > since);
        return { ok: true, data: { events, lastSeq: events.length ? events[events.length - 1].seq : since } };
      }
      return { ok: false, code: 1, message: `没有这个 action: ${action}` };
    },
  };
}

describe('toSyncEvent：网络上的 payload 先验形状再用', () => {
  it('认得出五种关卡事件', () => {
    expect(toSyncEvent(roomEvent(1, 'pickup', { nodeId: 'n1', itemIds: ['a'] }))).toEqual({
      type: 'pickup',
      nodeId: 'n1',
      itemIds: ['a'],
    });
    expect(toSyncEvent(roomEvent(2, 'use', { nodeId: 'n2', consumed: ['a'], produced: ['b'] }))).toEqual({
      type: 'use',
      nodeId: 'n2',
      consumed: ['a'],
      produced: ['b'],
    });
    expect(toSyncEvent(roomEvent(3, 'reveal', { nodeId: 'n3' }))).toEqual({
      type: 'reveal',
      nodeId: 'n3',
    });
    expect(toSyncEvent(roomEvent(4, 'scene', { viewId: 'B', sceneId: 's2' }))).toEqual({
      type: 'scene',
      viewId: 'B',
      sceneId: 's2',
    });
    expect(toSyncEvent(roomEvent(5, 'result', { status: 'success' }))).toEqual({
      type: 'result',
      status: 'success',
    });
  });

  it('认不出来的 type / 缺字段 / 类型不对 → 一律丢掉，不抛异常', () => {
    expect(toSyncEvent(roomEvent(1, 'chat', { text: '你好' }))).toBe(null);
    expect(toSyncEvent(roomEvent(2, 'start', { levelId: 'L01' }))).toBe(null);
    expect(toSyncEvent(roomEvent(3, 'pickup', { nodeId: 'n1' }))).toBe(null);
    expect(toSyncEvent(roomEvent(4, 'pickup', { nodeId: 42, itemIds: ['a'] }))).toBe(null);
    expect(toSyncEvent(roomEvent(5, 'pickup', { nodeId: 'n1', itemIds: ['a', 7] }))).toBe(null);
    expect(toSyncEvent(roomEvent(6, 'scene', { viewId: 'C', sceneId: 's' }))).toBe(null);
    expect(toSyncEvent(roomEvent(7, 'result', { status: 'failed' }))).toBe(null);
  });
});

describe('currentRunStartSeq：算出「本轮从哪条开始」', () => {
  const L = 'L01';

  it('本轮两个 start → 取较早那个（这样两边算出来一样）', () => {
    const events = [
      roomEvent(10, 'start', { levelId: L }),
      roomEvent(11, 'pickup', { levelId: L, nodeId: 'n1', itemIds: ['a'] }),
      roomEvent(20, 'start', { levelId: L }),
    ];
    expect(currentRunStartSeq(events, L, 20)).toBe(10);
  });

  it('上一轮跑完过（有 result）→ 只从本轮的第一个 start 算起', () => {
    const events = [
      roomEvent(10, 'start', { levelId: L }),
      roomEvent(11, 'pickup', { levelId: L, nodeId: 'n1', itemIds: ['a'] }),
      roomEvent(30, 'result', { levelId: L, status: 'success' }), // ← 上一轮到这儿为止
      roomEvent(60, 'start', { levelId: L }),
      roomEvent(65, 'start', { levelId: L }),
    ];
    expect(currentRunStartSeq(events, L, 65)).toBe(60);
  });

  it('上一轮中途退过（有 close）也一样是边界', () => {
    const events = [
      roomEvent(10, 'start', { levelId: L }),
      roomEvent(20, 'close', { levelId: L }),
      roomEvent(30, 'start', { levelId: L }),
    ];
    expect(currentRunStartSeq(events, L, 30)).toBe(30);
  });

  it('别的关卡的事件不参与 —— 换关了不该被上一关的 start 带偏', () => {
    const events = [
      roomEvent(10, 'start', { levelId: 'GUIDE' }),
      roomEvent(11, 'result', { levelId: 'GUIDE', status: 'success' }),
      roomEvent(20, 'start', { levelId: L }),
    ];
    expect(currentRunStartSeq(events, L, 20)).toBe(20);
  });
});

describe('LevelSync', () => {
  it('begin 之后才拉；send 带上关卡 id', async () => {
    const { log, script } = roomScript();
    const sync = new LevelSync(new CloudApi(fakeInvoker(script).invoke), 'ROOM01', 'L01', () => {});
    await sync.begin();
    expect(log[0].type).toBe('start');

    sync.send({ type: 'pickup', nodeId: 'n1', itemIds: ['a'] });
    expect(log[1].type).toBe('pickup');
    expect(log[1].payload).toEqual({ nodeId: 'n1', itemIds: ['a'], levelId: 'L01' });
  });

  it('begin 之前 tick 不会拉 —— 探测没完就回放会把上一轮的东西当自己的', () => {
    const { script } = roomScript([roomEvent(1, 'result', { levelId: 'L01', status: 'success' })]);
    const { invoke, calls } = fakeInvoker(script);
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', 'L01', () => {});
    sync.tick(5);
    expect(calls.filter((c) => c.action === 'event.pull')).toHaveLength(0);
  });

  it('**回归：上一轮的 result 不会被重放** —— 一进新关就"通关"的那个 bug', async () => {
    // 场景：房间里刚打完 L01（start → 拿道具 → result），现在重新进 L01
    const { script } = roomScript([
      roomEvent(10, 'start', { levelId: 'L01' }),
      roomEvent(11, 'pickup', { levelId: 'L01', nodeId: 'n1', itemIds: ['a'] }),
      roomEvent(30, 'result', { levelId: 'L01', status: 'success' }),
    ]);
    const seen: LevelSyncEvent[] = [];
    const cloud = new CloudApi(fakeInvoker(script).invoke);
    const sync = new LevelSync(cloud, 'ROOM01', 'L01', (event) => seen.push(event));
    await sync.begin();

    // 拉几轮，什么都不该被回放（本轮还没人操作）
    sync.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([]);
  });

  it('换关：上一关的事件不会被当成这一关的', async () => {
    const { script } = roomScript([
      roomEvent(10, 'start', { levelId: 'L01' }),
      roomEvent(11, 'result', { levelId: 'L01', status: 'success' }),
    ]);
    const seen: LevelSyncEvent[] = [];
    const cloud = new CloudApi(fakeInvoker(script).invoke);
    const sync = new LevelSync(cloud, 'ROOM01', 'L02', (event) => seen.push(event));
    await sync.begin();
    sync.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([]);
  });

  it('本轮对面先操作了 → 我进关卡后能补回他做过的事', async () => {
    // 对面在我之前已经进来并拿过道具（他的 start 在我的 start 之前）
    const { script } = roomScript([roomEvent(10, 'start', { levelId: 'L01' })]);
    const cloud = new CloudApi(fakeInvoker(script).invoke);
    // 对面拿道具（seq 11）
    await cloud.publish({ code: 'ROOM01', type: 'pickup', payload: { levelId: 'L01', nodeId: 'n1', itemIds: ['a'] } });

    const seen: LevelSyncEvent[] = [];
    const sync = new LevelSync(cloud, 'ROOM01', 'L01', (event) => seen.push(event));
    await sync.begin(); // 我的 start = seq 12
    sync.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([{ type: 'pickup', nodeId: 'n1', itemIds: ['a'] }]);
  });

  it('每 1 秒才拉一次 —— tick 每帧都在调，不能每帧都发请求', async () => {
    const { script } = roomScript();
    const { invoke, calls } = fakeInvoker(script);
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', 'L01', () => {});
    await sync.begin();
    const before = calls.filter((c) => c.action === 'event.pull').length;

    sync.tick(1 / 60);
    sync.tick(1 / 60);
    expect(calls.filter((c) => c.action === 'event.pull').length).toBe(before);

    sync.tick(1.2);
    expect(calls.filter((c) => c.action === 'event.pull').length).toBe(before + 1);
  });

  it('stop() 广播 close，之后不再发也不再拉', async () => {
    const { log, script } = roomScript();
    const { invoke, calls } = fakeInvoker(script);
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', 'L01', () => {});
    await sync.begin();
    sync.stop();
    expect(log[log.length - 1].type).toBe('close');

    const after = calls.length;
    sync.send({ type: 'result', status: 'success' });
    sync.tick(5);
    expect(calls.length).toBe(after);
  });

  it('探测失败 → 不同步，但也**不把上一轮的东西回放进来**', async () => {
    const warns: string[] = [];
    const { invoke } = fakeInvoker((action) => {
      if (action === 'event.publish') return { ok: true, data: { seq: 5, ts: 1 } };
      throw new Error('断网了');
    });
    const seen: LevelSyncEvent[] = [];
    const sync = new LevelSync(
      new CloudApi(invoke),
      'ROOM01',
      'L01',
      (event) => seen.push(event),
      (message) => warns.push(message),
    );
    await sync.begin();
    sync.tick(5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warns).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});
