import { describe, expect, it } from 'vitest';
import {
  completeLevel,
  createInitialAppState,
  formatTime,
  getMapNodes,
  recordFailure,
  roomSnapshotToState,
  selectMapNode,
  selectMode,
  signinAsGuest,
  startSelectedLevel,
} from '../assets/scripts/ui/AppState';
import {
  CAMPUS_MAP_REGIONS,
  coloredMapRegions,
  mapNodePoint,
  mapRegionForLevel,
  shouldColorMapRegion,
} from '../assets/scripts/ui/MapLayout';
import {
  countDiscoveredEggs,
  eggTotalForLevel,
  emptyLibrary,
  libraryFromUnknown,
  loadPlayerLibrary,
  mergeCollectedClues,
  mergeEggDiscoveries,
  savePlayerLibrary,
} from '../assets/scripts/ui/PlayerLibrary';
import { buildLevelRecordRows, buildRecordsSummary, formatTotalTime } from '../assets/scripts/ui/Records';
import { loadUiSettings, saveUiSettings } from '../assets/scripts/ui/SettingsStore';
import {
  buildFeedbackContext,
  buildFeedbackPayload,
  loadFeedbackHistory,
  pushFeedbackReceipt,
  saveFeedbackHistory,
  validateFeedbackContent,
} from '../assets/scripts/ui/Feedback';
import {
  clearDuoSession,
  formatSessionElapsed,
  isDuoSessionForRoom,
  loadDuoSession,
  saveDuoSession,
} from '../assets/scripts/ui/DuoSession';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';

const signedIn = () => signinAsGuest(createInitialAppState(), 'E 成员');

describe('关卡外用例自动化（映射 300 条用例中的可自动执行部分）', () => {
  it('OUT-036 单人模式进入地图', () => {
    expect(selectMode(signedIn(), 'solo').page).toBe('map');
  });

  it('OUT-037 双人模式进入房间', () => {
    expect(selectMode(signedIn(), 'duo').page).toBe('room');
  });

  it('OUT-042 未解锁节点不能进入模式选择', () => {
    let state = selectMapNode(signedIn(), 'node_teaching');
    state = startSelectedLevel(state);
    expect(state.page).not.toBe('level-bridge');
    expect(getMapNodes(state).filter((node) => node.nodeId === 'node_teaching')[0].state).toBe('locked');
  });

  it('OUT-043 已通关节点可复玩', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 30, ['node_gate_plaza']);
    state = selectMapNode(state, 'node_gate_plaza');
    state = startSelectedLevel(state);
    expect(state.page).toBe('level-bridge');
  });

  it('OUT-062 房主视角 A、加入者视角 B', () => {
    const guest = roomSnapshotToState({ code: 'AB3K9Q', levelId: 'L01', status: 'playing', myViewId: 'B', isHost: false });
    expect(guest.myViewId).toBe('B');
    expect(guest.isHost).toBe(false);
  });

  it('OUT-064 房主身份标识', () => {
    const host = roomSnapshotToState({ code: 'AB3K9Q', levelId: 'L01', status: 'waiting', myViewId: 'A', isHost: true });
    expect(host.isHost).toBe(true);
  });

  it('OUT-070 开局时间基线可解析', () => {
    const room = roomSnapshotToState({
      code: 'AB3K9Q', levelId: 'L01', status: 'playing', myViewId: 'A', isHost: true,
      startedAt: 1700000000000, serverNow: 1700000000100,
    });
    expect(room.startedAt).toBe(1700000000000);
    expect(room.serverNow).toBe(1700000000100);
  });

  it('OUT-086 初始地图全灰', () => {
    expect(coloredMapRegions(getMapNodes(signedIn()))).toHaveLength(0);
  });

  it('OUT-087 初始只开放第 0 关', () => {
    const nodes = getMapNodes(signedIn());
    expect(nodes[0].levelId).toBe('GUIDE');
    expect(nodes[0].state).toBe('unlocked');
    expect(nodes.slice(1).every((node) => node.state === 'locked')).toBe(true);
  });

  it('OUT-088 通关第 0 关后区域 0 与区域 1 上色', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    expect(coloredMapRegions(getMapNodes(state)).map((region) => region.levelId)).toEqual(['GUIDE', 'L01']);
  });

  it('OUT-089 第 1 关解锁即区域上色', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    expect(shouldColorMapRegion(getMapNodes(state)[1].state, 'L01')).toBe(true);
  });

  it('OUT-090 通关第 1 关后区域 2 上色', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 60, ['node_road']);
    expect(coloredMapRegions(getMapNodes(state)).map((region) => region.levelId)).toContain('L02');
  });

  it('OUT-091 未解锁区域保持灰色', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    const colored = coloredMapRegions(getMapNodes(state)).map((region) => region.levelId);
    expect(colored).not.toContain('L02');
    expect(shouldColorMapRegion('locked', 'L02')).toBe(false);
  });

  it('OUT-092 11 个关卡点位齐全', () => {
    expect(CAMPUS_MAP_REGIONS).toHaveLength(11);
    expect(new Set(CAMPUS_MAP_REGIONS.map((region) => region.levelId)).size).toBe(11);
  });

  it('OUT-093 点位与关卡一一对应', () => {
    for (const region of CAMPUS_MAP_REGIONS) {
      const point = mapNodePoint(region.levelId);
      expect(point).not.toBeNull();
      expect(point!.x).toBeGreaterThanOrEqual(region.rect.x);
      expect(point!.x).toBeLessThanOrEqual(region.rect.x + region.rect.width);
      expect(point!.y).toBeGreaterThanOrEqual(region.rect.y);
      expect(point!.y).toBeLessThanOrEqual(region.rect.y + region.rect.height);
    }
    expect(mapRegionForLevel('L05')?.patchAsset).toBe('images/campus-region-l05');
  });

  it('OUT-112 彩蛋点只在彩色区域', () => {
    const lockedOnly = signedIn();
    expect(coloredMapRegions(getMapNodes(lockedOnly))).toHaveLength(0);
    expect(shouldColorMapRegion('unlocked', 'GUIDE')).toBe(false);
  });

  it('OUT-118 全通关后所有区域上色', () => {
    let state = signedIn();
    const levels = ['GUIDE', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10'];
    levels.forEach((levelId) => {
      state = completeLevel(state, levelId, 60, []);
    });
    expect(coloredMapRegions(getMapNodes(state))).toHaveLength(11);
  });

  it('OUT-130 目录与地图状态同源一致', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    const nodes = getMapNodes(state);
    const rows = buildLevelRecordRows(state);
    expect(rows.map((row) => row.state)).toEqual(nodes.map((node) => node.state));
  });

  it('OUT-131 通关结算记录本局数据', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 61, ['node_gate_plaza']);
    expect(state.page).toBe('result');
    expect(state.lastResult?.levelId).toBe('GUIDE');
    expect(state.lastResult?.elapsedSec).toBe(61);
  });

  it('OUT-132 更快成绩更新最好用时', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 100, ['node_gate_plaza']);
    state = completeLevel(state, 'GUIDE', 90, ['node_gate_plaza']);
    expect(state.bestTimes.GUIDE).toBe(90);
  });

  it('OUT-133 更慢成绩不覆盖最好用时', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 100, ['node_gate_plaza']);
    state = completeLevel(state, 'GUIDE', 120, ['node_gate_plaza']);
    expect(state.bestTimes.GUIDE).toBe(100);
  });

  it('OUT-134 成绩相等不覆盖最好用时', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 100, ['node_gate_plaza']);
    state = completeLevel(state, 'GUIDE', 100, ['node_gate_plaza']);
    expect(state.bestTimes.GUIDE).toBe(100);
  });

  it('OUT-135 解锁下一地图节点', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    expect(state.unlockedProgress).toContain('node_gate_plaza');
    expect(getMapNodes(state)[1].state).toBe('unlocked');
  });

  it('OUT-136 已解锁节点不重复', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'GUIDE', 60, ['node_gate_plaza']);
    expect(state.unlockedProgress.filter((id) => id === 'node_gate_plaza')).toHaveLength(1);
  });

  it('OUT-137 结算显示本关彩蛋', () => {
    const state = completeLevel(signedIn(), 'L05', 60, [], [], { found: 1, total: 3, titles: ['食堂阿姨的隐藏菜单'] });
    expect(state.lastResult?.eggs).toEqual({ found: 1, total: 3, titles: ['食堂阿姨的隐藏菜单'] });
  });

  it('OUT-138 未配置彩蛋的关卡不显示 0/0', () => {
    const state = completeLevel(signedIn(), 'L01', 60, [], [], { found: 0, total: 0, titles: [] });
    expect(state.lastResult?.eggs).toBeUndefined();
  });

  it('OUT-144 终章结算无下一关', () => {
    const state = completeLevel(signedIn(), 'L10', 60, []);
    expect(state.lastResult?.unlockedNodeIds).toEqual([]);
  });

  it('OUT-147 失败不写通关进度', () => {
    const state = recordFailure(signedIn(), 'L01', 60, 'timeout', []);
    expect(state.completedLevelIds).not.toContain('L01');
    expect(getMapNodes(state)[1].state).toBe('locked');
  });

  it('OUT-148 失败不覆盖最好用时', () => {
    const cleared = completeLevel(signedIn(), 'L01', 100, ['node_road']);
    const failed = recordFailure(cleared, 'L01', 300, 'timeout', []);
    expect(failed.bestTimes.L01).toBe(100);
  });

  it('OUT-157 用时 1 秒可记录', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 1, ['node_gate_plaza']);
    expect(state.bestTimes.GUIDE).toBe(1);
    expect(formatTime(1)).toBe('00:01');
  });

  it('OUT-158 跨小时累计时间格式', () => {
    expect(formatTotalTime(3725)).toBe('1 小时 2 分');
  });

  it('OUT-159 无新解锁节点时不报错', () => {
    const state = completeLevel(signedIn(), 'L10', 60, []);
    expect(state.lastResult?.unlockedNodeIds).toEqual([]);
  });


  it('OUT-167 彩蛋解锁后条目出现', () => {
    const library = mergeEggDiscoveries(emptyLibrary(), 'L05', { found: 1, total: 2, titles: ['隐藏菜单'] }, 1);
    expect(countDiscoveredEggs(library, 'L05')).toBe(1);
  });

  it('OUT-169 彩蛋标题与关卡正确', () => {
    const library = mergeEggDiscoveries(emptyLibrary(), 'L03', { found: 1, total: 1, titles: ['门后的人影'] }, 1);
    expect(library.eggs[0]).toMatchObject({ levelId: 'L03', title: '门后的人影' });
  });

  it('OUT-175 图鉴重登后保留', () => {
    const store = memoryKeyValueStore();
    const library = mergeEggDiscoveries(emptyLibrary(), 'L05', { found: 1, total: 2, titles: ['隐藏菜单'] }, 1);
    savePlayerLibrary(store, library);
    expect(loadPlayerLibrary(store).eggs).toHaveLength(1);
  });

  it('OUT-178 已配置彩蛋显示 x/y', () => {
    const library = mergeEggDiscoveries(emptyLibrary(), 'L05', { found: 1, total: 3, titles: ['隐藏菜单'] }, 1);
    expect(eggTotalForLevel(library, 'L05')).toBe(3);
    expect(countDiscoveredEggs(library, 'L05')).toBe(1);
  });

  it('OUT-181 hidden 道具不进图鉴', () => {
    const library = mergeCollectedClues(emptyLibrary(), 'L02', [
      { itemId: 'frag_1', name: '已归位碎片 1', hidden: true },
      { itemId: 'map', name: '路线图' },
    ], 1);
    expect(library.clues.map((clue) => clue.itemId)).toEqual(['map']);
  });

  it('OUT-182 线索按 itemId 去重', () => {
    let library = mergeCollectedClues(emptyLibrary(), 'L03', [{ itemId: 'a', name: 'A' }], 1);
    library = mergeCollectedClues(library, 'L04', [{ itemId: 'a', name: 'A' }], 2);
    expect(library.clues).toHaveLength(1);
  });

  it('OUT-186 空记录状态', () => {
    const summary = buildRecordsSummary(signedIn());
    expect(summary.cleared).toBe(0);
    expect(summary.totalBestSec).toBe(0);
    expect(summary.averageBestSec).toBeNull();
  });

  it('OUT-187 单关通关记录', () => {
    const state = completeLevel(signedIn(), 'GUIDE', 61, ['node_gate_plaza']);
    const summary = buildRecordsSummary(state);
    expect(summary.cleared).toBe(1);
    expect(summary.bestSec).toBe(61);
  });

  it('OUT-188 多关统计', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 120, ['node_road']);
    expect(buildRecordsSummary(state).cleared).toBe(2);
  });

  it('OUT-189 累计最好成绩', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 120, ['node_road']);
    expect(buildRecordsSummary(state).totalBestSec).toBe(180);
  });

  it('OUT-190 平均成绩', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 121, ['node_road']);
    expect(buildRecordsSummary(state).averageBestSec).toBe(91);
  });

  it('OUT-191 最快一关', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 120, ['node_road']);
    expect(buildRecordsSummary(state).bestLevelTitle).toContain('第 0 关');
  });

  it('OUT-192 未通关显示 --:--', () => {
    const rows = buildLevelRecordRows(signedIn());
    expect(rows[1].bestText).toBe('--:--');
  });

  it('OUT-198 三种状态标签', () => {
    let state = completeLevel(signedIn(), 'GUIDE', 60, ['node_gate_plaza']);
    state = completeLevel(state, 'L01', 60, ['node_road']);
    const rows = buildLevelRecordRows(state);
    expect(rows[0].state).toBe('completed');
    expect(rows[1].state).toBe('completed');
    expect(rows[2].state).toBe('unlocked');
    expect(rows[3].state).toBe('locked');
  });

  it('OUT-212 设置重启后保持', () => {
    const store = memoryKeyValueStore();
    saveUiSettings(store, { bgmEnabled: false, sfxEnabled: true, tutorialEnabled: false, vibrationEnabled: true });
    expect(loadUiSettings(store)).toMatchObject({ bgmEnabled: false, tutorialEnabled: false });
  });

  it('OUT-225 设置默认值', () => {
    const store = memoryKeyValueStore();
    store.remove('bjg:ui-settings');
    expect(loadUiSettings(store)).toMatchObject({
      bgmEnabled: true, sfxEnabled: true, tutorialEnabled: true,
    });
  });

  it('OUT-226 设置缓存损坏回退默认值', () => {
    const store = memoryKeyValueStore();
    store.write('bjg:ui-settings', '{broken');
    expect(loadUiSettings(store).bgmEnabled).toBe(true);
  });

  it('OUT-237 反馈内容 4 字被拦截', () => {
    expect(validateFeedbackContent('四个汉字')).not.toBeNull();
  });

  it('OUT-238 反馈内容 5 字可提交', () => {
    expect(validateFeedbackContent('五个汉字啊')).toBeNull();
  });

  it('OUT-239 反馈内容 300 字可提交', () => {
    expect(validateFeedbackContent('字'.repeat(300))).toBeNull();
  });

  it('OUT-240 反馈内容 301 字被拦截', () => {
    expect(validateFeedbackContent('字'.repeat(301))).not.toBeNull();
  });

  it('OUT-241 空内容被拦截', () => {
    expect(validateFeedbackContent('')).not.toBeNull();
  });

  it('OUT-242 仅空格内容被拦截', () => {
    expect(validateFeedbackContent('    ')).not.toBeNull();
  });

  it('OUT-244 emoji 与特殊字符可提交', () => {
    expect(validateFeedbackContent('卡住了🔥 "引号" <tag>')).toBeNull();
  });

  it('OUT-249 自动附带关卡上下文', () => {
    const context = buildFeedbackContext({ levelId: 'L05', levelTitle: '第 5 关 · 学四餐厅', page: 'result' });
    expect(context.levelTitle).toBe('第 5 关 · 学四餐厅');
    expect(context.levelId).toBe('L05');
  });

  it('OUT-250 单人模式不附带视角', () => {
    const context = buildFeedbackContext({ mode: 'solo', viewId: 'A' });
    expect(context.viewId).toBe('');
  });

  it('OUT-256 最近回执只保留 3 条', () => {
    let history: ReturnType<typeof pushFeedbackReceipt> = [];
    for (let i = 0; i < 4; i += 1) {
      history = pushFeedbackReceipt(history, {
        localId: 'fb-' + i, category: 'bug', content: 'x', screenshotAttached: false,
        submittedAt: i, status: 'submitted', message: 'ok',
      });
    }
    expect(history).toHaveLength(3);
    expect(history[0].localId).toBe('fb-3');
  });

  it('OUT-257 反馈回执持久化', () => {
    const store = memoryKeyValueStore();
    saveFeedbackHistory(store, [{
      localId: 'fb-1', category: 'bug', content: 'x', screenshotAttached: false,
      submittedAt: 1, status: 'submitted', message: 'ok',
    }]);
    expect(loadFeedbackHistory(store)).toHaveLength(1);
  });


  it('OUT-266 保存本机进度', () => {
    const store = memoryKeyValueStore();
    const saved = saveDuoSession(store, {
      roomCode: 'AB3K9Q', levelId: 'L01', viewId: 'A', elapsedSec: 80, roomStartedAt: 100,
    });
    expect(saved?.elapsedSec).toBe(80);
  });

  it('OUT-269 恢复冻结的已用时', () => {
    const store = memoryKeyValueStore();
    saveDuoSession(store, {
      roomCode: 'AB3K9Q', levelId: 'L01', viewId: 'A', elapsedSec: 80, roomStartedAt: 100,
    });
    expect(loadDuoSession(store, 'AB3K9Q')?.elapsedSec).toBe(80);
    expect(formatSessionElapsed(80)).toBe('01:20');
  });

  it('OUT-270 恢复原视角', () => {
    const store = memoryKeyValueStore();
    saveDuoSession(store, {
      roomCode: 'AB3K9Q', levelId: 'L01', viewId: 'B', elapsedSec: 80, roomStartedAt: 100,
    });
    expect(loadDuoSession(store, 'AB3K9Q')?.viewId).toBe('B');
  });

  it('OUT-274 换关后旧存档失效', () => {
    const session = { roomCode: 'AB3K9Q', levelId: 'L01', viewId: 'A' as const, elapsedSec: 1, roomStartedAt: 100, savedAt: 1 };
    expect(isDuoSessionForRoom(session, { inviteCode: 'AB3K9Q', levelId: 'L02', startedAt: 100 })).toBe(false);
  });

  it('OUT-275 房主重开后旧存档失效', () => {
    const session = { roomCode: 'AB3K9Q', levelId: 'L01', viewId: 'A' as const, elapsedSec: 1, roomStartedAt: 100, savedAt: 1 };
    expect(isDuoSessionForRoom(session, { inviteCode: 'AB3K9Q', levelId: 'L01', startedAt: 101 })).toBe(false);
  });

  it('OUT-276 通关后清存档', () => {
    const store = memoryKeyValueStore();
    saveDuoSession(store, { roomCode: 'AB3K9Q', levelId: 'L01', viewId: 'A', elapsedSec: 1, roomStartedAt: 100 });
    clearDuoSession(store, 'AB3K9Q');
    expect(loadDuoSession(store, 'AB3K9Q')).toBeNull();
  });

  it('OUT-278 无存档正常开局', () => {
    expect(loadDuoSession(memoryKeyValueStore(), 'AB3K9Q')).toBeNull();
  });

  it('OUT-286 存档损坏被忽略', () => {
    const store = memoryKeyValueStore();
    store.write('bjg:duo-session:AB3K9Q', '{"roomCode":');
    expect(loadDuoSession(store, 'AB3K9Q')).toBeNull();
    expect(libraryFromUnknown('broken').clues).toHaveLength(0);
  });
});
