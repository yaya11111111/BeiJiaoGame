/**
 * 关卡配置的解析与校验。配置是 unknown JSON，必须先过这里再交给 LevelRuntime。
 *
 * 校验比看起来严，是因为关卡配置写错是最高频的故障源，而且「死局」这类错
 * 只在玩到一半才暴露、极难排查，所以在加载阶段就拦下并指明是哪个字段。
 *
 * 本文件不 import 任何 cc 模块。
 */

import type { HotspotConfig, LevelConfig, ViewConfig, ViewId } from './LevelTypes';

export class LevelConfigError extends Error {
  constructor(levelId: string, detail: string) {
    super(`关卡配置错误 [${levelId}]：${detail}`);
    this.name = 'LevelConfigError';
  }
}

const VIEW_IDS: ViewId[] = ['A', 'B'];
const HOTSPOT_ACTIONS = ['pickup', 'inspect', 'submit'] as const;
const PUZZLE_TYPES = ['route_rebuild', 'number_match', 'time_order', 'item_combine'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 不用 Array.prototype.includes：Cocos 的 target 是 ES2015，而 includes 是 ES2016
function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).indexOf(value) !== -1;
}

function requireString(levelId: string, obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new LevelConfigError(levelId, `${where}.${key} 必须是非空字符串，实际是 ${JSON.stringify(v)}`);
  }
  return v;
}

function requireStringArray(levelId: string, obj: Record<string, unknown>, key: string, where: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
    throw new LevelConfigError(levelId, `${where}.${key} 必须是字符串数组，实际是 ${JSON.stringify(v)}`);
  }
  return v as string[];
}

function parseHotspot(levelId: string, raw: unknown, where: string, seenNodeIds: Set<string>): HotspotConfig {
  if (!isPlainObject(raw)) {
    throw new LevelConfigError(levelId, `${where} 必须是对象`);
  }

  const nodeId = requireString(levelId, raw, 'nodeId', where);
  if (seenNodeIds.has(nodeId)) {
    throw new LevelConfigError(levelId, `${where}.nodeId 重复：${nodeId}`);
  }
  seenNodeIds.add(nodeId);

  const rect = raw.rect;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new LevelConfigError(levelId, `${where}.rect 必须是 4 个数字 [x, y, w, h]，实际是 ${JSON.stringify(rect)}`);
  }
  const [x, y, w, h] = rect as number[];
  if (w <= 0 || h <= 0) {
    throw new LevelConfigError(levelId, `${where}.rect 的宽高必须大于 0，实际是 w=${w} h=${h}`);
  }

  if (!isOneOf(HOTSPOT_ACTIONS, raw.action)) {
    throw new LevelConfigError(
      levelId,
      `${where}.action 必须是 ${HOTSPOT_ACTIONS.join(' / ')} 之一，实际是 ${JSON.stringify(raw.action)}`,
    );
  }

  const hotspot: HotspotConfig = {
    nodeId,
    rect: [x, y, w, h],
    action: raw.action,
  };

  if (raw.itemId !== undefined) hotspot.itemId = requireString(levelId, raw, 'itemId', where);
  if (raw.text !== undefined) hotspot.text = requireString(levelId, raw, 'text', where);
  if (raw.requiresItem !== undefined) hotspot.requiresItem = requireString(levelId, raw, 'requiresItem', where);
  if (raw.revealsNode !== undefined) hotspot.revealsNode = requireString(levelId, raw, 'revealsNode', where);
  if (raw.hiddenByDefault !== undefined) {
    if (typeof raw.hiddenByDefault !== 'boolean') {
      throw new LevelConfigError(levelId, `${where}.hiddenByDefault 必须是布尔值`);
    }
    hotspot.hiddenByDefault = raw.hiddenByDefault;
  }

  if (hotspot.action === 'pickup' && !hotspot.itemId) {
    throw new LevelConfigError(levelId, `${where} 的 action 是 pickup，必须提供 itemId`);
  }

  return hotspot;
}

function parseView(levelId: string, raw: unknown, viewId: ViewId, seenNodeIds: Set<string>): ViewConfig {
  const where = `views.${viewId}`;
  if (!isPlainObject(raw)) {
    throw new LevelConfigError(levelId, `${where} 必须是对象`);
  }

  // 允许省略 viewId，以键名为准；写了就必须一致，防止复制粘贴改漏
  if (raw.viewId !== undefined && raw.viewId !== viewId) {
    throw new LevelConfigError(
      levelId,
      `${where}.viewId 与键名不一致：键名是 ${viewId}，字段写的是 ${JSON.stringify(raw.viewId)}`,
    );
  }

  const hotspotsRaw = raw.hotspots;
  if (!Array.isArray(hotspotsRaw)) {
    throw new LevelConfigError(levelId, `${where}.hotspots 必须是数组`);
  }

  return {
    viewId,
    assetKey: requireString(levelId, raw, 'assetKey', where),
    hotspots: hotspotsRaw.map((h, i) => parseHotspot(levelId, h, `${where}.hotspots[${i}]`, seenNodeIds)),
  };
}

function parsePuzzle(levelId: string, raw: unknown): LevelConfig['puzzle'] {
  const where = 'puzzle';
  if (!isPlainObject(raw)) {
    throw new LevelConfigError(levelId, `${where} 必须是对象`);
  }

  if (!isOneOf(PUZZLE_TYPES, raw.type)) {
    throw new LevelConfigError(
      levelId,
      `${where}.type 必须是 ${PUZZLE_TYPES.join(' / ')} 之一，实际是 ${JSON.stringify(raw.type)}`,
    );
  }

  const answer = requireStringArray(levelId, raw, 'answer', where);
  if (answer.length === 0) {
    throw new LevelConfigError(levelId, `${where}.answer 不能是空数组`);
  }

  const puzzle: LevelConfig['puzzle'] = {
    type: raw.type,
    submitNodeId: requireString(levelId, raw, 'submitNodeId', where),
    answer,
  };

  if (raw.requiredItems !== undefined) {
    puzzle.requiredItems = requireStringArray(levelId, raw, 'requiredItems', where);
  }
  if (raw.maxAttempts !== undefined) {
    if (typeof raw.maxAttempts !== 'number' || !Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 1) {
      throw new LevelConfigError(levelId, `${where}.maxAttempts 必须是 >= 1 的整数`);
    }
    puzzle.maxAttempts = raw.maxAttempts;
  }

  return puzzle;
}

export function parseLevelConfig(raw: unknown, fallbackId = '<未知关卡>'): LevelConfig {
  if (!isPlainObject(raw)) {
    throw new LevelConfigError(fallbackId, '配置根节点必须是对象');
  }

  const levelId = requireString(fallbackId, raw, 'levelId', '<root>');

  const seenNodeIds = new Set<string>();
  const viewsRaw = raw.views;
  if (!isPlainObject(viewsRaw)) {
    throw new LevelConfigError(levelId, 'views 必须是对象，且包含 A 和 B 两个视角');
  }

  const views = {} as Record<ViewId, ViewConfig>;
  for (const viewId of VIEW_IDS) {
    if (viewsRaw[viewId] === undefined) {
      throw new LevelConfigError(levelId, `views.${viewId} 缺失，单人和双人模式都要求两个视角都存在`);
    }
    views[viewId] = parseView(levelId, viewsRaw[viewId], viewId, seenNodeIds);
  }

  const modeRaw = raw.mode;
  if (!Array.isArray(modeRaw) || modeRaw.length === 0 || modeRaw.some((m) => m !== 'solo' && m !== 'duo')) {
    throw new LevelConfigError(levelId, `mode 必须是 ['solo'] / ['duo'] / ['solo','duo'] 之一`);
  }

  const hints = requireStringArray(levelId, raw, 'hints', '<root>');
  if (hints.length === 0) {
    throw new LevelConfigError(levelId, 'hints 不能为空');
  }

  const rewardsRaw = raw.rewards;
  if (!isPlainObject(rewardsRaw)) {
    throw new LevelConfigError(levelId, 'rewards 必须是对象');
  }

  const config: LevelConfig = {
    levelId,
    chapterId: requireString(levelId, raw, 'chapterId', '<root>'),
    title: requireString(levelId, raw, 'title', '<root>'),
    mode: modeRaw as LevelConfig['mode'],
    views,
    puzzle: parsePuzzle(levelId, raw.puzzle),
    hints,
    rewards: { progress: requireStringArray(levelId, rewardsRaw, 'progress', 'rewards') },
  };

  if (raw.timeLimitSec !== undefined) {
    if (typeof raw.timeLimitSec !== 'number' || !(raw.timeLimitSec > 0)) {
      throw new LevelConfigError(levelId, 'timeLimitSec 必须是大于 0 的数字');
    }
    config.timeLimitSec = raw.timeLimitSec;
  }

  const allNodeIds = new Set<string>();
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) allNodeIds.add(hs.nodeId);
  }

  // 下面三条是死局检测：配置写错会让关卡永远通不了
  if (!allNodeIds.has(config.puzzle.submitNodeId)) {
    throw new LevelConfigError(
      levelId,
      `puzzle.submitNodeId 指向的节点不存在：${config.puzzle.submitNodeId}。现有节点：${[...allNodeIds].join(', ')}`,
    );
  }

  const allItemIds = new Set<string>();
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) {
      if (hs.itemId) allItemIds.add(hs.itemId);
      if (hs.revealsNode && !allNodeIds.has(hs.revealsNode)) {
        throw new LevelConfigError(levelId, `${hs.nodeId}.revealsNode 指向的节点不存在：${hs.revealsNode}`);
      }
    }
  }

  for (const item of config.puzzle.requiredItems ?? []) {
    if (!allItemIds.has(item)) {
      throw new LevelConfigError(levelId, `puzzle.requiredItems 里的道具拿不到：${item}（死局）`);
    }
  }
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) {
      if (hs.requiresItem && !allItemIds.has(hs.requiresItem)) {
        throw new LevelConfigError(levelId, `${hs.nodeId}.requiresItem 指向的道具拿不到：${hs.requiresItem}（死局）`);
      }
    }
  }

  return config;
}

export interface LevelIndex {
  /** nodeId → 它属于哪个视角 */
  readonly nodes: ReadonlyMap<string, { viewId: ViewId; hotspot: HotspotConfig }>;
}

export function buildIndex(config: LevelConfig): LevelIndex {
  const nodes = new Map<string, { viewId: ViewId; hotspot: HotspotConfig }>();
  for (const viewId of VIEW_IDS) {
    for (const hotspot of config.views[viewId].hotspots) {
      nodes.set(hotspot.nodeId, { viewId, hotspot });
    }
  }
  return { nodes };
}
