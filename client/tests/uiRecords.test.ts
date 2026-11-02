import { describe, expect, it } from 'vitest';
import { completeLevel, createInitialAppState, signinAsGuest } from '../assets/scripts/ui/AppState';
import { buildLevelRecordRows, buildRecordsSummary, formatTotalTime } from '../assets/scripts/ui/Records';
import { mergeCollectedClues, mergeEggDiscoveries } from '../assets/scripts/ui/PlayerLibrary';

describe('personal records page data (US08)', () => {
  it('summarises cleared levels, best times and the fastest level', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');
    state = completeLevel(state, 'GUIDE', 286, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 120, ['node_road']);

    const summary = buildRecordsSummary(state);
    expect(summary.total).toBe(11);
    expect(summary.cleared).toBe(2);
    expect(summary.unlocked).toBeGreaterThanOrEqual(2);
    expect(summary.totalBestSec).toBe(406);
    expect(summary.averageBestSec).toBe(203);
    expect(summary.bestSec).toBe(120);
    expect(summary.bestLevelTitle).toBe('第 1 关 · 南门小树林');
    expect(summary.clueCount).toBe(0);
    expect(summary.eggCount).toBe(0);
    expect(summary.cloud).toBeNull();
  });

  it('fills the table with every visible map node and the local best time', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');
    state = completeLevel(state, 'GUIDE', 61, ['node_gate_plaza']);
    const rows = buildLevelRecordRows(state);

    expect(rows).toHaveLength(11);
    expect(rows[0]).toMatchObject({
      levelId: 'GUIDE',
      state: 'completed',
      bestSec: 61,
      bestText: '01:01',
    });
    expect(rows[1]).toMatchObject({ levelId: 'L01', state: 'unlocked', bestText: '--:--' });
  });

  it('counts cross-level clues and eggs in the summary', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');
    state = {
      ...state,
      library: mergeEggDiscoveries(
        mergeCollectedClues(state.library, 'L03', [{ itemId: 'notice_a', name: '通知 A' }], 1),
        'L03',
        { found: 1, total: 2, titles: ['阅报栏里的旧车票'] },
        2,
      ),
    };

    const summary = buildRecordsSummary(state);
    expect(summary.clueCount).toBe(1);
    expect(summary.eggCount).toBe(1);
  });

  it('shows the server profile stats when they are available', () => {
    const state = {
      ...signinAsGuest(createInitialAppState(), 'E 成员'),
      stats: { clearedCount: 4, totalTimeMs: 900000 },
    };

    expect(buildRecordsSummary(state).cloud).toEqual({ clearedCount: 4, totalTimeMs: 900000 });
  });

  it('formats long play time for the summary card', () => {
    expect(formatTotalTime(0)).toBe('0 分 0 秒');
    expect(formatTotalTime(406)).toBe('6 分 46 秒');
    expect(formatTotalTime(3725)).toBe('1 小时 2 分');
  });
});
