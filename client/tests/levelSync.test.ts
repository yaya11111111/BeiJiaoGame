import { describe, expect, it } from 'vitest';

import { CloudApi, type CloudEnvelope, type CloudInvoker, type RoomEvent } from '../assets/scripts/common/CloudApi';
import { LevelSync, toSyncEvent } from '../assets/scripts/level/LevelSync';
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
function roomEvent(seq: number, type: string, payload: Record<string, unknown>): RoomEvent {
  return { seq, type, senderId: 'openid-对面', ts: 1000 + seq, payload };
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
    // 对面可能是新版本、带了本地还不认识的事件 —— 那种情况该安静跳过，不是把一局搞崩
    expect(toSyncEvent(roomEvent(1, 'chat', { text: '你好' }))).toBe(null);
    expect(toSyncEvent(roomEvent(2, 'pickup', { nodeId: 'n1' }))).toBe(null);
    expect(toSyncEvent(roomEvent(3, 'pickup', { nodeId: 42, itemIds: ['a'] }))).toBe(null);
    expect(toSyncEvent(roomEvent(4, 'pickup', { nodeId: 'n1', itemIds: ['a', 7] }))).toBe(null);
    expect(toSyncEvent(roomEvent(5, 'scene', { viewId: 'C', sceneId: 's' }))).toBe(null);
    expect(toSyncEvent(roomEvent(6, 'result', { status: 'failed' }))).toBe(null);
  });
});

describe('LevelSync', () => {
  it('send 调 event.publish，带上房间码、类型和 payload', () => {
    const { invoke, calls } = fakeInvoker(() => ({ ok: true, data: { seq: 3, ts: 1 } }));
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', () => {});
    sync.send({ type: 'pickup', nodeId: 'n1', itemIds: ['a'] });

    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('event.publish');
    expect(calls[0].params).toEqual({
      code: 'ROOM01',
      type: 'pickup',
      payload: { nodeId: 'n1', itemIds: ['a'] },
    });
  });

  it('广播失败只走 onWarn，**不抛**给人 —— 离线也要能一个人把关卡玩完', async () => {
    const warns: string[] = [];
    const { invoke } = fakeInvoker(() => {
      throw new Error('断网了');
    });
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', () => {}, (message) => warns.push(message));
    // send 是立即返回的（内部 catch），这里不 await 也不该抛
    sync.send({ type: 'result', status: 'success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warns).toHaveLength(1);
  });

  it('每 1 秒才拉一次 —— tick 每帧都在调，不能每帧都发请求', () => {
    const { invoke, calls } = fakeInvoker(() => ({ ok: true, data: { events: [], lastSeq: 0 } }));
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', () => {});

    sync.tick(1 / 60);
    sync.tick(1 / 60);
    expect(calls).toHaveLength(0);

    sync.tick(1.2);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('event.pull');
    expect(calls[0].params).toEqual({ code: 'ROOM01', sinceSeq: 0 });
  });

  it('按 seq 升序回放，并把 sinceSeq 推到最大那条', async () => {
    const seen: LevelSyncEvent[] = [];
    const seqs: number[] = [];
    const { invoke } = fakeInvoker((action, params) => {
      seqs.push(params.sinceSeq as number);
      return {
        ok: true,
        data: {
          // 服务端保证按 seq 升序给
          events: [
            roomEvent(5, 'pickup', { nodeId: 'n1', itemIds: ['a'] }),
            roomEvent(6, 'use', { nodeId: 'n2', consumed: ['a'], produced: ['b'] }),
          ],
          lastSeq: 6,
        },
      };
    });
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', (event) => seen.push(event));

    sync.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.map((e) => e.type)).toEqual(['pickup', 'use']);

    // 第二次只拉 6 之后的
    sync.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seqs).toEqual([0, 6]);
  });

  it('stop() 之后不再发也不再拉', () => {
    const { invoke, calls } = fakeInvoker(() => ({ ok: true, data: { events: [], lastSeq: 0 } }));
    const sync = new LevelSync(new CloudApi(invoke), 'ROOM01', () => {});
    sync.stop();
    sync.send({ type: 'result', status: 'success' });
    sync.tick(5);
    expect(calls).toHaveLength(0);
  });
});
