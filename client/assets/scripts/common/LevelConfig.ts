/**
 * 关卡配置的解析与校验。
 *
 * 配置来自 assets/resources/configs/*.json（后续也可能从后端下发），是 unknown JSON，
 * 必须先过这里校验成 LevelConfig 再交给 LevelRuntime。校验失败要直接抛错、
 * 并把「哪个关卡、哪个字段」写清楚 —— 关卡一多，配置写错是最高频的故障源，
 * 报错信息不清楚会白耗大量排查时间。
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
    throw new LevelConfigError(levelId, `${where}.nodeId 重复：${nodeId}（同一关内 nodeId 必须唯一）`);
  }
  seenNodeIds.add(nodeId);

  // rect：必须是 4 个有限数
  const rect = raw.rect;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new LevelConfigError(levelId, `${where}.rect 必须是 4 个数字 [x, y, w, h]，实际是 ${JSON.stringify(rect)}`);
  }
  const [x, y, w, h] = rect as number[];
  if (w <= 0 || h <= 0) {
    throw new LevelConfigError(levelId, `${where}.rect 的宽高必须大于 0，实际是 w=${w} h=${h}（左上原点，原图像素）`);
  }

  const action = raw.action;
  if (typeof action !== 'string' || !(HOTSPOT_ACTIONS as readonly string[]).includes(action)) {
    throw new LevelConfigError(
      levelId,
      `${where}.action 必须是 ${HOTSPOT_ACTIONS.join(' / ')} 之一，实际是 ${JSON.stringify(action)}`,
    );
  }

  const hotspot: HotspotConfig = {
    nodeId,
    rect: [x, y, w, h],
    action: action as HotspotConfig['action'],
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

  // pickup 必须带 itemId，否则点了没有东西入包
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

  // 允许配置里省略 viewId 字段，以键名为准；写了就必须一致，防止复制粘贴改漏
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

  const type = raw.type;
  if (typeof type !== 'string' || !(PUZZLE_TYPES as readonly string[]).includes(type)) {
    throw new LevelConfigError(
      levelId,
      `${where}.type 必须是 ${PUZZLE_TYPES.join(' / ')} 之一，实际是 ${JSON.stringify(type)}`,
    );
  }

  const answer = requireStringArray(levelId, raw, 'answer', where);
  if (answer.length === 0) {
    throw new LevelConfigError(levelId, `${where}.answer 不能是空数组`);
  }

  const puzzle: LevelConfig['puzzle'] = {
    type: type as LevelConfig['puzzle']['type'],
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

/**
 * 把 unknown 的 JSON 校验并转换成 LevelConfig。
 * 任何一项不合规都抛 LevelConfigError，信息里带 levelId 和字段路径。
 */
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
    throw new LevelConfigError(levelId, 'hints 不能为空，项目约定每关 3 段提示');
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

  // 提交热点必须真实存在，否则玩家永远提交不了，且这种错在运行时才暴露、很难查
  const allNodeIds = new Set<string>();
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) allNodeIds.add(hs.nodeId);
  }
  if (!allNodeIds.has(config.puzzle.submitNodeId)) {
    throw new LevelConfigError(
      levelId,
      `puzzle.submitNodeId 指向的节点不存在：${config.puzzle.submitNodeId}。现有节点：${[...allNodeIds].join(', ')}`,
    );
  }

  // revealsNode 指向的节点必须存在，否则信息差线索会永远点不出来
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) {
      if (hs.revealsNode && !allNodeIds.has(hs.revealsNode)) {
        throw new LevelConfigError(levelId, `${hs.nodeId}.revealsNode 指向的节点不存在：${hs.revealsNode}`);
      }
    }
  }

  // requiredItems / requiresItem 必须是真实存在的道具，否则关卡会变成死局
  const allItemIds = new Set<string>();
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) {
      if (hs.itemId) allItemIds.add(hs.itemId);
    }
  }
  for (const item of config.puzzle.requiredItems ?? []) {
    if (!allItemIds.has(item)) {
      throw new LevelConfigError(levelId, `puzzle.requiredItems 里的道具在任何热点里都拿不到：${item}（会是死局）`);
    }
  }
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) {
      if (hs.requiresItem && !allItemIds.has(hs.requiresItem)) {
        throw new LevelConfigError(levelId, `${hs.nodeId}.requiresItem 指向的道具拿不到：${hs.requiresItem}（会是死局）`);
      }
    }
  }

  return config;
}

/** 单关配置的索引：nodeId → 它属于哪个视角，方便运行时按 nodeId 反查。 */
export interface LevelIndex {
  /** nodeId → { viewId, hotspot } */
  readonly nodes: ReadonlyMap<string, { viewId: ViewId; hotspot: HotspotConfig }>;
}

/** 建立索引。校验阶段已保证 nodeId 唯一，这里可以直接覆盖写。 */
export function buildIndex(config: LevelConfig): LevelIndex {
  const nodes = new Map<string, { viewId: ViewId; hotspot: HotspotConfig }>();
  for (const viewId of VIEW_IDS) {
    for (const hotspot of config.views[viewId].hotspots) {
      nodes.set(hotspot.nodeId, { viewId, hotspot });
    }
  }
  return { nodes };
}
