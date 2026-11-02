import { describe, expect, it } from 'vitest';
import {
  countDiscoveredEggs,
  eggTotalForLevel,
  emptyLibrary,
  libraryFromUnknown,
  loadPlayerLibrary,
  mergeCollectedClues,
  mergeEggDiscoveries,
  savePlayerLibrary,
} from '../assets/scripts/ui/PlayerLibrary';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';

describe('cross-level collection (FR-11 / FR-12)', () => {
  it('collects clue items across levels and dedupes them by item id', () => {
    let library = emptyLibrary();
    library = mergeCollectedClues(library, 'L03', [
      { itemId: 'notice_a', name: '通知 A' },
      { itemId: 'notice_b', name: '通知 B' },
    ], 100);
    library = mergeCollectedClues(library, 'L04', [
      { itemId: 'notice_a', name: '通知 A' },
      { itemId: 'page_half', name: '半页线索' },
    ], 200);

    expect(library.clues.map((clue) => clue.itemId)).toEqual(['notice_a', 'notice_b', 'page_half']);
    expect(library.clues[2].levelId).toBe('L04');
  });

  it('skips internal hidden items that never appear in the inventory', () => {
    const library = mergeCollectedClues(emptyLibrary(), 'L02', [
      { itemId: 'frag_1', name: '已归位碎片 1', hidden: true },
      { itemId: 'map', name: '路线图' },
    ], 1);

    expect(library.clues).toHaveLength(1);
    expect(library.clues[0].itemId).toBe('map');
  });

  it('records egg discoveries and the per-level total once the level reports it', () => {
    let library = mergeEggDiscoveries(emptyLibrary(), 'L05', {
      found: 1,
      total: 3,
      titles: ['食堂阿姨的隐藏菜单'],
    }, 10);
    library = mergeEggDiscoveries(library, 'L05', {
      found: 1,
      total: 3,
      titles: ['食堂阿姨的隐藏菜单'],
    }, 20);

    expect(library.eggs).toHaveLength(1);
    expect(eggTotalForLevel(library, 'L05')).toBe(3);
    expect(countDiscoveredEggs(library, 'L05')).toBe(1);
  });

  it('does not create a 0/0 entry for levels without egg config', () => {
    const library = mergeEggDiscoveries(emptyLibrary(), 'L01', { found: 0, total: 0, titles: [] }, 1);

    expect(library.eggs).toHaveLength(0);
    expect(eggTotalForLevel(library, 'L01')).toBe(0);
    expect(library.eggTotals.L01).toBeUndefined();
  });

  it('rejects dirty cached data instead of crashing the page', () => {
    expect(libraryFromUnknown('nope')).toEqual(emptyLibrary());
    expect(libraryFromUnknown({ clues: [{ itemId: 1 }], eggs: 'bad', eggTotals: { L01: -3 } })).toEqual({
      clues: [],
      eggs: [],
      eggTotals: {},
    });
  });

  it('round-trips the library through local storage', () => {
    const store = memoryKeyValueStore();
    const library = mergeCollectedClues(emptyLibrary(), 'GUIDE', [{ itemId: 'ticket', name: '校门纸条' }], 5);

    savePlayerLibrary(store, library);
    expect(loadPlayerLibrary(store)).toEqual(library);
  });
});
