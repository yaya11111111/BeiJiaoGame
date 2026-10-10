# 《知行谜站》后端接口契约 v3

负责人：C　｜　状态：**9/23 冻结版（v1）**　｜　调用方：D（关卡模块）、E（外层页面）

> 这份文件是 D 和 E 的开工依据。**接口名、字段名一旦改动，必须在这里先改并通知 D、E**，不要只在代码里改。

---

## 1. 怎么调用

### 前置：客户端必须先初始化（E 负责，只做一次）

**不执行下面这段，任何 `wx.cloud.callFunction` 都会失败**——这是目前唯一还挡在 D / E 前面的东西。

| 项 | 说明 |
|---|---|
| 谁写 | **E**（外层入口负责人）。D 不用管，C 的云函数侧已经自己 init 过了 |
| 写在哪 | 小游戏**启动入口**，全局只执行一次，不要每个页面都调 |
| 什么时候 | `wx.cloud.init` 是同步的，放在入口最前面即可，必须早于任何 `callFunction` |
| envId 在哪看 | 微信开发者工具 → 云开发 → 环境设置 → **环境 ID**（形如 `beijiaogame-8gxxxxxx`），或控制台顶部环境名旁边 |

```js
// 小游戏启动入口（game.js 或 Cocos 构建产物的入口文件）
if (!wx.cloud) {
  console.error('当前基础库不支持云开发，请升级微信版本');
} else {
  wx.cloud.init({
    env: 'beijiaogame-8gxxxxxx', // ← 换成你开通的那个环境 ID
    traceUser: true,             // 自动记录用户访问，后台「独立玩家数」统计要用
  });
}
```

三个注意点：

1. **`env` 只写这一处**。换环境（比如从测试环境切到正式环境）只改这个字符串，客户端其他代码不用动
2. **`traceUser: true` 建议开**。它把用户访问记录写进云开发的用户分析，正好是分工里要求的「独立玩家数」统计口径，不用我们自己埋点
3. **开发者工具里 `project.config.json` 要配 `cloudfunctionRoot`**，否则右键看不到「上传并部署」：
   ```json
   "cloudfunctionRoot": "cloudfunctions/"
   ```

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

## 2. 错误码

| code | 含义 | 客户端建议处理 |
|---|---|---|
| 1001 | 拿不到用户身份 | 提示重新进入小游戏 |
| 2001 | 房间不存在 | 提示检查房间码 |
| 2002 | 房间已满（每间最多 2 人） | 提示换一个房间 |
| 2003 | 房间已关闭 | 回首页 |
| 2004 | 你不在这个房间里 | 回首页 |
| 2005 | 只有房主可以更换关卡（**不是 2004**，越权的人确实在房间里） | 把换关入口置灰/隐藏 |
| 3001 | 参数缺失或格式不对 | 开发期报错，别吞掉 |
| 4001 | 关卡数据缺失 | 提示联系管理员（一般是 C 没导配置） |
| 4002 | 缺少必要道具（requiredItems 未凑齐） | 提示先去场景里找道具；**不消耗容错次数** |
| 5000 | 服务端内部错误 | 提示稍后重试 |

## 3. 数据表（云开发数据库，共 5 个集合）

### `users` — 用户档案
`_id` 就是 openid。

| 字段 | 类型 | 说明 |
|---|---|---|
| `openid` | string | 微信身份标识，不对外下发 |
| `nickname` | string | 玩家自设昵称，1–16 字符 |
| `createdAt` / `lastLoginAt` | number | 毫秒时间戳 |
| `currentLevelId` | string | 最近进入的关卡（`GUIDE` / `L01`…） |

### `rooms` — 双人房间
`_id` 就是 6 位房间码。

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 房间码，同 `_id` |
| `levelId` | string | 本房要玩的关卡 |
| `hostOpenid` | string | 建房者 = **房主** = 视角 A。房主离开房间直接置 `closed`（见 `room.leave`） |
| `status` | string | `waiting`（等人）/ `playing`（进行中）/ `closed`（已关闭） |
| `players` | array | `[{ openid, nickname, viewId: 'A'\|'B', online, lastSeenAt }]`，最多 2 项 |
| `lastSeq` | number | 房间内事件序号，只由服务端自增 |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |

**viewId 分配规则**：第一个进房的是 `A`，第二个是 `B`（判断依据是「A 有没有人占」，不是人数）。同一人重复加入返回原来的 viewId（幂等）。

**房主规则（2026-10-10 定）**：
- **建房的人永远是视角 A，也永远是房主**（`hostOpenid`）。客户端用 `myViewId === 'A'` 判断"我是不是房主"即可，这个约定不再变。
- **房主离开 = 房间关闭**。这样上面那条约定就不会被打破（否则剩下的人是 B，新房客再进来分不出正确的 A/B，而且没人有权选关）。
- 留在房里的另一个人轮询 `room.state` 看到 `status === 'closed'` 后自行退出；再有人 `room.join` 这个码会拿到 **2003**。

### `events` — 房间内事件（只追加，不修改）
| 字段 | 类型 | 说明 |
|---|---|---|
| `roomId` | string | 空字符串表示这是个人埋点，不是房间事件 |
| `levelId` | string | 本轮事件属于哪一关（**v3 起提升为服务端字段**，原来是客户端塞在 payload 里的约定）。老数据没有这个字段，读出按空字符串处理 |
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
  // 答题通关的关才有 puzzle；「操作通关」的关（L01~L04、L06）没有这一节
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

---

## 4. 接口明细

### 账号

#### `auth.login`
无感登录，首次调用自动建档。**E 在登录页/启动时调一次。**
- 入参：无
- 出参：`{ openid 省略, nickname, currentLevelId, isNewUser }`

#### `auth.profile`
取档案 + 进度概览，**E 的个人记录页用**。
- 入参：无
- 出参：`{ nickname, currentLevelId, clearedCount, totalTimeMs }`

#### `auth.updateProfile`
- 入参：`{ nickname }`（1–16 字符，去首尾空格）
- 出参：`{ nickname }`

### 房间

> **房间快照（RoomSnapshot）统一结构**，`room.create` / `room.join` / `room.state` / `room.setLevel` 四个接口都返回它：
> ```jsonc
> {
>   "code": "AB3K7M",
>   "levelId": "L01",
>   "status": "waiting | playing | closed",
>   "myViewId": "A" | "B" | null,      // null = 你不在房里
>   "players": [{
>     "nickname": "交大同学1234",
>     "viewId": "A" | "B",
>     "online": true,
>     // v3 新增：这位玩家的关卡进度原始数据，给客户端算「双人可玩交集」用
>     "progress": [{ "levelId": "GUIDE", "status": "cleared" },
>                  { "levelId": "L01",   "status": "unlocked" }]
>   }]
> }
> ```
> `progress` **每次轮询都实时重查**（不做缓存）：玩家在房间里通关后，对方的可玩集合要立刻变化。

#### `room.create`
- 入参：`{ levelId }`
- 出参：房间快照（v3 起返回完整快照，不再只回 `code/myViewId`；`myViewId` 恒为 `'A'`）

#### `room.join`
- 入参：`{ code }`
- 出参：房间快照
- 已关闭的房间（房主离开过）→ **2003**

#### `room.leave`
- 入参：`{ code }`
- 出参：`{ left: true, roomClosed: boolean }`
- **房主离开 → 房间直接置 `closed`**（`roomClosed: true`），不管房里还有没有别人；非房主离开只是回到 `waiting`。

#### `room.state`
拉取房间快照。**E 的房间页用它刷新准备状态，也是"房主换关了"的感知通道。**
- 入参：`{ code }`
- 出参：房间快照

#### `room.setLevel`（v3 新增，**房主选关就用它**）
- 入参：`{ code, levelId }`
- 出参：房间快照（已带新的 `levelId`）
- 校验顺序：房间存在(2001) → 房间没关(2003) → 你在房里(2004) → **你是房主(2005)** → 关卡存在(4001)
- **服务端不校验"这一关两人是不是都能玩"** —— 可玩交集依赖关卡顺序、地图节点→关卡映射、solo/duo 标记，这三样都在客户端，服务端算不出来（见 §6）。客户端保证只传交集内的 `levelId`。
- `waiting` 和 `playing` 两种状态下都可以换关。
- **换关不清事件流水、不重置 `lastSeq`**：事件已按 `levelId` 打标，客户端只回放「本轮 + 本关」，上一关的事件不会串进来。
- 另一个玩家靠轮询 `room.state` 发现 `levelId` 变了 → 提示「房主更换了关卡」。换关后由**房主端**广播 `start` 事件开新一轮。

#### `room.heartbeat`
**建议每 10 秒调一次**，用来判定对方掉线（超过 30 秒没心跳视为离线）。
- 入参：`{ code }`
- 出参：`{ online: true }`
- 房间已关闭 → **2003**（读接口 `room.state` / `event.pull` 不受影响，客户端要靠它们观察 closed 状态）

### 关卡

#### `level.list`（v2 新增，**E 的地图页用**）
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
- **答案错误时不会回传正确答案**，只回剩余次数——这是需求评审定的隐私口径，别为了做提示把它加回来。
- **重新开局语义**：上次失败（次数用光）或已通关后重玩，`attempts` 自动清零重新计，不会把上一局的次数带进来。

### 事件与同步

#### `event.publish`
把动作广播给房间里另一视角。
- 入参：`{ code, type, payload, levelId? }`
  - `levelId` **v3 起是服务端字段**（原来是客户端塞在 payload 里的口头约定）。**建议每次都传**，这样服务端才能按关过滤/清理事件；`payload` 里那份如果已经在传，可以保留，不影响。
  - 房间已关闭 → **2003**
- 出参：`{ seq, ts, levelId }`

#### `event.pull`
**增量拉取**，轮询和断线重连都用它。
- 入参：`{ code, sinceSeq = 0 }`
- 出参：`{ events: [{ seq, levelId, type, senderId, ts, payload }], lastSeq }`
- `levelId` 对 2026-10-10 之前写入的老事件是空字符串，**客户端不要假设它一定非空**。
- `lastSeq` 是**本页最后一条事件的 seq**（不是房间全局值）。一次最多拉 200 条；如果返回的条数等于 200，说明可能还有，用 `lastSeq` 当 `sinceSeq` 再拉一次直到拿空。
- 客户端流程：记住上次拿到的最大 `seq` → 下次带 `sinceSeq` 只拉新的。断线重连后照样从旧 `seq` 拉，**不会丢事件**。

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

##### 谁在什么时候调（2026-10-10 定，**D / E 请按这个来**）

`progress` 是双人「可玩交集」的权威来源，所以什么时候写 `unlocked` 必须有统一口径：

| 时机 | 谁调 | 说明 |
|---|---|---|
| **登录时（基线）** | **服务端** `auth.login` | 保证 `GUIDE` 至少有一条 `unlocked`。**约定：零进度玩家只能玩 GUIDE**。服务端兜底，客户端不用管、也不用记这件事（老账号登录时也会补，已通关的不会被降级） |
| **通关一关之后** | **客户端**（D） | `level.submit` 返回通关后，把本关 `unlocks`（地图节点 id）**映射到的新解锁关卡**逐条 `progress.save({ status: 'unlocked' })`。节点→关卡的映射只在客户端有，所以这一步只能客户端做 |
| ~~进入关卡时~~ | — | **不推荐**。用「通关后落解锁」口径，解锁推进和地图解锁是同一套逻辑，不会出现"进了但没通关也算解锁"的歧义 |

- **不要在双人模式里补写**：房主能选到某一关，说明两人本来就都有它，没必要再写一次。
- 后果（**2026-10-10 产品已确认接受**）：**两个都没通关过 GUIDE 的新玩家，交集 = `{GUIDE}`，而 GUIDE 约定不可在双人房选 → 暂时没有可玩的关**。需要双方各自先单人通关 GUIDE（之后各自拿到 L01 的 unlocked，交集才有 L01）。见 §6。

> ~~`progress.nextLevel`~~ **v2 已删除**。「下一关是哪关」由客户端本地 `LEVEL_ORDER`（common/LevelConfig.ts）计算，服务端不再保存关卡顺序，两边不一致的问题从根上消失。

---

## 5. 数据权限设置（云开发控制台）

| 集合 | 权限 | 原因 |
|---|---|---|
| `users` / `rooms` / `progress` / `events` / `levels` | **「仅创建者可读写」** 之外的自定义权限 | 客户端**不直连数据库**，全部走云函数，所以权限可以收紧 |

**客户端一律不许直接读写数据库**，只能调云函数。否则「只下发当前视角线索」这条约束会被绕过。

## 6. 双人可玩交集（房主选关）口径

**分工：服务端只提供原始数据，交集一律客户端算。** 这是 2026-10-10 定的，理由是服务端算不了（见下面"服务端不做的事"）。

### 服务端给什么
`room.create` / `room.join` / `room.state` / `room.setLevel` 的 `players[].progress`：
`[{ levelId, status: 'unlocked' | 'cleared' }]`，每位玩家一份，**每次实时重查**。

### 客户端怎么算（D / E）
1. 每个人的「能玩集合」= `{ levelId | status ∈ { unlocked, cleared } }`
   —— 用 `unlocked` **或** `cleared`，不能只算 `cleared`（会把"已解锁还没通关"的人挡在外面，那正是要一起来通的人）。
2. 交集 = 房主集合 ∩ 另一位玩家集合。
3. 房间还在 `waiting`（只有房主 1 人）时，**交集 = 房主自己的集合**。
4. 从交集里**过滤掉**：
   - `GUIDE`（约定不可在双人房选）
   - 客户端配置 `mode` 不含 `'duo'` 的关（目前 10 关都是 `["solo","duo"]`，暂无影响）
   - **没有关卡数据的关**（`LEVEL_ORDER` 里的 `L10` 目前无配置无种子，别列出来给人选）
5. 剩下的按客户端 `LEVEL_ORDER` 排序展示给房主选。

### 服务端不做的事（以及为什么）
| 想让服务端做的事 | 为什么做不了 |
|---|---|
| 直接返回 `playableLevelIds` 交集 | 同上，而且会推翻「LEVEL_ORDER 只客户端」的结论 |
| 排除 solo-only 的关 | `levels` 集合**没有 `mode` 字段**（`build-seed.js` 不抽取），服务端不知道哪关是单人专属 |
| 按 `unlocks` 推出解锁了哪些关 | `unlocks` 里是**地图节点 id**（`node_road`、`node_teaching`…），不是 levelId，服务端没有节点→关卡的映射 |
| 按关卡顺序排序 | 服务端没有 `LEVEL_ORDER`；`level.list` 也**没有 `orderBy`**，返回的是数据库自然序（种子导入序是 `L01…L09,GUIDE`，和 `LEVEL_ORDER` 不一样） |

### 已知缺口（请知悉，不是 bug）
- **`GUIDE` 不可在双人房选，服务端无法强制**——服务端只校验"关卡存在"，`GUIDE` 在库里是存在的。这条靠客户端不给它出现在选项里来守住。

### 已确认的设计约束（2026-10-10 拍板，**不要再改**）
- **两个都没通关过 GUIDE 的新玩家，没有可玩的双人关卡**（交集 = `{GUIDE}`，而 GUIDE 被过滤掉）。
  这是上面 4 条过滤规则 + 「零进度只能玩 GUIDE」的直接结果。
- **产品已确认接受**：玩家必须**各自先单人通关新手引导 GUIDE**，之后各自拿到 L01 的 `unlocked`，
  交集才有 L01，此时才能联机。这符合"新手引导本来就该先做"的叙事。
- 客户端表现：房主选关列表为空时，请提示「先各自完成新手引导才能联机」，**不要显示空白列表**让人以为是 bug。
- 曾评估过的两个替代方案（均已否决，不要重新提出）：允许 GUIDE 双人选；把 L01 也算进零进度基线。

---

## 7. levels 种子数据（C 维护）

`levels` 集合的内容不用手写，由脚本从 D 的客户端配置自动生成：

```bash
# 在仓库根目录执行
node server/seeds/build-seed.js
# 产出 server/seeds/levels.seed.json → 云开发控制台 → levels → 导入（冲突处理选 Upsert）
```

- 输入：`client/assets/resources/configs/level.*.json`
- 抽取规则：每个视角 `inspect` 热点的 `text` → `views.X.clues`；`puzzle`（含 answer/requiredItems/maxAttempts）原样拷贝；`rewards.progress` → `unlocks`
- **A/B 出正式节点清单、9/27 剧情定稿后，D 更新配置，重跑脚本再导入即可**

## 8. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-21 | 初版。四张业务表 + `levels` 私密表；16 个 action；同步采用轮询 + seq 增量 |
| v2 | 2026-09-26 | 对齐 D 的关卡运行时：① 新增 `level.list`，删除 `progress.nextLevel`（LEVEL_ORDER 只留客户端）；② `levels` 文档加 `chapterId`/`title`/`unlocks`，`puzzle` 改为可选（操作通关的关没有）；③ `submit` 支持对象答案、`inventory` 道具校验（新错误码 4002）、重开清零 attempts、`elapsedMs` 缺省不清零最好成绩，通关返回 `unlocks`；④ `progress.save` 只接受 `unlocked`；⑤ 修复 D 反馈的 7 个 bug（join 并发、pull 分页 seq、getDoc 吞异常等）；⑥ 新增种子生成脚本 |
| v3 | 2026-10-10 | 房主选关：① 新增 `room.setLevel`（房主换关，新错误码 **2005 NOT_HOST**）；② 房间快照新增 `players[].progress`（每人每关 unlocked/cleared，供客户端算可玩交集）；③ **房主离开 = 房间关闭**（`room.leave` 返回 `roomClosed`，`join`/`heartbeat`/`event.publish` 对已关闭房间报 2003）；④ `viewId` 分配改为按「A 有没有人占」判断，修掉房主离开后新房客被分到重复 B 的问题；⑤ 事件 `levelId` 从 payload 约定提升为**服务端字段**（`event.publish` 入参、`event.pull` 出参）；⑥ `auth.login` 兜底基线进度（保证 GUIDE 有 unlocked）；⑦ 新增 §6 双人可玩交集口径、`progress.save` 调用时机；⑧ `room.create` 改为返回完整快照；⑨ 产品拍板：维持「两个新玩家需各自先单通 GUIDE 才能联机」（否决了"GUIDE 可双人"与"L01 进基线"两个替代方案） |
