import { describe, expect, it, vi } from 'vitest';
import {
  completeLevel,
  completeMapAchievement,
  createInitialAppState,
  createLocalRoom,
  applyPlayerLibrary,
  applyPlayerStats,
  formatTime,
  getCampusGates,
  getMapNodes,
  getMapRegions,
  getNextUnlocks,
  joinLocalRoom,
  navigateTo,
  recordFailure,
  roomPresentationChanged,
  roomSnapshotToState,
  selectMapNode,
  selectMode,
  signinAsGuest,
  startSelectedLevel,
  toggleSetting,
  applyCloudLevelList,
} from '../assets/scripts/ui/AppState';
import { mergeEggDiscoveries, recordEggDiscovery } from '../assets/scripts/ui/PlayerLibrary';
import { chooseAndUploadWechatAvatar, initWechatCloud, resetWechatCloudInitForTest } from '../assets/scripts/ui/WechatCloud';

describe('E outer page state', () => {
  it('keeps protected pages behind signin before login', () => {
    const state = createInitialAppState();

    expect(navigateTo(state, 'map').page).toBe('signin');
    expect(signinAsGuest(state, 'E 成员').page).toBe('home');
  });

  it('routes solo mode directly to map and duo mode to room', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');

    expect(selectMode(signedIn, 'solo').page).toBe('map');
    expect(selectMode(signedIn, 'duo').page).toBe('room');
  });

  it('creates and joins placeholder rooms while C API is pending', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');
    const created = createLocalRoom(signedIn);
    const joined = joinLocalRoom(signedIn, '7788');

    expect(created.room?.inviteCode).toBe('2048');
    expect(created.room?.playerCount).toBe(1);
    expect(joined.room?.inviteCode).toBe('7788');
    expect(joined.room?.playerCount).toBe(2);
  });

  it('accepts a compact room.create response without player and progress arrays', () => {
    const room = roomSnapshotToState({
      code: 'AB3K9Q',
      levelId: 'GUIDE',
      myViewId: 'A',
      status: 'waiting',
      isHost: true,
    }, 'dog');

    expect(room.inviteCode).toBe('AB3K9Q');
    expect(room.isHost).toBe(true);
    expect(room.playableLevelIds).toEqual(['GUIDE']);
    expect(room.players).toEqual([{ nickname: 'dog', viewId: 'A', online: true }]);
  });

  it('skips redraws for server clock updates but reacts to room changes', () => {
    const room = roomSnapshotToState({
      code: 'AB3K9Q', levelId: 'GUIDE', myViewId: 'A', status: 'waiting', isHost: true,
      serverNow: 1000, playableLevelIds: ['GUIDE'],
      players: [{ nickname: 'dog', viewId: 'A', online: true }],
    });
    expect(roomPresentationChanged(room, { ...room, serverNow: 2000 })).toBe(false);
    expect(roomPresentationChanged(room, { ...room, levelId: 'L01' })).toBe(true);
    expect(roomPresentationChanged(room, { ...room, playableLevelIds: ['GUIDE', 'L01'] })).toBe(true);
    expect(roomPresentationChanged(room, {
      ...room,
      players: [{ ...room.players[0], online: false }],
    })).toBe(true);
    expect(roomPresentationChanged(room, { ...room, status: 'playing', startedAt: 3000 })).toBe(true);
  });

  it('uses the server isHost flag instead of inferring ownership from view A', () => {
    const shared = {
      code: 'AB3K9Q',
      levelId: 'GUIDE',
      status: 'waiting' as const,
    };

    expect(roomSnapshotToState({ ...shared, myViewId: 'A', isHost: false }).isHost).toBe(false);
    expect(roomSnapshotToState({ ...shared, myViewId: 'B', isHost: true }).isHost).toBe(true);
  });

  it('locks every map node except the initial guide at first launch', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');
    const nodes = getMapNodes(signedIn);

    expect(nodes[0].levelId).toBe('GUIDE');
    expect(nodes[0].state).toBe('unlocked');
    expect(nodes[1].state).toBe('locked');
    expect(nodes[2].state).toBe('locked');
    expect(nodes[3].state).toBe('locked');
  });

  it('maps the eleven exploration regions, including region 0', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');
    const regions = getMapRegions(signedIn);

    expect(regions).toHaveLength(11);
    expect(regions[0].title).toBe('南门区域');
    expect(regions[0].state).toBe('locked');
    expect(regions[1].state).toBe('locked');
    expect(regions[2].state).toBe('locked');
    expect(regions[0].achievementFound).toBe(false);

    const guideComplete = completeLevel(signedIn, 'GUIDE', 286, getNextUnlocks('GUIDE'));
    const withAchievement = completeMapAchievement(guideComplete, regions[0].interactionId);
    expect(getMapRegions(withAchievement)[0].achievementFound).toBe(true);
  });

  it('opens the west, east and north gates after level 1', () => {
    const initial = createInitialAppState();
    const initialGates = getCampusGates({ ...initial, completedLevelIds: [] });
    expect(initialGates.filter((gate) => gate.unlocked)).toHaveLength(1);

    const completed = getCampusGates({ ...initial, completedLevelIds: ['L01'] });
    expect(completed.filter((gate) => gate.unlocked)).toHaveLength(4);
  });

  it('does not start a locked level', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');

    state = selectMapNode(state, 'node_teaching');
    state = startSelectedLevel(state);

    expect(state.page).toBe('home');
  });

  it('completes a level, records best time and unlocks the next node without changing collection', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');
    state = navigateTo(state, 'map');
    state = selectMapNode(state, 'node_campus_gate');
    state = startSelectedLevel(state);
    state = completeLevel(state, 'GUIDE', 301, getNextUnlocks('GUIDE'));
    state = completeLevel(state, 'GUIDE', 286, getNextUnlocks('GUIDE'));

    const nodes = getMapNodes(state);
    expect(state.page).toBe('result');
    expect(state.bestTimes.GUIDE).toBe(286);
    expect(nodes[0].state).toBe('completed');
    expect(nodes[1].state).toBe('unlocked');
    expect(nodes[2].state).toBe('locked');
    expect(state.collection[0].unlocked).toBe(false);
  });

  it('keeps the cloud room in duo result state so the player can return to it', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');
    const inRoom = createLocalRoom(signedIn);
    const result = completeLevel(inRoom, 'GUIDE', 30, getNextUnlocks('GUIDE'));

    expect(result.page).toBe('result');
    expect(result.mode).toBe('duo');
    expect(result.room?.inviteCode).toBe(inRoom.room?.inviteCode);
  });

  it('toggles settings and formats time for map/result UI', () => {
    let state = createInitialAppState();

    state = toggleSetting(state, 'bgmEnabled');
    state = toggleSetting(state, 'tutorialEnabled');

    expect(state.settings.bgmEnabled).toBe(false);
    expect(state.settings.tutorialEnabled).toBe(false);
    expect(formatTime(undefined)).toBe('--:--');
    expect(formatTime(286)).toBe('04:46');
    expect(formatTime(280.10699999968366)).toBe('04:40');
  });

  it('records a map achievement independently from level completion', () => {
    const initial = signinAsGuest(createInitialAppState(), 'E 成员');
    const lockedRegion = getMapRegions(initial)[2];
    const found = completeMapAchievement(initial, lockedRegion.interactionId);

    expect(found.completedAchievementIds).toEqual([lockedRegion.interactionId]);
    expect(found.collection.find((entry) => entry.id === lockedRegion.interactionId)?.unlocked).toBe(true);
  });

  it('maps the cloud level directory into local map progress', () => {
    const state = signinAsGuest(createInitialAppState(), 'E 成员');
    const synced = applyCloudLevelList(state, [
      {
        levelId: 'GUIDE',
        chapterId: 'campus_gate',
        title: '新手引导',
        unlocks: ['node_gate_plaza'],
        hasPuzzle: true,
        status: 'cleared',
        bestTimeMs: 286000,
        clearedAt: 1,
      },
      {
        levelId: 'L01',
        chapterId: 'campus_gate',
        title: '第 1 关',
        unlocks: ['node_road'],
        hasPuzzle: false,
        status: 'cleared',
        bestTimeMs: 241000,
        clearedAt: 2,
      },
      {
        levelId: 'L02',
        chapterId: 'campus_gate',
        title: '第 2 关',
        unlocks: ['node_teaching'],
        hasPuzzle: false,
        status: 'unlocked',
        bestTimeMs: 0,
        clearedAt: 0,
      },
    ]);

    expect(synced.completedLevelIds).toEqual(['GUIDE', 'L01']);
    expect(synced.unlockedProgress).toContain('node_road');
    expect(synced.unlockedProgress).not.toContain('node_avenue');
    expect(synced.bestTimes.L01).toBe(241);
    expect(synced.collection.filter((entry) => entry.unlocked)).toHaveLength(0);
  });

  it('repairs old cloud progress where level 1 is cleared without GUIDE', () => {
    const state = signinAsGuest(createInitialAppState(), 'E 成员');
    const synced = applyCloudLevelList(state, [{
      levelId: 'L01',
      chapterId: 'campus_gate',
      title: '第 1 关',
      unlocks: ['node_road'],
      hasPuzzle: true,
      status: 'cleared',
      bestTimeMs: 241000,
      clearedAt: 2,
    }]);

    expect(synced.completedLevelIds).toContain('GUIDE');
    expect(getMapRegions(synced)[0].state).toBe('completed');
  });

  it('initializes WeChat cloud once when wx.cloud exists', () => {
    resetWechatCloudInitForTest();
    const calls: Array<{ env: string; traceUser: boolean }> = [];
    const runtime = {
      cloud: {
        init: (options: { env: string; traceUser: boolean }) => calls.push(options),
      },
    };

    expect(initWechatCloud(runtime)).toBe(true);
    expect(initWechatCloud(runtime)).toBe(true);
    expect(calls).toEqual([{ env: 'cloudbase-d2gvkcghabfaf9768', traceUser: true }]);
  });

  it('skips WeChat cloud init safely outside WeChat runtime', () => {
    resetWechatCloudInitForTest();

    expect(initWechatCloud(undefined)).toBe(false);
    expect(initWechatCloud({})).toBe(false);
  });

  it('does not mark cloud as ready when wx.cloud.init throws', () => {
    resetWechatCloudInitForTest();
    const runtime = {
      cloud: {
        init: () => {
          throw new Error('invalid cloud environment');
        },
      },
    };

    expect(initWechatCloud(runtime)).toBe(false);
    expect(initWechatCloud(runtime)).toBe(false);
  });

  it('shows the cloud upload error returned by WeChat with its failing stage', async () => {
    vi.stubGlobal('wx', {
      chooseMedia: ({ success }: { success: (result: unknown) => void }) =>
        success({ tempFiles: [{ tempFilePath: '/tmp/avatar.jpg' }] }),
      cloud: {
        uploadFile: ({ fail }: { fail: (error: unknown) => void }) =>
          fail({ errMsg: 'uploadFile:fail permission denied' }),
      },
    });
    try {
      await expect(chooseAndUploadWechatAvatar()).rejects.toThrow(
        '云存储上传失败：uploadFile:fail permission denied',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts with an empty cross-level library and no server stats', () => {
    const state = createInitialAppState();

    expect(state.library).toEqual({ clues: [], eggs: [], eggTotals: {} });
    expect(state.stats).toBeNull();
  });

  it('keeps the egg summary from the level review on the result page', () => {
    const state = completeLevel(
      signinAsGuest(createInitialAppState(), 'E 成员'),
      'L05',
      90,
      ['node_sports'],
      ['餐牌'],
      { found: 1, total: 3, titles: ['食堂阿姨的隐藏菜单'] },
    );

    expect(state.lastResult?.eggs).toEqual({ found: 1, total: 3, titles: ['食堂阿姨的隐藏菜单'] });
  });

  it('drops a 0/0 egg summary instead of pretending the level has eggs', () => {
    const state = completeLevel(
      signinAsGuest(createInitialAppState(), 'E 成员'),
      'L05',
      90,
      ['node_sports'],
      [],
      { found: 0, total: 0, titles: [] },
    );

    expect(state.lastResult?.eggs).toBeUndefined();
  });

  it('shows egg progress on map nodes once the library knows the totals', () => {
    const base = signinAsGuest(createInitialAppState(), 'E 成员');
    const empty = getMapNodes(base)[5];
    expect(empty.hiddenTotal).toBe(0);

    const withEggs = applyPlayerLibrary(base, mergeEggDiscoveries(base.library, 'L05', {
      found: 1,
      total: 2,
      titles: ['食堂阿姨的隐藏菜单'],
    }, 1));
    const node = getMapNodes(withEggs)[5];

    expect(node.levelId).toBe('L05');
    expect(node.hiddenFound).toBe(1);
    expect(node.hiddenTotal).toBe(2);
  });

  it('shows a discovered egg before the per-level total is synced', () => {
    const base = signinAsGuest(createInitialAppState(), 'E 成员');
    const library = recordEggDiscovery(base.library, {
      levelId: 'GUIDE', eggId: 'GUIDE_window', title: '敲窗户',
    }, 1);
    const node = getMapNodes(applyPlayerLibrary(base, library))[0];

    expect(node.hiddenFound).toBe(1);
    expect(node.hiddenTotal).toBe(0);
  });

  it('merges server profile stats without touching local progress', () => {
    const state = signinAsGuest(createInitialAppState(), 'E 成员');
    const withStats = applyPlayerStats(state, { clearedCount: 3, totalTimeMs: 600000 });

    expect(withStats.stats).toEqual({ clearedCount: 3, totalTimeMs: 600000 });
    expect(withStats.completedLevelIds).toEqual(state.completedLevelIds);
  });

  it('records a failure summary without unlocking or overwriting progress', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');
    state = completeLevel(state, 'GUIDE', 61, ['node_gate_plaza']);
    const before = {
      completed: state.completedLevelIds,
      unlocked: state.unlockedProgress,
      best: state.bestTimes,
    };

    const failed = recordFailure(state, 'L01', 75, 'timeout', ['通知 A']);

    expect(failed.page).toBe('failed');
    expect(failed.lastFailure).toEqual({
      levelId: 'L01',
      elapsedSec: 75,
      reason: 'timeout',
      collectedItems: ['通知 A'],
    });
    expect(failed.completedLevelIds).toEqual(before.completed);
    expect(failed.unlockedProgress).toEqual(before.unlocked);
    expect(failed.bestTimes).toEqual(before.best);
  });
});
