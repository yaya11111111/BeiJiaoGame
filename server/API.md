# 《知行谜站》后端接口契约 v3

负责人：C　｜　状态：**2026-10-12 对齐版（v3）**　｜　调用方：D（关卡模块）、E（外层页面）

> 这份文件是 D 和 E 的开工依据。**接口名、字段名一旦改动，必须在这里先改并通知 D、E**，不要只在代码里改。
>
> v3 的两条口径在 2026-10-12 由 C 与 E 当面确认，**不要再改**：
> ① **房主离开 = 房间关闭**；② **新手引导关 `GUIDE` 允许在双人房里选**。详见 §5。

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

---

## 2. 错误码

| code | 含义 | 客户端建议处理 |
|---|---|---|
| 1001 | 拿不到用户身份 | 提示重新进入小游戏 |
| 2001 | 房间不存在 | 提示检查房间码 |
| 2002 | 房间已满（每间最多 2 人） | 提示换一个房间 |
| 2003 | 房间已关闭 | 回首页 |
| 2004 | 你不在这个房间里 | 回首页 |
| 2005 | 只有房主可以更换关卡（**不是 2004**，越权的人确实在房间里） | 把换关入口置灰/隐藏，别显示成"房间已关闭" |
| 3001 | 参数缺失或格式不对 | 开发期报错，别吞掉 |
| 4001 | 关卡数据缺失 | 提示联系管理员（一般是 C 没导配置） |
| 4002 | 缺少必要道具（requiredItems 未凑齐） | 提示先去场景里找道具；**不消耗容错次数** |
| 5000 | 服务端内部错误 | 提示稍后重试 |

> E 的 `AppShellView.cloudErrorText` 已经按 code 映射了提示文案；**加新错误码要同步去那里加一行**，否则会退化成显示服务端原始 message。

## 3. 数据表（云开发数据库，共 5 个集合）

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
>   "playableLevelIds": ["GUIDE", "L01", "L02"],  // 两人都能玩的关，已按服务端顺序排好
>   "players": [
>     { "nickname": "交大同学1234", "viewId": "A", "online": true }
>   ]
> }
> ```
> `playableLevelIds` **每次都实时重算**（不缓存）：玩家在房间里通关后，对方要立刻能看到新解锁的关。

#### `room.create`
- 入参：`{ levelId }`
- 校验：`levelId` 必须在服务端 `LEVEL_ORDER` 里，否则 **3001**（不认识的关**直接报错**，不静默降级成 GUIDE——否则客户端传错参数谁也不会发现）
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
- 权限：**仅房主**；非房主调用报 3001（消息「只有房主可以开始游戏」）
- 前置校验：
  - 房间里必须**满 2 人且两人都在线**，否则 3001（消息「请等待好友进入房间并保持在线」）
  - 房间已关闭 → 2003
- **重复点击幂等**：同一轮已经开始（`status === 'playing'` 且 `startedAt` 非 0）时直接返回原来的 `startedAt`，**不会**生成第二个开局时间
- `startedAt = 服务端当前时间 + 3000ms`（`START_DELAY_MS`）—— 给双方留出轮询和加载页面的时间，
  真正计时仍以这个服务端时刻为准，**两边看到的是同一个值，不会因为各自的网络延迟而有偏差**
- 另一个玩家靠轮询 `room.state` 观察到 `startedAt` 从 0 变成正数 → 自动进入关卡。
  客户端换算本地倒计时：`本地开始时刻 = Date.now() + (startedAt - serverNow)`

#### `room.leave`
- 入参：`{ code }`
- 出参：`{ left: true, roomClosed: boolean }`
- **房主离开 → 房间直接置 `closed`**（`roomClosed: true`），不管房里还有没有别人
- 非房主离开 → 回到 `waiting`（`roomClosed` 一般是 `false`，除非屋里只剩他一个）
- 两种情况下都会把 **`startedAt` 归零**：有人进出就意味着这一轮作废，要重新开始就得再点一次 `room.start`

#### `room.state`
拉取房间快照，**E 的房间页用它刷新准备状态，也是"房主换关了 / 房间没了"的感知通道**。
- 入参：`{ code }`
- 出参：完整房间快照
- **房间 `closed` 时仍然返回 200 正常数据**（不会报错）——目的是让留在房里的另一个人能从 `status` 观察到房间已关。客户端需要自己处理 `status === 'closed'`（退出房间页）
- 顺带把超过 30 秒没心跳的对面标成离线；只在在线状态真的变了时才写库

#### `room.heartbeat`
**建议每 10 秒调一次**，超过 30 秒没心跳，对面的 `room.state` 会把你显示成离线。
- 入参：`{ code }`
- 出参：`{ online: true }`
- 房间已关闭 → **2003**。客户端的心跳错误只需要 swallow，别弹提示误导玩家

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
- 出参：`{ correct, failed, remainAttempts, bestTimeMs?, unlocks? }`
  - `remainAttempts`：操作通关的关固定为 `null`（没有容错次数概念）
  - `unlocks`：通关时返回本关解锁的地图节点 id 列表
- 双人房间中任一成员合法通关后，服务端会为房内双方写入该关 `cleared`，保证下一次组房时共同可玩关卡不会退回第 0 关
- **答案错误时不会回传正确答案**，只回剩余次数——这是需求评审定的隐私口径，别为了做提示把它加回来。
- **重新开局语义**：上次失败（次数用光）或已通关后重玩，`attempts` 自动清零重新计，不会把上一局的次数带进来。

### 事件与同步

#### `event.publish`
把动作广播给房间里另一视角。
- 入参：`{ code, type, payload, levelId? }`
  - `levelId` 是**服务端字段**（2026-10-10 加），**建议每次都传**，这样服务端才能按关过滤/清理事件；`payload` 里那份如果已经在传可以保留，不影响
  - 但**关卡同步本身不靠它** —— D 的同步读的是 `payload.levelId`，那份**必须保留**
  - 房间已关闭 → **2003**（这时候另一个人可能还在 `players` 里，所以这条校验不能省）
- 出参：`{ seq, ts, levelId }`

#### `event.pull`
**增量拉取**，轮询和断线重连都用它。
- 入参：`{ code, sinceSeq = 0 }`
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
| `users` / `rooms` / `progress` / `events` / `levels` | 收紧到「仅管理端可读写」 | 客户端**不直连数据库**，全部走云函数 |

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

## 8. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-21 | 初版。四张业务表 + `levels` 私密表；16 个 action；同步采用轮询 + seq 增量 |
| v2 | 2026-09-26 | 对齐 D 的关卡运行时：① 新增 `level.list`，删除 `progress.nextLevel`（LEVEL_ORDER 只留客户端）；② `levels` 文档加 `chapterId`/`title`/`unlocks`，`puzzle` 改为可选（操作通关的关没有）；③ `submit` 支持对象答案、`inventory` 道具校验（新错误码 4002）、重开清零 attempts、`elapsedMs` 缺省不清零最好成绩，通关返回 `unlocks`；④ `progress.save` 只接受 `unlocked`；⑤ 修复 D 反馈的 7 个 bug（join 并发、pull 分页 seq、getDoc 吞异常等）；⑥ 新增种子生成脚本 |
| v3 | 2026-10-10 | 房主选关：① 新增 `room.setLevel`（房主换关，新错误码 **2005 NOT_HOST**）；② 房间快照新增玩家进度数据；③ **房主离开 = 房间关闭**（`room.leave` 返回 `roomClosed`，`heartbeat`/`event.publish` 对已关闭房间报 2003）；④ `viewId` 分配改为按「A 有没有人占」判断，修掉房主离开后新房客被分到重复 B 的问题；⑤ 事件 `levelId` 从 payload 约定提升为**服务端字段**；⑥ `room.create` 改为返回完整快照 |
| v3.1 | 2026-10-12 | 与 E 合并后重新对齐：① **可玩交集改为服务端算**，快照字段定为 `playableLevelIds`（含 sorted 顺序）+ `isHost`，删掉 `players[].progress`；② **`GUIDE` 明确允许双人房选**，服务端集合写死 `GUIDE`，因此取消 `auth.login` 的基线进度兜底；③ 再次确认**房主离开 = 房间关闭**，`room.setLevel` 补回 `NOT_IN_ROOM`(2004) 校验（前房主退出后不能再改关）；④ 恢复 `heartbeat` / `event.publish` 的 `ROOM_CLOSED`(2003) 校验；⑤ `auth.updateProfile` 支持 `avatarUrl`（云存储 `avatars/`）；⑥ 第 10 关接入，服务端 `LEVEL_ORDER` 补 `L10`；⑦ 新增 §1 部署流程、§6 云存储配置、§5 交集口径 |
| v3.2 | 2026-10-13 | **文档补齐**（服务端代码已由 `06f374e` 落地，本次只补文档）：① 新增 `room.start` 完整文档（仅房主统一开局、`startedAt` = 服务端时间 + 3s、重复点击幂等、满 2 人且都在线才允许、非房主报 3001）；② 快照新增 `startedAt` + `serverNow`，`rooms` 表新增 `startedAt`；③ **`room.leave` 房主离开即关房**（返回 `roomClosed`），两种离开都会把 `startedAt` 归零；④ `room.setLevel` 校验顺序写全 2001→2003→2004→2005→3001→4001，并说明换关会打回 `waiting`；⑤ `heartbeat` / `event.publish` 恢复 `ROOM_CLOSED`(2003) 校验、`shared/errors.ts` 恢复 `NOT_HOST 2005`；⑥ §5 交集算法更新为「补齐 `LEVEL_ORDER[0..f+1]`」+ 查询失败时按 `progressId` 逐关回退；⑦ `room.join` 补「人齐了也不会自动开始」 |
