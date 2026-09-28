import type { AuthLoginResult, LevelEntry, RoomSnapshot } from '../common/CloudApi';
export type PageId = 'signin' | 'home' | 'mode' | 'room' | 'map' | 'levels' | 'collection' | 'settings' | 'level-bridge' | 'result';

export type PlayMode = 'solo' | 'duo';

export type MapNodeState = 'locked' | 'unlocked' | 'completed';
export type CampusGateId = 'south' | 'west' | 'east' | 'north';

export type MapAnchor =
  | 'southWest'
  | 'south'
  | 'southEast'
  | 'west'
  | 'center'
  | 'east'
  | 'northWest'
  | 'north'
  | 'northEast';

export interface MapRegionDefinition {
  regionId: string;
  nodeId: string;
  levelId: string;
  title: string;
  interactionId: string;
  order: number;
  anchor: MapAnchor;
  widthCells: number;
  heightCells: number;
  offsetX?: number;
  offsetY?: number;
}

export interface MapRegionView extends MapRegionDefinition {
  state: MapNodeState;
  achievementFound: boolean;
}

export interface CampusGateView {
  gateId: CampusGateId;
  title: string;
  unlocked: boolean;
}

export interface MiniProgramConfig {
  appId: string;
  cloudEnv: string;
}

export interface PlayerProfile {
  playerId: string;
  nickname: string;
  avatarUrl?: string;
}

export interface RoomState {
  roomId: string;
  inviteCode: string;
  ownerId: string;
  playerCount: number;
  readyCount: number;
}

export interface MapNodeDefinition {
  nodeId: string;
  levelId: string;
  title: string;
  place: string;
  chapter: string;
  unlockText: string;
  visible?: boolean;
  anchor: MapAnchor;
  offsetX?: number;
  offsetY?: number;
}

export interface MapNodeView extends MapNodeDefinition {
  state: MapNodeState;
  bestTimeSec?: number;
  hiddenFound: number;
  hiddenTotal: number;
}

export interface CollectionEntry {
  id: string;
  title: string;
  sourceLevelId: string;
  unlocked: boolean;
}

export interface UserSettings {
  bgmEnabled: boolean;
  sfxEnabled: boolean;
  /** 是否显示外层页面的新手提示。 */
  tutorialEnabled: boolean;
  /** 保留给后续小游戏触感反馈接入，暂不由 E 页面使用。 */
  vibrationEnabled: boolean;
}

export interface AppState {
  page: PageId;
  profile: PlayerProfile | null;
  mode: PlayMode | null;
  room: RoomState | null;
  selectedNodeId: string | null;
  unlockedProgress: string[];
  completedLevelIds: string[];
  bestTimes: Record<string, number>;
  collection: CollectionEntry[];
  completedAchievementIds: string[];
  settings: UserSettings;
}

export const MINI_PROGRAM_CONFIG: MiniProgramConfig = {
  appId: 'wxf23657dd9d6612f4',
  cloudEnv: 'cloudbase-d2gvkcghabfaf9768',
};

export const MAP_NODES: MapNodeDefinition[] = [
  {
    nodeId: 'node_campus_gate',
    levelId: 'GUIDE',
    title: '新手引导',
    place: '南门入口',
    chapter: '序幕',
    unlockText: '初始开放',
    visible: false,
    anchor: 'south',
  },
  {
    nodeId: 'node_gate_plaza',
    levelId: 'L01',
    title: '第 1 关',
    place: '南门内侧迎新广场',
    chapter: '校园启程',
    unlockText: '完成新手引导后解锁',
    anchor: 'south',
    offsetY: 58,
  },
  {
    nodeId: 'node_road',
    levelId: 'L02',
    title: '第 2 关',
    place: '南门至思源楼林荫路',
    chapter: '校园启程',
    unlockText: '通关第 1 关后解锁',
    anchor: 'south',
    offsetY: 148,
  },
  {
    nodeId: 'node_teaching',
    levelId: 'L03',
    title: '第 3 关',
    place: '思源楼前',
    chapter: '通知校准',
    unlockText: '通关第 2 关后解锁',
    anchor: 'east',
    offsetX: -126,
    offsetY: -68,
  },
  {
    nodeId: 'node_library',
    levelId: 'L04',
    title: '第 4 关',
    place: '主校区图书馆',
    chapter: '半页线索',
    unlockText: '通关第 3 关后解锁',
    anchor: 'center',
    offsetX: -4,
    offsetY: 0,
  },
  {
    nodeId: 'node_canteen',
    levelId: 'L05',
    title: '第 5 关',
    place: '明湖餐厅',
    chapter: '流程误读',
    unlockText: '通关第 4 关后解锁',
    anchor: 'northEast',
    offsetX: -86,
    offsetY: -24,
  },
  {
    nodeId: 'node_sports',
    levelId: 'L06',
    title: '第 6 关',
    place: '主校区西侧运动场',
    chapter: '接力顺序',
    unlockText: '通关第 5 关后解锁',
    anchor: 'northWest',
    offsetX: 42,
    offsetY: 4,
  },
  {
    nodeId: 'node_history',
    levelId: 'L07',
    title: '第 7 关',
    place: '第四教学楼校史主题区',
    chapter: '展板重排',
    unlockText: '通关第 6 关后解锁',
    anchor: 'west',
    offsetX: 126,
    offsetY: -62,
  },
  {
    nodeId: 'node_train_model',
    levelId: 'L08',
    title: '第 8 关',
    place: '第八教学楼前',
    chapter: '线路连接',
    unlockText: '通关第 7 关后解锁',
    anchor: 'east',
    offsetX: 86,
    offsetY: 22,
  },
  {
    nodeId: 'node_service_center',
    levelId: 'L09',
    title: '第 9 关',
    place: '学生活动服务中心',
    chapter: '任务复原',
    unlockText: '通关第 8 关后解锁',
    anchor: 'southWest',
    offsetX: 112,
    offsetY: 44,
  },
  {
    nodeId: 'node_main_exhibit',
    levelId: 'L10',
    title: '第 10 关',
    place: '逸夫楼前迎新主展区',
    chapter: '知行谜站',
    unlockText: '通关第 9 关后解锁',
    anchor: 'southEast',
    offsetX: -118,
    offsetY: 52,
  },
];

/**
 * 地图探索区域按关卡从外向里推进。
 * 这里先只负责区域显示和锁定状态，区域内的彩蛋互动后续另接。
 */
export const MAP_REGIONS: MapRegionDefinition[] = [
  { regionId: 'region_south_gate', nodeId: 'node_gate_plaza', levelId: 'L01', title: '南门区域', interactionId: 'achievement_south_gate', order: 1, anchor: 'south', widthCells: 1.4, heightCells: 0.7, offsetY: 8 },
  { regionId: 'region_east_west_gates', nodeId: 'node_road', levelId: 'L02', title: '东西门与林荫路', interactionId: 'achievement_east_west_gates', order: 2, anchor: 'south', widthCells: 1.3, heightCells: 0.85, offsetY: 72 },
  { regionId: 'region_siyuan', nodeId: 'node_teaching', levelId: 'L03', title: '思源楼区域', interactionId: 'achievement_siyuan', order: 3, anchor: 'east', widthCells: 0.75, heightCells: 0.8, offsetX: -80, offsetY: 24 },
  { regionId: 'region_library', nodeId: 'node_library', levelId: 'L04', title: '图书馆区域', interactionId: 'achievement_library', order: 4, anchor: 'center', widthCells: 0.9, heightCells: 0.7, offsetX: -18, offsetY: 8 },
  { regionId: 'region_minghu', nodeId: 'node_canteen', levelId: 'L05', title: '明湖区域', interactionId: 'achievement_minghu', order: 5, anchor: 'northEast', widthCells: 0.85, heightCells: 0.75, offsetX: -28, offsetY: -8 },
  { regionId: 'region_sports', nodeId: 'node_sports', levelId: 'L06', title: '西运动场区域', interactionId: 'achievement_sports', order: 6, anchor: 'northWest', widthCells: 0.95, heightCells: 0.75, offsetX: 24, offsetY: -8 },
  { regionId: 'region_history', nodeId: 'node_history', levelId: 'L07', title: '四教区域', interactionId: 'achievement_history', order: 7, anchor: 'west', widthCells: 0.75, heightCells: 0.75, offsetX: 64, offsetY: -42 },
  { regionId: 'region_train', nodeId: 'node_train_model', levelId: 'L08', title: '八教区域', interactionId: 'achievement_train', order: 8, anchor: 'east', widthCells: 0.72, heightCells: 0.7, offsetX: 54, offsetY: 46 },
  { regionId: 'region_service', nodeId: 'node_service_center', levelId: 'L09', title: '学生活动中心区域', interactionId: 'achievement_service_center', order: 9, anchor: 'southWest', widthCells: 0.85, heightCells: 0.75, offsetX: 72, offsetY: 58 },
  { regionId: 'region_exhibit', nodeId: 'node_main_exhibit', levelId: 'L10', title: '逸夫楼主展区', interactionId: 'achievement_main_exhibit', order: 10, anchor: 'southEast', widthCells: 0.7, heightCells: 0.8, offsetX: -52, offsetY: 62 },
];

const DEFAULT_SETTINGS: UserSettings = {
  bgmEnabled: true,
  sfxEnabled: true,
  tutorialEnabled: true,
  vibrationEnabled: true,
};

export function createInitialAppState(): AppState {
  return {
    page: 'signin',
    profile: null,
    mode: null,
    room: null,
    selectedNodeId: null,
    unlockedProgress: ['node_campus_gate', 'node_gate_plaza', 'node_road'],
    completedLevelIds: ['L01'],
    bestTimes: {},
    collection: MAP_NODES.map((node, index) => ({
      id: 'card_' + node.levelId.toLowerCase(),
      title: index === 0 ? '临时接线员证' : '漫画卡 ' + index,
      sourceLevelId: node.levelId,
      unlocked: false,
    })),
    completedAchievementIds: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function signinAsGuest(state: AppState, nickname: string): AppState {
  const cleanName = nickname.trim() || '临时接线员';
  return {
    ...state,
    page: 'home',
    profile: {
      playerId: 'local-player',
      nickname: cleanName,
    },
  };
}

export function signinAsProfile(state: AppState, profile: AuthLoginResult): AppState {
  const next = signinAsGuest(state, profile.nickname);
  return {
    ...next,
    profile: {
      ...next.profile!,
      playerId: 'wechat-player',
    },
  };
}

/**
 * 把 C 的 level.list 结果映射到 E 的地图状态。
 * 未知 nodeId 会被忽略，避免服务端旧种子把不存在的节点误画成已解锁。
 */
export function applyCloudLevelList(state: AppState, entries: LevelEntry[]): AppState {
  const knownNodeIds = MAP_NODES.map((node) => node.nodeId);
  const completedLevelIds = entries
    .filter((entry) => entry.status === 'cleared')
    .map((entry) => entry.levelId);
  const unlockedProgress = entries
    .filter((entry) => entry.status === 'cleared')
    .reduce((list, entry) => entry.unlocks.reduce(
      (inner, nodeId) => knownNodeIds.indexOf(nodeId) >= 0 ? addUnique(inner, nodeId) : inner,
      list,
    ), ['node_campus_gate', 'node_gate_plaza']);
  const bestTimes = entries.reduce((times, entry) => {
    if (entry.bestTimeMs > 0) times[entry.levelId] = Math.floor(entry.bestTimeMs / 1000);
    return times;
  }, {} as Record<string, number>);
  return {
    ...state,
    completedLevelIds,
    unlockedProgress,
    bestTimes,
    collection: state.collection.map((entry) => ({
      ...entry,
      unlocked: completedLevelIds.indexOf(entry.sourceLevelId) >= 0,
    })),
  };
}

export function roomSnapshotToState(snapshot: RoomSnapshot): RoomState {
  return {
    roomId: snapshot.code,
    inviteCode: snapshot.code,
    ownerId: snapshot.myViewId === 'A' ? 'wechat-player' : 'room-host',
    playerCount: snapshot.players.length,
    readyCount: snapshot.status === 'playing' ? snapshot.players.length : 1,
  };
}

export function navigateTo(state: AppState, page: PageId): AppState {
  if (page !== 'signin' && state.profile === null) {
    return { ...state, page: 'signin' };
  }
  return { ...state, page };
}

export function selectMode(state: AppState, mode: PlayMode): AppState {
  return {
    ...state,
    mode,
    page: mode === 'duo' ? 'room' : 'map',
    room: mode === 'solo' ? null : state.room,
  };
}

export function createLocalRoom(state: AppState): AppState {
  const ownerId = state.profile ? state.profile.playerId : 'local-player';
  return {
    ...state,
    mode: 'duo',
    page: 'room',
    room: {
      roomId: 'local-room',
      inviteCode: '2048',
      ownerId,
      playerCount: 1,
      readyCount: 1,
    },
  };
}

export function joinLocalRoom(state: AppState, inviteCode: string): AppState {
  const normalized = inviteCode.trim() || '2048';
  const ownerId = state.profile ? state.profile.playerId : 'local-player';
  return {
    ...state,
    mode: 'duo',
    page: 'room',
    room: {
      roomId: 'joined-' + normalized,
      inviteCode: normalized,
      ownerId,
      playerCount: 2,
      readyCount: 1,
    },
  };
}

export function leaveRoom(state: AppState): AppState {
  return {
    ...state,
    room: null,
    page: 'mode',
  };
}

export function getMapNodes(state: AppState): MapNodeView[] {
  return MAP_NODES.map((node) => {
    const completed = state.completedLevelIds.indexOf(node.levelId) >= 0;
    const unlocked = state.unlockedProgress.indexOf(node.nodeId) >= 0;
    return {
      ...node,
      state: completed ? 'completed' : unlocked ? 'unlocked' : 'locked',
      bestTimeSec: state.bestTimes[node.levelId],
      hiddenFound: completed ? 1 : 0,
      hiddenTotal: 1,
    };
  });
}

export function getMapRegions(state: AppState): MapRegionView[] {
  const nodes = getMapNodes(state);
  return MAP_REGIONS.map((region) => {
    const node = nodes.filter((item) => item.nodeId === region.nodeId)[0];
    return {
      ...region,
      state: node ? node.state : 'locked',
      achievementFound: state.completedAchievementIds.indexOf(region.interactionId) >= 0,
    };
  });
}

export function getCampusGates(state: AppState): CampusGateView[] {
  const firstLevelComplete = state.completedLevelIds.indexOf('L01') >= 0
    || state.completedLevelIds.indexOf('level_1') >= 0;
  return [
    { gateId: 'south', title: '南门', unlocked: true },
    { gateId: 'west', title: '西门', unlocked: firstLevelComplete },
    { gateId: 'east', title: '东门', unlocked: firstLevelComplete },
    { gateId: 'north', title: '北门', unlocked: firstLevelComplete },
  ];
}

export function completeMapAchievement(state: AppState, interactionId: string): AppState {
  const region = MAP_REGIONS.filter((item) => item.interactionId === interactionId)[0];
  const completed = region
    && state.completedLevelIds.indexOf(region.levelId) >= 0;
  if (!completed) {
    return state;
  }
  return {
    ...state,
    completedAchievementIds: addUnique(state.completedAchievementIds, interactionId),
  };
}

export function selectMapNode(state: AppState, nodeId: string): AppState {
  const nodes = getMapNodes(state);
  const target = nodes.filter((node) => node.nodeId === nodeId)[0];
  if (!target || target.state === 'locked') {
    return { ...state, selectedNodeId: nodeId };
  }
  return {
    ...state,
    selectedNodeId: nodeId,
    page: 'map',
  };
}

export function getSelectedMapNode(state: AppState): MapNodeView | null {
  if (!state.selectedNodeId) {
    return null;
  }
  const nodes = getMapNodes(state);
  const selected = nodes.filter((node) => node.nodeId === state.selectedNodeId)[0];
  return selected || null;
}

export function startSelectedLevel(state: AppState): AppState {
  const selected = getSelectedMapNode(state);
  if (!selected || selected.state === 'locked') {
    return state;
  }
  return {
    ...state,
    page: 'level-bridge',
  };
}

export function completeLevel(state: AppState, levelId: string, elapsedSec: number, unlockNodeIds: string[]): AppState {
  const completedLevelIds = addUnique(state.completedLevelIds, levelId);
  const unlockedProgress = unlockNodeIds.reduce((list, nodeId) => addUnique(list, nodeId), state.unlockedProgress);
  const oldBest = state.bestTimes[levelId];
  const bestTimes = {
    ...state.bestTimes,
    [levelId]: oldBest === undefined ? elapsedSec : Math.min(oldBest, elapsedSec),
  };
  return {
    ...state,
    page: 'result',
    completedLevelIds,
    unlockedProgress,
    bestTimes,
    collection: state.collection.map((entry) => entry.sourceLevelId === levelId ? { ...entry, unlocked: true } : entry),
  };
}

export function toggleSetting(state: AppState, key: keyof UserSettings): AppState {
  return {
    ...state,
    settings: {
      ...state.settings,
      [key]: !state.settings[key],
    },
  };
}

export function formatTime(sec: number | undefined): string {
  if (sec === undefined) {
    return '--:--';
  }
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return twoDigits(minutes) + ':' + twoDigits(seconds);
}

/**
 * 这关通关后该解锁哪些地图节点。
 *
 * @deprecated 别再用它算解锁 —— 解锁节点是**关卡配置**里的事实（`rewards.progress`），
 * 由 D 的 `LevelReview.unlockedNodeIds` 带出来，直接透传给 `completeLevel` 就行。
 * 这份硬编码写在客户端，和配置一改就对不上（L01 那条原来解了三个节点，配置里只有一个）。
 * 留着只是因为 `uiAppState.test.ts` 还在用它造演示数据。
 */
export function getNextUnlocks(levelId: string): string[] {
  const index = MAP_NODES.map((node) => node.levelId).indexOf(levelId);
  if (index < 0 || index + 1 >= MAP_NODES.length) {
    return [];
  }
  if (levelId === 'GUIDE') {
    return ['node_gate_plaza', 'node_road'];
  }
  if (levelId === 'L01') {
    return ['node_teaching', 'node_library', 'node_canteen'];
  }
  return [MAP_NODES[index + 1].nodeId];
}

function addUnique(list: string[], value: string): string[] {
  return list.indexOf(value) >= 0 ? list : list.concat(value);
}

function twoDigits(value: number): string {
  return value < 10 ? '0' + value : String(value);
}
