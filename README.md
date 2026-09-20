# 断线之后 · BeiJiaoGame

> 以北京交通大学为背景的 2D 动漫风格协作解谜游戏 · 微信小游戏 · 5 人实训项目

## 这是什么

一款**双视角信息差**解谜游戏。线索按视角拆开，**任何一个视角都无法独立完成关键步骤**，必须靠沟通把两边的信息拼起来。

| 模式 | 玩家数 | 玩法 |
|---|---|---|
| 单人模式 | 1 人 | 一个界面内切换查看两个视角 |
| 双人模式 | 2 人 | 各持一个视角，靠沟通交换线索 |

- 语音：玩家自行使用微信语音通话（游戏内不做实时语音）
- 游戏内提供：文字聊天 + 快捷语句
- 内容规模：新手引导 1 个 + 正式关卡 10 个（5 个地图章节 × 2 关）
- 从校门开始，逐关解锁校园地图

## 技术栈

| 层 | 技术 |
|---|---|
| 客户端 | 微信小游戏 + **Cocos Creator 3.x + TypeScript** |
| 后端 | **Node.js + TypeScript**（微信云开发 / 云托管） |
| 关卡配置 | JSON（由 TypeScript 类型约束） |

> **全栈 TypeScript** —— 前后端同一种语言。架构上前后端严格分离（客户端只调 C 的接口），语言上统一用 TS。

## 目录结构

```
BeiJiaoGame/
├── docs/          # 全部项目文档
├── client/        # 微信小游戏客户端（Cocos Creator 工程）→ 见 client/README.md
├── server/        # 后端服务（Node.js + TypeScript）→ 见 server/README.md
└── tests/         # 测试用例、缺陷清单、测试记录 → 见 tests/README.md
```

---

## ⚠️ 三条铁律

### 1. `main` 分支永远是可运行的

任何时刻 `git clone` 下来的 `main` 都必须能用 Cocos Creator 打开、能上真机。
**这是本项目的核心质量约定**，也是《软件质量与测试》实训最直接的证据。

### 2. 不许直接往 `main` 推，一律走分支 + PR

```bash
# 开新活
git switch main
git pull
git switch -c feat/level-01

# 干活……干完提交
git add .
git commit -m "feat(level): 接入第1关热点点击 (FR-07)"
git push -u origin feat/level-01

# → 去 GitHub 开 Pull Request，至少 1 人 review 后合并
# 合并后删掉本地分支
git switch main
git pull
git branch -d feat/level-01
```

**分支寿命控制在 1~3 天**，合完就删。不要每人一条长期分支——`client/` 里的 `.scene` 和 `.prefab` 是 JSON 文件，长期分叉后**合并冲突无法手工解决**，解错了编辑器直接拒绝加载。

### 3. 只改自己拥有的文件

见下方所有权表。要改别人的文件，**走 PR 让 owner 合并**。

---

## 目录所有权表

**每个人的工作边界。** 5 个人并行改代码，最大的风险是互相覆盖，这张表就是防线。

| 路径 | 拥有者 | 说明 |
|---|---|---|
| `docs/关卡故事设计文档.md` | **A** | 总编；B 是共同作者，走 PR |
| `docs/需求分析和产品设计文档.md` | **C** | 唯一整合与提交人，其他人只读 |
| `docs/实现形式选型对比报告.md` | **C** | 已定稿 v2 |
| `docs/项目分工.md` | **A** | — |
| `client/assets/scenes/Guide.scene` | **D** | 新手引导 |
| `client/assets/scenes/Level01.scene` ~ `Level10.scene` | **D** | 10 个正式关卡 |
| `client/assets/scenes/Home` `Signin` `ModeSelect` `Room` `Map` `Collection` `Settings`.scene | **E** | 外层页面 |
| `client/assets/scenes/Result.scene` | **⚠️ 待明确** | 见 `client/README.md` |
| `client/assets/prefabs/` | **D、E 逐文件指定** | 公共控件，最容易冲突，见 `client/README.md` |
| `client/assets/scripts/level/` `common/` | **D** | — |
| `client/assets/scripts/ui/` | **E** | — |
| `client/assets/configs/` | **D** | 关卡配置 JSON |
| `client/assets/textures/` | **A、B 提交** | **只增不改** |
| `server/` | **C** | 其他人只读 |
| `tests/` | **全员可加** | 按模块分文件 |

---

## 提交信息规范

格式：`<类型>(<范围>): <描述> (FR-xx)`

```
feat(level): 接入第1关热点点击 (FR-07)
fix(room): 修复断线重连丢失房间状态 (FR-03)
docs(story): 补充第3关开场与结局 (FR-08)
art(level02): 提交第2关双视角场景图
test(level): 补充关卡判定单元测试 (FR-07)
```

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `docs` | 文档 |
| `art` | 美术资产 |
| `test` | 测试用例与记录 |
| `chore` | 构建、配置、依赖 |

**带上 `FR-xx` 编号**（定义见 `docs/《断线之后》需求评审.md` 第 5 章）——这是需求→代码→测试的**可追溯性**证据，答辩会被问。

---

## 关键时间节点

| 日期 | 交付 |
|---|---|
| **9/22** | 技术路线与 10 关清单冻结（C+D 真机验证） |
| **9/27** | 《关卡故事设计文档》定稿 |
| **10/4** | MVP 功能冻结，体验版可玩通引导 + 3 关 |
| **10/8** | 两份 PDF 文档 + 体验版 / 录屏 / 测试记录 提交 |
| **第 10 周（11/9—15）** | 中期展示 ≥7 关 + 完整双人流程 |
| **第 14 周（12/7—13）** | 10 关全部可玩，结题资料齐全 |

完整分工与依赖交接见 `docs/项目分工.md`。

---

## 怎么跑起来

> ⏳ 待补：C、D 在 9/22 技术路线冻结后填写。
> 需要包含：Cocos Creator 版本、微信开发者工具版本、AppID、构建步骤、云环境配置方式。

---

## 开发环境注意事项

- **`library/` `temp/` `build/` 等目录已在 `.gitignore` 中排除**，不要提交，否则仓库会迅速膨胀到几个 G
- 美术**源文件**（PSD/AI）体积大，放网盘共享；仓库里只放导出的 webp/png
- 密钥、secretId 等一律放 `.env`，已排除，**绝不提交**
