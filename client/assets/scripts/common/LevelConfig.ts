/**
 * 关卡配置的解析与校验。配置是 unknown JSON，必须先过这里再交给 LevelRuntime。
 *
 * 校验比看起来严，是因为关卡配置写错是最高频的故障源，而且「死局」这类错
 * 只在玩到一半才暴露、极难排查，所以在加载阶段就拦下并指明是哪个字段。
 *
 * 本文件不 import 任何 cc 模块。
 */

import type { HotspotConfig, LevelConfig, PuzzleAnswer, ViewConfig, ViewId } from './LevelTypes';
import { setToArray } from './Collections';

export class LevelConfigError extends Error {
  constructor(levelId: string, detail: string) {
    super(`关卡配置错误 [${levelId}]：${detail}`);
    this.name = 'LevelConfigError';
  }
}

const VIEW_IDS: ViewId[] = ['A', 'B'];
const HOTSPOT_ACTIONS = ['pickup', 'inspect', 'submit', 'use'] as const;
const PUZZLE_TYPES = ['route_rebuild', 'number_match', 'time_order', 'item_combine'] as const;
const INPUT_KINDS = ['none', 'numberpad', 'form'] as const;

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

  if (raw.itemId !== undefined) {
    // 字符串 = 拿一件；数组 = 一次拿多件（工具盒那种）
    if (Array.isArray(raw.itemId)) {
      const ids = requireStringArray(levelId, raw, 'itemId', where);
      if (ids.length === 0) {
        throw new LevelConfigError(levelId, `${where}.itemId 写成数组时不能为空`);
      }
      hotspot.itemId = ids;
    } else {
      hotspot.itemId = requireString(levelId, raw, 'itemId', where);
    }
  }
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

  if (raw.acceptedItems !== undefined) {
    const accepted = requireStringArray(levelId, raw, 'acceptedItems', where);
    if (accepted.length === 0) {
      throw new LevelConfigError(levelId, `${where}.acceptedItems 不能是空数组`);
    }
    hotspot.acceptedItems = accepted;
  }
  if (raw.consumes !== undefined) hotspot.consumes = requireStringArray(levelId, raw, 'consumes', where);
  if (raw.produces !== undefined) hotspot.produces = requireString(levelId, raw, 'produces', where);
  if (raw.successText !== undefined) hotspot.successText = requireString(levelId, raw, 'successText', where);
  if (raw.rejectText !== undefined) hotspot.rejectText = requireString(levelId, raw, 'rejectText', where);

  // action 是 use 却没有认可的道具 → 玩家挑什么都对，这个热点没有意义
  if (hotspot.action === 'use' && !hotspot.acceptedItems) {
    throw new LevelConfigError(levelId, `${where} 的 action 是 use，必须提供 acceptedItems（认可哪些道具）`);
  }
  // 反过来，不是 use 却写了这些字段，是复制粘贴改漏了
  if (hotspot.action !== 'use' && (hotspot.acceptedItems || hotspot.consumes || hotspot.produces)) {
    throw new LevelConfigError(
      levelId,
      `${where} 的 action 是 ${hotspot.action}，却写了 acceptedItems / consumes / produces —— ` +
        '这几个字段只有 action 为 use 时才生效',
    );
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

/**
 * 解析标准答案。形状决定语义，所以这里同时承担「告诉写配置的人他写的是哪种」的职责：
 * - 数组 → 有序答案
 * - 对象 → 按键答案
 * 写成别的东西（数字、字符串、空对象）时要把话说明白，否则运行时才炸。
 */
function parseAnswer(levelId: string, obj: Record<string, unknown>, where: string): PuzzleAnswer {
  const raw = obj.answer;

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new LevelConfigError(levelId, `${where}.answer 是数组时不能为空`);
    }
    if (raw.some((v) => typeof v !== 'string')) {
      throw new LevelConfigError(levelId, `${where}.answer 是数组时每一项都必须是字符串`);
    }
    return raw as string[];
  }

  if (isPlainObject(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      throw new LevelConfigError(levelId, `${where}.answer 是对象时不能为空`);
    }
    const keyed: Record<string, string> = {};
    for (const key of keys) {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) {
        throw new LevelConfigError(
          levelId,
          `${where}.answer 是对象时，每一项的值都必须是非空字符串，但 "${key}" 是 ${JSON.stringify(value)}`,
        );
      }
      keyed[key] = value;
    }
    return keyed;
  }

  throw new LevelConfigError(
    levelId,
    `${where}.answer 必须是数组（有序答案）或对象（按键答案），实际是 ${JSON.stringify(raw)}`,
  );
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

  const puzzle: LevelConfig['puzzle'] = {
    type: raw.type,
    answer: parseAnswer(levelId, raw, where),
  };

  // 先解析输入方式：它决定 submitNodeId 是必填还是可选
  parseInput(levelId, raw, puzzle);

  if (raw.submitNodeId !== undefined) {
    puzzle.submitNodeId = requireString(levelId, raw, 'submitNodeId', where);
  } else if (puzzle.input === 'none') {
    // 答案靠点热点提交的关卡，没有提交点就没有提交方式 —— 这是死局
    throw new LevelConfigError(
      levelId,
      `${where}.submitNodeId 缺失。答案靠点热点提交的关卡必须写它；` +
        "用输入面板的关卡（input 为 'numberpad' / 'form'）才可以不写",
    );
  }

  if (raw.requiredItems !== undefined) {
    puzzle.requiredItems = requireStringArray(levelId, raw, 'requiredItems', where);
  }
  if (raw.maxAttempts !== undefined) {
    if (typeof raw.maxAttempts !== 'number' || !Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 1) {
      throw new LevelConfigError(levelId, `${where}.maxAttempts 必须是 >= 1 的整数`);
    }
    puzzle.maxAttempts = raw.maxAttempts;
  }
  if (raw.wrongCooldownSec !== undefined) {
    if (typeof raw.wrongCooldownSec !== 'number' || !(raw.wrongCooldownSec > 0)) {
      // 0 是常见的写错法 —— 多半是想表达「不惩罚」，那就该整个字段都不写
      throw new LevelConfigError(
        levelId,
        `${where}.wrongCooldownSec 必须是大于 0 的数字；不想惩罚就不要写这个字段，而不是写 0`,
      );
    }
    puzzle.wrongCooldownSec = raw.wrongCooldownSec;
  }

  return puzzle;
}

/**
 * 解析「玩家怎么输入」，并检查输入方式和答案是否自洽。
 *
 * 这里的两条死局检测很关键，因为写错的表现是「这关永远通不了」，
 * 而且只有玩到一半才会发现：
 * - numberpad 只能打 0-9 一位数字，答案里出现 "10" 或字母就永远输不出来
 * - form 的候选项里如果没有正确答案，玩家点遍所有选项都填不对
 */
function parseInput(levelId: string, raw: Record<string, unknown>, puzzle: LevelConfig['puzzle']): void {
  const where = 'puzzle';
  const input = raw.input;

  if (input === undefined) {
    puzzle.input = 'none';
    return;
  }
  if (!isOneOf(INPUT_KINDS, input)) {
    throw new LevelConfigError(
      levelId,
      `${where}.input 必须是 ${INPUT_KINDS.join(' / ')} 之一，实际是 ${JSON.stringify(input)}`,
    );
  }
  puzzle.input = input;

  if (input === 'numberpad') {
    if (!Array.isArray(puzzle.answer)) {
      throw new LevelConfigError(levelId, `${where}.input 是 numberpad 时，answer 必须是数字数组`);
    }
    const bad = puzzle.answer.filter((digit) => !/^[0-9]$/.test(digit));
    if (bad.length > 0) {
      throw new LevelConfigError(
        levelId,
        `${where}.answer 里有数字键盘打不出来的项：${bad.join(', ')}（只能是一位 0-9，死局）`,
      );
    }
    return;
  }

  if (input === 'form') {
    if (Array.isArray(puzzle.answer)) {
      throw new LevelConfigError(levelId, `${where}.input 是 form 时，answer 必须写成对象（空名 → 正确答案）`);
    }

    const optionsRaw = raw.fieldOptions;
    if (!isPlainObject(optionsRaw)) {
      throw new LevelConfigError(levelId, `${where}.input 是 form 时必须提供 fieldOptions`);
    }

    const labels = Object.keys(puzzle.answer);
    for (const label of labels) {
      if (optionsRaw[label] === undefined) {
        throw new LevelConfigError(levelId, `${where}.fieldOptions 缺少 "${label}" 这一项的候选项`);
      }
    }
    for (const key of Object.keys(optionsRaw)) {
      if (labels.indexOf(key) === -1) {
        throw new LevelConfigError(
          levelId,
          `${where}.fieldOptions 里的 "${key}" 在 answer 里没有对应的空，两边必须一一对应`,
        );
      }
    }

    const fieldOptions: Record<string, string[]> = {};
    for (const label of labels) {
      const list = optionsRaw[label];
      if (!Array.isArray(list) || list.length === 0 || list.some((v) => typeof v !== 'string')) {
        throw new LevelConfigError(levelId, `${where}.fieldOptions.${label} 必须是至少一项的字符串数组`);
      }
      const values = list as string[];
      if (values.indexOf(puzzle.answer[label]) === -1) {
        throw new LevelConfigError(
          levelId,
          `${where}.fieldOptions.${label} 里没有正确答案，玩家点遍所有选项也填不对（死局）`,
        );
      }
      fieldOptions[label] = values;
    }
    puzzle.fieldOptions = fieldOptions;
  }
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
  const submitNodeId = config.puzzle.submitNodeId;
  if (submitNodeId !== undefined && !allNodeIds.has(submitNodeId)) {
    throw new LevelConfigError(
      levelId,
      `puzzle.submitNodeId 指向的节点不存在：${submitNodeId}。现有节点：${setToArray(allNodeIds).join(', ')}`,
    );
  }

  const allItemIds = new Set<string>();
  for (const viewId of VIEW_IDS) {
    for (const hs of views[viewId].hotspots) {
      // itemId 可能是字符串也可能是数组（一次拿多件），两种都要收进全集，
      // 否则后面的死局检测会把「工具盒给的那两件」当成拿不到
      if (typeof hs.itemId === 'string') allItemIds.add(hs.itemId);
      else if (Array.isArray(hs.itemId)) for (const id of hs.itemId) allItemIds.add(id);

      // 道具也可能由 use 热点合成出来（空白券 + 蓝方章 → 已盖章的券）。
      // 只算 pickup 的话，那些**合成产物**会被误判成「拿不到」而拦住一个合法配置
      if (hs.produces) allItemIds.add(hs.produces);
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
      // use 热点也要查：认可的道具和要消耗的道具，玩家必须拿得到，
      // 否则这个热点永远用不了 —— 而这类错只玩到一半才暴露
      for (const item of hs.acceptedItems ?? []) {
        if (!allItemIds.has(item)) {
          throw new LevelConfigError(levelId, `${hs.nodeId}.acceptedItems 里的道具拿不到：${item}（死局）`);
        }
      }
      for (const item of hs.consumes ?? []) {
        if (!allItemIds.has(item)) {
          throw new LevelConfigError(levelId, `${hs.nodeId}.consumes 里的道具拿不到：${item}（死局）`);
        }
      }
    }
  }

  return config;
}

/**
 * levelId → `resources.load()` 的路径（相对 resources/、不带扩展名）。
 * GUIDE → configs/level.guide；L01 → configs/level.01。
 *
 * 映射写死在这里而不是就地拼字符串，是为了让「文件名不合规」在加载前就
 * 抛出来。否则拼错的路径会被 `resources.load()` 吃下去，回一个语焉不详的
 * 失败，排查要绕一大圈才想到是命名对不上。
 */
export function levelConfigPath(levelId: string): string {
  if (levelId === 'GUIDE') return 'configs/level.guide';
  if (/^L\d{2}$/.test(levelId)) return `configs/level.${levelId.slice(1)}`;
  throw new LevelConfigError(levelId, `levelId 必须是 GUIDE 或 L01~L99，实际是 ${JSON.stringify(levelId)}`);
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
