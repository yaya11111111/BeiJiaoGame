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
- 地图页：使用新的手绘校园底图（`images/campus-map-gray`），11 个关卡各对应一块区域；
  **初始整张地图是灰的**，解锁一关后把该区域的彩色补丁（`images/campus-region-*`）盖回灰底
- 地图区域：区域来自标注图（图一）的黑色分区线，按关卡点位做连通填充得到 11 块；
  矩形与关卡圆标坐标集中在 `MapLayout.ts`，换底图只改这一份表
- 地图点位：11 个编号圆标（0—10）按图一红框中心定位；点击已解锁圆标进入模式选择，
  名称气泡只在选中关卡时显示，避免 11 个标签盖住底图
- 地图手势：拖动 / 双指缩放沿用原逻辑；底图按 1040:600 等比适配，不再拉伸
- 校门状态：第 1 关（`L01` 或 `level_1`）完成后，西门、东门、北门由灰暗状态切换为彩色
- 关卡入口：地图上点「进入当前关卡」→ 调 D 的 `mountLevel()`（`../level/LevelMountView`），
  关卡节点建在 Canvas 上盖住本层，本层先被藏起来；退出或通关后自动恢复。**不再有占位桥接页**
- 结算页：记录最好用时、解锁下一节点、点亮图鉴；本关彩蛋状态（`LevelReview.eggs` 有数据时显示）
- **失败结算**：失败后退出关卡进入复盘页（用时 / 失败原因 / 已收集线索 / 再来一次 / 回地图；
  双人给「返回房间」）。失败**不写通关进度、不覆盖最好用时**
- 图鉴页：分为「关卡成就 / 线索收藏 / 彩蛋记录」三栏；关卡成就沿用地图区域，
  线索收藏与彩蛋记录来自跨关本地收藏（见下）
- 设置页：资料、昵称、头像、音乐/音效/新手提示开关、个人记录与意见反馈入口、隐私口径；
  **三个开关写入本地缓存，重启后保持**（验收 OUT-21）
- 地图复玩：已通关节点继续显示为可进入状态，地图与关卡目录均可重新选择；
  目录显示最好用时，结算页可回地图或进入图鉴
- 云端接入口：微信环境中登录同步 `auth.login` + `level.list`，双人房间接入
  `room.create` / `room.join` / `room.state` / `room.heartbeat` / `room.leave`，
  预览环境继续安全降级为本地演示
- 关卡埋点：进入、退出、通关调用 `event.report`；关卡内容与答案仍由 D/C 的关卡接口负责
- **个人记录（US08 / 统计展示入口）**：汇总已通关、累计/平均最好成绩、最快一关、收藏数量，
  逐关列出状态与最好用时；登录后拉 `auth.profile` 显示服务端口径（`clearedCount` / `totalTimeMs`）
- **房间页聚合轮询**：按 C 的 `room.sync` 接入说明，房间/结算页用一次云调用同时拿快照、事件和在线状态，
  替掉 `room.state` + `room.heartbeat`；间隔按安静轮数 1.2→3→5 秒自适应，回前台立刻补一次。
- **排行榜与双人搭档档案（首版）**：个人记录页进入；「单人榜 / 双人榜 / 搭档档案」三栏，
  关卡按 L01—L10 切换，显示名次/玩家/用时/得分；搭档档案显示合作关数、一起玩局数、徽章与“邀请”。
  接口按 C 的 `rank.level` / `partner.list`（2026-11-13 草案）；服务端已排序算分，E 不重排、不算分。
  接口未就绪时显示“示例数据”，上线后自动切换
- **通关纪念截图**：结算页“保存纪念截图”，通过小游戏 Canvas 导出 PNG 后调用
  `wx.saveImageToPhotosAlbum` 存相册；相册权限被拒时给出可读提示
- **关卡外音效与震动**：按钮点击播放 `audio/sfx-click`（受“操作音效”开关控制）；
  通关/失败时 `wx.vibrateShort` 轻震，失败为重震
- **意见反馈（FR-14）**：设置页与结算页入口；四类（Bug / 卡住 / 建议 / 新玩法）、
  最多 300 字说明、可选 1 张截图（传云存储 `feedback/`）；自动附带关卡、模式、视角、
  房间码、来源页与提交时间；提交后回显成功/失败，最近 3 条回执存本地
- **双人保存退出与恢复（FR-15 的 E 侧）**：双人关卡中途退出时把房间、关卡、视角、
  已用时、本轮 `startedAt` 和 D 的局内快照（`LevelReview.progress`）存本地，并调用
  `save.write` 同步云端；房间页按 `room.state/room.sync` 的 `hasSave` 调 `save.load`
  拉回自己那一半进度，继续时用 `mountLevel.resume` 恢复道具 / 操作 / 错误次数 / 场景，
  倒计时从冻结的已用时接着走。「重新开始」会调 `save.clear` 清掉旧存档
- **跨关收藏（FR-11 的 E 侧）**：通关带出的线索道具（跳过 hidden 中间件）与彩蛋发现
  按 id 去重累积，写本地缓存；地图节点与个人记录显示彩蛋 `x/y`。图鉴分为“地图彩蛋 / 线索记录 / 关卡彩蛋”，内容区可滚动。
- **背景音乐**：`resources/audio/bgm-campus.mp3`，进入游戏即循环播放（音量 50%）；
  设置页「背景音乐」开关即时生效并持久化；切后台自动暂停、回前台恢复；
  首次触摸会补一次播放以绕过自动播放限制
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
| `Ranking.ts` | 排行榜 / 搭档档案的数据整理、接口字段归一化与示例数据 |
| `Feedback.ts` | 反馈分类、校验、上下文、提交载荷、本地回执 |
| `DuoSession.ts` | 双人保存进度的读写、有效期判断、恢复时间换算 |
| `PlayerLibrary.ts` | 跨关收藏（线索 + 彩蛋）的合并、去重与本地缓存 |
| `LocalStore.ts` | 微信同步存储 / 内存降级的适配层 |
| `MapLayout.ts` | 新地图的区域矩形、关卡点位、区域上色规则（与 AppShellView 分离，便于单测） |
| `SettingsStore.ts` | 设置项的本地持久化（重启后保持） |
| `WechatCloud.ts` | 云初始化、头像与反馈截图上传、云文件 URL |

## 地图资源与重新生成

| 资源 | 说明 |
|---|---|
| `resources/images/campus-map-gray.png` | 全灰底图（由彩图去色生成，保证与补丁像素对齐） |
| `resources/images/campus-region-<level>.png` | 每关一块彩色补丁，透明区域在区域外 |
| `resources/audio/bgm-campus.mp3` | 背景音乐（128kbps，约 2.9MB，随 `resources` 分包；换曲直接替换同名文件） |

生成脚本在仓库 `tools/`：

```bash
python tools/build_map_assets.py <图一.png> <图二.jpg> <输出目录> final
python tools/install_map_assets.py <输出目录> client/assets/resources/images
```

- 图一 = 带红/黑标注的图，用来识别区域和点位；图二 = 彩色原图。
- 脚本会对每个关卡点位做黑色分区线内的连通填充，得到该关自己的区域，再按区域裁剪彩图。
- 换底图后如果区域位置变了，重跑这两个脚本即可；`MapLayout.ts` 里的矩形需要同步更新
  （脚本会打印 `regions.json`，矩形就是里面的 `rect`）。

## 等待外部接口后替换的位置

- `signIn()`：C 的微信登录已完成；昵称/头像走 `auth.updateProfile`
- `createRoom()` / `joinRoom()`：已接 C 的 `room.*`；房间内进关卡走 `mountLevel`
- `completeLevel()`：**已接上 D 的关卡回调** —— 解锁节点直接用 `LevelReview.unlockedNodeIds`
  （来自关卡配置的 `rewards.progress`）。进度落库仍由 D 的 `level.submit` 负责
- `getNextUnlocks()`：**已废弃**，别再用它算解锁（硬编码、和配置对不上）。留着只是给
  `uiAppState.test.ts` 造演示数据。
- `unlockedProgress` / `createInitialAppState()` 里的演示数据：等 C 的进度接口来了换成真实进度。
- `MAP_REGIONS` / `getMapRegions()`：仍然是图鉴成就（地图彩蛋）的条目来源；
  地图上的**上色区域与点位**改由 `MapLayout.ts` 的 `CAMPUS_MAP_REGIONS` 维护，两者不要混用。
- `MINI_PROGRAM_CONFIG`：当前使用 AppID `wxf23657dd9d6612f4` 与云环境 `cloudbase-d2gvkcghabfaf9768`

## 新需求里 E 还需要 C / D 配合的部分

见 `接口需求.md`。一句话版本：

1. **反馈**：C 需要 `feedback.submit`（现在页面已经按约定字段调用，未部署时会显示“提交失败”并保留草稿）。
   C 还需提供管理员查看/处理反馈的受控入口：按微信 `openid` 白名单或等价服务端角色校验，
   查询反馈列表与详情、读取截图、更新处理状态；普通玩家不得读取其他人的反馈。
   E 只负责玩家提交及状态回显，不在客户端硬编码管理员身份。项目负责人需指定管理员微信账号，
   由 C 配置权限并说明查看方式；若仅在云开发控制台查看，也由 C 配好数据库权限并交付操作说明。
2. **双人保存（FR-15）**：C 的 `save.write` / `save.load` / `save.clear` 已在 v3.3 落地，
   E 已接入：中途退出先写本机再 `save.write`；房间页按 `hasSave` 调 `save.load`，
   用返回的 `mine.progress` + `elapsedSec` 走 `mountLevel.resume`；「重新开始」调 `save.clear`。
   房主退出房间前会等本次 `save.write` 完成再 `room.leave`（API-W8-FINAL §4）。
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
