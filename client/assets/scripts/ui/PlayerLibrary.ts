/**
 * 跨关收藏：线索道具 + 关卡彩蛋的本地图鉴数据。
 *
 * 需求（FR-11 / FR-12 / FR-13）把「通关、发现隐藏线索或关卡彩蛋」都算进图鉴，
 * 但服务端目前没有 `library.*` / 彩蛋记录接口（见 `接口需求.md`），D 的关卡配置
 * 也还没有彩蛋字段。所以 E 先把**页面这一侧**做成可用的：
 *
 * - D 的 `LevelReview.items` 里带出来的道具，按 `itemId` 去重后累积；
 * - D 将来在 `LevelReview` 上补 `eggs: { found, total, titles }`，这里直接接住；
 * - 二者都写本地缓存，换次启动还在；接上 C 的收藏接口后把 `load/save` 换掉即可。
 *
 * 这个文件不 import `cc`，也不直接碰 `wx`（存储走 `LocalStore`）。
 */

import type { KeyValueStore } from './LocalStore';
import { readJson, writeJson } from './LocalStore';

export interface CollectedClue {
  itemId: string;
  name: string;
  levelId: string;
  collectedAt: number;
}

export interface EggDiscovery {
  /** `${levelId}:${title}` —— 配置里没有稳定 eggId 之前的去重键 */
  eggId: string;
  title: string;
  levelId: string;
  foundAt: number;
}

export interface PlayerLibrary {
  clues: CollectedClue[];
  eggs: EggDiscovery[];
  /** 关卡 → 该关配置的彩蛋总数（`LevelReview` 给了才记）；没配置就不出现 */
  eggTotals: Record<string, number>;
}

/** D 的 `LevelReview.items` 里 E 用得到的字段（避免 import 关卡运行时） */
export interface CollectedItemLike {
  itemId: string;
  name: string;
  hidden?: boolean;
}

/** 关卡结算带回来的彩蛋结果。D 还没实现，先按这个形状接住。 */
export interface EggSummary {
  found: number;
  total: number;
  /** 本次新发现 / 已发现的彩蛋标题，按配置顺序 */
  titles: string[];
}

export const LIBRARY_STORAGE_KEY = 'bjg:player-library';

export function emptyLibrary(): PlayerLibrary {
  return { clues: [], eggs: [], eggTotals: {} };
}

/**
 * 把一次通关的战利品并进图鉴。
 *
 * **hidden 的道具不收**：那是关卡内部的中间件（第 2 关「已归位碎片」），
 * 玩家从没在背包里见过，收进图鉴只会让人困惑。
 */
export function mergeCollectedClues(
  library: PlayerLibrary,
  levelId: string,
  items: CollectedItemLike[],
  collectedAt: number,
): PlayerLibrary {
  const existing = new Set(library.clues.map((clue) => clue.itemId));
  const added: CollectedClue[] = [];
  for (const item of items) {
    if (!item || !item.itemId || item.hidden) continue;
    if (existing.has(item.itemId)) continue;
    existing.add(item.itemId);
    added.push({
      itemId: item.itemId,
      name: item.name || item.itemId,
      levelId,
      collectedAt,
    });
  }
  if (added.length === 0) return library;
  return { ...library, clues: library.clues.concat(added) };
}

/**
 * 把一次结算里的彩蛋结果并进图鉴。
 *
 * `summary` 为 undefined / total 为 0 时原样返回 —— D 还没配彩蛋的关不会被
 * 画成「0/0」，地图和结算页据此显示「本关暂未配置」。
 */
export function mergeEggDiscoveries(
  library: PlayerLibrary,
  levelId: string,
  summary: EggSummary | undefined,
  foundAt: number,
): PlayerLibrary {
  if (!summary || !Number.isFinite(summary.total) || summary.total <= 0) return library;
  const titles = Array.isArray(summary.titles) ? summary.titles.filter((title) => typeof title === 'string' && title.trim() !== '') : [];
  const existing = new Set(library.eggs.map((egg) => egg.eggId));
  const added: EggDiscovery[] = [];
  for (const title of titles) {
    const eggId = levelId + ':' + title;
    if (existing.has(eggId)) continue;
    existing.add(eggId);
    added.push({ eggId, title, levelId, foundAt });
  }
  const eggTotals = { ...library.eggTotals, [levelId]: Math.max(library.eggTotals[levelId] || 0, Math.floor(summary.total)) };
  const eggs = added.length > 0 ? library.eggs.concat(added) : library.eggs;
  if (added.length === 0 && eggTotals[levelId] === library.eggTotals[levelId]) return library;
  return { ...library, eggs, eggTotals };
}

export function countDiscoveredEggs(library: PlayerLibrary, levelId: string): number {
  return library.eggs.filter((egg) => egg.levelId === levelId).length;
}

export function eggTotalForLevel(library: PlayerLibrary, levelId: string): number {
  const total = library.eggTotals[levelId];
  return typeof total === 'number' && total > 0 ? total : 0;
}

export function cluesForLevel(library: PlayerLibrary, levelId: string): CollectedClue[] {
  return library.clues.filter((clue) => clue.levelId === levelId);
}

/** 读本地缓存。任何脏数据都退成空图鉴，不让页面因为一条旧记录起不来。 */
export function libraryFromUnknown(raw: unknown): PlayerLibrary {
  if (!raw || typeof raw !== 'object') return emptyLibrary();
  const source = raw as Partial<PlayerLibrary>;
  const clues = Array.isArray(source.clues)
    ? source.clues.filter(isCollectedClue).map((clue) => ({ ...clue }))
    : [];
  const eggs = Array.isArray(source.eggs)
    ? source.eggs.filter(isEggDiscovery).map((egg) => ({ ...egg }))
    : [];
  const eggTotals: Record<string, number> = {};
  if (source.eggTotals && typeof source.eggTotals === 'object') {
    for (const levelId of Object.keys(source.eggTotals)) {
      const total = source.eggTotals[levelId];
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) eggTotals[levelId] = Math.floor(total);
    }
  }
  return { clues, eggs, eggTotals };
}

export function loadPlayerLibrary(store: KeyValueStore): PlayerLibrary {
  return libraryFromUnknown(readJson(store, LIBRARY_STORAGE_KEY));
}

export function savePlayerLibrary(store: KeyValueStore, library: PlayerLibrary): void {
  writeJson(store, LIBRARY_STORAGE_KEY, library);
}

function isCollectedClue(value: unknown): value is CollectedClue {
  if (!value || typeof value !== 'object') return false;
  const clue = value as Partial<CollectedClue>;
  return typeof clue.itemId === 'string' && clue.itemId !== ''
    && typeof clue.name === 'string'
    && typeof clue.levelId === 'string'
    && typeof clue.collectedAt === 'number';
}

function isEggDiscovery(value: unknown): value is EggDiscovery {
  if (!value || typeof value !== 'object') return false;
  const egg = value as Partial<EggDiscovery>;
  return typeof egg.eggId === 'string' && egg.eggId !== ''
    && typeof egg.title === 'string'
    && typeof egg.levelId === 'string'
    && typeof egg.foundAt === 'number';
}
