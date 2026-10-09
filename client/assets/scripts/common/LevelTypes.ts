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
  /**
   * pickup 拾取道具 / inspect 给一段文字 / submit 提交答案
   * / use 在某个装置上使用一件道具（玩家自己从背包里挑，可以挑错）
   */
  action: 'pickup' | 'inspect' | 'submit' | 'use' | 'goto';
  /**
   * pickup 拿到的道具。写字符串是拿一件，写数组是**一次拿多件**
   * （第 1 关的工具盒同时给蓝方印章和磁吸杆）。
   */
  itemId?: string | string[];
  text?: string;
  /**
   * 特写图（放大图）的资源 key，放在 `assets/resources/details/` 下。
   *
   * 点这个热点时弹出一张放大的图，**只有关闭功能，图本身不能互动** ——
   * 目的是让玩家看清背景图里太小、看不清文字或细节的物件。
   *
   * 触发时机按 action 分两种：
   * - `inspect`：点击时弹（和 `text` 一起，文字进线索栏、图弹出来）
   * - `use`：**操作成功后**才弹（海报那种「翻开之后才看得清」的场景）
   *
   * 不填就是没有特写图，行为和以前完全一样。图找不到时只打日志、不弹，
   * 原有的文字和面板照常 —— 免得 A/B 漏交一张图就把关卡卡住。
   */
  detailKey?: string;
  /** 需要背包里有该道具才可点 */
  requiresItem?: string;
  /** 点击后揭示另一个 nodeId，通常在另一视角 */
  revealsNode?: string;
  /** 初始不可见，被 revealsNode 揭示后才出现 */
  hiddenByDefault?: boolean;
  /**
   * 这个热点属于哪个**场景**。
   *
   * **只在写了 `scenes` 的视角里有意义**：写了就只在该场景出现、也只有那时能点；
   * 不写 = 不管在哪个场景都出现（单场景视角不用写）。
   * 第 2 关的 A 视角靠它把「岔路 1 的两条路」和「岔路 2 的两条路」分开。
   */
  scene?: string;
  /**
   * `action: 'goto'` 专用：点了切到哪个场景（必须是**本视角**里存在的场景 id）。
   *
   * 导航用 —— 不拿道具、不给文字、不消耗次数，失败了也没有代价。
   * 第 2 关的「点这条路」「往前走」「点错的那一侧」都是它。
   */
  gotoScene?: string;

  /**
   * 以下是 action 为 'use' 时用的。配方写在热点自己身上，不用跑到别处对照。
   *
   * 玩家点这个热点 → 弹出背包让他挑一件道具 → 挑中的在 acceptedItems 里才算对。
   * 「挑错」是**软拒绝**（不当答错扣次数）：翻物件本来就是探索，
   * 罚得太重玩家就不敢点了。设计稿里「红圆章是辨析项」靠的就是这一步 ——
   * 挑红圆章会被拒，玩家得先拿到 B 的排除线索才知道该用蓝的。
   */
  /** 认可的道具。玩家挑中其中一件才算对 */
  acceptedItems?: string[];
  /**
   * 固定的几个选项，玩家选一个。和 acceptedItems 的区别是：
   * 这里的选项**不来自背包**，是现场摆着的几样东西（三条岔路、三张通知）。
   *
   * 三个输入门任选其一（也可以都不给，那就得靠 code 或 acceptedItems）：
   * code → 数字键盘 / acceptedItems → 背包列表 / choices → 选项列表
   */
  choices?: string[];
  /** choices 里哪个对。**必须出现在 choices 里**，否则玩家选遍所有选项也过不去（校验层会拦） */
  correctChoice?: string;
  /**
   * 要输的密码（有序，逐位比对）。给了它就**不弹道具列表、改弹数字键盘**。
   *
   * 这样一关可以有**多个**密码门：`puzzle` 只管最后那一下，
   * 中间的工具盒 / 保险柜各自带自己的 `code`。
   * 默认输错是**软拒绝**（只回一句 `rejectText`，不计数、不罚）；
   * 要罚就配 `wrongCooldownSec`（见下）。
   */
  code?: string[];
  /**
   * 输错 `code` 之后罚站多少秒。**不填 = 完全不罚**，行为和以前一模一样。
   *
   * 罚站期间这台装置点不开、也不收密码，屏幕左上角显示「⏳ N 秒」倒着走。
   * 和 `puzzle.wrongCooldownSec` 共用同一个冷却计时器 —— 那个管最后那次提交，
   * 这个管中途的密码门（第 1 关的工具盒）。每次输错都罚，不封顶。
   */
  wrongCooldownSec?: number;
  /** 用成功后要消耗掉的道具。**不填 = 什么都不消耗**（磁吸杆那种可重复用的） */
  consumes?: string[];
  /** 用成功后产出的新道具。写数组就一次产出多件（工具盒同时给印章和磁吸杆） */
  produces?: string | string[];
  /** 用成功后这关就通了。**一关的通关条件要么是 puzzle，要么是这个** */
  completes?: boolean;
  /**
   * 打开输入面板时显示的那句话。
   *
   * **不填会出问题**：B 点地图上的空缺时，面板只说「选哪个？」，玩家根本不知道
   * 这是哪一块空缺。场景里几个装置长得像的时候，这句提示是唯一的区分。
   */
  prompt?: string;
  /** 用成功后说一句话，让玩家知道发生了什么 */
  successText?: string;
  /** 挑错道具 / 输错密码时说什么 */
  rejectText?: string;
}

/**
 * 视角内的一个场景：一张背景图 + 一个可选的「返回」出口。
 *
 * **为什么需要**：一个视角只有一张图的关卡（绝大多数）用 `ViewConfig.assetKey` 就够了；
 * 第 2 关的 A 视角有 7 张图（3 个岔路各左右两张 + 终点），玩家走哪条路就换哪张图 ——
 * 那是「一个视角多张图」，用 `scenes` 表达。**两种写法二选一，同一视角不能都写。**
 */
export interface SceneConfig {
  /** A/B 按这个命名出图，如 bg/L02_A_1 */
  assetKey: string;
  /**
   * 「返回」回到哪个场景。**不写 = 这个场景没有返回出口**（岔路场景就不写）。
   *
   * 专门给「进去看一眼还得退出来」的侧路场景用（第 2 关的左右岔路图）。
   * 返回是**界面层的固定按钮**（左下角），不占原图坐标 —— A/B 不用为它量位置。
   */
  backScene?: string;
}

export interface ViewConfig {
  viewId: ViewId;
  /**
   * 单场景视角的背景图（A/B 按这个命名出图，如 bg/L01_A）。
   * 和 `scenes` 二选一 —— 写了 `scenes` 就不用它。
   */
  assetKey?: string;
  /**
   * 多场景视角：场景 id → 场景。写了它就必须同时给 `initialScene`。
   * 场景 id 只需要在本视角内唯一，命名随游戏逻辑走（`fork1`、`fork1_left`…）。
   */
  scenes?: Record<string, SceneConfig>;
  /** 多场景视角：进关卡 / 「再来一次」后先显示哪个场景 */
  initialScene?: string;
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
   * 【必填】提交热点的 nodeId，必须指向一个 action 为 submit 的真实热点。
   * 它的含义随 `input` 而变：
   * - `input` 不写 / 'none'：**点它就直接提交**（用背包顺序比对答案）
   * - `input` 为 'numberpad' / 'form'：**点它打开输入面板**，玩家在面板里输
   *
   * 后者是刻意的：面板常驻会挡住大半个场景（第 5 关那个 6 项表单尤其明显），
   * 玩家看不清该点哪儿。所以面板默认关着，点这个热点才弹出来。
   */
  submitNodeId: string;
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
  /**
   * 通关条件之一：**回答一个问题**（点热点提交，或用数字键盘/表单输入）。
   *
   * 可以整个不写 —— 那种关卡靠一个标了 `completes: true` 的 use 热点通关，
   * 比如第 1 关的最后一步是「把凭证插进 06 号柜」，那是操作，不是答题。
   * 两者至少要有一个。
   */
  puzzle?: PuzzleConfig;
  /**
   * 道具 id → 玩家看得见的名字。
   *
   * **不填的后果**：道具选择面板和背包栏会直接显示 `frag_sign`、`stamp_blue`
   * 这种技术 id，玩家根本不知道那是什么，也没法在列表里挑。
   * id 是给配置和存档用的，名字才是给玩家看的。
   */
  items?: Record<string, string>;
  /** 提示梯度，按顺序解锁 */
  hints: string[];
  rewards: RewardConfig;
}
