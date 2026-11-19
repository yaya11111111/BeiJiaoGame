/**
 * 排行榜与双人搭档档案的数据整理（E 负责页面）。
 *
 * 字段按 C 的《排行榜 & 双人搭档档案接口契约草案 v0.1》：
 * - `rank.level` 返回 `{ list, mine, total, scoreRuleVersion }`，**服务端已排好序、算好分**；
 *   E 不重新排序、不重算名次，只做展示与字段兜底。
 * - `partner.list` 返回搭档快照，`badges` 是 `{ id, title, description }[]`。
 * 接口未部署时退回本地示例数据，并在页面上标注“示例数据”。
 */

import { LEVEL_ORDER } from '../common/LevelConfig';
import type { AppState } from './AppState';
import { formatTime, getMapNodes } from './AppState';

export type RankingTab = 'solo' | 'duo';
export type RankingMode = 'solo' | 'duo';

export interface RankingEntry {
  rank: number;
  nickname: string;
  avatarUrl?: string;
  /** 双人榜：队友昵称；服务端未返回时为空 */
  partnerNickname?: string;
  score: number;
  timeSec: number;
  isMe: boolean;
}

export interface RankingMine {
  rank: number;
  score: number;
  timeSec: number;
  inTop: boolean;
}

export interface RankingBoard {
  list: RankingEntry[];
  mine: RankingMine | null;
  total: number;
  scoreRuleVersion: number;
}

export interface PartnerBadge {
  id: string;
  title: string;
  description: string;
}

export interface PartnerBestRecord {
  levelId: string;
  timeSec: number;
  score: number;
}

export interface PartnerEntry {
  partnerId: string;
  nickname: string;
  avatarUrl?: string;
  clearedCount: number;
  clearedLevels: string[];
  playCount: number;
  bestRecords: PartnerBestRecord[];
  badges: PartnerBadge[];
  lastPlayedAt: number;
  /** C 暂时没有在线态；有就显示，没有就不显示 */
  online?: boolean;
}

export const RANKING_LEVEL_IDS = ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10'];

const DEMO_NAMES = ['小轨', '阿知', '南门风', '林荫路', '明湖鸭', '八教钉子户', '思源楼常客', '西操慢跑者'];

/** 演示用的稳定数据：同一关/模式每次生成一样，方便截图和讲解。 */
export function demoRanking(levelId: string, mode: RankingMode = 'solo'): RankingBoard {
  const index = Math.max(0, RANKING_LEVEL_IDS.indexOf(levelId));
  const base = [152, 168, 183, 205, 226, 244, 268, 295];
  const list: RankingEntry[] = DEMO_NAMES.map((nickname, i) => {
    const timeSec = base[(i + index) % base.length] + index * 7 + (mode === 'duo' ? 22 : 0);
    return {
      rank: 0,
      nickname,
      partnerNickname: mode === 'duo' ? DEMO_NAMES[(i + 1) % DEMO_NAMES.length] : undefined,
      score: Math.max(0, 1000 - timeSec),
      timeSec,
      isMe: false,
    };
  });
  list.sort((a, b) => a.timeSec - b.timeSec).forEach((entry, i) => { entry.rank = i + 1; });
  return { list, mine: null, total: list.length + 21, scoreRuleVersion: 1 };
}

/** 接收 C 的 `rank.level` 返回；保持服务端顺序和名次，不重排。 */
export function normalizeRankingBoard(raw: unknown): RankingBoard {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawList = Array.isArray(source.list) ? source.list : [];
  const list: RankingEntry[] = [];
  for (const item of rawList) {
    const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const rank = typeof record.rank === 'number' ? Math.floor(record.rank) : 0;
    const nickname = typeof record.nickname === 'string' ? record.nickname : '';
    const timeMs = typeof record.timeMs === 'number' ? record.timeMs : 0;
    const score = typeof record.score === 'number' ? Math.floor(record.score) : 0;
    if (rank <= 0 || nickname === '' || timeMs < 0) continue;
    list.push({
      rank,
      nickname,
      avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : undefined,
      partnerNickname: typeof record.partnerNickname === 'string' ? record.partnerNickname : undefined,
      score,
      timeSec: Math.floor(timeMs / 1000),
      isMe: record.isMe === true,
    });
  }

  const rawMine = (source.mine && typeof source.mine === 'object' ? source.mine : null) as Record<string, unknown> | null;
  const mine: RankingMine | null = rawMine && typeof rawMine.rank === 'number'
    ? {
      rank: Math.floor(rawMine.rank),
      score: typeof rawMine.score === 'number' ? Math.floor(rawMine.score) : 0,
      timeSec: typeof rawMine.timeMs === 'number' ? Math.floor(rawMine.timeMs / 1000) : 0,
      inTop: rawMine.inTop === true,
    }
    : null;

  return {
    list,
    mine,
    total: typeof source.total === 'number' ? Math.max(list.length, Math.floor(source.total)) : list.length,
    scoreRuleVersion: typeof source.scoreRuleVersion === 'number' ? Math.floor(source.scoreRuleVersion) : 1,
  };
}

/** 接收 C 的 `partner.list` 返回；服务端按 lastPlayedAt 降序，E 保持原顺序。 */
export function normalizePartners(raw: unknown): PartnerEntry[] {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(source.list) ? source.list : Array.isArray(raw) ? raw : [];
  const partners: PartnerEntry[] = [];
  for (const item of list) {
    const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const nickname = typeof record.nickname === 'string' ? record.nickname : '';
    const partnerId = typeof record.partnerId === 'string' ? record.partnerId : '';
    if (!record || nickname === '') continue;
    const badges: PartnerBadge[] = [];
    if (Array.isArray(record.badges)) {
      for (const badge of record.badges) {
        const b = (badge && typeof badge === 'object' ? badge : {}) as Record<string, unknown>;
        if (typeof b.id !== 'string' || typeof b.title !== 'string') continue;
        badges.push({
          id: b.id,
          title: b.title,
          description: typeof b.description === 'string' ? b.description : '',
        });
      }
    }
    const bestRecords: PartnerBestRecord[] = [];
    if (Array.isArray(record.bestRecords)) {
      for (const entry of record.bestRecords) {
        const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        if (typeof r.levelId !== 'string' || typeof r.timeMs !== 'number') continue;
        bestRecords.push({
          levelId: r.levelId,
          timeSec: Math.floor(r.timeMs / 1000),
          score: typeof r.score === 'number' ? Math.floor(r.score) : 0,
        });
      }
    }
    partners.push({
      partnerId,
      nickname,
      avatarUrl: typeof record.avatarUrl === 'string' ? record.avatarUrl : undefined,
      clearedCount: typeof record.clearedCount === 'number' ? Math.max(0, Math.floor(record.clearedCount)) : 0,
      clearedLevels: Array.isArray(record.clearedLevels)
        ? record.clearedLevels.filter((id): id is string => typeof id === 'string')
        : [],
      playCount: typeof record.playCount === 'number' ? Math.max(0, Math.floor(record.playCount)) : 0,
      bestRecords,
      badges,
      lastPlayedAt: typeof record.lastPlayedAt === 'number' ? record.lastPlayedAt : 0,
      online: typeof record.online === 'boolean' ? record.online : undefined,
    });
  }
  return partners;
}

export function demoPartners(): PartnerEntry[] {
  return [
    {
      partnerId: 'p_demo1',
      nickname: '小轨',
      clearedCount: 6,
      clearedLevels: ['L01', 'L02', 'L03', 'L04', 'L05', 'L08'],
      playCount: 9,
      bestRecords: [{ levelId: 'L01', timeSec: 241, score: 759 }],
      badges: [
        { id: 'first_team', title: '初次并肩', description: '第一次一起通关' },
        { id: 'three_levels', title: '默契初成', description: '共同通关 3 关' },
      ],
      lastPlayedAt: Date.now() - 86400000,
      online: true,
    },
    {
      partnerId: 'p_demo2',
      nickname: '阿知',
      clearedCount: 3,
      clearedLevels: ['L01', 'L02', 'L03'],
      playCount: 4,
      bestRecords: [{ levelId: 'L02', timeSec: 305, score: 695 }],
      badges: [{ id: 'first_team', title: '初次并肩', description: '第一次一起通关' }],
      lastPlayedAt: Date.now() - 3 * 86400000,
      online: false,
    },
  ];
}

/** 当前账号各关最好成绩里，排行榜页默认选最近可玩的一关 */
export function defaultRankingLevel(state: AppState): string {
  const rows = getMapNodes(state).filter((node) => node.visible !== false && node.levelId !== 'GUIDE');
  const completed = rows.filter((row) => row.state === 'completed').slice(-1)[0];
  const unlocked = rows.filter((row) => row.state === 'unlocked').slice(0, 1)[0];
  return (completed || unlocked || rows[0]).levelId;
}

export function rankLabel(rank: number): string {
  return String(rank);
}

export function partnerSummary(partner: PartnerEntry): string {
  const parts = ['合作 ' + partner.clearedCount + ' 关', '一起玩 ' + partner.playCount + ' 局'];
  const badgeTitles = partner.badges.map((badge) => badge.title).filter((title) => title !== '');
  if (badgeTitles.length > 0) parts.push(badgeTitles.join(' · '));
  return parts.join(' · ');
}

export function partnerBestTime(partner: PartnerEntry): string {
  if (partner.bestRecords.length === 0) return '';
  const best = partner.bestRecords.slice().sort((a, b) => a.timeSec - b.timeSec)[0];
  return formatTime(best.timeSec);
}
