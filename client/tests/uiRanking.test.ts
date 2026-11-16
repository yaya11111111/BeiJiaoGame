import { describe, expect, it } from 'vitest';
import { completeLevel, createInitialAppState, signinAsGuest } from '../assets/scripts/ui/AppState';
import {
  demoPartners,
  demoRanking,
  defaultRankingLevel,
  normalizePartners,
  normalizeRanking,
  partnerSummary,
  RANKING_LEVEL_IDS,
  rankLabel,
} from '../assets/scripts/ui/Ranking';

describe('排行榜与搭档档案（E 页面首版）', () => {
  it('示例榜单按用时排序并带名次', () => {
    const ranking = demoRanking('L02', '我', 130);
    expect(ranking.length).toBeGreaterThan(3);
    expect(ranking[0].rank).toBe(1);
    for (let i = 1; i < ranking.length; i += 1) {
      expect(ranking[i - 1].bestTimeSec).toBeLessThanOrEqual(ranking[i].bestTimeSec);
      expect(ranking[i].rank).toBe(i + 1);
    }
    expect(ranking.filter((row) => row.isMe)).toHaveLength(1);
  });

  it('同一关卡的示例数据稳定', () => {
    expect(demoRanking('L03', '我', 100)).toEqual(demoRanking('L03', '我', 100));
  });

  it('接收服务端 ranking.list 的毫秒成绩并重新排名', () => {
    const ranking = normalizeRanking({
      list: [
        { nickname: 'A', bestTimeMs: 200000, score: 800 },
        { nickname: 'B', bestTimeMs: 100000, score: 900, isMe: true },
        { nickname: 'C', bestTimeMs: 0, score: 0 },
      ],
    });
    expect(ranking.map((row) => row.nickname)).toEqual(['B', 'A']);
    expect(ranking[0]).toMatchObject({ rank: 1, bestTimeSec: 100, isMe: true });
    expect(rankLabel(1)).toBe('1');
  });

  it('忽略不合法榜单条目', () => {
    expect(normalizeRanking('bad')).toEqual([]);
    expect(normalizeRanking({ list: [{ nickname: 'A', bestTimeMs: -1 }] })).toEqual([]);
  });

  it('搭档档案按最近一起玩排序并整理摘要', () => {
    const partners = normalizePartners({
      list: [
        { nickname: '旧友', clearedCount: 2, bestTimeMs: 300000, lastPlayedAt: 10, badge: '初次并肩' },
        { nickname: '新友', clearedCount: 5, bestTimeMs: 200000, lastPlayedAt: 20, badge: '并肩五站' },
        { bad: true },
      ],
    });
    expect(partners.map((row) => row.nickname)).toEqual(['新友', '旧友']);
    expect(partnerSummary(partners[0])).toContain('合作通关 5 关');
    expect(partnerSummary(partners[0])).toContain('最佳 03:20');
    expect(demoPartners().length).toBeGreaterThan(0);
  });

  it('默认选关优先已通关，其次当前可玩', () => {
    const fresh = signinAsGuest(createInitialAppState(), 'E');
    expect(RANKING_LEVEL_IDS).toContain(defaultRankingLevel(fresh));
    const cleared = completeLevel(fresh, 'GUIDE', 60, ['node_gate_plaza']);
    expect(defaultRankingLevel(cleared)).toBe('L01');
  });
});
