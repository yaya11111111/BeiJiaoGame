/**
 * 双人关卡「保存并退出」的本地进度快照（FR-15 的 E 侧）。
 *
 * 保存 D 的局内快照与已用时，继续同一轮时交给 mountLevel.resume。
 * 换关或重开后，旧快照失效。这里只处理本机保存，不代替服务端存档。
 *
 * 不 import `cc`，存储由调用方注入（`LocalStore`）。
 */

import type { KeyValueStore } from './LocalStore';
import type { LevelProgressSnapshot } from '../level/LevelRuntime';
import { readJson, writeJson } from './LocalStore';

export interface DuoSessionSnapshot {
  roomCode: string;
  levelId: string;
  viewId: 'A' | 'B';
  /** 退出时这一局已经用掉的秒数。恢复时用它反推 startedAtMs。 */
  elapsedSec: number;
  /** 保存时房间快照里的 `startedAt`，用来判断这是不是同一轮 */
  roomStartedAt: number;
  savedAt: number;
  /** 局内快照；旧版本保存的数据可以缺省。 */
  progress?: LevelProgressSnapshot;
}

/** 判断快照是否还属于当前这一轮房间，避免换关 / 重开后还提示旧进度 */
export interface DuoSessionRoomLike {
  inviteCode: string;
  levelId: string;
  startedAt: number;
}

export const DUO_SESSION_PREFIX = 'bjg:duo-session:';

export function duoSessionKey(roomCode: string): string {
  return DUO_SESSION_PREFIX + roomCode.trim().toUpperCase();
}

/**
 * 保存一份快照。数据不合法（没有房间码 / 关卡、视角不是 A/B、用时为负）时
 * 返回 null 且不写盘 —— 宁可没有进度，也不要存一条会把页面带崩的记录。
 */
export function saveDuoSession(
  store: KeyValueStore,
  snapshot: Omit<DuoSessionSnapshot, 'savedAt'> & { savedAt?: number },
  now = Date.now(),
): DuoSessionSnapshot | null {
  const normalized = normalizeSnapshot(snapshot, now);
  if (!normalized) return null;
  writeJson(store, duoSessionKey(normalized.roomCode), normalized);
  return normalized;
}

export function loadDuoSession(store: KeyValueStore, roomCode: string): DuoSessionSnapshot | null {
  if (!roomCode.trim()) return null;
  return normalizeSnapshot(readJson(store, duoSessionKey(roomCode)), Date.now());
}

export function clearDuoSession(store: KeyValueStore, roomCode: string): void {
  if (!roomCode.trim()) return;
  store.remove(duoSessionKey(roomCode));
}

/**
 * 这份快照能不能给当前房间用。
 *
 * 三个都要对上：房间码、关卡、以及**保存时的那一轮 `startedAt`**。
 * 房主重新点「开始游戏」后 `startedAt` 会变，旧进度就自动失效 —— 不然玩家会拿
 * 上一局的进度去接新一轮。
 */
export function isDuoSessionForRoom(session: DuoSessionSnapshot | null, room: DuoSessionRoomLike): boolean {
  if (!session) return false;
  if (session.roomCode.toUpperCase() !== room.inviteCode.trim().toUpperCase()) return false;
  if (session.levelId !== room.levelId) return false;
  if (session.roomStartedAt !== room.startedAt) return false;
  return true;
}

/** 恢复时传给 `mountLevel` 的 `startedAtMs`：让 D 的倒计时从上次用时接着算 */
export function resumeStartedAtMs(session: DuoSessionSnapshot, now = Date.now()): number {
  return now - Math.max(0, session.elapsedSec) * 1000;
}

export function formatSessionElapsed(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

export function formatSessionSavedAt(savedAt: number): string {
  const date = new Date(savedAt);
  const pad = (value: number): string => (value < 10 ? '0' : '') + value;
  return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function normalizeSnapshot(raw: unknown, now: number): DuoSessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<DuoSessionSnapshot>;
  const roomCode = typeof value.roomCode === 'string' ? value.roomCode.trim().toUpperCase() : '';
  const levelId = typeof value.levelId === 'string' ? value.levelId.trim() : '';
  if (!roomCode || !levelId) return null;
  if (value.viewId !== 'A' && value.viewId !== 'B') return null;
  const elapsedSec = typeof value.elapsedSec === 'number' && Number.isFinite(value.elapsedSec)
    ? Math.max(0, value.elapsedSec)
    : 0;
  const roomStartedAt = typeof value.roomStartedAt === 'number' && Number.isFinite(value.roomStartedAt)
    ? value.roomStartedAt
    : 0;
  const savedAt = typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) && value.savedAt > 0
    ? value.savedAt
    : now;
  const progress = normalizeProgress(value.progress);
  return { roomCode, levelId, viewId: value.viewId, elapsedSec, roomStartedAt, savedAt, progress };
}

function normalizeProgress(raw: unknown): LevelProgressSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Partial<LevelProgressSnapshot>;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === 'string');
  const scene = (id: unknown): id is string | null => id === null || typeof id === 'string';
  if (!strings(value.inventory) || !strings(value.revealed) || !strings(value.doneHotspots)
    || typeof value.wrongCount !== 'number' || !Number.isFinite(value.wrongCount)
    || typeof value.stage !== 'string' || !value.views || !scene(value.views.A) || !scene(value.views.B)) return undefined;
  return {
    inventory: value.inventory.slice(),
    revealed: value.revealed.slice(),
    doneHotspots: value.doneHotspots.slice(),
    wrongCount: Math.max(0, Math.floor(value.wrongCount)),
    stage: value.stage,
    views: { A: value.views.A, B: value.views.B },
    ...(strings(value.activeEggIds) ? { activeEggIds: value.activeEggIds.slice() } : {}),
  };
}
