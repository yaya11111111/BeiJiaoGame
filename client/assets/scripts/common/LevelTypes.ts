/**
 * 关卡配置的类型定义 —— 与 assets/resources/configs/*.json 的字段一一对应。
 *
 * 「9/22 关卡配置字段冻结」要求冻结的五个字段，在本文件里的位置：
 *   levelId            → LevelConfig.levelId
 *   viewId             → ViewConfig.viewId
 *   assetKey           → ViewConfig.assetKey
 *   nodeId             → HotspotConfig.nodeId / PuzzleConfig.submitNodeId
 *   progress           → RewardConfig.progress
 *
 * 这五个字段改名或改语义，必须走 D（关卡程序）、C（后端）、E（地图）三方确认，
 * 因为 A/B 按 assetKey 出图、C 按 nodeId 存进度、E 按 progress 挂地图节点。
 *
 * 本文件不 import 任何 cc 模块 —— 保持引擎无关，才能在 Node 里直接跑单元测试。
 */

/** 视角标识。单人模式一个玩家切换查看 A、B 两个视角；双人模式两人各持一个。 */
export type ViewId = 'A' | 'B';

/** 对局模式。 */
export type PlayMode = 'solo' | 'duo';

/**
 * 热点（场景里的可点击区域）。
 *
 * rect 的坐标口径 —— 这是 A/B 出图的依据，冻结前必须当面确认：
 *   以「原图左上角」为原点，单位是原图像素，顺序为 [x, y, w, h]，
 *   直接量原图，不用管最终屏幕尺寸和缩放。
 *   好处是 A/B 在图上一量就能填，程序按原图尺寸等比换算到实际屏幕。
 *   注意 Cocos 的节点坐标是「左下」原点，那一步换算放在适配层 LevelView 做，
 *   不要污染这里 —— 否则单人/双人两种屏幕尺寸下热点会错位。
 */
export interface HotspotConfig {
  /** 冻结字段：热点唯一标识，同一关内不可重复 */
  nodeId: string;
  /** [x, y, w, h]，原图像素，左上原点 */
  rect: [number, number, number, number];
  /** pickup = 拾取道具入包 / inspect = 只看一眼、给一段文字 / submit = 提交答案 */
  action: 'pickup' | 'inspect' | 'submit';
  /** action 为 pickup 时必填，道具标识 */
  itemId?: string;
  /** action 为 inspect 时展示的文案 */
  text?: string;
  /** 需要背包里有该道具才可点 —— 跨视角线索的「落点」通常靠这个 */
  requiresItem?: string;
  /** 点击后揭示另一视角的某个热点（对应 nodeId）—— 信息差的核心机制 */
  revealsNode?: string;
  /** 初始不可见，被别的热点通过 revealsNode 揭示后才出现 */
  hiddenByDefault?: boolean;
}

/** 一个视角下的完整画面数据。 */
export interface ViewConfig {
  /** 冻结字段：视角标识 */
  viewId: ViewId;
  /** 冻结字段：背景图资源键，A/B 按这个命名出图 */
  assetKey: string;
  hotspots: HotspotConfig[];
}

/** 本关的谜题规则。 */
export interface PuzzleConfig {
  /** 谜题类型，对应需求评审 FR-07 的三类 + 后续扩展 */
  type: 'route_rebuild' | 'number_match' | 'time_order' | 'item_combine';
  /** 冻结字段：提交按钮所在的热点 nodeId */
  submitNodeId: string;
  /** 标准答案，按顺序比对 */
  answer: string[];
  /** 提交前必须已在背包里的道具 */
  requiredItems?: string[];
  /** 容错次数，超过即判失败。默认 3 */
  maxAttempts?: number;
}

/** 通关奖励。 */
export interface RewardConfig {
  /** 冻结字段：通关后解锁的地图节点，E 的地图按这个挂入口 */
  progress: string[];
}

/** 一个关卡的完整配置。 */
export interface LevelConfig {
  /** 冻结字段：关卡标识，如 L01 / GUIDE */
  levelId: string;
  /** 所属地图章节 */
  chapterId: string;
  title: string;
  /** 支持的模式，MVP 每关都要两种都能进 */
  mode: PlayMode[];
  /** 倒计时秒数，不填表示不限时 */
  timeLimitSec?: number;
  views: Record<ViewId, ViewConfig>;
  puzzle: PuzzleConfig;
  /** 提示梯度，按顺序逐条解锁。项目约定每关 3 段 */
  hints: string[];
  rewards: RewardConfig;
}
