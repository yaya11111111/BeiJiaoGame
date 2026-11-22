import { describe, expect, it, vi } from 'vitest';
import { BundleImageLoader } from '../assets/scripts/common/BundleImageLoader';

describe('关卡美术请求恢复', () => {
  it('并发请求同一图片只执行一次加载，不把不同 key 合并', async () => {
    let release!: (bundle: string) => void;
    const bundle = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const image = vi.fn(async (_bundle: string, key: string) => key);
    const loader = new BundleImageLoader({ bundle, image, delay: async () => {} });
    const first = loader.load('bg/A'), again = loader.load('bg/A'), other = loader.load('details/card');
    expect(first).toBe(again);
    expect(bundle).toHaveBeenCalledTimes(1);
    release('levels');
    expect(await Promise.all([first, again, other])).toEqual(['bg/A', 'bg/A', 'details/card']);
    expect(image).toHaveBeenCalledTimes(2);
  });
  it('Bundle 网络失败会有限退避重试，恢复后继续加载', async () => {
    const bundle = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('levels');
    const delay = vi.fn(async (_ms: number) => {});
    const loader = new BundleImageLoader({ bundle, image: async () => 'frame', delay });
    expect(await loader.load('bg/A')).toBe('frame');
    expect(bundle).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(400);
  });
  it('断网耗尽重试后不缓存失败，恢复网络后同一 key 可以重试', async () => {
    let online = false;
    const delay = vi.fn(async (_ms: number) => {});
    const image = vi.fn(async () => online ? 'frame' : null);
    const loader = new BundleImageLoader({ bundle: async () => 'levels', image, delay });
    expect(await loader.load('bg/A')).toBeNull();
    expect(image).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map(call => call[0])).toEqual([400, 800]);
    online = true;
    expect(await loader.load('bg/A')).toBe('frame');
  });
  it('完成后不在协调器永久持有图，资源缓存与引用计数交回引擎和界面', async () => {
    const image = vi.fn(async () => 'frame');
    const loader = new BundleImageLoader({ bundle: async () => 'levels', image, delay: async () => {} });
    await loader.load('bg/A');
    await loader.load('bg/A');
    expect(image).toHaveBeenCalledTimes(2);
  });
});
