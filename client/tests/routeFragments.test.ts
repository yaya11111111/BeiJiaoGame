import { describe, expect, it } from 'vitest';
import { collectRouteFragment, completeRoutePuzzle, readRouteBook, ROUTE_BOOK_KEY, routePieceFits, mergeRouteBook, routePuzzleSpec } from '../assets/scripts/level/RouteFragments';
import { savePlayerLibrary } from '../assets/scripts/ui/PlayerLibrary';
import type { KeyValueStore } from '../assets/scripts/ui/LocalStore';
const storeOf = (): KeyValueStore => {
  const values = new Map<string, string>();
  return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); }, remove: key => { values.delete(key); } };
};
describe('D 跨关线路收藏', () => {
  it('只记录实际获得的残片，跨实例合并并去重；其他道具不会混入', () => {
    const store = storeOf();
    collectRouteFragment(store, 'board_comic'); expect(readRouteBook(store).fragments).toEqual([]);
    collectRouteFragment(store, 'route_fragment_1'); collectRouteFragment(store, 'route_fragment_2'); collectRouteFragment(store, 'route_fragment_1');
    expect(readRouteBook(store)).toEqual({ fragments: ['route_fragment_1', 'route_fragment_2'], assembled: 0 });
    expect(completeRoutePuzzle(store, 3)).toBe(false);
    expect(completeRoutePuzzle(store, 2)).toBe(true);
    collectRouteFragment(store, 'route_fragment_3'); expect(completeRoutePuzzle(store, 3)).toBe(true);
    expect(readRouteBook(store).assembled).toBe(3);
  });
  it('读取已有图鉴里的残片，缺片不能完成，坏缓存不制造进度', () => {
    const store = storeOf();
    savePlayerLibrary(store, { clues: [{ itemId: 'route_fragment_1', name: '线路图残片①', levelId: 'L04', collectedAt: 1 }], eggs: [], eggTotals: {} });
    expect(readRouteBook(store).fragments).toEqual(['route_fragment_1']);
    expect(completeRoutePuzzle(store, 2)).toBe(false);
    store.write(ROUTE_BOOK_KEY, JSON.stringify({ fragments: [false, 'made-up'], assembled: 3 }));
    expect(readRouteBook(store)).toEqual({ fragments: ['route_fragment_1'], assembled: 0 });
  });
  it('吸附容差随画幅缩放，未对齐或非法位移不完成', () => {
    expect(routePieceFits(10, 10, 600, 400)).toBe(true);
    expect(routePieceFits(20, 20, 1200, 800)).toBe(true);
    expect(routePieceFits(60, 0, 600, 400)).toBe(false);
    expect(routePieceFits(NaN, 0, 600, 400)).toBe(false);
  });
});


it('共享记录合并不丢各自残片，重复、乱序消息不会让完成阶段回退', () => {
  const store=storeOf();collectRouteFragment(store,'route_fragment_3');
  mergeRouteBook(store,{fragments:['route_fragment_1','route_fragment_2'],assembled:2});
  expect(readRouteBook(store)).toEqual({fragments:['route_fragment_1','route_fragment_2','route_fragment_3'],assembled:2});
  expect(completeRoutePuzzle(store,3)).toBe(true);
  mergeRouteBook(store,{fragments:['route_fragment_1'],assembled:0});expect(readRouteBook(store).assembled).toBe(3);
});


it('残片③沿用原图宽高比，与完整图匹配坐标一致',()=>{
  const spec=routePuzzleSpec(3);
  expect(spec.piece.rect[2]/spec.piece.rect[3]).toBeCloseTo(1283/2048,3);
  expect(spec.base.rect[0]).toBe(504);expect(spec.base.rect[1]).toBe(139);
});
