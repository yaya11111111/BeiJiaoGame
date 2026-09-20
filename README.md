# 断线之后 · BeiJiaoGame

以北京交通大学为背景的 2D 动漫风格协作解谜游戏 · 微信小游戏 · 5 人实训项目

## 项目简介

双视角信息差解谜游戏。线索按视角拆开，任一视角都无法独立完成关键步骤，需要靠沟通把两边的信息拼起来。

| 模式 | 玩家数 | 玩法 |
|---|---|---|
| 单人 | 1 人 | 一个界面内切换查看两个视角 |
| 双人 | 2 人 | 各持一个视角，通过沟通交换线索 |

语音由玩家自行使用微信通话，游戏内提供文字聊天与快捷语句。

内容规模：新手引导 1 个 + 正式关卡 10 个（5 个地图章节 × 2 关），从校门开始逐关解锁。

## 技术栈

| 层 | 技术 |
|---|---|
| 客户端 | Cocos Creator 3.x + TypeScript（微信小游戏） |
| 后端 | Node.js + TypeScript（微信云开发 / 云托管） |
| 关卡配置 | JSON |

前后端通过 API 通信，语言统一为 TypeScript。

## 目录结构

```
client/   微信小游戏客户端（Cocos Creator 3.8.8 工程，可直接用 Dashboard 打开）
server/   后端服务
tests/    测试用例、缺陷清单与测试记录
```

各目录的说明见对应目录下的 README。项目文档为本地文件，不入库。

## 协作方式

- `main` 保持可运行
- 改动走短分支，1~3 天合并后删除
- 每人只改自己负责的文件，改别人的文件走 PR

```bash
git switch main && git pull
git switch -c feat/level-01

# 编写代码……

git commit -m "feat(level): 接入第1关热点点击 (FR-07)"
git push -u origin feat/level-01
# 在 GitHub 开 PR，review 后合并
```

## 目录所有权

| 路径 | 负责人 |
|---|---|
| `client/assets/scenes/` Guide、Level01~10 | D |
| `client/assets/scenes/` Home、Signin、ModeSelect、Room、Map、Collection、Settings | E |
| `client/assets/scenes/Result.scene` | 待定 |
| `client/assets/prefabs/` | D、E 按文件指定 |
| `client/assets/scripts/level/`、`scripts/common/` | D |
| `client/assets/scripts/ui/` | E |
| `client/assets/resources/configs/` | D |
| `client/assets/textures/` | A、B |
| `client/tests/` | D |
| `server/` | C |
| `tests/` | 全员 |

## 提交信息

格式：`<类型>(<范围>): <描述> (FR-xx)`

```
feat(level): 接入第1关热点点击 (FR-07)
fix(room): 修复断线重连丢失房间状态 (FR-03)
art(level02): 提交第2关双视角场景图
```

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `docs` | 文档 |
| `art` | 美术资产 |
| `test` | 测试用例与记录 |
| `chore` | 构建、配置、依赖 |

## 关键节点

| 日期 | 交付 |
|---|---|
| 9/22 | 技术路线与 10 关清单冻结 |
| 9/27 | 关卡故事设计文档定稿 |
| 10/4 | MVP 功能冻结，体验版可玩通引导 + 3 关 |
| 10/8 | 两份 PDF 文档 + 体验版 / 录屏 / 测试记录 |
| 第 10 周 | 中期展示 ≥7 关 + 完整双人流程 |
| 第 14 周 | 10 关全部可玩，结题资料齐全 |

## 开发环境

⏳ 待补：Cocos Creator 版本、微信开发者工具版本、构建与运行步骤（C、D 在 9/22 后填写）。
