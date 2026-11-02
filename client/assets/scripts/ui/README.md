# E 外层页面模块

本目录负责微信小游戏的关卡外页面与地图，不包含 D 的关卡逻辑。视觉和页面流按
`C:\Users\20417\Documents\Codex\2026-09-15\zh\outputs\e-ui-demo` 的网页原型迁移：
晴日校园配色、首页入口、模式选择、房间、校园地图、10 个节点、关卡目录、图鉴和设置。

## 已实现

- 登录占位页：本地身份演示，后续接 C 的 `wx.login`
- 云开发初始化：`AppShellView.onLoad()` 调用 `initWechatCloud()`，全局只执行一次，环境为 `cloudbase-d2gvkcghabfaf9768`，`traceUser: true`
- 首页：开始游戏、地图、图鉴、设置入口
- 模式选择：单人直接进入地图，双人进入房间
- 房间页：本地创建/加入房间占位，后续替换为 C 的 API
- 地图页：原型中的校园平面布局、操场、明湖、图书馆、四教、思源楼、逸夫楼等地标，
  以及按 10 个正式关卡划分的探索区域；未解锁区域显示为灰色
- 地图骨架：使用 `south / west / center / east / north` 相对锚点布局，不再让建筑和关卡节点各自维护百分比坐标；
  南门固定在底部，北门固定在顶部，西门固定在左侧，东门固定在右侧
- 主校区地标层：补充官网海淀主校区标签中的教学楼、科研楼、办公楼、食堂、公寓、体育馆、
  服务设施、篮球场和运动场，并为小型建筑绘制屋顶、窗带、入口台阶与名称
- 地图减法排版：地图绘制层不再绘制学生公寓、宿舍楼或留学生公寓；建筑自动避让并保持至少 35px
  间距，建筑标签使用 10px 并在地图边界内自动选择上下位置
- 校门状态：第 1 关（`L01` 或 `level_1`）完成后，西门、东门、北门由灰暗状态切换为彩色
- 关卡入口：地图上点「进入当前关卡」→ 调 D 的 `mountLevel()`（`../level/LevelMountView`），
  关卡节点建在 Canvas 上盖住本层，本层先被藏起来；退出或通关后自动恢复。**不再有占位桥接页**
- 结算页：记录最好用时、解锁下一节点、点亮图鉴；本关彩蛋状态（`LevelReview.eggs` 有数据时显示）
- **失败结算**：失败后退出关卡进入复盘页（用时 / 失败原因 / 已收集线索 / 再来一次 / 回地图；
  双人给「返回房间」）。失败**不写通关进度、不覆盖最好用时**
- 图鉴页：分为「关卡成就 / 线索收藏 / 彩蛋记录」三栏；关卡成就沿用地图区域，
  线索收藏与彩蛋记录来自跨关本地收藏（见下）
- 设置页：资料、昵称、头像、音乐/音效/新手提示开关、个人记录与意见反馈入口、隐私口径
- 地图复玩：已通关节点继续显示为可进入状态，地图与关卡目录均可重新选择；
  目录显示最好用时，结算页可回地图或进入图鉴
- 云端接入口：微信环境中登录同步 `auth.login` + `level.list`，双人房间接入
  `room.create` / `room.join` / `room.state` / `room.heartbeat` / `room.leave`，
  预览环境继续安全降级为本地演示
- 关卡埋点：进入、退出、通关调用 `event.report`；关卡内容与答案仍由 D/C 的关卡接口负责
- **个人记录（US08 / 统计展示入口）**：汇总已通关、累计/平均最好成绩、最快一关、收藏数量，
  逐关列出状态与最好用时；登录后拉 `auth.profile` 显示服务端口径（`clearedCount` / `totalTimeMs`）
- **意见反馈（FR-14）**：设置页与结算页入口；四类（Bug / 卡住 / 建议 / 新玩法）、
  最多 300 字说明、可选 1 张截图（传云存储 `feedback/`）；自动附带关卡、模式、视角、
  房间码、来源页与提交时间；提交后回显成功/失败，最近 3 条回执存本地
- **双人保存退出与恢复（FR-15 的 E 侧）**：双人关卡中途退出时把房间、关卡、视角、
  已用时、本轮 `startedAt` 存本地；回房间页弹「继续上次的双人进度？」，
  继续后按保存的视角进入关卡，并把已用时折算成 `startedAtMs` 让倒计时接着走
- **跨关收藏（FR-11 的 E 侧）**：通关带出的线索道具（跳过 hidden 中间件）与彩蛋发现
  按 id 去重累积，写本地缓存；地图节点与个人记录显示彩蛋 `x/y`
- **前后台适配**：`wx.onHide` 时暂停房间轮询/心跳，`wx.onShow` 回前台补一次房间快照
- **启动适配**：设计分辨率固定 1280×720（FIXED_HEIGHT），超宽屏只延伸背景

## 在 Cocos Creator 中挂载

1. 使用 Cocos Creator 3.8.8 打开 `client/`。
2. 在默认场景或 E 自己的 `Home.scene` 中选中 `Canvas`。
3. 把 `assets/scripts/ui/AppShellView.ts` 拖到 `Canvas` 上，或通过添加组件选择 `AppShellView`。
4. 预览场景，点击“微信登录 / 本地演示”进入首页。
5. 后续拆分独立场景时，保留 `AppState.ts`，把 `AppShellView.ts` 的各页绘制逻辑迁移到对应的 `Home/Signin/ModeSelect/Room/Map/Collection/Settings.scene`。

## 文件分工

| 文件 | 作用 |
|---|---|
| `AppShellView.ts` | 全部页面绘制与交互（唯一挂到 Canvas 的组件） |
| `AppState.ts` | 页面状态、地图节点/区域、进度与解锁的纯函数 |
| `Records.ts` | 个人记录页的数据整理（汇总 + 逐关行） |
| `Feedback.ts` | 反馈分类、校验、上下文、提交载荷、本地回执 |
| `DuoSession.ts` | 双人保存进度的读写、有效期判断、恢复时间换算 |
| `PlayerLibrary.ts` | 跨关收藏（线索 + 彩蛋）的合并、去重与本地缓存 |
| `LocalStore.ts` | 微信同步存储 / 内存降级的适配层 |
| `WechatCloud.ts` | 云初始化、头像与反馈截图上传、云文件 URL |

## 等待外部接口后替换的位置

- `signIn()`：C 的微信登录已完成；昵称/头像走 `auth.updateProfile`
- `createRoom()` / `joinRoom()`：已接 C 的 `room.*`；房间内进关卡走 `mountLevel`
- `completeLevel()`：**已接上 D 的关卡回调** —— 解锁节点直接用 `LevelReview.unlockedNodeIds`
  （来自关卡配置的 `rewards.progress`）。进度落库仍由 D 的 `level.submit` 负责
- `getNextUnlocks()`：**已废弃**，别再用它算解锁（硬编码、和配置对不上）。留着只是给
  `uiAppState.test.ts` 造演示数据。
- `unlockedProgress` / `createInitialAppState()` 里的演示数据：等 C 的进度接口来了换成真实进度。
- `MAP_REGIONS` / `getMapRegions()`：当前先实现“每关一个区域、由外向里推进、锁定区域变灰”的地图骨架。
- `MINI_PROGRAM_CONFIG`：当前使用 AppID `wxf23657dd9d6612f4` 与云环境 `cloudbase-d2gvkcghabfaf9768`

## 新需求里 E 还需要 C / D 配合的部分

见 `接口需求.md`。一句话版本：

1. **反馈**：C 需要 `feedback.submit`（现在页面已经按约定字段调用，未部署时会显示“提交失败”并保留草稿）。
2. **双人保存**：C 需要把房间快照存下来（`room.saveSession` / `room.getSession` /
   `room.clearSession` 或等价字段）；D 需要在 `LevelReview` 上补 `eggs`、并导出关卡运行时的
   快照/恢复接口。E 这边已经把本地能确定的部分（关卡/视角/已用时）接好了。
3. **跨关收藏**：C 需要 `library.get` / `library.add` 或随 `level.submit` 一起落库；
   D 需要在 `LevelReview` 上补 `eggs: { found, total, titles }`。E 已按这个形状接住。
4. **彩蛋展示**：D 在结算里带上 `eggs` 后，结算页、地图节点、图鉴彩蛋栏、个人记录会自动显示，
   E 不用再改代码。
5. **失败原因**：E 已按 `LevelReview.failureReason` 的可选字段读取（`timeout` /
   `attempts-exhausted`），D 补上后失败结算会显示具体原因，没补时显示「没能完成」。

## 仍需补充的信息

1. C 的 `server/API.md` 增补：反馈、收藏、双人快照接口与错误码。
2. A/B 的关卡缩略图、纪念物图片和最终关卡名称；收到后放入 `assets/resources/` 并替换当前绘制占位。
3. 图鉴素材清单：10 张漫画卡、卡背文字顺序、跨关物品 ID 和出现关卡。
4. C 需要先将云端 `levels.unlocks` 的节点 ID 与客户端 `MAP_NODES` 对齐；
   当前旧种子仍出现 `node_avenue`、`node_gate_square`，客户端会主动忽略未知 ID。

`AppShellView.ts` 以 `View.ts` 结尾，避免被 Node 单测的 `cc` 模块解析规则误收进去。

## 检查命令

```bash
cd client/tests
npm run typecheck        # 纯逻辑单测的类型检查
npm run typecheck:view   # 含 cc 的 View 文件（需先用 Cocos 打开过工程）
npm test                 # vitest
```
