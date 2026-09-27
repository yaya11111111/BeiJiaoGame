import { describe, expect, it } from 'vitest';
import {
  completeLevel,
  completeMapAchievement,
  createInitialAppState,
  createLocalRoom,
  formatTime,
  getCampusGates,
  getMapNodes,
  getMapRegions,
  getNextUnlocks,
  joinLocalRoom,
  navigateTo,
  selectMapNode,
  selectMode,
  signinAsGuest,
  startSelectedLevel,
  toggleSetting,
} from '../assets/scripts/ui/AppState';
import { initWechatCloud, resetWechatCloudInitForTest } from '../assets/scripts/ui/WechatCloud';

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

  it('locks every map node except the initial guide at first launch', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');
    const nodes = getMapNodes(signedIn);

    expect(nodes[0].levelId).toBe('GUIDE');
    expect(nodes[0].state).toBe('unlocked');
    expect(nodes[1].state).toBe('completed');
    expect(nodes[2].state).toBe('unlocked');
    expect(nodes[3].state).toBe('locked');
  });

  it('maps ten exploration regions to the ten formal levels', () => {
    const signedIn = signinAsGuest(createInitialAppState(), 'E 成员');
    const regions = getMapRegions(signedIn);

    expect(regions).toHaveLength(10);
    expect(regions[0].title).toBe('南门区域');
    expect(regions[0].state).toBe('completed');
    expect(regions[1].state).toBe('unlocked');
    expect(regions[2].state).toBe('locked');
    expect(regions[0].achievementFound).toBe(false);

    const withAchievement = completeMapAchievement(signedIn, regions[0].interactionId);
    expect(getMapRegions(withAchievement)[0].achievementFound).toBe(true);
  });

  it('opens the west, east and north gates after level 1', () => {
    const initial = createInitialAppState();
    const initialGates = getCampusGates({ ...initial, completedLevelIds: [] });
    expect(initialGates.filter((gate) => gate.unlocked)).toHaveLength(1);

    const completed = getCampusGates(initial);
    expect(completed.filter((gate) => gate.unlocked)).toHaveLength(4);
  });

  it('does not start a locked level', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');

    state = selectMapNode(state, 'node_teaching');
    state = startSelectedLevel(state);

    expect(state.page).toBe('home');
  });

  it('completes a level, records best time, unlocks next node and collection card', () => {
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
    expect(nodes[1].state).toBe('completed');
    expect(nodes[2].state).toBe('unlocked');
    expect(state.collection[0].unlocked).toBe(true);
  });

  it('toggles settings and formats time for map/result UI', () => {
    let state = createInitialAppState();

    state = toggleSetting(state, 'bgmEnabled');

    expect(state.settings.bgmEnabled).toBe(false);
    expect(formatTime(undefined)).toBe('--:--');
    expect(formatTime(286)).toBe('04:46');
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
    expect(calls).toEqual([{ env: 'cloudbase-d2gvkcgabfaf9768', traceUser: true }]);
  });

  it('skips WeChat cloud init safely outside WeChat runtime', () => {
    resetWechatCloudInitForTest();

    expect(initWechatCloud(undefined)).toBe(false);
    expect(initWechatCloud({})).toBe(false);
  });
});
