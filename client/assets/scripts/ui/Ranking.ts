/**
 * 普通关卡排行榜与双人搭档档案的数据整理（E 负责页面）。
 *
 * C 的接口尚未落地（计划 11/20 提供），所以这里先把**展示层**做好：
 * - `normalizeRanking` / `normalizePartners` 按约定字段接收 C 的数据；
 * - 接口不可用时退回本地示例数据，并在页面标注“示例数据”，避免空白页；
 * - 排行榜只展示成绩，不设奖励（产品口径）。
 */

import type { AppState } from './AppState';
import { formatTime, getMapNodes } from './AppState';

export type RankingTab = 'levels' | 'partners';

export interface RankingEntry {
  rank: number;
  nickname: string;
  bestTimeSec: number;
  score: number;
  isMe: boolean;
}

export interface PartnerEntry {
  nickname: string;
  avatarUrl?: string;
  /** 一起通关过的关卡数 */
  clearedCount: number;
  /** 合作过的最好用时（秒）；没有就是 0 */
  bestTimeSec: number;
  /** 最近一次一起玩的时间戳 */
  lastPlayedAt: number;
  /** 合作徽章文案，例如“初次并肩” */
  badge: string;
}

export const RANKING_LEVEL_IDS = ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10'];

const DEMO_NAMES = ['小轨', '阿知', '南门风', '林荫路', '明湖鸭', '八教钉子户', '思源楼常客', '西操慢跑者'];

/** 演示用的稳定数据：同一个关卡每次生成一样，方便截图和讲解。 */
export function demoRanking(levelId: string, myNickname: string, myBestSec?: number): RankingEntry[] {
  const index = Math.max(0, RANKING_LEVEL_IDS.indexOf(levelId));
  const base = [82, 96, 110, 128, 145, 163, 188, 214];
  const rows = DEMO_NAMES.map((nickname, i) => ({
    nickname,
    bestTimeSec: base[(i + index) % base.length] + index * 6,
    score: Math.max(0, 1000 - (base[(i + index) % base.length] + index * 6)),
    isMe: false,
  }));
  if (myBestSec && myBestSec > 0) {
    rows.push({ nickname: myNickname || '我', bestTimeSec: Math.floor(myBestSec), score: Math.max(0, 1000 - Math.floor(myBestSec)), isMe: true });
  }
  return withRanks(rows);
}

function withRanks(rows: Array<{ nickname: string; bestTimeSec: number; score: number; isMe: boolean }>): RankingEntry[] {
  return rows
    .slice()
    .sort((a, b) => a.bestTimeSec - b.bestTimeSec)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** 接收 C 的 `ranking.list`：`{ list: [{ nickname, bestTimeMs, score, isMe }] }` */
export function normalizeRanking(raw: unknown): RankingEntry[] {
  const list = extractList(raw);
  const rows = list
    .map((item) => {
      const record = item as Record<string, unknown>;
      const ms = typeof record.bestTimeMs === 'number' ? record.bestTimeMs : 0;
      const sec = typeof record.bestTimeSec === 'number' ? record.bestTimeSec : Math.floor(ms / 1000);
      if (!record || typeof record.nickname !== 'string' || sec <= 0) return null;
      const score = typeof record.score === 'number' ? record.score : Math.max(0, 1000 - sec);
      return {
        nickname: record.nickname,
        bestTimeSec: Math.floor(sec),
        score: Math.floor(score),
        isMe: record.isMe === true,
      };
    })
    .filter((row): row is { nickname: string; bestTimeSec: number; score: number; isMe: boolean } => row !== null);
  return withRanks(rows);
}

/** 接收 C 的 `partner.list`：`{ list: [{ nickname, avatarUrl, clearedCount, bestTimeMs, lastPlayedAt, badge }] }` */
export function normalizePartners(raw: unknown): PartnerEntry[] {
  const list = extractList(raw);
  const partners: PartnerEntry[] = [];
  for (const item of list) {
    const record = item as Record<string, unknown>;
    if (!record || typeof record.nickname !== 'string') continue;
    const ms = typeof record.bestTimeMs === 'number' ? record.bestTimeMs : 0;
    partners.push({
      nickname: record.nickname,
      avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : undefined,
      clearedCount: typeof record.clearedCount === 'number' ? Math.max(0, Math.floor(record.clearedCount)) : 0,
      bestTimeSec: ms > 0 ? Math.floor(ms / 1000) : 0,
      lastPlayedAt: typeof record.lastPlayedAt === 'number' ? record.lastPlayedAt : 0,
      badge: typeof record.badge === 'string' ? record.badge : '',
    });
  }
  return partners.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { list?: unknown[] }).list)) {
    return (raw as { list: unknown[] }).list;
  }
  return [];
}

export function demoPartners(): PartnerEntry[] {
  return [
    { nickname: '小轨', clearedCount: 6, bestTimeSec: 241, lastPlayedAt: Date.now() - 86400000, badge: '并肩六站' },
    { nickname: '阿知', clearedCount: 3, bestTimeSec: 305, lastPlayedAt: Date.now() - 3 * 86400000, badge: '初次并肩' },
    { nickname: '南门风', clearedCount: 1, bestTimeSec: 412, lastPlayedAt: Date.now() - 8 * 86400000, badge: '初见' },
  ];
}

/** 当前账号在各关的最好成绩里，排行榜页默认选中最近可玩的一关 */
export function defaultRankingLevel(state: AppState): string {
  const rows = getMapNodes(state).filter((node) => node.visible !== false && node.levelId !== 'GUIDE');
  const completed = rows.filter((row) => row.state === 'completed').slice(-1)[0];
  const unlocked = rows.filter((row) => row.state === 'unlocked').slice(0, 1)[0];
  return (completed || unlocked || rows[0]).levelId;
}

export function rankLabel(rank: number): string {
  if (rank === 1) return '1';
  if (rank === 2) return '2';
  if (rank === 3) return '3';
  return String(rank);
}

export function partnerSummary(partner: PartnerEntry): string {
  const parts = ['合作通关 ' + partner.clearedCount + ' 关'];
  if (partner.bestTimeSec > 0) parts.push('最佳 ' + formatTime(partner.bestTimeSec));
  if (partner.badge) parts.push(partner.badge);
  return parts.join(' · ');
}
