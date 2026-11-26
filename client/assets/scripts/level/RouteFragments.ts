import { readJson, writeJson } from '../ui/LocalStore';
import type { KeyValueStore } from '../ui/LocalStore';
import { loadPlayerLibrary } from '../ui/PlayerLibrary';

export const ROUTE_BOOK_KEY = 'bjg:d:route-fragments:v1';
export const ROUTE_FRAGMENTS = ['route_fragment_1', 'route_fragment_2', 'route_fragment_3'];
export interface RouteBookState { fragments: string[]; assembled: number }

/** D 的线路拼图记录；只读已有图鉴，不改 E 的收藏结构或云端协议。 */
export function readRouteBook(store: KeyValueStore): RouteBookState {
  const raw = readJson(store, ROUTE_BOOK_KEY) as Partial<RouteBookState> | null;
  const ids = Array.isArray(raw?.fragments) ? raw!.fragments! : [];
  const clues = loadPlayerLibrary(store).clues.map(clue => clue.itemId);
  const fragments = ROUTE_FRAGMENTS.filter(id => ids.indexOf(id) >= 0 || clues.indexOf(id) >= 0);
  const maximum = fragments.length === 3 ? 3 : fragments.indexOf('route_fragment_1') >= 0
    && fragments.indexOf('route_fragment_2') >= 0 ? 2 : 0;
  return { fragments, assembled: raw?.assembled === 3 && maximum === 3 ? 3
    : (raw?.assembled === 2 || raw?.assembled === 3) && maximum >= 2 ? 2 : 0 };
}

export function collectRouteFragment(store: KeyValueStore, itemId: string): void {
  if (ROUTE_FRAGMENTS.indexOf(itemId) < 0) return;
  const state = readRouteBook(store);
  if (state.fragments.indexOf(itemId) >= 0) return;
  state.fragments.push(itemId);
  writeJson(store, ROUTE_BOOK_KEY, state);
}

export function completeRoutePuzzle(store: KeyValueStore, stage: 2 | 3): boolean {
  const state = readRouteBook(store);
  if (ROUTE_FRAGMENTS.slice(0, stage).some(id => state.fragments.indexOf(id) < 0)) return false;
  if (stage === 3 && state.assembled < 2) return false;
  writeJson(store, ROUTE_BOOK_KEY, { ...state, assembled: Math.max(state.assembled, stage) });
  return true;
}

export interface RoutePuzzleSpec {
  stage: 2 | 3;
  size: { width: number; height: number };
  base: { key: string; rect: [number, number, number, number] };
  piece: { key: string; rect: [number, number, number, number] };
  result: string;
}

/** 原始碎片与现有合成图的摆放关系，坐标均以结果图为基准。 */
export function routePuzzleSpec(stage: 2 | 3): RoutePuzzleSpec {
  return stage === 2 ? {
    stage, size: { width: 1527, height: 1248 },
    base: { key: 'details/L04_route_fragment_01', rect: [7, 291, 785, 956] },
    piece: { key: 'details/L06_route_fragment_02', rect: [52, 1, 1471, 969] },
    result: 'details/L06_route_fragment_02_01',
  } : {
    stage, size: { width: 1606, height: 979 },
    base: { key: 'details/L06_route_fragment_02_01', rect: [504, 139, 987, 806] },
    piece: { key: 'details/L07_route_fragment_03', rect: [-3, 5, 573, 915] },
    result: 'details/L07_route_fragment_03_02_01',
  };
}

/** 容差按显示画幅计算；大小屏幕的吸附手感保持一致。 */
export function routePieceFits(dx: number, dy: number, width: number, height: number): boolean {
  return Math.hypot(dx, dy) <= Math.min(width, height) * 0.09;
}


/** Merge the team's collected route clues without overwriting either player's history. */
export function mergeRouteBook(store: KeyValueStore, incoming: RouteBookState): void {
  const current = readRouteBook(store);
  const fragments = ROUTE_FRAGMENTS.filter(id => current.fragments.indexOf(id) >= 0 || incoming.fragments.indexOf(id) >= 0);
  const proposed = Math.max(current.assembled,incoming.assembled);
  const assembled = fragments.length === 3 && proposed >= 3 ? 3 : fragments.indexOf(ROUTE_FRAGMENTS[0]) >= 0 && fragments.indexOf(ROUTE_FRAGMENTS[1]) >= 0 && proposed >= 2 ? 2 : 0;
  writeJson(store,ROUTE_BOOK_KEY,{fragments,assembled});
}
