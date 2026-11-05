import { describe, expect, it } from 'vitest';
import {
  clearDuoSession,
  DUO_SESSION_PREFIX,
  duoSessionKey,
  formatSessionElapsed,
  isDuoSessionForRoom,
  loadDuoSession,
  resumeStartedAtMs,
  saveDuoSession,
} from '../assets/scripts/ui/DuoSession';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';

const room = { inviteCode: 'AB3K9Q', levelId: 'L05', startedAt: 1700000000000 };

describe('duo level save & resume (FR-15)', () => {
  it('saves, loads and clears a session by room code', () => {
    const store = memoryKeyValueStore();
    const saved = saveDuoSession(store, {
      roomCode: 'ab3k9q',
      levelId: 'L05',
      viewId: 'B',
      elapsedSec: 126,
      roomStartedAt: room.startedAt,
    }, 1700000126000);

    expect(saved).not.toBeNull();
    expect(duoSessionKey(' ab3k9q ')).toBe(DUO_SESSION_PREFIX + 'AB3K9Q');
    const loaded = loadDuoSession(store, 'AB3K9Q');
    expect(loaded).toEqual({
      roomCode: 'AB3K9Q',
      levelId: 'L05',
      viewId: 'B',
      elapsedSec: 126,
      roomStartedAt: room.startedAt,
      savedAt: 1700000126000,
    });

    clearDuoSession(store, 'AB3K9Q');
    expect(loadDuoSession(store, 'AB3K9Q')).toBeNull();
  });

  it('refuses to save an invalid snapshot', () => {
    const store = memoryKeyValueStore();

    expect(saveDuoSession(store, {
      roomCode: '',
      levelId: 'L05',
      viewId: 'A',
      elapsedSec: 10,
      roomStartedAt: 0,
    })).toBeNull();
    expect(saveDuoSession(store, {
      roomCode: 'AB3K9Q',
      levelId: 'L05',
      // @ts-expect-error 视角只能是 A/B，脏数据不能落盘
      viewId: 'C',
      elapsedSec: 10,
      roomStartedAt: 0,
    })).toBeNull();
    expect(loadDuoSession(store, 'AB3K9Q')).toBeNull();
  });

  it('only accepts a session from the same room, level and round', () => {
    const session = {
      roomCode: 'AB3K9Q',
      levelId: 'L05',
      viewId: 'A' as const,
      elapsedSec: 30,
      roomStartedAt: room.startedAt,
      savedAt: 1,
    };

    expect(isDuoSessionForRoom(session, room)).toBe(true);
    expect(isDuoSessionForRoom(session, { ...room, levelId: 'L06' })).toBe(false);
    expect(isDuoSessionForRoom(session, { ...room, inviteCode: 'ZZ9Y8X' })).toBe(false);
    // 房主重开了一轮：startedAt 变了，旧进度失效
    expect(isDuoSessionForRoom(session, { ...room, startedAt: room.startedAt + 1 })).toBe(false);
    expect(isDuoSessionForRoom(null, room)).toBe(false);
  });

  it('turns the saved elapsed time back into a mount timestamp', () => {
    const session = {
      roomCode: 'AB3K9Q',
      levelId: 'L05',
      viewId: 'A' as const,
      elapsedSec: 125,
      roomStartedAt: 0,
      savedAt: 1,
    };

    expect(resumeStartedAtMs(session, 1700001000000)).toBe(1700001000000 - 125000);
  });

  it('formats elapsed seconds for the resume prompt', () => {
    expect(formatSessionElapsed(0)).toBe('00:00');
    expect(formatSessionElapsed(126)).toBe('02:06');
    expect(formatSessionElapsed(-5)).toBe('00:00');
  });

  it('ignores corrupt local data', () => {
    const store = memoryKeyValueStore();
    store.write(duoSessionKey('AB3K9Q'), '{"roomCode":"AB3K9Q"}');

    expect(loadDuoSession(store, 'AB3K9Q')).toBeNull();
  });
});
