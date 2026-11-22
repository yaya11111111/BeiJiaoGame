# `room.sync` 接入说明（给 D 和 E）

日期：2026-11-13　｜　服务端：**已就绪**（云函数 `game` 的 `room.sync` 已注册，`API.md` v3.5）
　｜　客户端：**待 D / E 各自改**

> 一句话：**把「房间快照 + 事件增量 + 在线状态」合并成一次云调用**，替掉现在并排跑的三条定时器。
> 服务端行为是 `room.state` + `room.heartbeat` + `event.pull` 的**并集**，不引入任何新语义。

> **行号说明（2026-11-13 补）**：文中的行号是按 **C 分支**（`535b65d`）的代码写的。
> main 上 D 改过 `LevelSync.ts`（+83 行）、E 改过 `AppShellView.ts`（+541 行），
> 行号会全对不上 —— **一律按方法名定位**：
> `LevelSync.pull` / `LevelSync.pullAll` / `LevelSync.tick`、`AppShellView.update` /
> `syncRoomState` / `invalidateRoomStateRequest` / `closeRoomAndReturnHome`。

---

## 0. 为什么改（别跳过）

现状（2 人、房间页 60 秒、关卡 300 秒一局）：

| 阶段 | 现在 | 调用次数/局 |
|---|---|---|
| 房间页 | `room.state` 0.5 秒 + `room.heartbeat` 10 秒 | 240 + 12 = 252 |
| 关卡内 | `event.pull` 1 秒 | 600 |
| 其他（建房/入房/存档/答题） | — | ~30 |
| **合计** | | **~880 次/局** |

云函数免费额度是 **20 万次/月**，按每天 20 局算是 600 局/月 → **53 万次**，超了 2.6 倍。
而且 `room.state` 每 0.5 秒还要顺手查两遍 `progress`（算双人可玩交集）和一遍 `saves`，
读配额也被同一件事重复消耗。

改完的账（服务端已做的优化 + 客户端按本文档降频）：

| 阶段 | 改后 | 调用次数/局 |
|---|---|---|
| 房间页 | `room.sync` 自适应 1.2→5 秒 | ~48 |
| 关卡内 | `room.sync` 活跃 1.2 / 静默 2.5 秒 | ~300 |
| 其他 | — | ~30 |
| **合计** | | **~380 次/局（−57%）** |

**但注意：这个降幅里有一半要靠 D 把关卡内的间隔从固定 1 秒改成自适应。**
如果关卡内还是死守 1 秒/次，总量只有 ~580 次/局（−34%），月度还是 35 万，照样超额。
换句话说：**E 的改动决定房间页，D 的改动决定总量。**

---

## 1. 接口速查（详细契约见 `API.md` §room.sync）

```ts
cloudApi.call('room.sync', { code: 'AB3K9Q', sinceSeq: 42 })
// →
{
  room: {
    code, levelId, status, myViewId, isHost, startedAt, serverNow,
    hasSave, saveComplete, playableLevelIds,
    players: [{ nickname, viewId, online }],
  },                                     // 和 room.state 的返回完全一致
  events: [{ seq, levelId, type, senderId, ts, payload }],   // seq 升序，最多 100 条
  lastSeq: 42,                           // 本页最后一条的 seq；空页 = 你传进来的 sinceSeq
  hasMore: false,                        // true = 后面还有，立刻用 lastSeq 再调一次
}
```

四条**不能想当然**的约定：

1. **`sinceSeq` 必填**（`>= 0` 的数字），缺了报 `3001`。
   首次传 `0`；之后用上一次返回的 `lastSeq`。**不要**图省事传房间的全局 `lastSeq`，那会静默跳过中间事件。
2. **`lastSeq` 是本页最后一条的 seq，不是全局值**。空页时它等于你传进来的 `sinceSeq`（游标不会跳）。
3. **事件不按 `levelId` 过滤**，返回整个房间的流水。原因见 §5 坑 1。
4. **房间关闭不报错**：`200` + `room.status === 'closed'`。必须自己处理退房分支，
   **不要当成错误重试**（会卡死在房间页）。

错误码：`2001` 房间不存在 / `2004` 你不在这个房间 / `3001` 参数不合法（含 `sinceSeq` 缺失）。**不会**因为关闭而报 `2003`。

服务端顺带做的两件写操作（客户端**不用再发心跳**）：

| 副作用 | 频率 | 说明 |
|---|---|---|
| 刷新调用者的 `lastSeenAt` | 最多 10 秒一次 | 10 秒内重复调用只改返回值、不写库。30 秒没刷新，对面看到你离线 |
| 缓存双人可玩交集 | 15 秒一次 | 已知副作用：好友刚解锁的新关，选关列表最多晚 15 秒出现 |

---

## 2. E 要做的（房间页 / 结算页）

涉及 `client/assets/scripts/common/CloudApi.ts` 与 `client/assets/scripts/ui/AppShellView.ts`。
行号是**现在**的，改完会漂，按方法名找。

### 2.1 `CloudApi.ts`：加一个方法（放在 `pull()` 附近，:269）

先加个类型（放在 `RoomSnapshot` 定义旁边）：

```ts
/** room.sync 的返回：房间快照 + 一页事件 */
export interface RoomSyncPage {
  room: RoomSnapshot;
  events: RoomEvent[];
  /** 本页最后一条的 seq；空页等于入参 sinceSeq */
  lastSeq: number;
  /** true = 后面还有，立刻用 lastSeq 再调一次 */
  hasMore: boolean;
}
```

```ts
  /**
   * 房间 + 事件的聚合拉取。取代 room.state + room.heartbeat + event.pull 三条定时器。
   * `sinceSeq` 必填：首次传 0，之后用上次返回的 lastSeq。
   * `room.status === 'closed'` 时**不报错**，调用方必须自己处理退房。
   */
  syncRoom(code: string, sinceSeq: number): Promise<RoomSyncPage> {
    return this.call<RoomSyncPage>('room.sync', { code, sinceSeq });
  }
```

> 注意 `call<T>` 的泛型必须显式写（`CloudApi.ts:210` 的签名是 `async call<T>(...)`，
> T 只出现在返回值位置，不写会推成 `unknown` 导致编译不过）。

> `pull()`（:269）、`getRoomState()`（:304）、`heartbeatRoom()`（:316）**都先留着**，
> 等双机验收通过再删。`heartbeatRoom` 请标 `@deprecated` 并注明「lastSeenAt 已由 room.sync 刷新」。

### 2.2 `AppShellView.ts`：字段（加在 :193 后面）

```ts
  // —— room.sync 聚合轮询（2026-11-13）——
  /** 事件游标。换房间要归零，同一房间重连要保留 */
  private syncSeq = 0;
  /** syncSeq 属于哪个房间码；和当前房间不一致就自动重置游标 */
  private syncSeqRoomCode: string | null = null;
  /** 当前轮询间隔（秒），由连续「无变化」轮数决定 */
  private syncIntervalSec = 1.2;
  private syncIdleRounds = 0;
```

**游标归属要按房间码判断，不要按「进出房间页」判断**：进出房间页时房间没变，游标必须保留，
否则每次切页都会把整条流水重拉一遍。

### 2.3 `AppShellView.ts`：`update()` 里合并两条定时器（现在 :284-299）

删掉心跳整段（:289-293），把 state 那段换成：

```ts
    this.roomStateSyncElapsed += dt;
    this.enterRoomWhenStartTimeArrives();
    if ((this.state.page === 'room' || this.state.page === 'result')
        && this.roomStateSyncElapsed >= this.syncIntervalSec
        && this.roomStateRequestCode !== code) {
      this.roomStateSyncElapsed = 0;
      this.roomStateRequestCode = code;
      void this.syncRoom(code, ++this.roomStateRequestGeneration);
    }
```

> 后台停轮询的逻辑（`update()` 开头 `if (this.appHidden) return;`，:280）**保持不变**，它本来就对。

### 2.4 `AppShellView.ts`：`syncRoomState`（:312-338）改名改造

```ts
  private async syncRoom(code: string, generation: number): Promise<void> {
    try {
      if (this.syncSeqRoomCode !== code) {
        this.syncSeqRoomCode = code;
        this.syncSeq = 0;
      }
      const page = await this.cloudApi!.syncRoom(code, this.syncSeq);
      if (generation !== this.roomStateRequestGeneration) return;
      if ((this.state.page !== 'room' && this.state.page !== 'result')
          || this.state.room?.inviteCode !== code) return;

      this.syncSeq = page.lastSeq;              // 只推进游标，**不追 hasMore**（见下方警告）
      if (page.room.status === 'closed') {
        this.closeRoomAndReturnHome();
        return;
      }

      const previousRoom = this.state.room;
      const clearedError = this.roomStateErrorText !== '' && this.noticeText === this.roomStateErrorText;
      if (clearedError) this.noticeText = '';
      this.roomStateErrorText = '';
      this.applyRoomSnapshot(page.room);
      if (clearedError && this.state.room && !roomPresentationChanged(previousRoom, this.state.room)) this.render();

      // 自适应降频：有事件 / 快照有变化 → 立刻回到 1.2 秒；连续安静才慢慢退
      const changed = page.events.length > 0 || roomPresentationChanged(previousRoom, this.state.room);
      this.syncIdleRounds = changed ? 0 : this.syncIdleRounds + 1;
      this.syncIntervalSec = this.syncIdleRounds >= 8 ? 5 : this.syncIdleRounds >= 4 ? 3 : 1.2;
    } catch (error) {
      if (generation !== this.roomStateRequestGeneration) return;
      if ((this.state.page !== 'room' && this.state.page !== 'result')
          || this.state.room?.inviteCode !== code) return;
      const message = this.cloudErrorText(error, '房间状态同步失败。');
      if (message !== this.roomStateErrorText || this.noticeText !== message) {
        this.roomStateErrorText = message;
        this.noticeText = message;
        this.render();
      }
    } finally {
      if (generation === this.roomStateRequestGeneration) this.roomStateRequestCode = null;
    }
  }
```

> ⚠️ **E 不要追 `hasMore`。** 房间页不消费事件，追页只会在切回房间页时连打好几次云函数。
> 游标按 `lastSeq` 慢慢往前爬就够了，每条最多多传 100 行。**追 `hasMore` 是 D 的责任。**
>
> 另外 `syncIntervalSec` 只在页面停留期间有效，切页不用重置；但**回前台**那一处要重置（见 2.6）。

### 2.5 `AppShellView.ts`：删掉心跳

- 删 `syncRoomHeartbeat`（:302-310）整个方法
- 删字段 `roomHeartbeatRequestCode` / `roomHeartbeatRequestGeneration`（:190、:192）
- 同步删掉 `invalidateRoomStateRequest`（:662-668）里对这两个字段的重置，否则编译报错
- `onShow` 里（:1938-1942）删掉 `roomSyncElapsed = 999` 和 `roomHeartbeatRequestCode = null`，
  改成：

```ts
        this.roomStateSyncElapsed = 999;   // 回前台立刻补一次
        this.syncIntervalSec = 1.2;        // 顺便退出降频状态
        if (this.cloudRoom && this.state.room && (this.state.page === 'room' || this.state.page === 'result')) {
          this.roomStateRequestCode = null;
        }
```

- `closeRoomAndReturnHome()`（:676-677）里 `roomSyncElapsed` 相关两行删掉，保留
  `this.roomStateSyncElapsed = 0;`，并加一行 `this.syncSeqRoomCode = null;`（下一个房间重新从 0 起）

### 2.6 E 的验收点

- 两个设备：A 建房 → B 加入 → 双方 3 秒内看到对方昵称和在线状态
- 房主点「开始」→ 另一方 2 秒内自动进关卡
- 房主退出 → 另一方 **2 秒内**回首页，不能卡在房间页
- 切后台 30 秒再回来 → 立刻补一次同步，能看到期间发生的变化
- 房间页停留 1 分钟，云开发控制台里 A 的调用数 **≤ 60 次**（原来约 130 次）
- **房间页停留期间，控制台里不应再出现 `room.heartbeat` 调用**

---

## 3. D 要做的（关卡内）

涉及 `client/assets/scripts/common/CloudApi.ts`（复用 E 加的 `syncRoom`）和
`client/assets/scripts/level/LevelSync.ts`。

### 3.1 改 `pull()`（LevelSync.ts:324-353）

只改**取数**和**翻页判断**两处，处理事件的循环体一行都不用动：

```ts
  private async pull(): Promise<void> {
    this.inFlight = true;
    try {
      let more = true;
      while (more && !this.stopped) {
        const page = await this.cloud.syncRoom(this.roomCode, this.sinceSeq);
        if (this.stopped) return;

        // 房主走了 = 房间关闭。以前关卡内根本感知不到，队友会一直卡在关卡里
        if (page.room.status === 'closed') {
          this.onPeerLeft();
          return;
        }

        let received = 0;
        for (const raw of page.events ?? []) {
          received += 1;
          this.sinceSeq = Math.max(this.sinceSeq, raw.seq);   // 保持原有逐条推进的语义
          if (raw.payload?.levelId !== this.levelId) continue;
          if (raw.type === LEAVE) { this.onPeerLeft(); continue; }
          if (raw.type === START || raw.type === CLOSE) continue;
          const event = toSyncEvent(raw);
          if (event) this.onRemote(event);
        }
        more = page.hasMore;                                   // 原来是 events.length >= 200 去猜
        this.idleRounds = received > 0 ? 0 : this.idleRounds + 1;
      }
      this.intervalSec = this.idleRounds >= 6 ? 2.5 : 1.2;
    } catch (error) {
      this.onWarn('[LevelSync] 拉取失败（不影响本地游玩）', error);
    } finally {
      this.inFlight = false;
    }
  }
```

新增两个字段（:164 附近）：

```ts
  /** 连续几轮没收到任何事件。用来把间隔从 1.2 秒退到 2.5 秒 */
  private idleRounds = 0;
  /** 当前拉取间隔（秒）。有新事件立刻回到 ACTIVE_INTERVAL_SEC */
  private intervalSec = ACTIVE_INTERVAL_SEC;
```

常量（替换 :33 的 `PULL_INTERVAL_SEC` 和 :39 的 `PULL_PAGE_SIZE`）：

```ts
/** 有人在动的时候的间隔。点击解谜对这个延迟完全不敏感 */
const ACTIVE_INTERVAL_SEC = 1.2;
/** 连续 6 轮（约 8 秒）没有任何事件 → 认为对面在思考，退到 2.5 秒 */
const IDLE_INTERVAL_SEC = 2.5;
const IDLE_ROUNDS_BEFORE_SLOW = 6;
```

`tick()`（:272-289）里把 `PULL_INTERVAL_SEC` 换成 `this.intervalSec`。
`send()`（:227）和 `begin()` 成功后各加一行 `this.intervalSec = ACTIVE_INTERVAL_SEC;`——
本地刚操作完，对面大概率马上回应，别让它在 2.5 秒的慢档上等。

### 3.2 `pullAll()` **不要动**，继续用 `event.pull`

这一条容易想当然：既然有 `room.sync` 了，探测也顺手换掉吧 —— **别换**。

```ts
  // pullAll 保持原样，继续走 event.pull（200 条/页）
  private async pullAll(): Promise<RoomEvent[]> {
    const all: RoomEvent[] = [];
    let cursor = 0;
    let more = true;
    while (more) {
      const page = await this.cloud.pull({ code: this.roomCode, sinceSeq: cursor });
      const events = page.events ?? [];
      for (const event of events) all.push(event);
      if (events.length > 0) cursor = page.lastSeq;
      more = events.length >= PULL_PAGE_SIZE && cursor > 0;
    }
    return all;
  }
```

三条理由：

1. **`room.sync` 的页是 100，`event.pull` 是 200。** `pullAll` 每次进关卡都要把整条房间
   流水从 `seq=0` 扫到尾，页大小砍一半就是**往返次数翻倍**。房间活得越久越明显。
2. **它是一次性调用，不参与降频。** 合并调用省的是「每秒一次」的那种开销，这里一天也发生不了几次。
3. **`pullAll` 不关心房间快照和在线状态**，要的只是事件列表，多拿两个字段没有收益。

> 唯一的硬要求还是那条：**必须把整条流水扫完**。少拉一页，`begin()` 里
> `all.find(e => e.payload?.runId === runId)` 就可能找不到本轮第一条，
> 回到「一进新关就通关」那个老 bug（2026-10-10 实测踩过）。

### 3.3 `sinceSeq` / `lastSeq` / `hasMore` 的分工（别记反）

| 方法 | 走哪个接口 | 游标怎么推进 | 追 `hasMore` 吗 |
|---|---|---|---|
| `pull()` 增量 | **`room.sync`** | 逐条 `Math.max`（保持原状，异常时最多重放当前页） | **要**，丢一条操作对面就少一次动作 |
| `pullAll()` 探测 | **`event.pull`**（不动） | `cursor = page.lastSeq` | 靠 `length >= 200` 判断，与现在一致 |
| E 的房间页 | **`room.sync`** | `this.syncSeq = page.lastSeq` | **不要**，E 不消费事件 |

### 3.4 测试要跟着改

`client/tests/levelSync.test.ts:44` 和 `client/tests/duoRoom.test.ts:87` 里的内存假服务端
只实现了 `event.pull`。D 改完 `LevelSync` 后这两个用例会全挂，需要在假服务端里加分支：

```ts
if (action === 'room.sync') {
  const sinceSeq = params.sinceSeq as number;
  const all = events.filter((e) => e.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  const page = all.slice(0, 100);
  return {
    room: { status: 'playing', levelId, players: [], isHost: false, myViewId: 'A', startedAt: 0, serverNow: Date.now() },
    events: page,
    lastSeq: page.length ? page[page.length - 1].seq : sinceSeq,
    hasMore: all.length > 100,
  };
}
```

### 3.5 D 的验收点

- 双人进关：A 拿道具 → B 侧 2 秒内看到（原来 1 秒下限，现在是**最坏 2.5 秒**，请确认验收标准）
- 一方通关 → 另一方 2.5 秒内弹结算（那条 `result` 走的是 publish，不受拉取间隔影响）
- 房主中途退出 → 另一方**在关卡内就能收到**并回房间（这是新能力，以前感知不到）
- 对面挂机 60 秒，云开发控制台里本机调用数约 25 次（原来 60 次）
- 断网 20 秒恢复 → 中间的操作全部补齐，且**不重放上一局的通关**

---

## 4. 谁在什么时候跑定时器

| 页面 | 跑谁的定时器 | 间隔 | 游标 |
|---|---|---|---|
| 房间页 `room` | E（`AppShellView`） | 1.2 → 3 → 5 秒 | E 的 `syncSeq` |
| 结算页 `result` | E | 同上 | E 的 `syncSeq` |
| 关卡内 `level` | D（`LevelSync`） | 1.2 / 2.5 秒 | D 的 `sinceSeq`（**自己探测，不由 E 交接**） |

**不会出现两个定时器同时跑**：E 的轮询条件本来就限定 `page === 'room' || page === 'result'`（:294），
D 的 `LevelSync` 只在关卡挂载期间 `tick`。两边**不需要交接游标** ——
D 的 `begin()` 会重新 `pullAll` + `currentRunStartSeq` 自己算出本轮起点，这是刻意的设计。

---

## 5. 五个坑（都踩过，别再来一次）

1. **别让服务端按 `levelId` 过滤事件。**
   D 在 `280720d` 之后把「本轮」判定换成了 `startedAt` 当 `runId`，新路径确实只关心本关事件；
   但 `LevelSync.begin()` 里还留着**未传 `runId` 的旧入口 fallback**，那条走的仍是
   `currentRunStartSeq`，要从**跨关**的 `result` / `close` 找边界。服务端一旦只回本关事件，
   旧入口会把上一轮的 `start` 当本轮起点 → 重放旧 `result` → **一进新关立刻通关**（2026-10-10 实测）。
   而且 `pullAll` 本来就要扫整条流水。过滤留在客户端（`pull()` 里已有
   `payload.levelId !== this.levelId` 和 `payload.runId !== this.runId` 两道）。

2. **别把 `lastSeq` 当成"房间最新序号"用。**
   它是**本页最后一条**的 seq。拿它当"跳到最新"会跳过一页之外没拉到的中间事件，
   症状是「对面偶尔少做一步」。

3. **别把 `closed` 当错误。**
   `room.sync` 对已关闭房间返回 `200`。当成错误重试 → 卡在房间页 / 卡在关卡里。

4. **别保留心跳。**
   `room.sync` 已经在刷 `lastSeenAt`。两边都写 `players` 数组只是白烧调用次数，
   而且整数组覆盖还可能互相把对方的时间戳盖回旧值。

5. **别用 `events.length` 和页大小比较来判断有没有下一页。**
   页大小从 200 变成了 100，`hasMore` 才是权威值。写死 200 会漏拉。

---

## 6. 联调顺序与回滚

1. **服务端先发**（已就绪）→ 老客户端完全不感知，`room.state` / `room.heartbeat` / `event.pull` 都还在
2. E 先改房间页 → 双机验证房间流程（这条链路用户最多，先保它）
3. D 再改关卡内 → 双机验证同步
4. 两边都稳定一个版本后，才讨论删 `room.heartbeat`

**回滚**：客户端把 `syncRoom(...)` 换回 `getRoomState(...)` 即可，服务端不用动。
`room.sync` 往房间文档里多写的 `playableCache*` 三个字段老代码不读，**不需要清数据**。
