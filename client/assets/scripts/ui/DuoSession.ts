/**
 * 双人关卡「保存并退出」的本地进度快照（FR-15 的 E 侧）。
 *
 * **完整快照应该由 C 存、D 产出**（关卡、视角、线索、道具、已完成操作、错误次数、
 * 解谜阶段、剩余时间）。这两头现在都还没有：
 * - C 的 `server/API.md` 里没有 `room.saveSession` / `room.getSession`；
 * - D 的 `LevelRuntime` 也没有导出快照 / 恢复的入口（`initialElapsedSec` 只够续计时）。
 *
 * 所以 E 先把自己能确定的那部分存下来 —— 房间、关卡、视角、已用时 —— 重新进关时
 * 用 `startedAtMs = now - elapsedSec * 1000` 交给 D 的挂载参数，倒计时从上次的位置
 * 接着走。等 C/D 两头补齐后，把 `progress` 字段接上即可，页面流程不用改。
 *
 * 不 import `cc`，存储由调用方注入（`LocalStore`）。
 */

import type { KeyValueStore } from './LocalStore';
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
  /** 预留给 D 的局内快照（线索 / 道具 / 操作 / 错误次数 / 阶段）。现在恒为 undefined。 */
  progress?: Record<string, unknown>;
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
  if (session.roomStartedAt > 0 && room.startedAt > 0 && session.roomStartedAt !== room.startedAt) return false;
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
  const progress = value.progress && typeof value.progress === 'object' && !Array.isArray(value.progress)
    ? { ...value.progress }
    : undefined;
  return { roomCode, levelId, viewId: value.viewId, elapsedSec, roomStartedAt, savedAt, progress };
}
