# 《知行谜站》后端接口契约 v3.9

负责人：C　｜　状态：**2026-11-20 v3.9 双人榜改「一队一条」（有代码改动，E 需配合）**　｜　调用方：D（关卡模块）、E（外层页面）

> 这份文件是 D 和 E 的开工依据。**接口名、字段名一旦改动，必须在这里先改并通知 D、E**，不要只在代码里改。
>
> v3 的两条口径在 2026-10-12 由 C 与 E 当面确认，**不要再改**：
> ① **房主离开 = 房间关闭**；② **新手引导关 `GUIDE` 允许在双人房里选**。详见 §5。
>
> v3.5 只是**新增** `room.sync`，老的 `room.state` / `room.heartbeat` / `event.pull` 行为一个字都没改，
> 老客户端不接也不受影响。D / E 的改法见 `room-sync-接入说明.md`。
>
> **v3.6 草案（2026-11-13）**：排行榜与双人搭档档案，见 **§8**。完整版在 `rank-partner-契约草案.md`。
> **v3.8 起 §8 已定稿并实现**，草案文档仅作历史留档。
>
> **v3.7（2026-11-16）**：把 7 条「文档写法 ≠ 服务端实际行为」对齐到**当前实现**（A1–A7），
> 涉及 `room.create` 的大小写、`room.start` 的越权错误码、存档接口名 `save.write`、
> `event.publish` 的类型校验强度、`event.pull` 对 `sinceSeq` 的容错、`level.submit` 次数耗尽后的语义。
> A8/A9/A10 三条未修，登记在 **§10 待办**。
>
> **v3.8（2026-11-19）**：
> ① **新增 `rank.level` / `partner.list`**（§8 定稿），`scores` / `partners` 两个集合从草案转为正式；
> ② `level.submit` 新增返回 `score` / `rank` / `isNewBest`（外加重复结算时的 `duplicate`），**原有字段一个没动**；
> ③ 新增错误码 **`4003` 本关时间已到**（限时关超时提交）；
> ④ 修掉 **T9**（双人同局重复结算）、**T10**（超时后提交仍落 cleared）、**T7**（未开局存档 pairKey 读不回）。
> **T6（越权提交未解锁关卡）仍未修**，留在 §10。
> **本文只加不改**：老客户端不接 `rank.level` / `partner.list` 完全不受影响。
>
> **v3.9（2026-11-20）：双人榜改「一队一条」**，是**唯一一次破坏性口径变更**：
> ① `scores` 双人记录从「一人一条」改为**按 `pairKey` 聚合，一队一条**，
>    `_id = duo_<sha256 摘要>`，成员写在 `openids`；
> ② `rank.level` 每行新增 **`players: [{ nickname, avatarUrl, isMe }]`**，
>    `total` / `rank` / `mine` 改为**队伍口径**；平级 `nickname` / `avatarUrl` 保留作兼容；
> ③ 双人榜查询带 `openids: _.exists(true)`，v3.8 旧双人记录自动挡在榜外，**不用清库**；
> ④ `level.submit` 双人分支只写一条队记录，返回体形状不变。
> **E 需要改的只有排行榜双人榜的渲染**（用 `players` 而不是 `nickname`），其余接口零改动。
> 详见 §8.3 与 §4 `rank.level`。

---

## 1. 怎么调用

### 前置：客户端必须先初始化（E 负责，只做一次）

**不执行下面这段，任何 `wx.cloud.callFunction` 都会失败**。

| 项 | 说明 |
|---|---|
| 谁写 | **E**（外层入口负责人）。D 不用管，C 的云函数侧已经自己 init 过了 |
| 写在哪 | 小游戏**启动入口**，全局只执行一次，不要每个页面都调 |
| 什么时候 | `wx.cloud.init` 是同步的，放在入口最前面即可，必须早于任何 `callFunction` |
| envId 在哪看 | 微信开发者工具 → 云开发 → 环境设置 → **环境 ID**，或控制台顶部环境名旁边 |

```js
// 小游戏启动入口（game.js 或 Cocos 构建产物的入口文件）
if (!wx.cloud) {
  console.error('当前基础库不支持云开发，请升级微信版本');
} else {
  wx.cloud.init({
    env: 'cloudbase-xxxxxxxx', // ← 换成你开通的那个环境 ID
    traceUser: true,           // 自动记录用户访问，后台「独立玩家数」统计要用
  });
}
```

三个注意点：

1. **`env` 只写这一处**。换环境只改这个字符串，客户端其他代码不用动
2. **`traceUser: true` 建议开**。它是分工里要求的「独立玩家数」统计口径，不用我们自己埋点
3. **云存头像时要配云存储权限**，见 §6（这点容易漏，漏了的表现是「头像上传失败」）

> 云函数**内部**不需要这段——`src/shared/db.ts` 里已经用 `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })` 处理过了，部署到哪个环境就自动用哪个。

---

后端只有一个云函数，名字叫 `game`，内部按 `action` 分发。

```ts
const res = await wx.cloud.callFunction({
  name: 'game',
  data: { action: 'room.join', params: { code: 'AB3K9Q' } },
})
// res.result 只有两种形状：
// 成功 → { ok: true,  data: {...} }
// 失败 → { ok: false, code: 2001, message: '房间不存在，请检查房间码' }
```

**客户端一定要判 `ok`**，不要只看有没有报错。业务失败（房间满了、参数不对）也是走 `ok: false`，不会抛异常。

openid 由云函数从微信上下文自动获取，**客户端不用传、也传不了**。

### 在开发者工具 Console 里自测（C 自用，也供 D / E 排查）

> ⚠️ **文档里 `auth.login {}` 这种写法是「简写记法」**，意思是「调 `auth.login`，参数是空对象」，
> **不能直接粘进 Console**。JS 会把 `auth.login {}` 解析成「表达式 `auth.login` + 一个块语句 `{}`」，
> 立刻报 `Uncaught SyntaxError: Unexpected token '{'`。本文档所有接口小节里的 `{ ... }` 都是**参数示意**，
> 不是可直接执行的代码。

Console 里要写成真正的函数调用。**粘一次，后面反复用**：

```js
// 1) 初始化（每个调试窗口各做一次；env 换成测试环境 ID）
wx.cloud.init({ env: 'cloudbase-xxxxxxxx' })

// 2) 调用器：action 是字符串，params 是对象
var api = async (action, params = {}) => {
  const r = await wx.cloud.callFunction({ name: 'game', data: { action, params } })
  console.log(action, r.result)
  return r.result
}

// 3) 断言小工具：失败直接抛，成功只回 data
var mustOk = (r) => { if (!r.ok) throw new Error(r.code + ' ' + r.message); return r.data }
```

用法对照：

```js
await api('auth.login')                                     // ← 文档里的「auth.login {}」
await api('auth.updateProfile', { nickname: '小明' })        // ← 「auth.updateProfile {nickname}」
const room = mustOk(await api('room.create', { levelId: 'GUIDE' }))
await api('room.join', { code: room.code.toLowerCase() })    // 故意传小写，验证 join 会转大写
```

三个最常见的坑：

| 现象 | 原因 | 解法 |
|---|---|---|
| `SyntaxError: Unexpected token '{'` | 把简写记法当代码粘了 | 写成 `api('auth.login', {})` |
| `{ok:false, code:1001}` | 当前窗口没执行过 `wx.cloud.init`，或模拟器没走微信登录态 | 先 init；仍不行就重启模拟器 |
| 先打印 `Promise {<pending>}`、后面才是结果 | 忘了 `await` | 加 `await`；老版本 Console 不支持顶层 await 时改成 `api(...).then(r => ...)` |

> 顺带说明：`Promise {<fulfilled>: undefined}` 说明上一句**执行成功了但没打印结果**
> （`callFunction` 的返回值没取 `res.result`）。所以看到它不等于报错，是写法问题。

### 部署（C 负责）

云函数源码是 TypeScript，**部署前必须先编译**，产物不入库（`.gitignore` 忽略了 `*.js`）：

```bash
cd server/cloudfunctions/game
npm run build            # 等价于 tsc -p tsconfig.json
# 产物：index.js + src/**/*.js
```

产物出来后上传到云开发（二选一）：

- **A**：微信开发者工具打开 `client/` 目录 → 在该目录下建 `cloudfunctions/` → 把编译好的 `game/` 整个拷进去 → `client/project.config.json` 加 `"cloudfunctionRoot": "cloudfunctions/"` → 右键 `game` 目录 → **上传并部署：云端安装依赖**
- **B**：把 `game/` 打成 zip，云开发控制台 → 云函数 → 上传 zip，同样勾「云端安装依赖」（别带 `node_modules`）

> **`package.json` 里只有 `wx-server-sdk` 一个运行时依赖**，所以「云端安装依赖」能用；如果要带上本地 `node_modules` 上传，包会大很多。

#### v3.8 部署前必须做的两件事（不做会报错 / 全表扫）

1. **建两个集合**：云开发控制台 → 数据库 → 新建 `scores`、`partners`。
   **云开发写不存在的集合会直接报错**（`-502005 database collection not exists`），
   不是自动建表 —— 漏了这一步，第一次通关就会在日志里冒出 `[level] 榜单/搭档档案写入失败`。
2. **建索引**：见 §8.6 那张表（`scores` 两条、`partners` 一条）。
   不建也能跑，但榜单是 `where + orderBy` 的查询，没索引会全表扫，人一多就慢。

> 榜单/搭档档案的写入是**附带产物**：整段包在 try 里，写失败只打日志，**不会让玩家通关失败**。
> 所以上线初期可以先建集合、后补索引，页面最多是"榜单空着"。

---

## 2. 错误码

| code | 含义 | 客户端建议处理 |
|---|---|---|
| 1001 | 拿不到用户身份 | 提示重新进入小游戏 |
| 1002 | 没有管理权限（openid 不在 `admins` 名单里） | 管理端接口专用，玩家侧不会遇到；开发期直接看 message |
| 2001 | 房间不存在 | 提示检查房间码 |
| 2002 | 房间已满（每间最多 2 人） | 提示换一个房间 |
| 2003 | 房间已关闭 | 回首页 |
| 2004 | 你不在这个房间里 | 回首页 |
| 2005 | 只有房主可以更换关卡（**不是 2004**，越权的人确实在房间里） | 把换关入口置灰/隐藏，别显示成"房间已关闭" |
| 3001 | 参数缺失或格式不对 | 开发期报错，别吞掉 |
| 4001 | 关卡数据缺失 | 提示联系管理员（一般是 C 没导配置） |
| 4002 | 缺少必要道具（requiredItems 未凑齐） | 提示先去场景里找道具；**不消耗容错次数** |
| 4003 | 本关时间已到（限时关超时后才提交，v3.8） | 结算页显示"时间到"；正常客户端不会收到 —— 本地计时归零后就不该再上报 |
| 5000 | 服务端内部错误 | 提示稍后重试 |

> E 的 `AppShellView.cloudErrorText` 已经按 code 映射了提示文案；**加新错误码要同步去那里加一行**，否则会退化成显示服务端原始 message。`4003` 需要在 E 那边补一行文案。

## 3. 数据表（云开发数据库，共 11 个集合）

### `users` — 用户档案
`_id` 就是 openid。

| 字段 | 类型 | 说明 |
|---|---|---|
| `openid` | string | 微信身份标识，不对外下发 |
| `nickname` | string | 玩家自设昵称，1–16 字符 |
| `avatarUrl` | string? | 头像。可以是云存储 fileID（`cloud://…`）或 https 地址，由客户端自己上传后写入。服务端只截断到 2048 字符，**不校验来源** |
| `createdAt` / `lastLoginAt` | number | 毫秒时间戳 |
| `currentLevelId` | string | 最近进入的关卡（`GUIDE` / `L01`…） |

### `rooms` — 双人房间
`_id` 就是 6 位房间码。

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 房间码，同 `_id` |
| `levelId` | string | 本房要玩的关卡 |
| `hostOpenid` | string | **建房者 = 房主**。这个值建好后不会变，也不会因为房主离开而清空 |
| `status` | string | `waiting`（等人/已人齐但房主还没开局）/ `playing`（进行中）/ `closed`（已关闭） |
| `startedAt` | number | 房主统一开局的服务端时间戳；**`0` 表示还在房间准备页、没人点过开始**。由 `room.start` 写入，换关/有人离开时归零 |
| `sessionPlayers` | array | **本局开局瞬间房内两人的 openid 快照**（v3.3 新增）。`room.start` 时写入，双人存档靠它算 `pairKey`。**不能改用 `players`**：玩家退出会从 `players` 里移除成员，先退的人一走就凑不齐两个人了 |
| `players` | array | `[{ openid, nickname, viewId: 'A'\|'B', online, lastSeenAt }]`，最多 2 项 |
| `lastSeq` | number | 房间内事件序号，只由服务端自增 |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |

**viewId 分配规则**：第一个进房的是 `A`，第二个是 `B`。判断依据是「**A 有没有人占**」而不是人数——人数判法在「房主走了、只剩 B」时会把新房客也分到 B，屋里出现两个 B，双视角的信息差直接失效。同一人重复加入返回原来的 viewId（幂等）。

**房主规则（2026-10-12 再次确认）**：
- **建房的人永远是视角 A，也永远是房主**（`hostOpenid`）。客户端用返回的 `isHost` 字段判断，不要用 `myViewId === 'A'` 去猜。
- **选关和开局都是房主专属**：`room.setLevel` 和 `room.start` 只有房主能调，客户端按 `isHost` 决定按钮要不要显示。
- **房主离开 = 房间关闭**（`status: 'closed'`），**不管房里还有没有别人**。
  这样上面那条约定就不会被打破：否则剩下的是 B，新房客再进来分不出正确的 A/B，而且没人有权选关（选关权限绑在房主身上）。
- 留在房里的另一个人轮询 `room.state` 看到 `status === 'closed'` 后应自行退出；**这条分支客户端必须处理**，否则会卡在房间页。
- 之后再有人 `room.join` 这个码会拿到 **2003**。
- 非房主离开：只要还有人，房间退回 `waiting`，房主可以继续等人。

### `events` — 房间内事件（只追加，不修改）
| 字段 | 类型 | 说明 |
|---|---|---|
| `roomId` | string | 空字符串表示这是个人埋点，不是房间事件 |
| `levelId` | string | 本轮事件属于哪一关（**v3 起提升为服务端字段**，原来是客户端塞在 payload 里的口头约定）。老数据没有这个字段，读出按空字符串处理 |
| `type` | string | 见下表 |
| `senderId` | string | 发起者 openid |
| `seq` | number | 房间内单调递增，**断线重连靠它补齐** |
| `ts` | number | 服务端时间戳 |
| `payload` | object | 按 type 而定 |

`type` 取值：`join` / `leave` / `clue`（发现线索）/ `pickup`（拾取道具）/ `submit`（提交答案）/ `chat`（聊天/快捷语句）/ `hint`（用提示）/ `result`（关卡结果）/ `metric`（埋点）

> **复合索引必须建**：`roomId`（升序）+ `seq`（升序）。不建的话 `event.pull` 在数据量上来后会很慢。

### `progress` — 关卡进度
`_id` 固定为 `` `${openid}_${levelId}` ``，天然保证一人一关只有一条。

| 字段 | 类型 | 说明 |
|---|---|---|
| `openid` / `levelId` | string | |
| `status` | string | `unlocked`（已解锁未通关）/ `cleared`（已通关） |
| `bestTimeMs` | number | 最好用时 |
| `attempts` | number | 已提交次数，用于算剩余容错 |
| `clearedAt` / `updatedAt` | number | 毫秒时间戳 |

> **注意**：登录时服务端**不会**补写任何基线进度。一个全新玩家的 `progress` 是空的（连 `GUIDE` 都没有）——这是正常的，见 §5。

### `levels` — 关卡私密数据（**不放在客户端包里**）
`_id` 就是 `levelId`。由 `server/seeds/build-seed.js` 从客户端关卡配置自动生成（见 §7），C 导入数据库。

```jsonc
{
  "levelId": "L01",
  "chapterId": "campus_gate",
  "title": "第一关 · xxx",
  "views": {
    "A": { "clues": { "nodeId_1": "线索正文…" } },   // 来自该视角 inspect 热点的 text
    "B": { "clues": { "nodeId_9": "线索正文…" } }
  },
  // 答题通关的关才有 puzzle；「操作通关」的关没有这一节
  "puzzle": {
    "type": "item_combine",
    "submitNodeId": "node_submit",
    // answer 两种形状，与客户端 PuzzleAnswer 对齐：
    //   数组 → 有序答案（numberpad）；对象 → 按键答案（form 表单）
    "answer": { "岗位": "接线员", "编号": "07" },    // 永不下发到客户端
    "requiredItems": ["uv_lamp"],                    // 可选，提交前背包必须持有
    "maxAttempts": 3
  },
  // 通关后解锁的地图节点 id 列表 = 客户端配置 rewards.progress（自由列表，与 chapterId 无关）
  "unlocks": ["node_avenue"]
}
```

**为什么拆出来**：客户端配置里同时有 A、B 两侧的线索，解包就能看到对面视角的信息，还带 `puzzle.answer`——等于作弊。拆走之后，玩家只能拿到自己这一侧，提交也由服务端判。

> 服务端 `room.ts` 里另有一份 `LEVEL_ORDER`（`GUIDE, L01…L10`），**只用于房间选关的顺序和「最远通关的下一关」推导**，和客户端那份 `LEVEL_ORDER`（算结算页下一关）用途不同。加新关时两份都要更新，且**必须先有配置和种子**。

### `feedbacks` — 玩家反馈（v3.3 / FR-14）
`_id` 由服务端自动生成。

| 字段 | 类型 | 说明 |
|---|---|---|
| `openid` | string | 服务端注入，不信任客户端 |
| `category` | string | `bug` / `stuck` / `suggestion` / `newmode` |
| `content` | string | 5–300 字 |
| `screenshotFileId` | string | 云存储 `feedback/` 目录的 fileID，可空 |
| `levelId` / `levelTitle` / `mode` / `viewId` / `page` / `roomCode` | string | 从 `context` 展平，便于后台筛选 |
| `clientVersion` / `submittedAt` | string / number | 排查用；`submittedAt` 是客户端时间，仅参考 |
| `createdAt` | number | 服务端时间，**统计以它为准** |
| `status` | string | `open`（默认）/ `triaged` / `fixed` / `closed`，C 后台改 |

索引：`createdAt` 倒序、`category`、`levelId`、`openid+createdAt`。玩家侧**不提供**「我的反馈列表」；
管理端查看见 `admin.feedback.list`（v3.4）。

### `libraries` — 跨关收藏与图鉴彩蛋（v3.3 / FR-11/12/13）
`_id` = openid，一人一条。

| 字段 | 类型 | 说明 |
|---|---|---|
| `clues` | array | `[{ itemId, name, levelId, collectedAt }]` |
| `eggs` | array | `[{ eggId, title, levelId, foundAt }]` |
| `eggTotals` | object | `{ L05: 3 }`，每关配置的彩蛋总数；没配彩蛋的关不出现 |
| `updatedAt` | number | 毫秒时间戳 |

写入按 `(levelId, itemId)` / `(levelId, eggId)` 去重，**幂等**（重玩多次只算一次）。

### `saves` — 双人关卡存档（v3.3 / FR-15）
`_id` 由服务端自动生成。**索引键是 `pairKey + levelId`，不含 `roomCode`** —— 房间会因「房主退出即关房」消失，存档必须活过房间。

| 字段 | 类型 | 说明 |
|---|---|---|
| `pairKey` | string | 两个 openid **升序排序**后 `join('_')`，保证 A+B 与 B+A 得到同一个 key |
| `levelId` | string | 关卡 |
| `elapsedSec` | number | 已用时，取两人上报中较大的那个 |
| `players` | array | `[{ openid, progress, savedAt }]`，**按 openid 存不按 viewId 存**（再次组队谁建房不一定，viewId 可能交换） |
| `savedAt` / `updatedAt` | number | 毫秒时间戳 |

`progress` 由 D 的 `getSnapshot()` 产出，服务端**不解析**，上限 64KB。字段：`inventory[]` / `revealed[]` / `doneHotspots[]` / `wrongCount` / `stage` / `views{A,B}`。

> **唯一索引必须建 `pairKey + levelId`**，否则 `save.load` 会退化成全表扫，且重复开同关可能刷出多份存档。
>
> 存档和「断线重连」是两件事：断线重连房间还在、数据还在客户端内存里，W8 沿用 E 的本地 `DuoSessionSnapshot`；本集合只负责**跨会话**的保存退出 / 读取存档。

### `admins` — 管理端白名单（v3.4）
`_id` = openid，一人一条。名单里的人才调得动 `admin.*`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `openid` | string | 与 `_id` 相同，方便导出和排查 |
| `enabled` | boolean | `false` = 收回权限但保留记录。判定用 `!== false`，老文档漏写这个字段也算启用 |
| `note` | string | 备注（谁、什么时候加的） |
| `createdAt` | number | 毫秒时间戳，仅记录 |

初始名单 3 人，种子文件 `server/seeds/admins.seed.json`（JSONL，控制台导入选 Upsert）。
**加人 / 停用只改这个集合，不需要重新部署云函数**。

---

### `scores` — 排行榜成绩（**v3.8 正式，需建表；v3.9 双人改一队一条**）

**两种粒度**：

- 单人榜：一人 · 一关 一条，`_id = ${openid}_${levelId}_solo`（见 `db.scoreId`）
- 双人榜：**一队 · 一关 一条**，`_id = duo_<sha256(pairKey+levelId) 前 32 位>`（见 `db.duoScoreId`），
  成员写在 `openids`。改这个是因为「一人一条」会让同一局出两行，`rank` / `total` / `mine` 全算错

| 字段 | 说明 |
|---|---|
| `openid` / `levelId` / `mode` | `mode` 为 `solo` / `duo`。**双人记录 `openid` 为空串**，成员看 `openids` |
| `openids` / `teamKey` | **只有双人记录有**。`openids` = 两人升序，`teamKey` = `savePairKey(openids)`。查双人榜靠 `openids: _.exists(true)` 区分新旧数据 |
| `score` | **服务端算**，越高越好。v1 规则：`max(0, 1000 - 用时秒数)` |
| `timeMs` | 本局用时。**排名按它升序**，它才是排名的依据，`score` 只是展示用 |
| `partnerOpenid` | **v3.9 起不再写入**，仅历史数据可能有值。新代码不要读它 |
| `roomCode` | 留痕，便于排查 |
| `scoreRuleVersion` | 计分公式版本，当前 1；改规则时 +1，历史数据不动 |
| `clearedAt` / `updatedAt` | `clearedAt` 兼作同用时的 tie-break（先达成的在前） |

> `hintsUsed` / `eggsFound` **本期没有**：D 的 `LevelView.reportSubmit` 还没上报这两个数，
> 公式里也用不到。等 D 补上后把 `scoreRuleVersion` 升到 2 再加字段。

### `partners` — 双人搭档档案（**v3.8 正式，需建表**）

`_id` 沿用 `savePairKey`（两 openid 升序拼接），另有 `partnerId` 作为给客户端的短 id。

| 字段 | 说明 |
|---|---|
| `openids` | 升序两人 |
| `profiles` | 昵称/头像快照，每次双人结算时刷新 |
| `clearedLevels` / `clearedCount` | 共同通关过的关卡（按先后去重） |
| `playCount` / `lastPlayedAt` | **本期只统计「通关并结算」的局**，没通关的局不计（见 §8.3） |
| `bestRecords` | 每关最佳合作记录，只留更好的那次 |
| `badges` | 已达成的徽章 id 列表（读取时按 `clearedCount` 现算，库里这份只作留档） |

---

## 4. 接口明细

### 账号

#### `auth.login`
无感登录，首次调用自动建档。**E 在登录页/启动时调一次。**
- 入参：无
- 出参：`{ nickname, avatarUrl?, currentLevelId, isNewUser }`
- **不写任何 `progress`**。新玩家的 progress 表是空的，这是预期行为（见 §5）。

#### `auth.profile`
取档案 + 进度概览，**E 的个人记录页用**。
- 入参：无
- 出参：`{ nickname, avatarUrl?, currentLevelId, clearedCount, totalTimeMs }`

#### `auth.updateProfile`
- 入参：`{ nickname, avatarUrl? }`
  - `nickname`：1–16 字符，去首尾空格
  - `avatarUrl`：可选。客户端先用 `wx.cloud.uploadFile` 传到云存储拿到 fileID 再传进来（见 §6）。只传昵称时不会清掉已有头像
- 出参：`{ nickname, avatarUrl? }`

### 房间

> **房间快照（RoomSnapshot）统一结构**，`room.create` / `room.join` / `room.state` / `room.setLevel` 四个接口都返回它：
> ```jsonc
> {
>   "code": "AB3K7M",
>   "levelId": "L01",
>   "status": "waiting | playing | closed",
>   "myViewId": "A" | "B" | null,     // null = 你不在房里
>   "isHost": true,                   // 你是不是房主。不要用 myViewId 去猜
>   "startedAt": 0,                   // 0 = 还没开局；>0 = 房主点了开始，值是对齐后的服务端开始时刻
>   "serverNow": 1760000000000,       // 服务端当前时间，客户端用它把 startedAt 换算成本地倒计时
>   "hasSave": false,                 // v3.3：这一关有没有可恢复的双人存档（房间页据此显示「继续上次的进度」）
>   "saveComplete": false,            // v3.3：存档是否两个人的进度都齐了
>   "playableLevelIds": ["GUIDE", "L01", "L02"],  // 两人都能玩的关，已按服务端顺序排好
>   "players": [
>     { "nickname": "交大同学1234", "viewId": "A", "online": true }
>   ]
> }
> ```
> `playableLevelIds` **每次都实时重算**（不缓存）：玩家在房间里通关后，对方要立刻能看到新解锁的关。

#### `room.create`
- 入参：`{ levelId }`，**必传**
- 校验：`levelId` 必须在服务端 `LEVEL_ORDER` 里，否则 **3001**（不认识的关**直接报错**，不静默降级成 GUIDE——否则客户端传错参数谁也不会发现）
- ⚠️ **`levelId` 区分大小写**：必须原样传 `GUIDE` / `L01`…`L10`。传 `l01` 会报 3001
  ——`room.create` **不做大写归一**，只有 `room.setLevel` 会（见下）。客户端把关卡 id 当常量用就不会踩到。
- 出参：完整房间快照，`isHost` 恒为 `true`，`myViewId` 恒为 `'A'`
- **不校验建房者自己有没有解锁这关**。房主选了自己没解锁的关也能建，等人进来时会被 `room.join` 自动降级（见下）。

#### `room.join`
- 入参：`{ code }`（大小写都行，服务端会转大写）
- 出参：完整房间快照
- 房间不存在 → 2001；已关闭 → 2003；满 2 人 → 2002
- 已经在房里 → 幂等返回，顺带把在线状态刷回来
- **人齐了也不会自动开始**：加入成功后 `status` 仍是 `waiting`、`startedAt` 仍是 `0`，
  要等房主调 `room.start` 才进 `playing`。所以房间页的「开始游戏」按钮只对房主显示。
- **关卡降级**：第二名玩家加入后，服务端会**把房间切到双方共同可玩的最高那一关**（不管房主原来选的什么）。
  房主仍可以用 `room.setLevel` 改回列表里任意较早的关。房主那边靠轮询 `room.state` 看到变化，
  所以不要假设自己选的关一定能生效。

`playableLevelIds` 是房间内所有玩家已解锁关卡的交集，**房主只能从这里选关**。算法与边界见 **§5**（服务端算好，客户端直接展示）。

#### `room.setLevel`（房主换关）
- 入参：`{ code, levelId }`
- ⚠️ **这里的 `levelId` 会 `toUpperCase()`**，传 `l01` 等价于 `L01`（与 `room.create` 不一致，见 §10 T1）。
  客户端按原样传即可，不要依赖这个容错
- 出参：更新后的房间快照
- 校验顺序：房间存在(2001) → 房间没关(2003) → 你在房里(2004) → **你是房主(2005)** → levelId 在可玩交集里(3001) → 关卡数据存在(4001)
- `waiting` 和 `playing` 两种状态下都可以换关
- **换关会把 `status` 打回 `waiting`、`startedAt` 归零** —— 新一轮必须由房主重新 `room.start`，
  这样两边才会拿到同一个计时起点。
- **换关不清事件流水、不重置 `lastSeq`**：事件已按 `levelId` 打标，客户端只回放「本轮 + 本关」，上一关的事件不会串进来
- 另一个玩家靠轮询 `room.state` 发现 `levelId` / `status` 变了 → 提示「房主更换了关卡」

#### `room.start`（房主统一开局，**2026-10-13 并入本文档**）
- 入参：`{ code }`
- 出参：更新后的房间快照（`status: 'playing'`、`startedAt > 0`）
- 权限：**仅房主**；非房主调用报 **3001**（消息「只有房主可以开始游戏」）
  - ⚠️ 注意与 `room.setLevel` 不一致：换关越权是 **2005**，开局越权是 **3001**。
    客户端别用「code 是不是 2005」判断越权，**统一按「非房主就不显示开始按钮」**处理（`snapshot.isHost`）。
    这条列为 §10 待办 T2，暂不改代码
- 前置校验：
  - 房间里必须**满 2 人且两人都在线**，否则 3001（消息「请等待好友进入房间并保持在线」）
  - 房间已关闭 → 2003
- **重复点击幂等**：同一轮已经开始（`status === 'playing'` 且 `startedAt` 非 0）时直接返回原来的 `startedAt`，**不会**生成第二个开局时间
- `startedAt = 服务端当前时间 + 3000ms`（`START_DELAY_MS`）—— 给双方留出轮询和加载页面的时间，
  真正计时仍以这个服务端时刻为准，**两边看到的是同一个值，不会因为各自的网络延迟而有偏差**
- 另一个玩家靠轮询 `room.state` 观察到 `startedAt` 从 0 变成正数 → 自动进入关卡。
  客户端换算本地倒计时：`本地开始时刻 = Date.now() + (startedAt - serverNow)`
- **同时把当时房内两人的 openid 写进 `rooms.sessionPlayers`**（v3.3）。双人存档靠它算 `pairKey`，
  不读 `players` —— 玩家退出会从 `players` 移除成员，先退的人一走就凑不齐两个人了

#### `room.leave`
- 入参：`{ code }`
- 出参：`{ left: true, roomClosed: boolean }`
- **房主离开 → 房间直接置 `closed`**（`roomClosed: true`），不管房里还有没有别人
- 非房主离开 → 回到 `waiting`（`roomClosed` 一般是 `false`，除非屋里只剩他一个）
- 两种情况下都会把 **`startedAt` 归零**：有人进出就意味着这一轮作废，要重新开始就得再点一次 `room.start`

#### `room.sync`（**v3.5 新增，D / E 接入的首选接口**）

一次调用同时拿回「房间快照 + 事件增量 + 在线状态刷新」，用来替代原来并排跑的三条定时器
（`room.state` 0.5 秒 + `room.heartbeat` 10 秒 + `event.pull` 1 秒）。**行为上它是这三个接口的并集**，
不引入任何新语义。

- 入参：`{ code, sinceSeq }`
  - `sinceSeq` **必填**：`>= 0` 的数字。缺了或类型不对报 **3001**
  - **不要默认传房间的 `lastSeq`**：那等于「只从最新开始」，中间的事件会被静默跳过。
    首次调用传 `0`；之后逐次用上一次返回的 `lastSeq`
- 出参：
  ```jsonc
  {
    "room":   { /* 房间快照，字段与 room.state 完全一致，含 serverNow */ },
    "events": [{ "seq": 43, "levelId": "L01", "type": "pickup",
                 "senderId": "oXXXX", "ts": 1762..., "payload": { } }],
    "lastSeq": 43,     // 本页最后一条的 seq；空页 = 你传进来的 sinceSeq
    "hasMore": false   // true = 后面还有，应当立刻用 lastSeq 再调一次，不要等下一个间隔
  }
  ```
- **`events` 一次最多 100 条**（比 `event.pull` 的 200 少）。`hasMore` 是权威判断，
  不要再拿 `events.length` 和页大小比较去猜
- **事件不按 `levelId` 过滤**，返回的是整个房间的流水。为什么：客户端算「本轮从哪条开始」
  要靠跨关的 `result` / `close` 当边界（`LevelSync.currentRunStartSeq`），只回本关事件会让它
  把上一轮当成同一轮，症状是**一进新关立刻通关**。要按关过滤留在客户端做
- **房间 `closed` 仍然返回 200**，`room.status === 'closed'`，`events` 照常返回。
  客户端必须自己处理这个分支（关关卡 / 退房间页），**不要把它当错误重试**
- 错误码：`2001` 房间不存在 / `2004` 你不在这个房间里 / `3001` 参数不合法（含 `sinceSeq` 缺失或不是数字）
  —— 注意 **不会** 因为房间关闭而报 `2003`

**服务端顺带做的两件写操作**（客户端不用再单独发心跳）：

| 副作用 | 频率 | 说明 |
|---|---|---|
| 刷新调用者的 `lastSeenAt` | **最多 10 秒一次** | 10 秒内重复调用只更新返回值，不写库。30 秒没刷新，对面看到你离线 |
| 缓存双人可玩交集 | **15 秒一次** | 算一次要给每人查一遍 `progress`，高频接口不缓存会把读配额吃光 |

> **可玩交集的 15 秒缓存有个已知副作用**：好友刚通关解锁的新关，选关列表最多晚 15 秒出现。
> 这是拿「读配额」换「选关列表实时性」，已知并接受。

> **配额提示**：`room.sync` 一次调用 = 1 次房间读 + 1 次事件查询（房间页多 1 次存档查询）。
> 按 2 人、房间页 60 秒、关卡 300 秒估算，每局从约 880 次调用降到约 580 次。
> **但关卡内的间隔才是决定月调用量的大头** —— 详见接入说明里的账。

#### `room.state`（**保留**，新代码不建议再用）
拉取房间快照，**E 的房间页用它刷新准备状态，也是"房主换关了 / 房间没了"的感知通道**。
- 入参：`{ code }`
- 出参：完整房间快照
- **房间 `closed` 时仍然返回 200 正常数据**（不会报错）——目的是让留在房里的另一个人能从 `status` 观察到房间已关。客户端需要自己处理 `status === 'closed'`（退出房间页）
- 顺带把超过 30 秒没心跳的对面标成离线；只在在线状态真的变了时才写库

#### `room.heartbeat`（**保留，v3.5 起不建议再用**）
原来的独立心跳。接了 `room.sync` 之后**必须停掉它** —— `room.sync` 已经在刷新 `lastSeenAt`，
两边同时发只是白烧调用次数，还可能互相覆盖 `players`。
- 入参：`{ code }`
- 出参：`{ online: true }`
- 房间已关闭 → **2003**。客户端的心跳错误只需要 swallow，别弹提示误导玩家
- 保留原因：还没升级的老客户端仍在调。**至少留一个版本**再谈删除

### 关卡

#### `level.list`（**E 的地图页用**）
一次拿全关卡目录 + 当前玩家进度。
- 入参：无
- 出参：
  ```jsonc
  { "list": [{
      "levelId": "L01", "chapterId": "campus_gate", "title": "…",
      "unlocks": ["node_avenue"],   // 通关这关解锁的地图节点
      "hasPuzzle": false,           // false = 操作通关
      "status": "none | unlocked | cleared",  // none = 还没碰过
      "bestTimeMs": 0, "clearedAt": 0
  }] }
  ```
- **地图节点解锁状态由客户端推导**：初始节点 + 所有 `cleared` 关卡的 `unlocks` 并集。服务端不单独存解锁状态。
- **没有 `orderBy`**，返回的是数据库自然序，客户端要排序请自己按 `LEVEL_ORDER` 排。

#### `level.getView`
按调用者身份下发**他有权看到的线索**。这是信息差机制的技术落点。
- 入参：`{ levelId, mode: 'solo' | 'duo', code? }`
  - `solo`：一人看两视角 → 返回 A、B 两份线索（他本来就该看全）
  - `duo`：必须传 `code` → **只返回自己在房间里的那个视角**；且 `levelId` 必须与房间当前关卡一致，否则报 3001
- 出参：
  ```jsonc
  {
    "levelId": "L01",
    "views": { "A": { "clues": { "nodeId_1": "…" } } },   // duo 模式下只有一个键
    // 操作通关的关没有 puzzle，这里是 null，客户端走 completes 热点通关
    "puzzle": { "type": "item_combine", "submitNodeId": "…", "maxAttempts": 3, "hasRequiredItems": true } | null
    // 注意：没有 answer 字段，永远不会有
  }
  ```

#### `level.submit`
提交答案 / 上报通关，**通关记录（cleared）只由这个接口产生**。
- 入参：`{ levelId, answer?, inventory?, elapsedMs?, code? }`
  - **答题通关的关**（有 puzzle）：`answer` 必传，形状与服务端存的答案一致——数组（有序）或对象（按键）；若该关配了 `requiredItems`，`inventory: string[]` 必传，缺道具报 **4002 且不消耗容错次数**
  - **操作通关的关**（无 puzzle）：不用传 `answer`，客户端完成操作后调用即视为通关上报，服务端采信
  - `elapsedMs`：本局用时（毫秒）。**不传或 ≤0 视为未提供，不影响最好成绩**
- 出参：`{ correct, failed, remainAttempts, bestTimeMs?, unlocks?, score?, rank?, isNewBest?, duplicate? }`
  - `remainAttempts`：操作通关的关固定为 `null`（没有容错次数概念）
  - `unlocks`：通关时返回本关解锁的地图节点 id 列表
  - **`score`（v3.8）**：本局得分，`null` 表示没进榜（没报用时就进不了榜）
  - **`rank`（v3.8）**：本局结算后的名次（1 起），`null` 同上。**只在首次结算时给**，
    重复结算（`duplicate: true`）时也为 `null`，因为这一局的名次早在另一端结算时定过了
  - **`isNewBest`（v3.8）**：有没有刷新自己的最好用时
  - **`duplicate`（v3.8，仅双人）**：`true` = 这一局已经被另一端结算过，本次调用是**幂等返回**，
    什么都没写。此时 `correct` 仍是 `true`（对玩家来说他就是通关了），`bestTimeMs` 取他自己的历史最好成绩
- 双人房间中任一成员合法通关后，服务端会为房内双方写入该关 `cleared`，保证下一次组房时共同可玩关卡不会退回第 0 关
- **答案错误时不会回传正确答案**，只回剩余次数——这是需求评审定的隐私口径，别为了做提示把它加回来。
- **重新开局语义**：上次失败（次数用光）或已通关后重玩，`attempts` 自动清零重新计，不会把上一局的次数带进来。
  - **具体行为**：某关 `maxAttempts = N`，第 N 次答错返回 `remainAttempts: 0, failed: true`；
    **第 N+1 次提交不会被拒绝**，而是当作新一局的第一答：`attempts` 置 0 后 +1，
    返回 `remainAttempts: N-1, failed: false`（答对则直接通关）。
  - 也就是说服务端**不会把玩家锁在失败状态**，失败只影响本次结算展示。
    旧文档里「额外提交不得绕过限制」的说法以本段为准（见 §10 T3：是否需要"失败后冷却"另议）。
- **限时关超时（v3.8，T10）**：配了 `timeLimitSec` 的关（当前只有 `L01 = 300 秒`），
  若上报的 `elapsedMs` 超过上限 → **4003**，不记为通关。
  依据是**客户端上报的用时**，不是服务端墙钟：单人局没有开局时刻可比，双人局的 `startedAt`
  又会被暂停拉长（暂停时长还没落服务端，见 §10 T8），用墙钟会把暂停过的正常玩家误判成超时。
  所以这是**软校验**：挡得住老老实实耗到 0 才上报的客户端，挡不住把 `elapsedMs` 改小的改包。
  `elapsedMs` 没传（≤0）时无法判断，放行且不进榜。
- **双人一局只结算一次（v3.8，T9）**：房间文档记 `clearedRunAt = 房间当时的 startedAt`，
  在事务里抢占。抢不到的那一端走 `duplicate` 分支，**不重复写 cleared、不重复加 `playCount`、不重复发结算事件**。
  换关 / 重开会让 `startedAt` 变化，所以「新的一局」自然可以再次结算，不用额外清理标记。

### 事件与同步

#### `event.publish`
把动作广播给房间里另一视角。
- 入参：`{ code, type, payload, levelId? }`
  - `type`：**只校验「非空字符串」，服务端没有白名单**。约定取值为
    `join` / `clue` / `pickup` / `submit` / `chat` / `hint` / `result` / `metric`
    （见《核心功能模块详细需求与设计》§6.4）。
    传别的字符串也能写进库，但客户端回放时不认识，等于白写一条事件（见 §10 T4：要不要补白名单）
  - `levelId` 是**服务端字段**（2026-10-10 加），**建议每次都传**，这样服务端才能按关过滤/清理事件；`payload` 里那份如果已经在传可以保留，不影响
  - 但**关卡同步本身不靠它** —— D 的同步读的是 `payload.levelId`，那份**必须保留**
  - 房间已关闭 → **2003**（这时候另一个人可能还在 `players` 里，所以这条校验不能省）
- 出参：`{ seq, ts, levelId }`

#### `event.pull`
**增量拉取**，轮询和断线重连都用它。
- 入参：`{ code, sinceSeq = 0 }`
  - ⚠️ `sinceSeq` **不做类型校验**：缺省、`null`、`'abc'` 一律**按 0 处理**，
    等于把整间房的历史事件**从头重放一遍**（客户端会看到上一局的操作）。
    所以**每次都必须显式传上一次的 `lastSeq`**。
  - 这与 `room.sync` 不同：`room.sync` 的 `sinceSeq` 非法会直接报 **3001**。
    新代码请优先用 `room.sync`；`event.pull` 保持这个宽容行为是为了兼容老客户端（见 §10 T5）
- 出参：`{ events: [{ seq, levelId, type, senderId, ts, payload }], lastSeq }`
- 顶层 `levelId` 对 2026-10-10 之前写入的老事件是空字符串，**别假设它一定非空**
- `lastSeq` 是**本页最后一条事件的 seq**（不是房间全局值）。一次最多拉 200 条；如果返回的条数等于 200，说明可能还有，用 `lastSeq` 当 `sinceSeq` 再拉一次直到拿空
- 客户端流程：记住上次拿到的最大 `seq` → 下次带 `sinceSeq` 只拉新的。断线重连后照样从旧 `seq` 拉，**不会丢事件**

> **同步节奏建议**：客户端每 **1 秒** 调一次 `event.pull`。点击解谜对延迟不敏感，1 秒以内完全够用，而且比数据库 `watch` 省心太多（不受集合权限、后台断连、连接数限制影响）。

#### `event.report`
埋点上报，供后台统计。
- 入参：`{ type: 'level:enter' | 'level:exit' | 'level:finish', levelId, extra? }`
- 出参：`{ logged: true }`

### 进度

#### `progress.get`
- 入参：`{ levelId? }`（不传返回全部）
- 出参：`{ list: [{ levelId, status, bestTimeMs, attempts, clearedAt }] }`
- **E 的地图页靠这个决定节点是锁定、解锁还是通关态。**

#### `progress.save`
- 入参：`{ levelId, status: 'unlocked' }`
- 出参：`{ levelId, status, bestTimeMs, attempts }`
- **只接受 `unlocked`**。`cleared` 一律走 `level.submit`（答题关由服务端判题、操作关由客户端上报），本接口传 `cleared` 会报 3001——这是防"客户端自封通关"的闸口。已通关的记录不会被本接口降级。

##### 谁在什么时候调（**D / E 请按这个来**）

`progress` 是双人「可玩交集」的权威来源，所以什么时候写 `unlocked` 必须有统一口径：

| 时机 | 谁调 | 说明 |
|---|---|---|
| **通关一关之后** | **客户端**（D） | `level.submit` 返回通关后，把本关 `unlocks`（地图节点 id）**映射到的新解锁关卡**逐条 `progress.save({ status: 'unlocked' })`。节点→关卡的映射只在客户端有，所以这一步只能客户端做 |
| ~~登录时补基线~~ | — | **服务端不做**。2026-10-12 起 `auth.login` 不再写 `GUIDE` 的 unlocked 记录，因为 `GUIDE` 已经在服务端的可玩集合里写死了，不依赖 progress 记录（见 §5） |
| ~~进入关卡时~~ | — | **不推荐**。用「通关后落解锁」口径，不会出现"进了但没通关也算解锁"的歧义 |

- **新玩家的 progress 表是空的，这是正常的**，不要当成异常去补数据。
- 客户端地图页的 `node_campus_gate`（GUIDE 节点）是**硬编码初始解锁**的，不依赖 progress 记录，所以新玩家照样能单人玩引导关。

> ~~`progress.nextLevel`~~ **v2 已删除**。「下一关是哪关」由客户端本地 `LEVEL_ORDER`（common/LevelConfig.ts）计算，服务端不再保存关卡顺序。

### 反馈（v3.3 / FR-14）

#### `feedback.submit`
- 入参（**完全按 E 已实现的 `Feedback.ts`**）：
  `{ category, content, screenshotFileId, context: { levelId, levelTitle, mode, viewId, page, roomCode, submittedAt }, clientVersion }`
  - `category`：`bug` / `stuck` / `suggestion` / `newmode`
  - `content`：5–300 字；`screenshotFileId` 没传就是 `''`（截图客户端自己传云存储 `feedback/` 目录）
  - `context` 整体可选，缺字段按空串处理，不逐个报参数错
- 出参：`{ feedbackId, createdAt }`
- 服务端补 `openid` / `createdAt` / `status:'open'`。`submittedAt` 只存不用，统计以 `createdAt` 为准
- `category` 不在枚举、`content` 长度不对 → **3001**（message 会原样显示在 E 的表单下方，写人话）
- **首版不提供 `feedback.list`**：反馈只给 C 看，C 直接在控制台查集合。玩家之间不该互看反馈，E 不做「我的反馈列表」页，界面上的「已提交」只是本机回执
- 管理端查看方式见下面 `admin.feedback.list`（v3.4）。**玩家侧的 `feedback.list` 仍然不做**

### 管理端（v3.4，仅 `admins` 名单）

> 命名提醒：管理端列表叫 `admin.feedback.list`，**不叫 `feedback.list`**。
> E 的《接口需求》§1.3 已经把 `feedback.list` 定义成「玩家看自己的反馈」，
> 同名会让「越权读全量」变得很难发现。

#### `admin.whoami`
- 入参：无
- 出参：`{ openid, isAdmin }`
- **不设权限**，就是给配名单的人自查用的：把 openid 导进 `admins` 后跑一次，确认 `isAdmin: true`
- 排查 1002 时先用它，别靠列表报错反推

#### `admin.feedback.list`
- 入参：`{ status?, category?, levelId?, limit?, before? }`，全部可选
  - `status`：`open` / `triaged` / `fixed` / `closed`
  - `category`：`bug` / `stuck` / `suggestion` / `newmode`
  - `limit`：默认 20，**上限 100**（超过按 100 取）
  - `before`：`createdAt` 游标，返回**严格小于**它的记录；首页不传
- 出参：`{ list: [...], hasMore, nextBefore }`
  - `list[]`：`{ feedbackId, openid, category, content, screenshotFileId, levelId, levelTitle, mode, viewId, page, roomCode, clientVersion, submittedAt, createdAt, status }`
  - `hasMore`：多取一条判断，`true` 时客户端/调用方立即用 `nextBefore` 再拉一页
  - `nextBefore`：本页最后一条的 `createdAt`；空页原样返回传入的 `before`，不会卡死
- 按 `createdAt` 倒序。**用游标不用 skip** —— 反馈持续新增，skip 分页会被新数据顶出重复项
- 调用者不在 `admins` 名单（或 `enabled: false`）→ **1002**
- 查看方式 A（不经过本接口）：云开发控制台 → 数据库 → `feedbacks`，按 `createdAt` 排序；改 `status` 也在控制台改


### 收藏与图鉴彩蛋（v3.3 / FR-11 / FR-12 / FR-13）

#### `library.add`
- 入参：`{ levelId, clues: [{ itemId, name }], eggs: [{ eggId, title }], eggTotal }`
- 出参：`{ clues, eggs, eggTotals }` —— 合并后的全量
- **幂等**：按 `(levelId,itemId)` / `(levelId,eggId)` 去重，重复上报直接跳过，一关重玩多次只算一次
- 支持多次增量调用（**发现彩蛋瞬间**上报一次、通关再报一次），服务端做并集
- `eggTotal` 每次覆盖写；`eggTotals` 按 levelId 存
- **彩蛋不单独开 `egg.record` / `egg.list`** —— 两条写入路径会把同一彩蛋记成两份

#### `library.get`
- 入参：无
- 出参：`{ clues: [{itemId,name,levelId,collectedAt}], eggs: [{eggId,title,levelId,foundAt}], eggTotals: { L05: 3 } }`
- 登录后拉一次即可，E 用它替换本地 `PlayerLibrary.ts` 缓存 → 跨设备还原图鉴。**只返回自己的**

### 双人关卡存档（v3.3 / FR-15）

> **这是「保存退出 / 读取存档」，不是「断线重连」**。断线重连房间还在、数据在客户端内存里，
> W8 沿用 E 的本地 `DuoSessionSnapshot`；本组接口负责跨房间、跨会话的存档。
> 索引键 `pairKey + levelId`，**不含 roomCode**。

#### `save.write`
- 入参：`{ code, levelId, progress, elapsedSec }`
- 出参：`{ savedAt, complete }`（`complete` = 两个人的进度都到齐了）
- **各人各调一次** —— progress 只在各自设备上，一方拿不到另一方的完整 runtime 状态
- 校验：房间存在(2001) → 你在本局 `sessionPlayers` 里(2004)；`progress` 超 64KB → 3001
- **不校验房间是否已关闭**：房主退出会把房间关掉，但另一个人必须还能把存档传上来，否则这一半进度就丢了
- `elapsedSec` 取两人中较大的（时钟略有差异时保守，避免少算）

#### `save.load`
- 入参：`{ code, levelId }`
- 出参：`{ found: false }` 或
  `{ found: true, complete, elapsedSec, savedAt, mine, peerReady }`
- **`mine` 只含调用者自己的 progress** —— 不把队友的线索/道具发给对方，双视角信息差是核心玩法，存档也不能破这条
- **`found:false` 不是错误**，返回 `ok:true`，E 据此决定要不要显示「继续上次的进度」
- `complete:false` → E 显示「存档不完整」，两人重新进一次关卡再退出即可补齐

#### `save.clear`
- 入参：`{ code, levelId }`；出参：`{ cleared }`
- **通关时服务端自动调**（`level.submit` 两条通关分支），清理失败不影响通关结果
- 玩家侧**不给 UI 入口**：想重来就点「重新开始」，下次退出会覆盖旧存档

#### 倒计时与恢复口径
- 存档是**冻结**不是暂停：保存时冻结 `elapsedSec`，读档后**走现成的 `room.start`**，
  把 `elapsedSec` 作为挂载参数传给 D（`mountLevel.resume`）—— 3 秒延迟、双方同时开跑的逻辑完全复用
- `timeLimitSec` 只在客户端配置里，服务端**不返回「剩余时间」**，只返回 `elapsedSec`，
  客户端算 `剩余 = timeLimitSec * 1000 - elapsedSec * 1000`

#### 退出即默认保存（E 的三个配合项）
1. **房主先存、存完再退**：房主点退出先 `save.write` 成功，再 `room.leave`
2. **非房主被踢出时也要存一次**：收到 `status === 'closed'` 后先 `save.write` 再离开房间页，否则只有房主那半进度进存档
3. **读档入口必须有「重新开始」**：退出即保存后没有「放弃」入口，不给「重新开始」玩家会被旧进度锁死

> **v3.8 补丁（T7）**：未开局的房间没有 `sessionPlayers` 快照，之前 `pairKey` 是从 `players` 现算的，
> 人一走键就从 `A_B` 漂成 `B`，剩下那个人再也读不回存档。
> 现在 `room.leave` 会在移除成员**之前**冻结快照，`save.*` 首次调用也会兜底冻结一次，两条顺序都覆盖到了。

---

### 排行榜与搭档档案（v3.9 / FR-16 / FR-17）

> 口径总览与设计理由见 **§8**；这里只列接口形状。

#### `rank.level`
某关某模式的榜单。**服务端已排好序、算好分**，客户端不要再排一遍。
- 入参：`{ levelId, mode: 'solo' | 'duo', limit? }`
  - `limit` 默认 20、最大 100；非法值不报错，按默认处理
  - `mode` 非法 → **3001**
- 出参（双人榜）：
  ```jsonc
  {
    "levelId": "L10",
    "mode": "duo",
    "total": 64,                      // v3.9：双人榜是**队伍数**，不是玩家数
    "list": [
      {
        "rank": 1,
        "players": [                   // 权威字段：一行 = 一队，两个人
          { "nickname": "八教钉子户", "avatarUrl": "https://…", "isMe": true },
          { "nickname": "思源楼常客", "avatarUrl": "", "isMe": false }
        ],
        "nickname": "八教钉子户",       // 兼容字段 = players[0].nickname
        "avatarUrl": "https://…",      // 兼容字段 = players[0].avatarUrl
        "score": 805,
        "timeMs": 195000,
        "isMe": true
      }
    ],
    "mine": { "rank": 1, "score": 805, "timeMs": 195000, "inTop": true } | null,
    "scoreRuleVersion": 1
  }
  ```
- 出参（单人榜）：`players` 只有一项，其余字段一致
- **记录粒度（v3.9 变更）**
  - `mode: 'solo'` → **一人一条**
  - `mode: 'duo'` → **一队一条**（按 `pairKey` 聚合）。同一局不会再出现
    「A 搭档 B」「B 搭档 A」两行，`rank` / `total` / `mine` 全部是**队伍口径**
- `players` 是权威字段，客户端按数组顺序渲染成「A / B」；`isMe` 逐项标记，
  队伍里哪一个人是"我"由服务端给，**不要拿昵称比对**（重名会标错）
- 平级 `nickname` / `avatarUrl` 是**兼容字段**（取 `players[0]`）。旧逻辑只认它们，
  所以服务端保证非空 —— 一旦下发空串，客户端 `normalizeRankingBoard` 会静默丢行
- **`mine` 双人榜取「我参与过的队记录里最快的那条」**：我可能和不同搭档打过同一关，
  那就是多条队伍记录，`mine` 只显示我在本关的最好队成绩
- **`list` 按 `timeMs` 升序**（用时越短越前），同用时按 `clearedAt` 早的在前
- **不返回他人 `openid`**
- `mine` 即使不在前 N 也照给（为 `null` = 你自己没成绩），客户端固定在底部显示"我的名次"
- **`GUIDE` 查榜直接返回空榜，不报错**（`total: 0`, `mine: null`）
- 昵称兜底为 `神秘玩家`

#### `partner.list`
我的搭档档案，按 `lastPlayedAt` 降序。
- 入参：`{ limit? }`，默认 20、最大 50
- 出参：
  ```jsonc
  {
    "total": 3,
    "list": [{
      "partnerId": "p_7f3k2m",          // 前端 key，不含 openid
      "nickname": "阿岚",               // 对方的昵称，不是你自己
      "avatarUrl": "https://…",
      "clearedCount": 2,
      "clearedLevels": ["L01", "L02"],
      "playCount": 5,
      "bestRecords": [ { "levelId": "L01", "timeMs": 183000, "score": 817 } ],
      "badges": [ { "id": "first_team", "title": "初次并肩", "description": "第一次一起通关任意一关" } ],
      "lastPlayedAt": 1762910000000
    }]
  }
  ```
- 「搭档」= **一起通关过的人**，不是微信好友（小游戏拿不到关系链）
- **不返回 `openid`**，客户端只用 `partnerId` 做 key
- 「再次邀请」= 先 `room.create` 再自己分享房间码，服务端不提供"直接发给某个人"

---

## 5. 双人可玩交集（房主选关）口径

**分工：服务端算好 `playableLevelIds`，客户端直接展示。** 2026-10-12 定，取代了 v3 早期「客户端算」的方案。

### 服务端怎么算

对房间里每一位玩家：

1. 初始集合 = `{'GUIDE'}`
2. 遍历他的 `progress`：`status` 是 `unlocked` 或 `cleared` 的 `levelId` 加进集合
   —— 用 `unlocked` **或** `cleared`，不能只算 `cleared`（"已解锁还没通关"正是要一起来通的那种）
3. 找出他在服务端 `LEVEL_ORDER` 里**最靠后的 cleared 关卡**下标 `f`，
   把 `LEVEL_ORDER[0..f+1]` **全部**加进集合（见下面「为什么要补齐」）
4. 各位玩家的集合取**交集**，按服务端 `LEVEL_ORDER` 的顺序输出

**为什么要补齐 0..f+1 而不是只加「下一关」**：通关了更后面的关，意味着前面的关一定也能重玩。
但旧的进度数据可能只保存了最近通关的那一关，没有为每个前置关卡都留一条文档；
只相信实际记录的话，「已通关第 1 关」的玩家会缺少第 0、1 关的按钮。

**查询失败时的回退**：正常路径每人只查一次 `where({ openid })`；
一旦抛异常（老环境/索引异常），就按确定性的文档 id `progressId(openid, levelId)` **逐关回退查询**，
而不是像旧实现那样 catch 成空数组（那样界面会静默退化成「只能选第 0 关」）。

边界：房间里一个人的时候，交集就是房主自己的集合；`players` 为空时返回 `['GUIDE']`。

### 两条确认过的口径（**不要再改**）

- **`GUIDE` 允许在双人房里选**（2026-10-12 与 E 确认）。所以每个玩家的集合都无条件先塞一个 `GUIDE`，
  结果是**两个零进度的新手也能联机**——他们的交集是 `{GUIDE}`，正好可以先一起做新手引导。
- 正因为集合里写死了 `GUIDE`，**服务端不再需要在登录时补基线进度记录**，两个新手的交集也不会是空集。
  （这两件事是绑定的：如果要恢复"登录补 `GUIDE` 的 unlocked"，就可以把写死的 `GUIDE` 摘掉，反之亦然。**不要只改一半**。）

### 客户端要做什么

1. 直接拿 `playableLevelIds` 渲染给房主选，**不用自己算交集**
2. 从服务端 `LEVEL_ORDER` 里剔除掉**没有关卡数据的关**再展示；目前 11 关都有种子（含 L10），暂无需要剔除的
3. `waiting`（只有房主 1 人）时列表是房主自己的集合，人齐了会收窄——这是正常的，别当成 bug
4. 房主选关后可能对面还没刷新，真正的权威值是轮询 `room.state` 拿回来的

### 已知行为（不是 bug）

- 房主在 `room.create` 时可以选自己没解锁的关（服务端不校验），**但等第二个人进来时 `room.join` 会自动降级**到交集里最靠后的一关。房主那边靠轮询看到。
- `room.setLevel` 会校验交集，房主界面数据过期（同伴刚退出/进度变了）时会拿到 3001；客户端刷新列表重试即可。

---

## 6. 数据权限与云存储（云开发控制台）

### 数据库权限

| 集合 | 权限 | 原因 |
|---|---|---|
| `users` / `rooms` / `progress` / `events` / `levels` / `feedbacks` / `libraries` / `saves` | 收紧到「仅管理端可读写」 | 客户端**不直连数据库**，全部走云函数 |

> v3.3 新增的 3 个集合也要在控制台**手工建**（新建集合不会自动出现），权限同上。
> 索引：`feedbacks`（`createdAt` 倒序 / `category` / `levelId` / `openid+createdAt`）、
> **`saves`（`pairKey + levelId` 唯一）**、`libraries` 按 `_id` 主键查不需要额外索引。
>
> v3.4 再增 `admins`（`_id` = openid）。**权限必须收到「仅管理端可读写」** ——
> 客户端能写这个集合就等于人人可给自己提权。初始 3 人用
> `server/seeds/admins.seed.json` 导入（Upsert）。

**客户端一律不许直接读写数据库**，只能调云函数。否则「只下发当前视角线索」这条约束会被绕过。

### 云存储（头像上传，2026-10-12 新增）

客户端用 `wx.cloud.uploadFile` **直传**到 `avatars/` 目录，**不经过云函数**，所以：

1. **云存储权限**：云开发控制台 → 云存储 → **权限设置** → 选「**所有用户可读，仅创建者可读写**」
   （这是默认值；如果被改成「仅管理端可读写」，客户端上传会直接报权限错误）
2. **不用预建目录**：`avatars/` 第一次上传会自动出现，云存储没有"新建文件夹"这个操作
3. **环境要一致**：`wx.cloud.init` 的 `env` 必须和云函数所在的云开发环境是同一个，否则 fileID 换不出临时链接
4. **真机域名**：如果头像用的是微信头像 https 地址（域名 `thirdwx.qlogo.cn`），必须在 mp 后台 → 开发管理 → 开发设置 → **downloadFile 合法域名**里加上，否则开发工具能显示、真机白图

上传链路（客户端 `WechatCloud.ts`，E 已实现）：`wx.chooseMedia` 选图 → `uploadFile({ cloudPath: 'avatars/{ts}-{rand}.{ext}' })` → 拿到 `fileID`（`cloud://…`）→ 调 `auth.updateProfile` 存进 `users.avatarUrl` → 显示时用 `wx.cloud.getTempFileURL` 换临时链接。**临时链接有有效期，重复进入时重新换一次。**

## 7. levels 种子数据（C 维护）

`levels` 集合的内容不用手写，由脚本从 D 的客户端配置自动生成：

```bash
# 在仓库根目录执行
node server/seeds/build-seed.js
# 产出 server/seeds/levels.seed.json → 云开发控制台 → levels → 导入（冲突处理选 Upsert）
```

- 输入：`client/assets/resources/configs/level.*.json`
- 抽取规则：每个视角 `inspect` 热点的 `text` → `views.X.clues`；`puzzle`（含 answer/requiredItems/maxAttempts）原样拷贝；`rewards.progress` → `unlocks`
- **加第 11 关及以后：先让 D 出配置和 `level.NN.json`，重跑脚本导入，再往服务端 `room.ts` 的 `LEVEL_ORDER` 和客户端 `LevelConfig.LEVEL_ORDER` 里加**；顺序反了会让房主选到一个点进去报「关卡数据缺失」的按钮

### 管理端名单（`admins`）

不是脚本生成的，是手写的一份 JSONL：`server/seeds/admins.seed.json`，
在控制台 → `admins` → 导入 → 冲突处理 **Upsert**。改名单直接改集合文档，不用动代码：

- 加人：新增一条 `{ _id: openid, openid, enabled: true, note, createdAt }`
- 停用：把 `enabled` 改成 `false`（**别删文档**，留着才能查到是谁什么时候加过）
- 验证：用那个微信号跑一次 `admin.whoami`，`isAdmin: true` 才算配好

## 8. 排行榜与双人搭档档案（**v3.9 已定稿并实现**）

> 历史草案见 `rank-partner-契约草案.md`（保留作决策留档，**以本节为准**）。
> 原则：**客户端上报"发生了什么"，服务端决定"值多少分、排第几"** —— 不接受客户端直接传 `score`。
> 接口形状见 §4「排行榜与搭档档案」，本节讲口径和为什么这么定。

### 8.1 计分规则 v1（2026-11-19 定）

**只按通关用时排名，越快越前。**

```
score = max(0, 1000 - floor(timeMs / 1000))
```

- 排名按 `timeMs` 升序，`score` 只是给页面显示的一个更好看的数字，**两者等价**
- 同用时：`clearedAt` 早的在前（必须有确定性 tie-break，否则翻页会重复/漏项）
- `scoreRuleVersion = 1`。改公式时 +1，历史数据不动
- **`timeMs <= 0` 不入榜**：没有可用用时就没法排名，硬写进去 0 秒会霸榜
- 原草案里的 `hintsUsed` / `eggsFound` **本期没做** —— D 的 `LevelView.reportSubmit` 至今没上报
  这两个数，公式里也用不到。等 D 补上再升 `scoreRuleVersion = 2`
- 失败局不计分；`GUIDE` 不计分（查榜返回空榜）

### 8.2 `level.submit` 的增量（向后兼容）

返回值新增（**原有字段一个没动**）：

```jsonc
{ "score": 800, "rank": 7, "isNewBest": true, "duplicate": true }
```

- `score` / `rank` 在「没报用时」「失败局」「重复结算」时为 `null`
- `duplicate` 只在双人同局重复结算时出现，见 §4 `level.submit` 的 T9 段落
- **入参没有新增**（草案里的 `hintsUsed` / `eggsFound` 本期不做，老客户端不受影响）

### 8.3 `rank.level` —— 某关榜单

字段与规则见 §4。要点：

- **记录粒度（2026-11-20 变更，v3.9）**
  - 单人榜：**一人一条**，`_id = ${openid}_${levelId}_solo`
  - 双人榜：**一队一条**，`_id = duo_<sha256(pairKey+levelId) 前 32 位>`，成员写在 `openids`
  - 为什么改：v3.8 是「一人一条」，同一双人局会出「A 搭档 B」「B 搭档 A」两行，
    E 只能在前端做展示去重兜底，但 `rank` / `total` / `mine` 仍然是玩家口径 ——
    第 2 名的队伍会被算成第 2、第 3 名。改成按 `pairKey` 聚合后，三个数才是队伍口径
  - 双人记录不写 `openid`（空串），也不写 `partnerOpenid`；旧字段仅历史数据还有
- **旧数据过滤**：双人榜查询带 `openids: _.exists(true)`。v3.8 的双人记录没有这个字段，
  会被自动挡在榜外，**不需要清理旧数据**（想清也行，见 §8.6 备注）
- `players` 是权威出参，一行给两个人；平级 `nickname` / `avatarUrl` 只是兼容字段
- `mine` 双人榜 = 「我参与过的队记录里最快的那条」，多一次 `where + orderBy + limit(1)`
- `limit` 默认 20、最大 100，**不做无限滚动**（10 关的量级，Top 50 + 我的名次够用）
- 排序：`timeMs` 升序 → `clearedAt` 升序
- **不返回他人 `openid`**；`isMe` 由服务端逐项标（E 不要用昵称比对，重名会标错）
- `mine` 即使不在前 N 也给，E 固定在底部显示"我的名次"
- 昵称兜底 `神秘玩家`（客户端会静默丢掉空昵称条目，见 §4）
- 名次算法：`比我快的条数 + 同用时比我早的条数 + 1`，两次 `count` 查询，都能吃到复合索引。
  **`rankOf()` 和榜单查询必须用同一套过滤条件**，否则结算页名次会和榜上对不上

### 8.4 `partner.list` —— 我的搭档档案

字段见 §4。要点：

- **`playCount` 本期只统计「通关并结算」的局**，没通关的局不计。
  要统计全部局得在 `room.start` 埋一次写，那会让每次开局多一次数据库写，
  **2026-11-19 与用户确认先不做**，等有人在页面上真的需要这个数再补。
- `clearedLevels` 去重按通关先后追加；`clearedCount = clearedLevels.length`
- `bestRecords` 每关只留更好的一次；`timeMs <= 0` 不允许覆盖已有记录
- `badges` **读取时按 `clearedCount` 现算**，库里存的那份只作留档 ——
  规则改了不用回填历史数据，也能自愈"旧数据漏写徽章"

#### 徽章（4 条，达标即永久保留）

| id | 名称 | 条件 |
|---|---|---|
| `first_team` | 初次并肩 | 共同通关 1 关 |
| `three_levels` | 默契初成 | 共同通关 3 关 |
| `five_levels` | 心有灵犀 | 共同通关 5 关 |
| `all_levels` | 全勤搭档 | 共同通关全部 10 关 |

### 8.5 两个口径必须写进 E 的页面设计

1. **「好友」= 一起玩过一局的人**，不是微信好友（小游戏拿不到关系链，除非走开放数据域，本期不做）
2. **「再次邀请」= 建房 + `wx.shareAppMessage`**，没有"直接发给指定人"的接口。
   如果 E 设计成点一下就把邀请推给这个搭档，**本期做不到**

### 8.6 索引（**部署前必须在控制台建好，不建会全表扫**）

| 集合 | 索引字段 | 用途 |
|---|---|---|
| `scores` | `levelId`(升) + `mode`(升) + `timeMs`(升) + `clearedAt`(升) | 榜单主查询 + tie-break |
| `scores` | `levelId`(升) + `mode`(升) + `timeMs`(升) | `count` 名次（比我快的有多少） |
| `scores` | `openids`(数组) + `levelId`(升) + `mode`(升) + `timeMs`(升) | **v3.9 新增**：双人榜取「我参与过的最快队记录」（`mine`） |
| `partners` | `openids`(数组) + `lastPlayedAt`(降) | 我的搭档列表 |

> **旧数据不用清**：双人榜查询带 `openids: _.exists(true)`，v3.8 的「一人一条」记录
> 没有这个字段，查不出来也进不了榜。想彻底清干净就在控制台删 `scores` 里
> `mode == 'duo' && openids 不存在` 的文档（可选，不做也不影响）。
>
> 顺带两条**已经在用但可能没建**的：
> `saves` → `pairKey`(升) + `levelId`(升)（`save.*` 全靠它）；
> `events` → `roomId`(升) + `seq`(升)（`room.sync` / `event.pull` 的 `where + orderBy`）。

### 8.7 明确不做

好友榜/同校榜（无关系链）、榜单奖励与段位（分工写明「只展示成绩，不设奖励」）、
榜单实时推送、无限滚动、成绩申诉后台、`rank.mine`（E 不需要，结算页用 `level.submit` 的 `rank`）。


## 9. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-21 | 初版。四张业务表 + `levels` 私密表；16 个 action；同步采用轮询 + seq 增量 |
| v2 | 2026-09-26 | 对齐 D 的关卡运行时：① 新增 `level.list`，删除 `progress.nextLevel`（LEVEL_ORDER 只留客户端）；② `levels` 文档加 `chapterId`/`title`/`unlocks`，`puzzle` 改为可选（操作通关的关没有）；③ `submit` 支持对象答案、`inventory` 道具校验（新错误码 4002）、重开清零 attempts、`elapsedMs` 缺省不清零最好成绩，通关返回 `unlocks`；④ `progress.save` 只接受 `unlocked`；⑤ 修复 D 反馈的 7 个 bug（join 并发、pull 分页 seq、getDoc 吞异常等）；⑥ 新增种子生成脚本 |
| v3 | 2026-10-10 | 房主选关：① 新增 `room.setLevel`（房主换关，新错误码 **2005 NOT_HOST**）；② 房间快照新增玩家进度数据；③ **房主离开 = 房间关闭**（`room.leave` 返回 `roomClosed`，`heartbeat`/`event.publish` 对已关闭房间报 2003）；④ `viewId` 分配改为按「A 有没有人占」判断，修掉房主离开后新房客被分到重复 B 的问题；⑤ 事件 `levelId` 从 payload 约定提升为**服务端字段**；⑥ `room.create` 改为返回完整快照 |
| v3.1 | 2026-10-12 | 与 E 合并后重新对齐：① **可玩交集改为服务端算**，快照字段定为 `playableLevelIds`（含 sorted 顺序）+ `isHost`，删掉 `players[].progress`；② **`GUIDE` 明确允许双人房选**，服务端集合写死 `GUIDE`，因此取消 `auth.login` 的基线进度兜底；③ 再次确认**房主离开 = 房间关闭**，`room.setLevel` 补回 `NOT_IN_ROOM`(2004) 校验（前房主退出后不能再改关）；④ 恢复 `heartbeat` / `event.publish` 的 `ROOM_CLOSED`(2003) 校验；⑤ `auth.updateProfile` 支持 `avatarUrl`（云存储 `avatars/`）；⑥ 第 10 关接入，服务端 `LEVEL_ORDER` 补 `L10`；⑦ 新增 §1 部署流程、§6 云存储配置、§5 交集口径 |
| v3.2 | 2026-10-13 | **文档补齐**（服务端代码已由 `06f374e` 落地，本次只补文档）：① 新增 `room.start` 完整文档（仅房主统一开局、`startedAt` = 服务端时间 + 3s、重复点击幂等、满 2 人且都在线才允许、非房主报 3001）；② 快照新增 `startedAt` + `serverNow`，`rooms` 表新增 `startedAt`；③ **`room.leave` 房主离开即关房**（返回 `roomClosed`），两种离开都会把 `startedAt` 归零；④ `room.setLevel` 校验顺序写全 2001→2003→2004→2005→3001→4001，并说明换关会打回 `waiting`；⑤ `heartbeat` / `event.publish` 恢复 `ROOM_CLOSED`(2003) 校验、`shared/errors.ts` 恢复 `NOT_HOST 2005`；⑥ §5 交集算法更新为「补齐 `LEVEL_ORDER[0..f+1]`」+ 查询失败时按 `progressId` 逐关回退；⑦ `room.join` 补「人齐了也不会自动开始」 |
| v3.3 | 2026-11-02 | **第 8 周新增功能**（代码 `1196328`，定稿见 `server/API-W8-FINAL.md`）：① 新增 `feedback.submit`（FR-14，载荷沿用 E 的 `Feedback.ts`）+ `feedbacks` 集合；② 新增 `library.get` / `library.add`（FR-11/12/13，跨关收藏与图鉴彩蛋，写入幂等）+ `libraries` 集合；③ 新增 `save.write` / `save.load` / `save.clear`（FR-15 双人存档）+ `saves` 集合，索引键 `pairKey + levelId` **不含 roomCode**，跨房间长期保留；④ `rooms` 加 `sessionPlayers`（`room.start` 时快照，供存档算 pairKey）；⑤ 房间快照加 `hasSave` / `saveComplete`，省一次 `save.load` 往返；⑥ `level.submit` 两条通关分支自动清存档；⑦ **不新增错误码**，全部复用 3001/2001/2004；⑧ 明确「存档 ≠ 断线重连」，`room.sync` 聚合与断线重连云端版排 W9–10 |
| v3.4 | 2026-11-05 | **管理端反馈查看**（E 要求「反馈提交后由谁查看」）：① 新增 `admins` 集合（`_id` = openid，`enabled:false` 即收回权限）；② 新增 `admin.whoami`（自查，不设权限）与 `admin.feedback.list`（仅管理员，`createdAt` 游标分页，`limit` 上限 100，支持 `status`/`category`/`levelId` 过滤）；③ 新错误码 **1002 FORBIDDEN**；④ 管理端列表**刻意不叫 `feedback.list`** —— 那个名字在 E 的《接口需求》§1.3 已被定义为「玩家看自己的反馈」，同名会造成越权误读；⑤ 查看方式 A（控制台直看）保留，`status` 也在控制台改；⑥ 种子 `server/seeds/admins.seed.json` |
| v3.5 | 2026-11-13 | **`room.sync` 聚合轮询**：① 新增 `room.sync`，一次返回房间快照 + 事件增量 + 在线状态，替代 `room.state`(0.5s)/`room.heartbeat`(10s)/`event.pull`(1s) 三条定时器；② `lastSeenAt` 由它顺带刷新（**10 秒节流写**），心跳可停；③ 双人可玩交集 15 秒缓存（`rooms.playableCache*`），`playing` 时跳过 `peekSave`；④ 事件页 100 条 + `hasMore`（多取一条判定），`lastSeq` 取本页最后一条、空页回退 `sinceSeq`；⑤ **房间 `closed` 返回 200 不报 2003**，**不按 `levelId` 过滤事件**（客户端跨关边界探测要用）；⑥ `sinceSeq` 必填，缺失报 3001；⑦ **老接口一行未删**，接入说明见 `room-sync-接入说明.md` |
| v3.6（草案） | 2026-11-13 | **排行榜 + 双人搭档档案**（§8，**未定稿**）：① 新增 `scores` / `partners` 两个集合（尚未建表）；② `level.submit` 增加可选 `hintsUsed` / `eggsFound`，返回增加 `score` / `rank` / `isNewBest`；③ 新增 `rank.level`（榜单，不返回他人 openid）与 `partner.list`（搭档档案，用 `partnerId` 而非 openid）；④ 计分公式由服务端实现并带 `scoreRuleVersion`，**不接受客户端传分数**；⑤ 完整草案见 `rank-partner-契约草案.md`，D 11/17 确认后定稿 |
| v3.7 | 2026-11-16 | **文档对齐实现（零代码改动）**，消化《后端黑盒测试用例集》附录 A 的 A1–A7：① `room.create` 明确 `levelId` 必传且**区分大小写**，`room.setLevel` 则 `toUpperCase`；② `room.start` 越权明确为 **3001**（与 `setLevel` 的 2005 不同，客户端改用 `isHost` 判断）；③ 存档接口名统一为 **`save.write`**（设计文档 §4.7 里的 `save.save` 已改）；④ `event.publish` 的 `type` 明确**只校验非空、无白名单**；⑤ `event.pull` 的 `sinceSeq` 非法按 0 处理（= 全量重放），与 `room.sync` 报 3001 的差异写清；⑥ `level.submit` 次数耗尽后第 N+1 次按"新一局第一答"处理、`remainAttempts=N-1`；⑦ 新增 **§10 待办**，登记 A8/A9/A10 与 5 条代码侧遗留项 |
| v3.9 | 2026-11-20 | **双人榜改「一队一条」**（E 反馈：双人榜只能显示一个人，且 E 只能在展示层去重兜底）：① `scores` 双人记录从一人一条改为**按 `pairKey` 聚合**，`_id = duo_<sha256(pairKey+levelId) 前 32 位>`，成员写 `openids`，`openid` 空串、不再写 `partnerOpenid`；② `rank.level` 每行新增 **`players: [{nickname,avatarUrl,isMe}]`**，`total`/`rank`/`mine` 改**队伍口径**；平级 `nickname`/`avatarUrl` 保留兼容（取 `players[0]`，保证非空）；③ 双人 `mine` 改为「我参与过的最快队记录」，`rankOf()` 与榜单查询共用 `boardFilter()` 保证名次一致；④ 双人榜带 `openids: _.exists(true)`，v3.8 旧记录自动过滤，**无需清库**；⑤ `level.submit` 双人分支只写一条队记录（原来每人写一条），返回体形状不变；⑥ 新增索引 `scores(openids+levelId+mode+timeMs)`；⑦ 自测补到 **79 条零失败**（新增双人队粒度 / 换搭档另起记录 / `players` 形状共 20 条） |

---

## 10. 待办 / 已知问题

来源：`《知行谜站》后端黑盒测试用例.md` 附录 A。A1–A7 已在 v3.7 按「改文档」结案；
**T7 / T9 / T10 已在 v3.8 修复**（回归用例 SV-15 / SUB-27 / SUB-28，见下表的「状态」列）。
剩下的 T1–T6、T8 是代码侧或产品语义侧还没动的部分，**不影响当前联调**，但答辩/正式上线前要清。

| 编号 | 对应 | 问题 | 影响面 | 建议处理 | 优先级 | 状态 |
|---|---|---|---|---|---|---|
| T1 | A2 | `room.create` 不归一大小写，`room.setLevel` 会 `toUpperCase`，两个接口口径不一致 | 客户端传小写 `l01` 建房会失败，换关却成功 | 在 `room.create` 的 `requireString` 后同样 `toUpperCase` | P2 | 未修 |
| T2 | A3 | `room.start` 越权报 3001，`room.setLevel` 越权报 2005 | 客户端没法用统一错误码判断"越权" | 统一为 `2005`（但要先确认 E 的 `cloudErrorText` 不需要特判） | P2 | 未修 |
| T3 | A7 | 次数耗尽后第 N+1 次提交直接重开一局，没有失败冷却 | 玩家可以连点刷次数，容错次数形同虚设 | 加 `failedAt` + 冷却（例如 10 秒）或"退出重进才重开"，需 D 确认关卡节奏 | P1 | 未修 |
| T4 | A5 | `event.publish` 不校验 `type` 白名单 | 脏类型事件会占 `seq`、被对端丢弃，排查困难 | 按 `join/clue/pickup/submit/chat/hint/result/metric` 加白名单，非法报 3001 | P2 | 未修 |
| T5 | A6 | `event.pull` 的 `sinceSeq` 非数字静默按 0，会把整局历史重放 | 客户端漏传参数 → 画面重放上一局操作 | 与 `room.sync` 统一为非法报 3001（需 E 确认没有地方依赖这个宽容） | P1 | 未修 |
| T1 | A2 | `room.create` 不归一大小写，`room.setLevel` 会 `toUpperCase`，两个接口口径不一致 | 客户端传小写 `l01` 建房会失败，换关却成功 | 在 `room.create` 的 `requireString` 后同样 `toUpperCase` | P2 | 未修 |
| T2 | A3 | `room.start` 越权报 3001，`room.setLevel` 越权报 2005 | 客户端没法用统一错误码判断"越权" | 统一为 `2005`（但要先确认 E 的 `cloudErrorText` 不需要特判） | P2 | 未修 |
| T3 | A7 | 次数耗尽后第 N+1 次提交直接重开一局，没有失败冷却 | 玩家可以连点刷次数，容错次数形同虚设 | 加 `failedAt` + 冷却（例如 10 秒）或"退出重进才重开"，需 D 确认关卡节奏 | P1 | 未修 |
| T4 | A5 | `event.publish` 不校验 `type` 白名单 | 脏类型事件会占 `seq`、被对端丢弃，排查困难 | 按 `join/clue/pickup/submit/chat/hint/result/metric` 加白名单，非法报 3001 | P2 | 未修 |
| T5 | A6 | `event.pull` 的 `sinceSeq` 非数字静默按 0，会把整局历史重放 | 客户端漏传参数 → 画面重放上一局操作 | 与 `room.sync` 统一为非法报 3001（需 E 确认没有地方依赖这个宽容） | P1 | 未修 |
| T6 | A8 | **`level.submit` 不校验该关是否已解锁**，知道答案即可直通任意关 | 可绕过解锁链直接通关 L10；`unlocks` 也会一次性全开 | 提交前校验 `progress` 存在且 `status ∈ {unlocked, cleared}`，否则 3001 | **P0** | 未修 |
| T7 | A9 | 未开局就 `save.write` 时 `pairKey` 取自 `players`，房主离开后 `players` 只剩一人，键变了 | 该场景下存档读不回，违反 FR-15「房间关闭后仍可恢复」 | 在移除成员**之前**冻结 `sessionPlayers` | **P0** | **v3.8 已修**：`room.leave` 冻结 + `save.*` 首次调用兜底，两条顺序都覆盖 |
| T8 | A10 | 「保存时暂停倒计时」只冻结了 `elapsedSec`，服务端无 `pausedAt`，暂停期间的时间由客户端决定 | 客户端若在处理 `elapsedSec` 时算错，等于没有暂停 | 与 D/E 确认暂停是纯客户端行为；若是，在 `save.write` 文档里写明「`elapsedSec` 由客户端在暂停瞬间取值，服务端只存不算」 | P1 | 未修 |
| T9 | 前端缺陷 2 | 双人同一局两端各调一次 `level.submit`，服务端没有按局防重 | 同一局重复上报：`clearSaveForRoom` 重复执行、`result` 事件可能重复；一局提交次数不可信 | 局级幂等键 `roomCode + startedAt` | P1 | **v3.8 已修**：`rooms.clearedRunAt` + 事务抢占，重复的一端返回 `duplicate: true` 且不写任何东西 |
| T10 | 前端缺陷 1 | `level.submit` 不校验本关是否已超时，倒计时归零后再提交照样落 `cleared` | 一端已判超时失败、后端却记通关；双人两端结算结论不一致（BB-128 的根因之一） | 超时提交返回业务错误、不落 `cleared` | **P0** | **v3.8 已修**：限时关 `elapsedMs` 超上限报 **4003**。**是软校验**（依据客户端上报的用时，用服务端墙钟会误杀暂停过的玩家），挡不住改小 `elapsedMs` 的改包 |

> **T6 仍是唯一没修的口子**（能跳过解锁直接通关），对应 `SUB-26`。
> T7 对应 `SV-15`，T9 / T10 对应 `SUB-27` / `SUB-28`（前端 BB-128 / BB-129 在服务端的根因），
> 三条都已在 v3.8 修复，**回归时把测试用例集里那 3 条改回「通过」**。
> 每次改 `level.ts` / `save.ts` / `room.ts` 之后都要重新编译（`tsc -p tsconfig.json`）再部署。
