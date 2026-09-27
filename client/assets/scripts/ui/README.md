# E 外层页面模块

本目录负责微信小游戏的关卡外页面与地图，不包含 D 的关卡逻辑。当前视觉和页面流已按
`C:\Users\20417\Documents\Codex\2026-09-15\zh\outputs\e-ui-demo` 的网页原型迁移：
晴日校园配色、首页入口、模式选择、房间、校园地图、10 个节点、关卡目录、图鉴和设置。

## 已实现

- 登录占位页：本地身份演示，后续接 C 的 `wx.login`
- 云开发初始化：`AppShellView.onLoad()` 调用 `initWechatCloud()`，全局只执行一次，环境为 `cloudbase-d2gvkcgabfaf9768`，`traceUser: true`
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
- 关卡入口桥接页：等待 D 提供统一关卡进入接口
- 结算页：记录最好用时、解锁下一节点、点亮图鉴
- 图鉴页与设置页：本地可交互

## 在 Cocos Creator 中挂载

1. 使用 Cocos Creator 3.8.8 打开 `client/`。
2. 在默认场景或 E 自己的 `Home.scene` 中选中 `Canvas`。
3. 把 `assets/scripts/ui/AppShellView.ts` 拖到 `Canvas` 上，或通过添加组件选择 `AppShellView`。
4. 预览场景，点击“微信登录 / 本地演示”进入首页。
5. 后续拆分独立场景时，保留 `AppState.ts`，把 `AppShellView.ts` 的各页绘制逻辑迁移到对应的 `Home/Signin/ModeSelect/Room/Map/Collection/Settings.scene`。

## 等待外部接口后替换的位置

- `signinAsGuest()`：替换为 C 的微信登录与用户资料接口。
- `createLocalRoom()` / `joinLocalRoom()`：替换为建房、入房、退出、重连接口。
- `completeLevel()`：替换为 D 结算回调 + C 进度保存接口。
- `getNextUnlocks()` 与 `unlockedProgress`：当前只是本地演示数据，等待 C 确认进度/解锁模型后再收口为正式规则。
- `MAP_REGIONS` / `getMapRegions()`：当前先实现“每关一个区域、由外向里推进、锁定区域变灰”的地图骨架。
  锁定区使用轻量灰度和斜线纹理，不再覆盖成厚重的灰色圆角块；已通关区域显示可探索互动点，
  `completedAchievementIds` 后续可替换为山楂、小红果、点击思源楼等正式成就条件。
- `MINI_PROGRAM_CONFIG`：当前使用 AppID `wxf23657dd9d6612f4` 与云环境 `cloudbase-d2gvkcgabfaf9768`。

`AppShellView.ts` 以 `View.ts` 结尾，避免被 Node 单测的 `cc` 模块解析规则误收进去。

## 仍需补充的信息

1. C 的 `server/API.md`：登录、用户进度、房间创建/加入/退出/重连、图鉴和统计接口。
2. D 的统一关卡入口：例如 `openLevel(levelId, mode)` 或场景名映射，以及结算回调字段。
3. A/B 的关卡缩略图、纪念物图片和最终关卡名称；收到后放入 `assets/resources/` 并替换当前绘制占位。
4. 图鉴素材清单：10 张漫画卡、卡背文字顺序、跨关物品 ID 和出现关卡。
