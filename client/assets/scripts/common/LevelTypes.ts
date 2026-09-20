/**
 * 关卡配置的类型定义，与 assets/resources/configs/*.json 一一对应。
 * 本文件不 import 任何 cc 模块，保持引擎无关，才能在 Node 里直接跑单测。
 *
 * 9/22 冻结的五个字段：levelId / viewId / assetKey / nodeId / progress。
 */

export type ViewId = 'A' | 'B';

export type PlayMode = 'solo' | 'duo';

/**
 * 热点。rect 为 [x, y, w, h]，以原图左上角为原点、单位是原图像素，直接量原图。
 * 换算到 Cocos 的左下原点坐标由适配层做，不污染配置。
 */
export interface HotspotConfig {
  /** 同关内唯一 */
  nodeId: string;
  rect: [number, number, number, number];
  /** pickup 拾取道具 / inspect 给一段文字 / submit 提交答案 */
  action: 'pickup' | 'inspect' | 'submit';
  itemId?: string;
  text?: string;
  /** 需要背包里有该道具才可点 */
  requiresItem?: string;
  /** 点击后揭示另一个 nodeId，通常在另一视角 */
  revealsNode?: string;
  /** 初始不可见，被 revealsNode 揭示后才出现 */
  hiddenByDefault?: boolean;
}

export interface ViewConfig {
  viewId: ViewId;
  /** A/B 按这个命名出图，如 bg/L01_A */
  assetKey: string;
  hotspots: HotspotConfig[];
}

export interface PuzzleConfig {
  type: 'route_rebuild' | 'number_match' | 'time_order' | 'item_combine';
  submitNodeId: string;
  /** 按顺序严格比对 */
  answer: string[];
  /** 提交前必须已在背包里 */
  requiredItems?: string[];
  /** 容错次数，默认 3 */
  maxAttempts?: number;
}

export interface RewardConfig {
  /** 通关解锁的地图节点，E 的地图按这个挂入口 */
  progress: string[];
}

export interface LevelConfig {
  levelId: string;
  chapterId: string;
  title: string;
  mode: PlayMode[];
  /** 不填表示不限时 */
  timeLimitSec?: number;
  views: Record<ViewId, ViewConfig>;
  puzzle: PuzzleConfig;
  /** 提示梯度，按顺序解锁 */
  hints: string[];
  rewards: RewardConfig;
}
