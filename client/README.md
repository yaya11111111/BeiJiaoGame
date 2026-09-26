# client — 微信小游戏客户端

负责人：D（关卡模块）、E（外层页面）

Cocos Creator **3.8.8** + TypeScript，导出微信小游戏。关卡由配置数据驱动，不是每关重写程序。

## 打开工程

Cocos Dashboard → 项目 → 打开项目 → 选本目录。

**版本必须统一在 3.8.8**（钉在 `package.json` 的 `creator.version`，别改）：编辑器升级过一次并保存后，低版本就再也打不开，`.meta` 的 UUID 还可能变，场景引用会丢。

`library/` `temp/` `build/` `profiles/` 是编辑器产物，不入库，首次打开自动重建。

## 目录结构

```
client/
├── assets/
│   ├── scene.scene                  ✅ 默认空场景
│   ├── scripts/
│   │   ├── common/                  【D】✅ 引擎无关的公共层
│   │   │   ├── LevelTypes.ts          关卡配置的类型定义
│   │   │   ├── LevelConfig.ts         配置解析 + 校验 + 死局检测 + 路径映射
│   │   │   ├── Coord.ts               原图坐标 → 节点坐标换算
│   │   │   ├── Collections.ts         setToArray（别用 [...set]，见下）
│   │   │   └── Emitter.ts             事件总线
│   │   ├── level/                   【D】✅ 关卡模块
│   │   │   ├── LevelRuntime.ts        ★ 状态机（引擎无关，只算不画）
│   │   │   ├── LevelView.ts           ★ Cocos 适配层（只画不算）
│   │   │   ├── LevelBootView.ts       自动挂载入口
│   │   │   ├── UiKitView.ts           共用零件：建节点、按钮、按钮格子
│   │   │   ├── NumberPadView.ts       数字键盘（密码类关卡）
│   │   │   ├── FormPanelView.ts       逐项选择的表单（引导关）
│   │   │   └── UsePanelView.ts        挑东西的面板（道具 / 固定选项）
│   │   └── ui/                      【E】⬜ 待建
│   ├── resources/                   ★ 见「为什么放 resources/」
│   │   └── configs/                 【D】✅
│   │       ├── level.guide.json       新手引导关
│   │       ├── level.01.json          第 1 关
│   │       ├── level.02.json          第 2 关
│   │       └── schema/level.schema.json
│   ├── scenes/                      ⬜ 待建，D 与 E 按文件分
│   ├── textures/                    【A、B】⬜ 待建
│   └── prefabs/                     【D、E】⬜ 待建
├── tests/                           【D】单测，在 assets/ 外面所以不进包
│   ├── levelConfig.test.ts            配置解析与校验
│   ├── levelRuntime.test.ts           状态机
│   ├── coord.test.ts                  坐标换算
│   ├── collections.test.ts            setToArray + 展开运算符守护
│   ├── fixtures/                      引擎测试的夹具，**不是真实关卡**
│   │                                  真实关卡会随 A/B 的设计一直改，
│   │                                  引擎测试拿它们当夹具会被设计变更拖崩
│   ├── vitest.config.ts               ← 那条 oxc.tsconfig:false 不能删
│   ├── tsconfig.json                  ← exclude 掉 *View.ts
│   ├── tsconfig.view.json             ← 反过来，专查 *View.ts
│   └── package.json
├── settings/                        工程设置（含引擎裁剪）
├── package.json                     工程标识 + 版本基线
└── tsconfig.json                    Cocos 生成，extends 指向 temp/
```

## 关卡配置

### 五个冻结字段

改名前必须 D、C、E 三方确认：A/B 按 `assetKey` 出图、C 按 `nodeId` 存进度、E 按 `progress` 挂地图入口。

| 字段 | 位置 | 说明 |
|---|---|---|
| `levelId` | 配置根 | `GUIDE` / `L01`~`L10` |
| `viewId` | `views.A` / `views.B` | 可省略，以键名为准 |
| `assetKey` | 每视角一个 | 如 `bg/L01_A`，**A/B 按这个命名出图** |
| `nodeId` | 每个热点一个 | 同关内唯一，**C 按这个存进度** |
| `progress` | `rewards.progress` | 通关解锁的地图节点，**E 按这个挂入口** |

完整约束见 `assets/resources/configs/schema/level.schema.json`。

### 答案怎么写：看形状

`puzzle.answer` **由形状决定怎么判**，不需要额外的字段（数组和对象在 JSON 里没有歧义）：

| 写什么 | 怎么判 | 用在哪 |
|---|---|---|
| 数组 `["2","4","1"]` | **有序**：长度相同且逐位相等 | 数字密码、路线顺序、背包顺序 |
| 对象 `{"岗位":"接线员","编号":"07"}` | **按键**：键集合相同且每键的值相等，**顺序无关** | 表单填空、拖放到位、单选（只有一个键） |

有序答案不传答案时用背包里的道具顺序（老行为）；**按键答案必须显式 `submit(answer)`**，点提交热点交不了——那种关的提交按钮在表单里。

答案形状和配置对不上时按 `blocked` 处理，**不算一次尝试、也不触发惩罚**：那是调用方写错代码，不该让玩家买单。

### 玩家怎么输入：`input`

| 取值 | 界面 | 要求 |
|---|---|---|
| 不写 / `none` | 靠点热点提交 | `answer` 是道具 id 序列（背包顺序） |
| `numberpad` | 屏幕数字键盘 | `answer` 必须是**单个 0-9** 组成的数组 |
| `form` | 逐项选择填空 | `answer` 必须是对象，且要给 `fieldOptions` |

**面板默认是关着的，点 `submitNodeId` 那个热点才弹出来。**

常驻会挡住大半个场景（第 5 关那个 6 项表单尤其明显），玩家看不清该点哪儿。所以 `submitNodeId` **两种输入方式下都必填**，只是含义不同：

- `input` 为 `none`：点它**直接提交**
- `input` 为 `numberpad` / `form`：点它**打开面板**，玩家在面板里输

后者顺带堵掉一个坑：以前面板类关卡如果也放了提交热点，玩家手滑点一下就会拿背包顺序当答案交上去，白扣一次机会甚至触发惩罚。现在点它只是开面板。

**表单为什么是"选"而不是"打字"**：引导关三个空里两个是中文（"接线员""南门内侧"），手机上打中文很别扭，而且打错一个字、多一个空格就判错，玩家会莫名其妙地卡住。给候选项让他选，候选项本身还能当干扰项用——选错也是玩法。

```jsonc
"puzzle": {
  "input": "form",
  "answer":       { "岗位": "接线员", "编号": "07" },
  "fieldOptions": { "岗位": ["接线员","志愿者","社团负责人"], "编号": ["07","03","12"] }
}
```

`fieldOptions` 的键必须和 `answer` 的键**一一对应**，而且**每个空的正确答案必须出现在自己的候选项里**——少了就是永远填不对的死局，校验层会拦。

### 在装置上使用道具：`action: "use"`

玩家点这个热点 → 弹出背包让他**自己挑**一件 → 挑中的在 `acceptedItems` 里才算对。

```jsonc
{
  "nodeId": "hs_a_stamp_device",
  "action": "use",
  "acceptedItems": ["stamp_blue"],              // 认可蓝方章
  "consumes": ["blank_ticket", "stamp_blue"],   // 成功后消耗这两件
  "produces": "stamped_ticket",                 // 产出「已盖章的领取券」
  "successText": "券上盖好了蓝色方章。",
  "rejectText": "这个章不认。"
}
```

三个要点：

- **挑错是"软拒绝"**：不扣容错次数、不触发惩罚，只说一句话。翻物件本来就是探索，罚重了玩家就不敢点了。设计稿里「红圆章是辨析项」正要靠这一步——挑红章被拒，玩家才得去找 B 的排除线索。
- **`consumes` 不填 = 什么都不消耗**（磁吸杆那种可重复用的）。填了的话，列出的道具玩家必须都持有，否则用不了。
- **`produces` 出来的道具算「拿得到」**，可以给别的热点当 `requiresItem` / `acceptedItems`——合成链就是这么做出来的。

`use` 热点和 `pickup` 一样是**一次性的**：用过后 `done: true` + `enabled: false`，界面据此变灰。

### 三种输入门，`use` 热点任选一种

| 给什么 | 玩家看到 | 用在哪 |
|---|---|---|
| `code: ["2","4","1"]` | **数字键盘** | 第 1 关的工具盒 |
| `acceptedItems: [...]` | **背包列表**（挑一件） | 第 1 关的盖章台、第 2 关的碎片归位 |
| `choices: [...]` + `correctChoice` | **选项列表**（选一个） | 第 2 关的三条岔路、第 3 关的三张通知 |

```jsonc
// 固定选项门：现场摆着几样东西，选一个
{
  "nodeId": "hs_a_fork_1",
  "action": "use",
  "requiresItem": "route_map",              // 前置：地图没拼好之前点不动
  "choices": ["路灯", "花坛", "长凳"],
  "correctChoice": "路灯",                   // 必须在 choices 里，否则死局（校验层会拦）
  "produces": "path_1",
  "rejectText": "这条路是死胡同，退回岔口重来。"
}
```

**三种选错都是"软拒绝"**——不扣次数、不锁时间，只说一句话。理由：翻物件、选路口本来就是探索动作，罚重了玩家就不敢点了。

`choices` 只是**选项本身**（现场看得见的东西），`correctChoice` 才是答案，**不会下发给界面**。

### 一关可以有多个输入门：`use` 热点带 `code`

`puzzle` 只管**最后那一下**。中间的工具盒、保险柜各自带自己的密码：

```jsonc
{
  "nodeId": "hs_a_toolbox",
  "action": "use",
  "code": ["2", "4", "1"],                  // 弹数字键盘，输这个
  "produces": ["stamp_blue", "suction_rod"], // 开了之后一次给两件
  "rejectText": "密码不对，盒子纹丝不动。"
}
```

给了 `code` 就**弹数字键盘**，没给就弹道具列表。输错是**软拒绝**——设计稿明写「错误密码打不开，也不会封锁密码盒」，所以不扣次数、不锁时间。

### 通关条件：答题通 **或** 操作通

**一关的通关条件必须有一个**，两个都没有就是玩家做对了也没反应（死局，校验层会拦）：

| 方式 | 怎么写 | 用在哪 |
|---|---|---|
| **答题通** | 给 `puzzle`（`submitNodeId` 或 `input` 面板） | 引导关（填表）、密码关 |
| **操作通** | 给某个 use 热点标 `completes: true` | 第 1 关（最后一步是「把凭证插进柜子」，那是操作不是答题） |

**两者可以同时存在**——中途答一题、最后再做个操作。两条路都走同一个 `level:success` 广播，E 的地图只认一种载荷。

`puzzle` 现在**可以整个不写**。`submitNodeId` 只能指向 `action: "submit"` 的热点——指到 use 上通不了（use 不经过答题判定），校验层会拦。

### 道具要有显示名：`items`

```jsonc
"items": {
  "stamp_blue": "蓝色方形印章",
  "suction_rod": "磁吸杆",
  "stamped_ticket": "已盖章的领取券"
}
```

**每件拿得到的道具都必须有名字**（校验层会拦）。少了的话道具面板和背包栏会直接列出 `frag_sign`、`stamp_blue` 这种技术 id——**玩家不知道那是什么，也没法在列表里挑**。

id 是给配置和存档用的，名字才是给玩家看的。运行时把名字放进 `inventory[].name`，界面显示它、交回给运行时的是 `itemId`。

### `itemId` 可以是数组

一次拾取多件（第 1 关的工具盒同时给蓝方印章和磁吸杆）：

```jsonc
{ "nodeId": "hs_a_toolbox", "action": "pickup", "itemId": ["stamp_blue", "suction_rod"] }
```

### 答错要不要罚

```jsonc
"wrongCooldownSec": 10   // 答错后锁 10 秒。不填 = 只提示错误，不惩罚
```

两种口径都支持是刻意的：第 1 关的红圆章是故意设的辨析项，答错本身就是玩法，那种关不该罚；而密码类的关不罚，玩家会一路穷举。**不想惩罚就别写这个字段，别写 0**（校验层会拦）。

惩罚期内提交热点仍然可点（`enabled` 不置 false），点了回 `reason: 'cooldown'`，界面据此播报「还有 N 秒」——置成点不动的话玩家点下去毫无反应，只会以为坏了。

### rect 口径

`[x, y, w, h]`，**原图左上角**为原点，单位原图像素，直接量原图。A/B 量完就填，不用管屏幕尺寸；换算到 Cocos 左下原点由适配层做。改动等于全量返工。

### 为什么放 `assets/resources/`

Cocos 只打包「被场景 / prefab 引用的资源」+ `assets/resources/` 下的资源。关卡配置是运行时 `resources.load()` 读的，没有被任何场景引用 —— 放 `assets/configs/` 构建时会被整包丢掉（实测过，`build/wechatgame/` 里搜不到）。

路径**相对 `resources/`、不带扩展名**，且 `load` 没有三参数重载（中间那个 `null` 是 onProgress，不能省）：

```ts
resources.load('configs/level.01', JsonAsset, null, (err, asset) => { ... });
```

A/B 的图同理。首包约 4MB、总包约 30MB，大资源必须走这条路 + 懒加载，所以 `resources/` 会变成 D/A/B 共用的目录，分包方式要在 A/B 大量出图前定。

## 运行时契约（E 和适配层看）

`LevelRuntime` 不碰 Cocos 节点，只通过 `getState()` 快照 + 事件广播。类型在 `LevelRuntime.ts` 顶部。

| 项 | 语义 |
|---|---|
| `state:changed` | 只在状态真的变了时广播，不是每帧。倒计时按「显示的秒数」节流。订阅它做整体重绘是安全的 |
| `hotspots[].enabled` | `false` 就是点不动，别再派发点击 |
| `hotspots[].done` | 只对 `pickup` 有意义；`inspect` 可反复点，永远不 `done`，别拿它灰化 |
| `inventory` | 数组顺序就是提交顺序 |
| `cooldownLeftSec` | 答错惩罚的剩余秒数，`0` 表示现在可提交。`tick` 只在它变化的秒数上广播 |

`answer:wrong` / `level:failed` 的载荷**不含正确答案**（隐私口径，别为了做提示加回来）。

## 跑测试

```bash
cd client/tests
npm install
npm test                # 单测
npm run typecheck       # 引擎无关部分
npm run typecheck:view  # *View.ts，需要开过一次 Cocos
```

`npm test` 通过 ≠ 类型没问题 —— vitest 只转译不检查类型，两个 typecheck 都要跑。

| 命令 | 覆盖 | 需要 Cocos |
|---|---|---|
| `typecheck` | `assets/scripts/**` 除 `*View.ts` | 否 |
| `typecheck:view` | 全部，含 `*View.ts` | 是（要 `temp/declarations/cc.d.ts`） |

**新 clone 下来的人第一次跑 `typecheck:view` 必然失败** —— `temp/` 是编辑器产物、不入库。而失败的样子很误导：一串 `Cannot find module 'cc'` 和 `Property 'node' does not exist on type 'LevelView'`，**看起来像代码坏了**。

所以它前面挂了个前置检查（`check-cc-typings.js`）：`temp/` 不在时直接说明原因再退出。**别因为这个去改 `tsconfig.view.json` 或给 `cc` 加 mock** —— 用 Cocos 打开一次工程就好了。`npm run typecheck` 和 `npm test` 都不需要 Cocos。

**命名约定：`import 'cc'` 的文件一律以 `View.ts` 结尾。** Node 解析不到 `cc`，主 typecheck 靠 `exclude: **/*View.ts` 把它们挡开，否则报 TS2307。引擎无关的逻辑放 `common/`、`level/` 下的非 View 文件。

## 怎么跑起来

改 `LevelBootView.ts` 顶部两个常量：

```ts
const AUTO_BOOT_LEVEL = 'GUIDE';   // 换成 'L01' 就跑第 1 关；null = 关掉自动挂载
const AUTO_BOOT_DEBUG = true;      // 打开热点调试框
```

**预览时左上角有一条关卡切换按钮**，点一下直接换关，不用改常量等重新编译。那是**开发工具不是产品界面**——正式的选关入口是 E 的地图页（首页 → 选模式 → 地图）。等 E 那边上来，把 `DEV_LEVELS` 那段删掉、`AUTO_BOOT_LEVEL` 设成 `null` 即可。

`DEV_LEVELS` 只放**已经有配置文件**的关卡，写一个没有配置的 id 会白屏。

它用 `director` 的场景启动回调挂节点，所以**不需要先建 `.scene`**。只在预览 / 真机生效，编辑器里编辑场景时不动手（用 `EDITOR_NOT_IN_PREVIEW` 守着，否则 `LevelView(auto)` 会被存进 `.scene`）。

预期画面：占位底色（写着期望的 `assetKey`，四角有 L 形方向标记）+ 每个热点的半透明框与 `nodeId` + 顶部状态栏 + 底部背包 / 线索 / 按钮。

引导关走一遍：A 点信箱 → 切 B 看到公告栏 → 回 A 点海报拿凭证 → 切 B 点读卡槽提交。

长期还是在编辑器里建 `Guide.scene` / `Level01.scene` 挂 `LevelView`（UUID 已生成），那时把 `AUTO_BOOT_LEVEL` 设成 `null`。**`.meta` 必须入库**，否则别人拉到代码后 UUID 重新生成、场景引用全断。

**美术的图丢进 `assets/resources/` 就自动生效**：按 `assetKey` 找（`bg/GUIDE_A` → `assets/resources/bg/GUIDE_A.png`），找不到画占位图 + warning，找到就用真图，且热点换算基准自动切换成那张图的真实像素尺寸 —— 不用改配置。

## ⚠️ 构建产物 ≠ 浏览器预览

**有的 bug 只在构建产物 / 真机出现，预览里怎么点都正常。** 真机是本项目验收口径，所以交付前必须在**微信开发者工具**里跑一遍。

### `[...set]` 会在构建产物里炸

Cocos 用 Babel loose 模式转展开运算符，`[...set]` 变成 `[].concat(set)`，而 concat 只展开数组、不展开 Set → 拿到 `[set 自己]` → 一调用就报 `TypeError: s is not a function`（压缩后变量名全是 `s`，栈里看不出是 Set）。`[...set].join()` 不崩，但拼出 `[object Set]`。

**改用 `common/Collections.ts` 的 `setToArray()`。** 预览保留 ES2015+ 语法所以看不出问题，只有降级到 ES5 的构建产物才走 `[].concat`。`tests/collections.test.ts` 有源码守护，扫描每个 `[...x]`，操作数不在白名单就失败。

`for...of` 遍历 Map / Set **是安全的**（构建产物编译成规范迭代器形式，已验证）。出问题的只有展开运算符。

同类：`Array.prototype.includes` 是 ES2016 API，Cocos target 是 ES2015，判断包含用 `indexOf(...) !== -1`。

## 构建

编辑器「项目 → 构建发布」→ 微信小游戏，产物在 `build/wechatgame/`（不入库）。构建完不会自动显示画面，要用微信开发者工具「导入项目」指向它。

构建的**场景列表要包含要跑的场景**，否则真机白屏。目前只打了 `scene.scene`，够用 —— 自动挂载不依赖具体场景。将来 `Guide.scene` / `Level01.scene` 建好后记得加进去。

包体基线（9/20 实测，空场景）：**2.9MB**，其中引擎 2.5MB、资源 196K。首包约 4MB，引擎有富余，资源一进来就吃紧。`engine.json` 已关 `3d`/`physics`/`particle`/`skeletal-animation`；还能砍 `spine-3.8`、`dragon-bones`、`tiled-map`、`video`、`webview`、`profiler`。

## 场景归属

`.scene` / `.prefab` 是 JSON，两人同改必然冲突，所以各占独立文件。

| 路径 | 负责人 |
|---|---|
| `assets/scenes/Guide.scene` | D |
| `assets/scenes/Level01.scene` ~ `Level10.scene` | D |
| `assets/scenes/Home.scene`、`Signin`、`ModeSelect`、`Room`、`Map`、`Collection`、`Settings` | E |
| `assets/scenes/Result.scene` | 待定 |
| `assets/prefabs/` | D、E 按文件指定 |
| `assets/scripts/level/`、`scripts/common/` | D |
| `assets/scripts/ui/` | E |
| `assets/resources/configs/` | D |
| `assets/textures/` | A、B |

## 待定事项

- **屏幕朝向**：`build/wechatgame/game.json` 现在是 `portrait`，`settings/` 里没人显式设过。**和画布基准是同一件事的两面，必须一起定** —— 横屏按 16:9 出图、竖屏按 9:16，定反了 A/B 的图全部作废。
- **画布基准**：`project.json` 是空的，等于用 Cocos 默认 960×640。不阻塞 D（换算基准取自图的真实尺寸），但影响 A/B 出图比例。
- **`pickup` 是否可逆**：道具只进不出而答案是背包顺序，所以点掉干扰道具本关就永远通不了（`level.01.json` 东路口就是）。要么背包加移除，要么干扰项改 `inspect`。**A/B 写第 2、3 关之前要先定。**
- **`resources/` 分包方案**：A/B 大量出图前必须定。
- **配置里哪些字段留本地、哪些从服务端取**：现在 `puzzle.answer` 和对面视角线索一起打进包，解包能看答案。要等 C 的 API v1 对齐。
- **`Result.scene` 归属**：建议结算逻辑归 D，结算页 UI 与跳转归 E。
- **场景加载方式**：单场景 + prefab 还是多场景。不阻塞关卡跑通。
- **公共 prefab 清单**：目前 `LevelBootView` 走纯代码建节点，`prefabs/` 还没建。
