# client — 微信小游戏客户端

负责人：D（关卡模块）、E（外层页面）

技术栈：Cocos Creator 3.x + TypeScript，导出微信小游戏。关卡由配置数据驱动。

工程由 Cocos Creator 编辑器生成（`settings/`、`package.json`、`assets/` 内的 `.meta` 等），新建工程时把路径指向本目录。

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
| `assets/configs/` | D |
| `assets/textures/` | A、B |

`assets/prefabs/` 是公共控件（按钮、热点、物品栏、线索卡），两边都会用到。每个 prefab 指定唯一负责人，他人需要改动时找负责人提需求或走 PR。

## 待定事项（9/22 前确定）

- **Result.scene 归属**：D 的职责含"结算"，E 的职责含"结算跳转"。建议关卡内结算逻辑归 D，结算页 UI 与跳转归 E。
- **场景加载方式**：单场景 + prefab 切换，或多场景切换。
- **公共 prefab 清单**：先列出并指定负责人。
- **关卡配置字段**：`levelId` / `viewId` / `assetKey` / `nodeId` / `progress` 等，9/23 前由 D、C、E 冻结。

## 包体约束

首包约 4MB、总包约 30MB（以微信官方文档为准）。引擎运行时占用首包，需实测裁剪后的体积。

大资源（场景图、音频）放远程，首包只保留首屏与引导所需；构建配置固化到工程模板。
