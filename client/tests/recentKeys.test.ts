import { describe, expect, it } from 'vitest';

import { touchRecent } from '../assets/scripts/common/RecentKeys';

/**
 * 背景图的缓存淘汰规则（`LevelView` 用它把用过很久的背景放掉，省内存）。
 *
 * 这条规则**搞错的两种后果都不轻**：
 * - 淘汰掉了当前正在显示的那张 → 花屏
 * - 该放的不放 → 内存下不来，真机上「运行内存不够」被杀
 *
 * 而调用它的 `LevelView` import 'cc'、单测碰不到，所以规则本身抽到
 * `common/RecentKeys.ts` 这里测。
 */
describe('touchRecent：最近用过的 key 顺序表', () => {
  it('把 key 放到末尾（= 最近用过）', () => {
    expect(touchRecent(['a', 'b'], 'c', 3)).toEqual({ order: ['a', 'b', 'c'], evicted: [] });
  });

  it('已经在表里的 key 先摘掉再放末尾 —— 不会重复占位', () => {
    expect(touchRecent(['a', 'b', 'c'], 'a', 3)).toEqual({ order: ['b', 'c', 'a'], evicted: [] });
  });

  it('超出上限时从**最老的**开始淘汰', () => {
    expect(touchRecent(['a', 'b', 'c'], 'd', 3)).toEqual({ order: ['b', 'c', 'd'], evicted: ['a'] });
  });

  it('一次淘汰多张时，evicted 按「最老在前」返回', () => {
    expect(touchRecent(['a', 'b', 'c', 'd'], 'e', 2)).toEqual({
      order: ['d', 'e'],
      evicted: ['a', 'b', 'c'],
    });
  });

  it('**末尾那张（当前正在用的）永远不会被淘汰** —— limit 给 0 也兜底成 1', () => {
    // 这条是最要紧的：淘汰掉当前这张就是必然花屏
    for (const limit of [0, 1, -3]) {
      const { order, evicted } = touchRecent(['a', 'b'], 'c', limit);
      expect(order).toEqual(['c']); // 只留下当前这张
      expect(evicted).toEqual(['a', 'b']);
    }
  });

  it('空表起步也对', () => {
    expect(touchRecent([], 'a', 3)).toEqual({ order: ['a'], evicted: [] });
  });

  it('**keep 里的（精灵正在显示的）不会被动** —— 哪怕它是最老的那张', () => {
    // 换画面是异步的：新图还在解码时精灵显示的还是上一张。
    // 放掉它 = 精灵引用一张不存在的纹理 = 崩。
    const { order, evicted } = touchRecent(['showing', 'b', 'c'], 'd', 3, ['showing']);
    // 淘汰的是别人（b），正在显示的那张留在表里
    expect(evicted).toEqual(['b']);
    expect(order).toEqual(['showing', 'c', 'd']);
    expect(order).toContain('showing');
  });

  it('全都被钉住、腾不出位置时 → 宁可超上限，也不放掉正在显示的', () => {
    // 上限 1 意味着「只留当前这张」，但它正显示着另一张 —— 那就两张都留着
    const { order, evicted } = touchRecent(['showing'], 'next', 1, ['showing']);
    expect(evicted).toEqual([]);
    expect(order).toEqual(['showing', 'next']);
  });

  it('真实场景：第 2 关 A 视角连走 4 个画面，只丢最老的那张', () => {
    let order: string[] = [];
    const used = ['L02_A_1', 'L02_A_1_left', 'L02_A_1', 'L02_A_2', 'L02_A_2_right'];
    const evictedAll: string[] = [];
    for (const key of used) {
      const r = touchRecent(order, key, 3);
      order = r.order;
      evictedAll.push(...r.evicted);
    }
    // 「走进去再退回来」的 L02_A_1 仍在（最近用过），只有最老的那张被淘汰
    expect(order).toEqual(['L02_A_1', 'L02_A_2', 'L02_A_2_right']);
    expect(evictedAll).toEqual(['L02_A_1_left']);
  });
});
