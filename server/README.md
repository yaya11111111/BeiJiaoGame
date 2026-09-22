# server — 后端服务

负责人：C

技术栈：**Node.js + TypeScript，跑在微信云开发云函数上**。

## 技术选型（已决策，不再讨论）

| 待定项 | 结论 | 理由 |
|---|---|---|
| 云开发 vs 云托管 | **微信云开发（云函数 + 云数据库）** | 备案未完成也能跑：云函数调用走微信内部通道，不需要配置 request 合法域名、不依赖 ICP 备案；零运维；免费额度够 5 人实训 |
| 云函数拆分方式 | **单函数 `game` + action 路由** | 云开发每个函数是独立 npm 包，函数间无法共享代码。拆多个函数就得把公共代码复制多份，改一处同步多处 |
| 双人同步方式 | **客户端每 1 秒轮询 `event.pull`**，不用数据库 `watch` | `watch` 受集合权限、连接数、切后台断连影响，出问题难排查；轮询与断线重连共用同一套 `sinceSeq`，代码只有一份；点击解谜对延迟不敏感 |
| 关卡配置拆分 | 客户端只留"外壳"，线索正文与答案上服务端 | 见下节 |

### 关卡配置怎么拆（需要 D 配合）

现在 `client/assets/resources/configs/*.json` 里同时有 A、B 两侧线索和 `puzzle.answer`，**解包就能看到对面视角的信息和答案**，跟"服务端只下发当前视角线索"的口径冲突。

| 留在客户端包里 | 搬到服务端 `levels` 集合 |
|---|---|
| `levelId` / `chapterId` / `title` / `mode` / `timeLimitSec` | `views.A.clues` / `views.B.clues`（即 `hotspot.text`） |
| `views.*.assetKey`（背景图 key） | `puzzle.answer`（只用于服务端判定，永不外传） |
| `views.*.hotspots[].nodeId` / `rect` / `action` / `itemId` / `requiresItem` / `revealsNode` / `hiddenByDefault` | `puzzle.requiredItems` / `maxAttempts`（可选，也可留客户端） |
| `hints` / `rewards.progress` | |

`nodeId` 和 `rect` 必须留客户端——客户端要先知道有这个热点，才能在被 `revealsNode` 揭示后显示出来。要搬走的只是**线索正文**（`text`）和**答案**。

## 目录结构

```
server/
├── API.md                      接口契约 v1 —— D 和 E 看这个就够了
├── README.md                   本文件
└── cloudfunctions/
    └── game/                   唯一的云函数
        ├── index.ts            入口：解析 action → 查路由表 → 分发
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── actions/
            │   ├── index.ts    action 路由表（新增接口在这里登记）
            │   ├── auth.ts     登录建档 / 档案 / 改昵称
            │   ├── room.ts     建房 / 入房 / 离开 / 状态 / 心跳
            │   ├── level.ts    按视角下发线索 / 服务端判答案
            │   ├── event.ts    事件发布、增量拉取、埋点
            │   └── progress.ts 进度读写
            └── shared/
                ├── db.ts       数据库连接、openid、seq 分配
                ├── types.ts    所有数据结构定义
                └── errors.ts   错误码与统一信封
```

## 本地改代码

```bash
cd server/cloudfunctions/game
npm install          # 第一次
npm run build        # TypeScript → JavaScript，产物就在同目录
npm run watch        # 边改边编译
```

**改完必须 `npm run build`**，云函数上传的是编译后的 `.js`，不是 `.ts`。

## 部署到云开发

云函数的源码在 `server/`，但微信开发者工具只认**小游戏工程目录**下的 `cloudfunctions/`。
所以流程是：

1. `npm run build` 编译
2. 把 `index.js`、`src/**/*.js`、`package.json` 复制到小游戏工程的 `cloudfunctions/game/`
   （小游戏工程 = `client/build/wechatgame/`，是 Cocos 构建产物，也可以直接在
   微信开发者工具里单独开一个云开发项目）
3. 微信开发者工具里右键 `cloudfunctions/game` → 「上传并部署：云端安装依赖」

> 这套手工拷贝后面可以写个脚本自动化，等第一次跑通再说。

## 建库与索引（在云开发控制台做一次）

建 5 个集合：`users` / `rooms` / `progress` / `events` / `levels`。

**必须建索引**（不建会慢或报错）：

| 集合 | 索引 | 用途 |
|---|---|---|
| `events` | `roomId`（升序）+ `seq`（升序）复合索引 | `event.pull` 增量拉取 |
| `progress` | `openid`（升序） | `progress.get` 取全部进度 |
| `progress` | `openid` + `status` 复合索引 | 统计已通关数 |

**权限设置**：客户端一律不直连数据库，全部走云函数。集合权限按最严的来设，
否则"只下发当前视角线索"这条约束会被绕过。

## 待办

- [ ] `levels` 集合导入关卡私密数据（等 D 拆分配置后，A/B 提供线索正文）
- [x] 云开发控制台建集合与索引（2026-09-22 完成：5 个集合权限均为「所有用户不可读写」；`events` 有 `roomId`+`seq` 复合非唯一索引，`progress` 有 `openid` 与 `openid`+`status`）
- [ ] 真机跑通：建房 → 加入 → 分视角 → 发消息 → 同步 → 一人退出重连 → 进度保存（9/30 联调）
