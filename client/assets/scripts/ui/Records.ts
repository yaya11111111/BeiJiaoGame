/**
 * 个人记录页（US08 / §6.1「统计展示入口」）的数据整理。
 *
 * 页面在 `AppShellView` 的 `records`，这里只做「AppState → 行/汇总」的纯函数，
 * 方便单测。数据源优先级：
 * 1. 本地 `bestTimes` / `completedLevelIds`（关卡结算当场写入，离线也有）；
 * 2. 登录时 `level.list` 同步回来的进度；
 * 3. `auth.profile` 的 `clearedCount` / `totalTimeMs`（服务端口径，作对照展示）。
 */

import type { AppState, MapNodeState } from './AppState';
import { formatTime, getMapNodes } from './AppState';

export interface LevelRecordRow {
  nodeId: string;
  levelId: string;
  title: string;
  place: string;
  chapter: string;
  state: MapNodeState;
  bestSec?: number;
  bestText: string;
}

export interface RecordsSummary {
  /** 已通关关数（含新手引导） */
  cleared: number;
  /** 地图上可见的关卡总数 */
  total: number;
  unlocked: number;
  /** 各关最好成绩之和；没通关的关不计 */
  totalBestSec: number;
  /** 已通关关的平均最好成绩；一关没通就是 null */
  averageBestSec: number | null;
  bestLevelTitle: string;
  bestSec?: number;
  clueCount: number;
  eggCount: number;
  /** 服务端 `auth.profile` 的口径；没拉到就是 null */
  cloud: CloudPlayerStats | null;
}

export interface CloudPlayerStats {
  clearedCount: number;
  totalTimeMs: number;
}

export function buildLevelRecordRows(state: AppState): LevelRecordRow[] {
  return getMapNodes(state)
    .filter((node) => node.visible !== false)
    .map((node) => ({
      nodeId: node.nodeId,
      levelId: node.levelId,
      title: node.title,
      place: node.place,
      chapter: node.chapter,
      state: node.state,
      bestSec: node.bestTimeSec,
      bestText: node.bestTimeSec === undefined ? '--:--' : formatTime(node.bestTimeSec),
    }));
}

export function buildRecordsSummary(state: AppState): RecordsSummary {
  const rows = buildLevelRecordRows(state);
  const clearedRows = rows.filter((row) => row.state === 'completed');
  const totalBestSec = clearedRows.reduce((sum, row) => sum + (row.bestSec || 0), 0);
  let best: LevelRecordRow | null = null;
  for (const row of clearedRows) {
    if (row.bestSec === undefined) continue;
    if (!best || best.bestSec === undefined || row.bestSec < best.bestSec) best = row;
  }
  return {
    cleared: clearedRows.length,
    total: rows.length,
    unlocked: rows.filter((row) => row.state !== 'locked').length,
    totalBestSec,
    averageBestSec: clearedRows.length > 0 ? Math.round(totalBestSec / clearedRows.length) : null,
    bestLevelTitle: best ? best.title + ' · ' + best.place : '',
    bestSec: best ? best.bestSec : undefined,
    clueCount: state.library.clues.length,
    eggCount: state.library.eggs.length,
    cloud: state.stats,
  };
}

export function formatTotalTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  return minutes + ' 分 ' + (whole % 60) + ' 秒';
}
