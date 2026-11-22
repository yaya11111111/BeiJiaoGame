import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clear, load, write } from '../../server/cloudfunctions/game/src/actions/save';

// 模拟事务的快照及冲突重试，让两份请求先读到同一版本再依次提交。
const { db, saves } = vi.hoisted(() => {
  type Save = {
    _id: string;
    pairKey: string;
    levelId: string;
    elapsedSec: number;
    players: { openid: string; progress: unknown; savedAt: number }[];
    savedAt: number;
  };
  const saves = new Map<string, Save>();
  let revision = 0;
  let autoId = 0;

  function collection(store: Map<string, Save>, name: string) {
    return {
      doc: (id: string) => ({
        get: async () => ({ data: name === 'rooms'
          ? { sessionPlayers: ['player-a', 'player-b'] }
          : structuredClone(store.get(id)) }),
        set: async ({ data }: { data: Omit<Save, '_id'> }) => {
          store.set(id, { ...structuredClone(data), _id: id });
        },
        update: async ({ data }: { data: Partial<Save> }) => {
          const current = store.get(id);
          if (!current) throw new Error('document not found');
          store.set(id, { ...current, ...structuredClone(data) });
          if (store === saves) revision += 1;
        },
        remove: async () => {
          if (store.delete(id) && store === saves) revision += 1;
        },
      }),
      where: (key: { pairKey: string; levelId: string }) => ({
        limit: (max: number) => ({
          get: async () => ({ data: structuredClone(Array.from(store.values())
            .filter((doc) => doc.pairKey === key.pairKey && doc.levelId === key.levelId).slice(0, max)) }),
        }),
      }),
      add: async ({ data }: { data: Omit<Save, '_id'> }) => {
        const id = `auto-${++autoId}`;
        store.set(id, { ...structuredClone(data), _id: id });
        revision += 1;
      },
    };
  }

  const db = {
    collection: (name: string) => collection(saves, name),
    runTransaction: async <T>(update: (tx: { collection: (name: string) => ReturnType<typeof collection> }) => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const baseRevision = revision;
        const snapshot = structuredClone(saves);
        const result = await update({ collection: (name) => collection(snapshot, name) });
        if (baseRevision !== revision) continue;
        saves.clear();
        snapshot.forEach((doc, id) => saves.set(id, doc));
        revision += 1;
        return result;
      }
      throw new Error('transaction conflict');
    },
  };
  return { db, saves };
});

vi.mock('../../server/cloudfunctions/game/src/shared/db', () => ({
  C: { rooms: 'rooms', saves: 'saves' },
  db,
  getDoc: async (collection: string, id: string, source = db) =>
    (await source.collection(collection).doc(id).get()).data ?? null,
  now: () => Date.now(),
  savePairKey: (openids: string[]) => openids.slice().sort().join('_'),
}));

describe('双人云端存档并发写入', () => {
  const params = { code: 'AB3K9Q', levelId: 'L07' };
  const host = { openid: 'player-a' };
  const guest = { openid: 'player-b' };
  const hostProgress = { inventory: ['placed_tl'], doneHotspots: ['hs_a_slot_tl'] };
  const guestProgress = { inventory: [], doneHotspots: [], stage: 'archive' };

  beforeEach(() => saves.clear());

  it.each([false, true])('两端同时保存时只留下一个双端存档（有旧存档=%s）', async (hasLegacySave) => {
    const legacyId = 'existing-auto-id';
    if (hasLegacySave) {
      saves.set(legacyId, {
        _id: legacyId,
        pairKey: 'player-a_player-b',
        levelId: params.levelId,
        elapsedSec: 3,
        players: [{ openid: host.openid, progress: { inventory: [] }, savedAt: 1 }],
        savedAt: 1,
      });
    }

    const result = await Promise.all([
      write({ ...params, progress: hostProgress, elapsedSec: 9 }, host),
      write({ ...params, progress: guestProgress, elapsedSec: 11 }, guest),
    ]);
    expect(saves.size).toBe(1);
    if (hasLegacySave) expect(saves.has(legacyId)).toBe(true);
    expect(await load(params, host)).toMatchObject({ found: true, complete: true, elapsedSec: 11, mine: hostProgress });
    expect(await load({ ...params, code: 'BC4L8R' }, guest)).toMatchObject({
      found: true, complete: true, elapsedSec: 11, mine: guestProgress,
    });
    expect(result.some((item) => item.complete)).toBe(true);

    expect(await clear(params, host)).toEqual({ cleared: true });
    expect(await load(params, guest)).toEqual({ found: false });
  });
});
