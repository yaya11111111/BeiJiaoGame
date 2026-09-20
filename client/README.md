# client — 微信小游戏客户端

**负责人：D（关卡模块）、E（外层页面）**

> ⚠️ **本目录不要手工创建 Cocos 工程文件。** `settings/`、`package.json`、`assets/` 内的 `.meta` 等由 Cocos Creator 编辑器生成。
> 正确做法：用 Cocos Creator 新建工程时把路径指向本目录，让编辑器生成骨架，再提交。

## 技术栈

- **Cocos Creator 3.x + TypeScript**
- 导出目标：微信小游戏
- 关卡采用**配置数据驱动**（线索、触点、谜题、正误判定、奖励），不每关重写程序

## ⚠️ 最重要的一条：场景文件按人切开

Cocos 的 `.scene` 和 `.prefab` 是 **JSON 文件**。两个人同时改同一个文件，合并冲突**无法手工解决**——解决错了文件结构损坏，编辑器会直接拒绝加载。

所以：**D 和 E 永远不碰同一个 `.scene` 文件。** 这是本项目防冲突的第一道防线，比分支策略更重要。

| 路径 | 拥有者 | 说明 |
|---|---|---|
| `assets/scenes/Guide.scene` | **D** | 新手引导 |
| `assets/scenes/Level01.scene` ~ `Level10.scene` | **D** | 10 个正式关卡 |
| `assets/scenes/Home.scene` | **E** | 首页 |
| `assets/scenes/Signin.scene` | **E** | 登录 |
| `assets/scenes/ModeSelect.scene` | **E** | 选模式 |
| `assets/scenes/Room.scene` | **E** | 组队房间 |
| `assets/scenes/Map.scene` | **E** | 地图与节点解锁 |
| `assets/scenes/Collection.scene` | **E** | 成就图鉴 |
| `assets/scenes/Settings.scene` | **E** | 设置 |
| `assets/scenes/Result.scene` | **⚠️ 待明确** | 见下方「待明确事项」 |
| `assets/prefabs/` | **D、E 逐文件指定** | 公共控件，见下 |
| `assets/scripts/level/` | **D** | 关卡逻辑 |
| `assets/scripts/ui/` | **E** | 外层页面逻辑 |
| `assets/scripts/common/` | **D** | 公共工具，E 需要改动先找 D |
| `assets/configs/` | **D** | 关卡配置 JSON |
| `assets/textures/levels/` | **A、B 提交** | 关卡美术，**只增不改** |
| `assets/textures/ui/` | **A、B 提交** | UI 素材，**只增不改** |

## 共享预制体（`assets/prefabs/`）怎么管

公共控件（按钮、热点、物品栏、线索卡）**最容易冲突**——两边都要用。规则：

1. 每个 prefab 文件**指定唯一 owner**，写进上表
2. 别人需要改动，**找 owner 提需求**，或走 PR 由 owner 合并
3. 新增公共 prefab 前，先在群里说一声，避免两个人各建一个

## 待明确事项（9/22 前定）

- [ ] **结算页归属**：D 的职责含"结算"，E 的职责含"结算跳转"。建议拆成——关卡内结算逻辑归 D，结算页 UI 与跨页跳转归 E。需 D、E 确认。
- [ ] **场景加载方式**：一个场景 + prefab 切换，还是多场景切换？前者加载快、包体小，后者结构清晰。影响所有场景文件的组织方式。
- [ ] **公共 prefab 清单**：先列出来并指定 owner，再开工。
- [ ] **关卡配置 JSON 的字段定义**：`levelId` / `viewId` / `assetKey` / `nodeId` / `progress` 等，9/23 前由 D、C、E 共同冻结。

## 包体约束

- 首包约 4MB、总包约 30MB（以微信官方文档为准）
- 引擎运行时本身会占用首包，需实测裁剪后的体积
- 大资源（场景图、音频）放远程，首包只留首屏与引导所需
- **构建配置必须固化到工程模板**，不要每人各导一份
