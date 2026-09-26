# 《断线之后》后端接口契约 v1

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
| `hostOpenid` | string | 建房者 |
| `status` | string | `waiting`（等人）/ `playing`（进行中）/ `closed`（已关闭） |
| `players` | array | `[{ openid, nickname, viewId: 'A'\|'B', online, lastSeenAt }]`，最多 2 项 |
| `lastSeq` | number | 房间内事件序号，只由服务端自增 |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |

**viewId 分配规则**：第一个进房的是 `A`，第二个是 `B`。同一人重复加入返回原来的 viewId（幂等）。

### `events` — 房间内事件（只追加，不修改）
| 字段 | 类型 | 说明 |
|---|---|---|
| `roomId` | string | 空字符串表示这是个人埋点，不是房间事件 |
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

#### `room.create`
- 入参：`{ levelId }`
- 出参：`{ code, levelId, myViewId: 'A', status: 'waiting' }`

#### `room.join`
- 入参：`{ code }`
- 出参：`{ code, levelId, myViewId: 'A' | 'B', players: [{ nickname, viewId, online }], status }`

#### `room.leave`
- 入参：`{ code }`
- 出参：`{ left: true }`　（房里没人时房间自动置 `closed`）

#### `room.state`
拉取房间快照。**E 的房间页用它刷新准备状态。**
- 入参：`{ code }`
- 出参：同 `room.join`

#### `room.heartbeat`
**建议每 10 秒调一次**，用来判定对方掉线（超过 30 秒没心跳视为离线）。
- 入参：`{ code }`
- 出参：`{ online: true }`

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
- 入参：`{ code, type, payload }`
- 出参：`{ seq, ts }`

#### `event.pull`
**增量拉取**，轮询和断线重连都用它。
- 入参：`{ code, sinceSeq = 0 }`
- 出参：`{ events: [{ seq, type, senderId, ts, payload }], lastSeq }`
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

> ~~`progress.nextLevel`~~ **v2 已删除**。「下一关是哪关」由客户端本地 `LEVEL_ORDER`（common/LevelConfig.ts）计算，服务端不再保存关卡顺序，两边不一致的问题从根上消失。

---

## 5. 数据权限设置（云开发控制台）

| 集合 | 权限 | 原因 |
|---|---|---|
| `users` / `rooms` / `progress` / `events` / `levels` | **「仅创建者可读写」** 之外的自定义权限 | 客户端**不直连数据库**，全部走云函数，所以权限可以收紧 |

**客户端一律不许直接读写数据库**，只能调云函数。否则「只下发当前视角线索」这条约束会被绕过。

## 7. levels 种子数据（C 维护）

`levels` 集合的内容不用手写，由脚本从 D 的客户端配置自动生成：

```bash
# 在仓库根目录执行
node server/seeds/build-seed.js
# 产出 server/seeds/levels.seed.json → 云开发控制台 → levels → 导入（覆盖模式）
```

- 输入：`client/assets/resources/configs/level.*.json`
- 抽取规则：每个视角 `inspect` 热点的 `text` → `views.X.clues`；`puzzle`（含 answer/requiredItems/maxAttempts）原样拷贝；`rewards.progress` → `unlocks`
- **A/B 出正式节点清单、9/27 剧情定稿后，D 更新配置，重跑脚本再导入即可**

## 7. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-21 | 初版。四张业务表 + `levels` 私密表；16 个 action；同步采用轮询 + seq 增量 |
| v2 | 2026-09-26 | 对齐 D 的关卡运行时：① 新增 `level.list`，删除 `progress.nextLevel`（LEVEL_ORDER 只留客户端）；② `levels` 文档加 `chapterId`/`title`/`unlocks`，`puzzle` 改为可选（操作通关的关没有）；③ `submit` 支持对象答案、`inventory` 道具校验（新错误码 4002）、重开清零 attempts、`elapsedMs` 缺省不清零最好成绩，通关返回 `unlocks`；④ `progress.save` 只接受 `unlocked`；⑤ 修复 D 反馈的 7 个 bug（join 并发、pull 分页 seq、getDoc 吞异常等）；⑥ 新增种子生成脚本 |
