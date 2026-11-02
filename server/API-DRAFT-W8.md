# 第 8 周新增接口设计草案 **v3.1**（口径已定稿 · C 起草）

> **v3.1 = v3 + 2026-11-02 敲定的 6 条口径**（见 §5）。写代码以此为准，不再改动。
> 已吸收 E《接口需求.md》（2026-11-02 马靖渝）。
> 核心修正：**把「双人保存退出 / 读取存档」和「断线重连」拆成两件事**，存档改为**跨房间持久化**。

---

## 0. 两个功能不是一回事

| | 断线重连 | **双人存档** |
|---|---|---|
| 触发 | 意外：掉线、切后台 | **主动：点退出**（退出即默认保存） |
| 房间还在吗 | **还在**（非房主退出 → `waiting`） | 可能关闭（房主退出 → `closed`） |
| 数据谁有 | 客户端内存里还在 | 必须**上传云端**才保得住 |
| 存活期 | 随房间消失 | **跨房间、跨会话长期保留** |
| 恢复时机 | 立刻回到同一局 | **两人再次组队时**，可选「继续上次的进度」 |
| 本草案方案 | 沿用 E 已实现的本地 `DuoSessionSnapshot`，第 8 周不做云端版 | **本草案 §2，第 8 周做** |

> **关键推论**：存档的键里**绝不能含 `roomCode`**，否则「房主退出 = 房间关闭」时存档就没了 ——
> 而「房主离开即关房」是 10-12 与 E 当面定稿的口径，不能为存档推翻它。

---

## 1. 通用约定

- 单云函数 `game`，入参 `{ action, params }`，出参 `{ ok:true, data }` / `{ ok:false, code, message }`
- `openid` 由云函数注入，客户端不传
- 新增集合权限一律 **「仅管理端可读写」**
- **不新增错误码**（§6）

---

## 2. FR-15 双人存档：`save.write` / `save.load` / `save.clear`

### 2.1 索引键：按「这一对玩家 + 这一关」

```
pairKey = 两个 openid 升序排序后 join('_')    // 保证 A+B 与 B+A 得到同一个 key
```

- 同一对玩家 + 同一关 → **一份存档**（覆盖更新）
- 换搭档 / 换关 → 自动是不同存档
- **与房间无关** → 房间关了存档还在

> 不把 openid 拼进 `_id`（两个 28 位 openid ≈ 60 字符，接近云开发 `_id` 长度限制）。
> 改用**服务端自动生成 `_id`**，`pairKey` 存普通字段，靠 `pairKey + levelId` 唯一索引查。

### 2.2 两个 openid 从哪来：`rooms.sessionPlayers`（**条件 1**）

`room.players` 会在玩家退出时移除成员。非房主先退 → `players` 只剩房主 → 房主再退出时
`pairKey` 无从得知。

> **`room.start` 时把当时房内两人的 openid 快照写进 `rooms.sessionPlayers: string[]`**。
> **`save.write` 一律用 `sessionPlayers` 算 `pairKey`，不读 `players`。**
> 房间关闭后 `rooms` 文档仍在（`status:'closed'`，不删），所以谁后存都能拿到。

### 2.3 按 openid 存，不按 viewId 存

房间规则是「**建房者 = 视角 A**」。两人再次组队时**谁建房不一定**，viewId 可能交换。
存档按 **openid** 索引，读取时各人取自己那份，视角怎么变都不受影响。

### 2.4 `saves` 集合

```ts
{
  _id: 自动生成,
  pairKey: 'oA_oB',                 // 排序后
  levelId: 'L05',
  elapsedSec: 1234,                 // 共享：两人中较大的那个
  players: [
    { openid: 'oA', progress: {...}, savedAt: 1764662400000 },
    { openid: 'oB', progress: {...}, savedAt: 1764662400000 }
  ],
  savedAt, updatedAt
}
```

索引：**`pairKey + levelId`（唯一）**

### 2.5 `save.write`

```ts
{
  code,                 // 房间码 → 服务端用 rooms.sessionPlayers 算 pairKey
  levelId,
  progress: {...},      // D 的 getSnapshot()，服务端不解析
  elapsedSec            // 本端已用时；服务端取两人中较大的
}
// → { savedAt, complete }    // complete = 两人的进度都到齐了
```

- **各人各调一次**（数据只在各自设备上，一方拿不到另一方完整 runtime 状态）
- 校验：房间存在(2001)；`sessionPlayers` 里必须有你（不在 → 2004）
- **不校验房间是否关闭** —— 房间关了也要能存完
- 服务端按 openid 定位 `players[]` 里自己的槽位，有则覆盖、无则 push
- `progress` 超过 64KB → 3001

**`progress` 字段（已定，只存 6 个）：**
`inventory[]` / `revealed[]` / `doneHotspots[]` / `wrongCount` / `stage` / `views{A,B}`

### 2.6 `save.load`

```ts
{ code, levelId }
// → { found: false }
// → { found: true, complete: true, elapsedSec, savedAt, mine: {...}, peerReady: true }
```

- **只返回自己那份 progress**（不把队友的线索/道具发给对方 —— 双视角信息差是核心玩法，存档也不能破这条）
- `found:false` 不是错误，返回 `ok:true`
- `complete:false` → E 显示「存档不完整」

### 2.7 `save.clear`

```ts
{ code, levelId }   // → { cleared: boolean }
```

- **通关时服务端自动清**（在 `level.submit` 通关分支里，防残留）
- 玩家侧**不给 UI 入口**（§5 条件 3）

### 2.8 倒计时：冻结，不是暂停

```
保存时  冻结 elapsedSec
读档后  走现成的 room.start（resumeAt = 服务端时间 + 3000ms，3 秒延迟逻辑完全复用）
剩余    = timeLimitSec * 1000 - elapsedSec * 1000     ← 客户端算
```

`timeLimitSec` 只在客户端配置里（`LevelTypes.ts:302`），服务端没有 —— 所以服务端
**只存和返回 `elapsedSec`，不给「剩余时间」**。

---

## 3. FR-14 玩家反馈（沿用 E 的实现）

### 3.1 `feedback.submit`

```ts
{
  category: 'bug' | 'stuck' | 'suggestion' | 'newmode',
  content: string,              // 5–300 字
  screenshotFileId: string,     // 云存储 feedback/ 目录；没传就是 ''
  context: { levelId, levelTitle, mode, viewId, page, roomCode, submittedAt },
  clientVersion: string
}
// → { feedbackId, createdAt }
```

- 服务端补：`openid`、`createdAt`、`status='open'`
- `submittedAt` 只存不校验，统计以 `createdAt` 为准
- 首版不做限流

### 3.2 `feedbacks` 集合

`openid` / `category` / `content` / `screenshotFileId` / `levelId` / `levelTitle` /
`mode` / `viewId` / `page` / `roomCode` / `clientVersion` / `submittedAt` / `createdAt` / `status`

索引：`createdAt` 倒序、`category`、`levelId`、`openid+createdAt`

### 3.3 `feedback.list`

**首版不做。** 后果（E 已确认）：界面上的「已提交」只是**本机回执**，换设备不显示。

---

## 4. FR-11 / FR-12 / FR-13 跨关收藏与彩蛋（`library`）

### 4.1 `library.add`

```ts
{
  levelId,
  clues: [{ itemId, name }],      // 通关时上报
  eggs:  [{ eggId, title }],      // 已定：发现瞬间就上报
  eggTotal: number
}
// → { clues: [...], eggs: [...], eggTotals: { L05: 3 } }
```

- **幂等**：`clues` 按 `(levelId, itemId)` 去重，`eggs` 按 `(levelId, eggId)` 去重 —— 重玩多次只算一次
- 可多次增量调用，服务端做并集
- `eggTotal` 覆盖写

### 4.2 `library.get`

```ts
// → { clues: [{itemId,name,levelId,collectedAt}],
//     eggs:  [{eggId,title,levelId,foundAt}],
//     eggTotals: { L05: 3 } }
```

登录后拉一次，E 用它替换本地 `PlayerLibrary.ts` 缓存 → **跨设备还原图鉴**。只返回自己的。

### 4.3 `libraries` 集合

`_id = openid`（一人一条），内含 `clues[]` / `eggs[]` / `eggTotals{}` / `updatedAt`。

### 4.4 不再单独提供 `egg.record` / `egg.list`

彩蛋并进 `library`，避免两条写入路径把同一彩蛋记成两份。

---

## 5. 已定口径（2026-11-02 敲定）

| # | 议题 | **结论** |
|---|---|---|
| 1 | 房间已关闭时 `save.write` 从哪拿两个 openid | **方案 A：房主先存、存完再退** |
| 2 | 读档入口 | 放**房间页**；`room.state` 顺带返回 **`hasSave` / `saveComplete`** |
| 3 | 读档后怎么开局 | **走现成的 `room.start`**，`elapsedSec` 作为挂载参数传给 D（`mountLevel.resume`） |
| 4 | 保存与退出是否合并 | **合并：退出即默认保存**（不做单独的「保存并退出」按钮） |
| 5 | `progress` 字段 | 只存 6 个；`selectedItemId` / `hintsUnlocked` / `cooldownUntilSec` **先不存** |
| 6 | 彩蛋上报时机 | **发现瞬间上报**（不等通关） |

### 「退出即默认保存」的三个配套条件（缺一就会掉数据）

**条件 1：`rooms.sessionPlayers`** —— 见 §2.2。没有它，先退的人一走 `pairKey` 就算不出来。

**条件 2：非房主被踢出时也要存一次**

房主退出 → 房间 `closed` → 非房主收到状态变化。此时**非房主必须先 `save.write` 再离开房间页**，
否则只有房主的进度进存档，另一半丢失。（服务端代存不了 —— progress 只在玩家自己的设备上。）

**条件 3：读档入口必须提供「重新开始」**

退出即保存后没有「放弃」入口，旧存档会一直留到通关。所以「继续上次的进度」旁边
**必须有「重新开始」**，否则玩家被旧进度锁死。（通关时服务端自动 `save.clear`，正常通关不残留。）

> `save.clear` 保留 API 但不给 UI；「重新开始」后下次退出会自然覆盖旧存档。

---

## 6. 错误码：不新增

| 场景 | 复用 |
|---|---|
| 缺参数 / `category` 不在枚举 / `content` 长度不对 / `progress` 超 64KB | **3001** |
| 房间不存在 | **2001** |
| 你不在本局的 `sessionPlayers` 里 | **2004** |
| 没有存档 | **不是错误**，`found: false` |

> 不新增 = E 的 `AppShellView.cloudErrorText` 零改动（`API.md:97` 明确要求新增错误码要同步那边）。

---

## 7. 新增集合与索引（**C 手工在控制台建**）

| 集合 | `_id` | 索引 |
|---|---|---|
| `feedbacks` | 自动生成 | `createdAt` 倒序、`category`、`levelId`、`openid+createdAt` |
| `libraries` | `openid` | 无需（按主键查） |
| `saves` | 自动生成 | **`pairKey + levelId`（唯一）** |

权限全部「仅管理端可读写」。

**`rooms` 文档新增字段**：`sessionPlayers: string[]`（`room.start` 时写入）

---

## 8. 第 8 周不做：`room.sync` 聚合、断线重连云端版

- **`room.sync`**（E §6：`room.state`/`heartbeat`/`event.pull` 三合一）→ 需 C/D/E 三方同时改，排**第 9—10 周**
- **断线重连云端版**（房间级 `room.saveSession`）→ 第 8 周**沿用 E 已实现的本地 `DuoSessionSnapshot`**
  （只恢复关卡/视角/计时，已够演示）。第 9 周若发现换设备不够用再补。

---

## 9. 排期（C 侧）

| 时间 | 事项 |
|---|---|
| 11/2（今天） | 口径定稿 → 写代码 |
| 11/4 | `actions/feedback.ts`、`actions/library.ts`、`actions/save.ts` + `room.ts` 加 `sessionPlayers`/`hasSave` + `index.ts` 注册 + `API.md` |
| 11/4 | 控制台建 3 个集合 → `tsc --noEmit` 校验 → 部署云函数 |
| 11/5 | 配合 D / E 联调 |
| 11/6 | 中期检查 |
