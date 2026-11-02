# 第 8 周新增接口 · **最终定稿**

> **状态：已冻结，2026-11-02 晚确认，C 已实现并推送（`1196328`）。**
> 给 D / E 看这一份即可；过程中的草案 `API-DRAFT-W8.md`（v1–v3.1）已删除，不要拿它来对字段。
> **D 此前给的四块建议（room.sync / 快照 session / egg 独立 / library 延后）本次全部不采纳**，
> 理由见 §6。正式接口契约见 `server/API.md` v3.3。

---

## 1. 已定口径（6 条，不再改）

| # | 议题 | 结论 |
|---|---|---|
| 1 | 房间已关闭时 `save.write` 从哪拿两个 openid | **方案 A：房主先存、存完再退** |
| 2 | 读档入口 | 放**房间页**；`room.state` 顺带返回 `hasSave` / `saveComplete` |
| 3 | 读档后怎么开局 | **走现成的 `room.start`**，`elapsedSec` 作为挂载参数传给 D（`mountLevel.resume`） |
| 4 | 保存与退出是否合并 | **合并：退出即默认保存**，不做单独的「保存并退出」按钮 |
| 5 | `progress` 字段 | 只存 6 个：`inventory[]` / `revealed[]` / `doneHotspots[]` / `wrongCount` / `stage` / `views{A,B}`；`selectedItemId` / `hintsUnlocked` / `cooldownUntilSec` **先不存** |
| 6 | 彩蛋上报时机 | **发现瞬间上报**；彩蛋**并进 `library`**，不单独开 `egg.*` |

---

## 2. 两个功能不是一回事

| | 断线重连 | 双人存档 |
|---|---|---|
| 触发 | 意外掉线 / 切后台 | **主动点退出**（退出即默认保存） |
| 房间还在吗 | 还在（非房主退出 → `waiting`） | 可能关闭（房主退出 → `closed`） |
| 数据 | 客户端内存里还有 | 必须上传云端 |
| 存活期 | 随房间消失 | **跨房间、跨会话长期保留** |
| 恢复 | 立刻回到同一局 | 两人再次组队时，可选「继续上次的进度」 |
| 方案 | 沿用 E 已实现的本地 `DuoSessionSnapshot`，W8 不做云端版 | **本次实现** |

> 存档的键里**绝不能含 `roomCode`**，否则房主一退房间关闭，存档就没了。

---

## 3. 三个接口

### 3.1 `feedback.submit`（FR-14）

载荷**完全沿用 E 已写好的 `Feedback.ts`**，字段一个没改：

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

服务端补 `openid` / `createdAt` / `status='open'`。`submittedAt` 只存不用，统计以 `createdAt` 为准。
**首版不做 `feedback.list`** —— 界面上的「已提交」只是本机回执，换设备不显示（E 已确认可接受）。

### 3.2 `library.get` / `library.add`（FR-11 / FR-12 / FR-13）

```ts
library.add({ levelId, clues: [{itemId,name}], eggs: [{eggId,title}], eggTotal })
// → { clues, eggs, eggTotals: { L05: 3 } }     // 合并后的全量

library.get()
// → { clues: [{itemId,name,levelId,collectedAt}],
//     eggs:  [{eggId,title,levelId,foundAt}],
//     eggTotals: { L05: 3 } }
```

- **幂等**：按 `(levelId,itemId)` / `(levelId,eggId)` 去重，一关重玩多次只算一次
- 可多次增量调用（发现彩蛋调一次、通关再调一次），服务端做并集
- `library.get` 登录后拉一次，E 用它替换本地 `PlayerLibrary.ts` 缓存 → 跨设备还原图鉴
- **彩蛋不单独开 `egg.record` / `egg.list`** —— 避免两条写入路径把同一彩蛋记成两份

### 3.3 `save.write` / `save.load` / `save.clear`（FR-15）

```
pairKey = 两个 openid 升序排序后 join('_')      // 保证 A+B 与 B+A 一致
索引键 = pairKey + levelId                       // 不含 roomCode
```

```ts
save.write({ code, levelId, progress, elapsedSec })   // 各人各调一次
// → { savedAt, complete }

save.load({ code, levelId })
// → { found: false }
// → { found: true, complete, elapsedSec, savedAt, mine, peerReady }
//    mine 只含自己的 progress，不发队友的线索/道具

save.clear({ code, levelId })  // → { cleared }
```

- 两个 openid 来自 **`rooms.sessionPlayers`**（`room.start` 时快照），不读 `players`
  （`players` 会在玩家退出时移除成员，先退的人一走就凑不齐）
- **按 openid 存，不按 viewId 存** —— 再次组队时谁建房不一定，viewId 可能交换
- `save.write` **不校验房间是否已关闭**，否则房主一退另一半进度就丢了
- `found:false` 不是错误，返回 `ok:true`
- **通关时服务端自动清存档**（`level.submit` 两条通关分支，失败不影响通关结果）
- 倒计时 = **冻结**，不是暂停：存档冻结 `elapsedSec`，读档后走 `room.start`

---

## 4. 需要 E 配合的三件事（缺一就会掉数据）

1. **房主先存、存完再退**：房主点退出时先 `save.write` 成功，再 `room.leave`。
2. **非房主被踢出时也要存一次**：房主退出 → 房间 `closed` → 非房主收到状态变化后，
   **必须先 `save.write` 再离开房间页**，否则只有房主那半进度进存档。
   （服务端代存不了 —— progress 只在玩家自己的设备上。）
3. **读档入口必须有「重新开始」**：退出即保存后没有「放弃」入口，旧存档会留到通关，
   不给「重新开始」玩家就被旧进度锁死。

> `complete:false`（只有一人存过）→ 显示「存档不完整」，两人重新进一次关卡再退出即可补齐。

## 5. 需要 D 配合的两件事

1. `mountLevel` 支持 `resume`（E《接口需求.md》§3.4 已提），把 `elapsedSec` 传进去。
2. 通关后由客户端调 `progress.save` 落 `unlocked`（沿用现有口径，`API.md` §4 进度小节）。

---

## 6. 明确不采纳 D 旧建议的条目（**给 D 看**）

| D 的建议 | 不采纳的理由 |
|---|---|
| ① `room.sync` 纳入 W8、房间关闭返回 2003、`lastSeq` 用房间全局游标 | W8 只到 11/6，需 C/D/E 三方同时改，排 **W9–10**；2003 与 `API.md:292`「closed 仍返回 200」冲突；全局 `lastSeq` 会跳事件（`event.ts:88-90` 有明确注释），且 E §6.1 也写「本页末条」 |
| ② 房主转移、房主离开不销毁房间、session 随房间关闭/超时清理、暂停/停表/`resumeClock`/`elapsedMs`、`roundId` | 与定稿「**房主 = 建房者永不变；房主离开 = 房间 closed**」硬冲突；且把「断线重连」和「双人存档」混成了一套。本次存档按 §3.3 的跨房间方案实现 |
| ③ 彩蛋独立 `egg.list` / `egg.record` | 本次**并进 `library`**，避免两条写入路径 |
| ④ `library` 延后 W9 | 本次 **W8 做**，E《接口需求.md》§2.2 明确需要它（FR-11 图鉴跨设备） |

**保留不变**：`room.sync` 仍按 E §6 单独讨论，W9–10 再排；断线重连 W8 沿用 E 本地方案。

---

## 7. 部署清单（C 执行）

- [ ] 云开发控制台建 3 个集合：`feedbacks` / `libraries` / `saves`，权限一律「仅管理端可读写」
- [ ] 索引：`feedbacks` 建 `createdAt` 倒序、`category`、`levelId`、`openid+createdAt`；`saves` 建 **`pairKey + levelId` 唯一**
- [ ] `npm run build` 重新编译（`.js` 产物不入库）
- [ ] 上传部署云函数 `game`（勾「云端安装依赖」）
- [ ] `level.03/04/05.json` 有改动 → 重跑 `node server/seeds/build-seed.js` 并 Upsert 导入 `levels`

## 8. 已落地

- 代码：`actions/feedback.ts`、`actions/library.ts`、`actions/save.ts`；
  `room.ts` 加 `sessionPlayers` + `hasSave`/`saveComplete`；`level.ts` 通关自动清存档；
  `shared/db.ts` 加集合常量与 `savePairKey()`；`index.ts` 注册 6 个 action
- 校验：`tsc -p tsconfig.json --noEmit` → `BUILD_EXIT=0`
- 提交：`1196328`，已推分支 C
- 契约：`server/API.md` **v3.3** 已同步
