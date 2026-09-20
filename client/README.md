# client — 微信小游戏客户端

负责人：D（关卡模块）、E（外层页面）

技术栈：Cocos Creator **3.8.8** + TypeScript，导出微信小游戏。关卡由配置数据驱动，不是每关重写程序。

## 怎么打开这个工程

Cocos Dashboard → 「项目」→ **打开项目** → 选中本目录（`client/`）。

**版本必须全组统一在 3.8.8。** 不同版本打开同一工程时编辑器会提示升级，**一旦升级并保存，低版本就再也打不开**，而且 `.meta` 里的资源 UUID 可能变化，导致场景引用丢失。版本号钉在 `package.json` 的 `creator.version` 和 `settings/` 里，别改。

`library/`、`temp/`、`build/`、`profiles/` 都是编辑器生成的缓存和产物，不入库、也不用手动建 —— 第一次打开工程时自动重建。

## 目录结构

```
client/
├── assets/
│   ├── scene.scene                  默认空场景（Cocos 建工程时生成）
│   │
│   ├── scripts/
│   │   ├── common/                  【D】引擎无关的公共层
│   │   │   ├── LevelTypes.ts          关卡配置的类型定义
│   │   │   ├── LevelConfig.ts         配置解析 + 校验 + 死局检测
│   │   │   └── Emitter.ts             事件总线
│   │   └── level/                   【D】关卡模块
│   │       └── LevelRuntime.ts        ★ 关卡状态机
│   │       └── (LevelView.ts)         待补：Cocos 适配层
│   │
│   └── resources/                   ★ Cocos 的特殊目录，见下方说明
│       └── configs/                 【D】关卡配置
│           ├── level.guide.json       新手引导关（三步教学）
│           ├── level.01.json          第 1 关
│           └── schema/
│               └── level.schema.json  配置格式的 JSON Schema
│
├── tests/                           【D】关卡模块单元测试
│   ├── levelConfig.test.ts            配置校验（23 项）
│   ├── levelRuntime.test.ts           状态机（19 项）
│   ├── vitest.config.ts               ← 里面那条 oxc.tsconfig:false 不能删，见文件注释
│   └── tsconfig.json
│
├── settings/                        工程设置（含引擎模块裁剪配置）
├── package.json                     工程标识 + Cocos 版本基线
└── tsconfig.json                    Cocos 生成的 TS 配置，extends 指向 temp/（需开过编辑器才生成）
```

### 为什么配置放在 `assets/resources/` 而不是 `assets/configs/`

Cocos **只打包「被场景或 prefab 引用的资源」和 `assets/resources/` 目录下的资源**。

关卡配置是运行时用 `resources.load()` 动态读的，没有任何场景直接引用它 —— 放在 `assets/configs/` 的话**构建时会被整包丢掉**，跑起来直接报「找不到资源」。这个坑实测过：搜遍 `build/wechatgame/` 找不到任何配置内容。

`resources.load()` 的路径是**相对 `resources/` 且不带扩展名**，所以：

```ts
resources.load('configs/level.01', JsonAsset, (err, asset) => { ... });
```

**A/B 的图和音频同理。** 首包只有约 4MB、总包约 30MB，场景图几乎必然超限，所以大资源必须走 `resources/` + 远程化 + 懒加载这条路。`assets/resources/` 会变成 D、A、B 共用的目录，具体怎么分（按关卡分？按章节分包？）需要 D、A、B 一起定，**在 A/B 大量出图之前定下来**，否则路径全量返工。

## 关卡配置字段

**9/22 冻结的五个字段**，改名前必须走 D、C、E 三方确认 —— 因为 A/B 按 `assetKey` 出图、C 按 `nodeId` 存进度、E 按 `progress` 挂地图入口。

| 字段 | 位置 | 说明 |
|---|---|---|
| `levelId` | 配置根 | `GUIDE` / `L01`~`L10` |
| `viewId` | `views.A` / `views.B` | 可省略，以键名为准 |
| `assetKey` | 每个视角一个 | 如 `bg/L01_A`，**A/B 按这个命名出图** |
| `nodeId` | 每个热点一个 | 同一关内唯一，**C 按这个存进度** |
| `progress` | `rewards.progress` | 通关解锁的地图节点，**E 按这个挂入口** |

完整的字段说明、取值约束见 `assets/resources/configs/schema/level.schema.json`。

### 热点坐标的口径

`rect` 统一为 **`[x, y, w, h]`，以「原图左上角」为原点，单位是原图像素，直接量原图**。

- A/B 在图上量完直接填，不用管屏幕尺寸和缩放
- 换算到 Cocos 的左下原点坐标系由适配层做，**不污染配置** —— 否则单人/双人两种屏幕尺寸下热点会错位

这条是 A/B 出图的直接依据，改动等于全量返工。

## 跑单元测试

```bash
cd client/tests
npm install     # 第一次
npm test
```

状态机（`LevelRuntime.ts`）**故意不 import 任何 `cc` 模块**，所以测试能在 Node 里直接跑，不用开编辑器。这也是为什么要把逻辑和渲染拆开 —— `LevelView.ts` 是唯一会 `import cc` 的文件。

`tests/` 放在 `assets/` **外面**，这样 Cocos 不会把它打进小游戏包。

## 构建与验证

编辑器里「项目 → 构建发布」，平台选**微信小游戏**。构建产物在 `build/wechatgame/`（不入库）。

构建完**不会自动显示画面**，要用**微信开发者工具**「导入项目」指向 `build/wechatgame` 才能看到。那个目录本身就是个合法的小游戏工程，`project.config.json` 里 AppID 已经填好。

包体基线（2026-09-20 实测，空场景）：**总计 2.9MB**，其中 `cocos-js` 引擎运行时 2.5MB、资源 196K。首包约束约 4MB —— 引擎这块有富余，但资源一旦进来就会吃紧。

`settings/v2/packages/engine.json` 里已经关掉了 `3d` / `physics` / `particle` / `skeletal-animation`。还能再砍的是 **spine-3.8、dragon-bones、tiled-map、video、webview、profiler** —— 本项目一个都用不到，砍掉能再省一截。

## 场景归属

Cocos 的 `.scene` 和 `.prefab` 是 JSON 文件，两人同时改会产生无法手工解决的合并冲突。因此 D 和 E 各自负责独立的场景文件。

| 路径 | 负责人 |
|---|---|
| `assets/scenes/Guide.scene` | D |
| `assets/scenes/Level01.scene` ~ `Level10.scene` | D |
| `assets/scenes/Home.scene` | E |
| `assets/scenes/Signin.scene` | E |
| `assets/scenes/ModeSelect.scene` | E |
| `assets/scenes/Room.scene` | E |
| `assets/scenes/Map.scene` | E |
| `assets/scenes/Collection.scene` | E |
| `assets/scenes/Settings.scene` | E |
| `assets/scenes/Result.scene` | 待定 |
| `assets/prefabs/` | D、E 按文件指定 |
| `assets/scripts/level/`、`scripts/common/` | D |
| `assets/scripts/ui/` | E |
| `assets/resources/configs/` | D |
| `assets/textures/` | A、B |

`assets/prefabs/` 是公共控件（按钮、热点、物品栏、线索卡），两边都会用到。每个 prefab 指定唯一负责人，他人需要改动时找负责人提需求或走 PR。

## 待定事项（9/22 前确定）

- **Result.scene 归属**：D 的职责含"结算"，E 的职责含"结算跳转"。建议关卡内结算逻辑归 D，结算页 UI 与跳转归 E。
- **场景加载方式**：单场景 + prefab 切换，或多场景切换。
- **公共 prefab 清单**：先列出并指定负责人。
- **`assets/resources/` 的分包方案**：见上文，A/B 大量出图前必须定。
