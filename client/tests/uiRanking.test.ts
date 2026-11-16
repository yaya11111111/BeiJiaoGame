import { describe, expect, it } from 'vitest';
import { completeLevel, createInitialAppState, signinAsGuest } from '../assets/scripts/ui/AppState';
import {
  demoPartners,
  demoRanking,
  defaultRankingLevel,
  normalizePartners,
  normalizeRankingBoard,
  partnerBestTime,
  partnerSummary,
  RANKING_LEVEL_IDS,
} from '../assets/scripts/ui/Ranking';

describe('排行榜与搭档档案（C 契约 v0.1）', () => {
  it('示例榜单保持服务端顺序并带名次', () => {
    const board = demoRanking('L02', 'duo');
    expect(board.list.length).toBeGreaterThan(3);
    expect(board.list[0].rank).toBe(1);
    for (let i = 1; i < board.list.length; i += 1) {
      expect(board.list[i - 1].timeSec).toBeLessThanOrEqual(board.list[i].timeSec);
      expect(board.list[i].rank).toBe(i + 1);
    }
    expect(board.total).toBeGreaterThanOrEqual(board.list.length);
  });

  it('接收 rank.level 时不在客户端重排名', () => {
    const board = normalizeRankingBoard({
      list: [
        { rank: 2, nickname: 'B', timeMs: 100000, score: 900, isMe: true },
        { rank: 1, nickname: 'A', timeMs: 200000, score: 800 },
      ],
      mine: { rank: 2, score: 900, timeMs: 100000, inTop: true },
      total: 12,
      scoreRuleVersion: 2,
    });
    expect(board.list.map((row) => row.nickname)).toEqual(['B', 'A']);
    expect(board.list[0]).toMatchObject({ rank: 2, timeSec: 100, isMe: true });
    expect(board.mine).toMatchObject({ rank: 2, score: 900, timeSec: 100, inTop: true });
    expect(board.total).toBe(12);
    expect(board.scoreRuleVersion).toBe(2);
  });

  it('忽略不合法榜单条目，mine 缺失时为 null', () => {
    expect(normalizeRankingBoard('bad').list).toEqual([]);
    expect(normalizeRankingBoard({ list: [{ nickname: 'A', timeMs: -1 }] }).list).toEqual([]);
    expect(normalizeRankingBoard({ list: [] }).mine).toBeNull();
  });

  it('接收 partner.list 的头像、徽章、最佳记录', () => {
    const partners = normalizePartners({
      list: [
        {
          partnerId: 'p1',
          nickname: '小轨',
          avatarUrl: 'https://a',
          clearedCount: 6,
          clearedLevels: ['L01', 'L02'],
          playCount: 9,
          bestRecords: [{ levelId: 'L01', timeMs: 241000, score: 759 }],
          badges: [{ id: 'first_team', title: '初次并肩', description: '第一次一起通关' }],
          lastPlayedAt: 100,
        },
        { nickname: '' },
      ],
    });
    expect(partners).toHaveLength(1);
    expect(partners[0]).toMatchObject({ partnerId: 'p1', clearedCount: 6, playCount: 9 });
    expect(partners[0].badges[0]).toMatchObject({ id: 'first_team', title: '初次并肩' });
    expect(partnerSummary(partners[0])).toContain('合作 6 关');
    expect(partnerSummary(partners[0])).toContain('初次并肩');
    expect(partnerBestTime(partners[0])).toBe('04:01');
    expect(demoPartners().length).toBeGreaterThan(0);
  });

  it('默认选关优先已通关，其次当前可玩', () => {
    const fresh = signinAsGuest(createInitialAppState(), 'E');
    expect(RANKING_LEVEL_IDS).toContain(defaultRankingLevel(fresh));
    const cleared = completeLevel(fresh, 'GUIDE', 60, ['node_gate_plaza']);
    expect(defaultRankingLevel(cleared)).toBe('L01');
  });
});
