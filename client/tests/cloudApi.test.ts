import { describe, expect, it } from 'vitest';

import {
  CLOUD_CODE,
  CloudApi,
  CloudError,
  type CloudEnvelope,
  type CloudInvoker,
} from '../assets/scripts/common/CloudApi';
import { createWechatCloudInvoker, isCloudAvailable } from '../assets/scripts/common/WechatCloud';

/**
 * 云的这一层**不联网也能测** —— 真正调 wx 的那一步是注入进来的，
 * 这里塞一个假的进去就行。所以这些用例不依赖 E 的 wx.cloud.init，
 * 也不依赖云环境。
 */

/** 造一个假的调用器：记下每次调用，按剧本返回信封 */
function fakeInvoker(script: (action: string, params: Record<string, unknown>) => CloudEnvelope<unknown>) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const invoke: CloudInvoker = async (action, params) => {
    calls.push({ action, params });
    return script(action, params);
  };
  return { invoke, calls };
}

const okInvoker = (data: unknown) => fakeInvoker(() => ({ ok: true, data }));

describe('信封的处理', () => {
  it('ok:true 时返回 data', async () => {
    const api = new CloudApi(okInvoker({ hello: 'world' }).invoke);
    await expect(api.call('any.action')).resolves.toEqual({ hello: 'world' });
  });

  it('ok:false 时抛 CloudError，**code 能拿到** —— 调用方按 code 分支，不按 message', async () => {
    const api = new CloudApi(
      fakeInvoker(() => ({ ok: false, code: CLOUD_CODE.ROOM_FULL, message: '房间已满，每间房最多 2 人' })).invoke,
    );

    await expect(api.call('room.join')).rejects.toThrow(CloudError);
    try {
      await api.call('room.join');
      expect.unreachable('应该抛');
    } catch (err) {
      expect((err as CloudError).code).toBe(CLOUD_CODE.ROOM_FULL);
    }
  });

  it('信封形状不对（比如网关返了别的东西）当成 5000，不是崩掉', async () => {
    const api = new CloudApi(fakeInvoker(() => '这不是信封' as unknown as CloudEnvelope<unknown>).invoke);
    try {
      await api.call('any.action');
      expect.unreachable('应该抛');
    } catch (err) {
      expect((err as CloudError).code).toBe(CLOUD_CODE.INTERNAL);
    }
  });

  it('信封里 ok 不是布尔值也算形状不对', async () => {
    const api = new CloudApi(fakeInvoker(() => ({ data: 1 } as unknown as CloudEnvelope<unknown>)).invoke);
    await expect(api.call('any.action')).rejects.toThrow(/形状/);
  });
});

describe('level.submit —— 答错不是异常', () => {
  it('答错返回 {correct:false}，**不抛** —— 它是正常结果，不是错误', async () => {
    const api = new CloudApi(okInvoker({ correct: false, failed: false, remainAttempts: 2 }).invoke);
    await expect(api.submit({ levelId: 'L05' })).resolves.toEqual({
      correct: false,
      failed: false,
      remainAttempts: 2,
    });
  });

  it('道具没凑齐（4002）才是异常 —— 那道闸在服务端，不消耗容错次数', async () => {
    const api = new CloudApi(
      fakeInvoker(() => ({ ok: false, code: CLOUD_CODE.MISSING_ITEM, message: '缺少必要道具：紫外线灯' })).invoke,
    );
    try {
      await api.submit({ levelId: 'L03', answer: ['9'], inventory: [] });
      expect.unreachable('应该抛');
    } catch (err) {
      expect((err as CloudError).code).toBe(CLOUD_CODE.MISSING_ITEM);
    }
  });

  it('操作通关的关：remainAttempts 是 null（没有容错次数的概念）', async () => {
    const api = new CloudApi(okInvoker({ correct: true, failed: false, remainAttempts: null }).invoke);
    await expect(api.submit({ levelId: 'L01' })).resolves.toEqual({
      correct: true,
      failed: false,
      remainAttempts: null,
    });
  });

  it('通关时带回解锁的地图节点', async () => {
    const api = new CloudApi(
      okInvoker({ correct: true, failed: false, remainAttempts: 2, unlocks: ['node_avenue'] }).invoke,
    );
    const res = await api.submit({ levelId: 'L01', elapsedMs: 61000 });
    expect(res.unlocks).toEqual(['node_avenue']);
  });
});

describe('调用的参数形状（要和 server/API.md 对得上）', () => {
  it('每个方法发的 action 名是对的', async () => {
    const { invoke, calls } = okInvoker({ list: [] });
    const api = new CloudApi(invoke);

    await api.getView({ levelId: 'L01', mode: 'solo' });
    await api.submit({ levelId: 'L01' });
    await api.report('level:finish', 'L01');
    await api.list();

    expect(calls.map((c) => c.action)).toEqual([
      'level.getView',
      'level.submit',
      'event.report',
      'level.list',
    ]);
  });

  it('submit 原样带上 answer / inventory / elapsedMs', async () => {
    const { invoke, calls } = okInvoker({ correct: true, failed: false, remainAttempts: 1 });
    const api = new CloudApi(invoke);

    await api.submit({ levelId: 'L05', answer: { 主食: '轨道饭' }, inventory: ['a'], elapsedMs: 30000 });
    expect(calls[0].params).toEqual({
      levelId: 'L05',
      answer: { 主食: '轨道饭' },
      inventory: ['a'],
      elapsedMs: 30000,
    });
  });

  it('report 带上 type / levelId / extra', async () => {
    const { invoke, calls } = okInvoker({ logged: true });
    const api = new CloudApi(invoke);

    await api.report('level:enter', 'L02', { from: 'map' });
    expect(calls[0].params).toEqual({ type: 'level:enter', levelId: 'L02', extra: { from: 'map' } });
  });
});

describe('getView 的返回形状', () => {
  it('操作通关的关 puzzle 是 null —— 客户端走 completes 热点那条路', async () => {
    const api = new CloudApi(
      okInvoker({ levelId: 'L01', views: { A: { clues: {} }, B: { clues: {} } }, puzzle: null }).invoke,
    );
    const res = await api.getView({ levelId: 'L01', mode: 'solo' });
    expect(res.puzzle).toBeNull();
  });

  it('答题通关的关带回 maxAttempts 和 hasRequiredItems（但**没有 answer**）', async () => {
    const api = new CloudApi(
      okInvoker({
        levelId: 'L05',
        views: { A: { clues: { hs: '线索' } } },
        puzzle: { type: 'item_combine', submitNodeId: 'hs_x', maxAttempts: 5, hasRequiredItems: false },
      }).invoke,
    );
    const res = await api.getView({ levelId: 'L05', mode: 'solo' });
    expect(res.puzzle?.maxAttempts).toBe(5);
    // 关键：返回里绝不能有答案
    expect(JSON.stringify(res)).not.toContain('answer');
  });
});

describe('微信环境探测', () => {
  it('Node 下没有 wx → 不可用，且造不出调用器（调用方据此走离线路径）', () => {
    expect(isCloudAvailable()).toBe(false);
    expect(createWechatCloudInvoker()).toBeNull();
  });

  it('这条守的是「浏览器预览不能崩」—— Cocos 预览里就没有 wx', () => {
    // 探测本身不抛异常，只是返回 false
    expect(() => isCloudAvailable()).not.toThrow();
  });
});
