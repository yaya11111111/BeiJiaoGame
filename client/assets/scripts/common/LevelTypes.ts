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

export type PuzzleType = 'route_rebuild' | 'number_match' | 'time_order' | 'item_combine';

/**
 * 有序答案：逐位相等才算对。用于数字密码（["2","4","1"]）、路线顺序、背包顺序。
 */
export type SequenceAnswer = string[];

/**
 * 按键对的答案：键集合相同、每个键的值相等才算对，**顺序无关**。
 * 用于表单填空（{ 岗位: "接线员", 编号: "07" }）、拖放到位、单选（只有一个键）。
 * 表单天然是无序的 —— 玩家先填哪个空不该影响对错。
 */
export type KeyedAnswer = Record<string, string>;

export type PuzzleAnswer = SequenceAnswer | KeyedAnswer;

/** 玩家提交上来的答案，形状要与配置里的 answer 对应 */
export type SubmittedAnswer = PuzzleAnswer;

/** 玩家怎么把答案输进去 */
export type InputKind =
  /** 靠点热点，例如按顺序捡道具（默认） */
  | 'none'
  /** 屏幕上的数字键盘，用于数字密码 */
  | 'numberpad'
  /** 逐项选择填空，用于表单 */
  | 'form';

/**
 * 告诉界面「该画什么输入控件」。
 *
 * 刻意只给控件需要的信息，**不含答案**：
 * - digitCount 会暴露密码位数，但这个位数光看几个空格也知道，不算泄露
 * - fields[].options 里混着正确项和干扰项，界面看不出哪个对
 */
export interface InputSpec {
  kind: InputKind;
  /** kind 为 numberpad 时：要输几位 */
  digitCount: number;
  /** kind 为 form 时：每个空的名字和候选项 */
  fields: { label: string; options: string[] }[];
}

export interface PuzzleConfig {
  type: PuzzleType;
  /**
   * 答案靠「点热点」提交时必填 —— 指的是那个提交热点的 nodeId。
   *
   * `input` 为 'numberpad' / 'form' 时**可以不写**：那种关的提交按钮在输入面板里，
   * 热点上再放一个提交点会变成陷阱 —— 玩家手滑点它会拿背包顺序当答案交上去，
   * 白扣一次机会、甚至触发答错惩罚。
   */
  submitNodeId?: string;
  /**
   * 标准答案。**由形状决定怎么判**，不需要额外字段：
   * - `string[]`   → 有序比，逐位相等
   * - `{键: 值}`   → 按键比，顺序无关
   *
   * 之所以不另加一个 answerKind 字段：数组和对象在 JSON 里没有歧义，
   * 少一个字段 A/B 就少一处写错的机会。
   */
  answer: PuzzleAnswer;
  /** 提交前必须已在背包里 */
  /**
   * 玩家怎么输入。不填 = 'none'，也就是答案靠点热点产生（按顺序捡道具、点提交）。
   * 填 'numberpad' 时 answer 必须是单个数字组成的数组；填 'form' 时 answer 必须是
   * 对象，且要一起给 fieldOptions。
   */
  input?: InputKind;
  /**
   * input 为 'form' 时每个空的可选项。**键必须和 answer 的键完全一致**，
   * 而且**每个空的正确答案必须出现在它自己的候选项里** —— 少了就是永远填不对的死局，
   * 校验层会拦。
   */
  fieldOptions?: Record<string, string[]>;
  /** 提交前必须已在背包里 */
  requiredItems?: string[];
  /** 容错次数，默认 3 */
  maxAttempts?: number;
  /**
   * 答错后锁多少秒不能重交。不填 = 只提示错误，不做任何惩罚。
   *
   * 两种口径都支持是刻意的：第 1 关的红圆章是故意设的辨析项，
   * 答错本身就是玩法的一部分，那种关就不该罚；而密码类的关卡
   * 不加惩罚玩家会一路穷举，所以要能锁。
   */
  wrongCooldownSec?: number;
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
