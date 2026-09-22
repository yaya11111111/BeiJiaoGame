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
│   │   │   └── LevelBootView.ts       自动挂载入口
│   │   └── ui/                      【E】⬜ 待建
│   ├── resources/                   ★ 见「为什么放 resources/」
│   │   └── configs/                 【D】✅
│   │       ├── level.guide.json       新手引导关
│   │       ├── level.01.json          第 1 关
│   │       └── schema/level.schema.json
│   ├── scenes/                      ⬜ 待建，D 与 E 按文件分
│   ├── textures/                    【A、B】⬜ 待建
│   └── prefabs/                     【D、E】⬜ 待建
├── tests/                           【D】单测，在 assets/ 外面所以不进包
│   ├── levelConfig.test.ts            25 项
│   ├── levelRuntime.test.ts           29 项
│   ├── coord.test.ts                  22 项
│   ├── collections.test.ts            9 项（含展开运算符守护）
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

**命名约定：`import 'cc'` 的文件一律以 `View.ts` 结尾。** Node 解析不到 `cc`，主 typecheck 靠 `exclude: **/*View.ts` 把它们挡开，否则报 TS2307。引擎无关的逻辑放 `common/`、`level/` 下的非 View 文件。

## 怎么跑起来

改 `LevelBootView.ts` 顶部两个常量：

```ts
const AUTO_BOOT_LEVEL = 'GUIDE';   // 换成 'L01' 就跑第 1 关；null = 关掉自动挂载
const AUTO_BOOT_DEBUG = true;      // 打开热点调试框
```

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
