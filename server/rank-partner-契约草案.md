# 排行榜 & 双人搭档档案 —— 接口契约草案（v0.1）

日期：2026-11-13　｜　作者：C　｜　状态：**草案，未定稿**
对接人：**D**（计分规则 + 上报字段）、**E**（展示页）

> 这份文档是为了让 D 和 E 能在 11/20 之前开工而先冻结"形状"。
> **字段名可能要改**：计分规则 D 11/17 才交，规则一变，`score` 的算法和部分字段会跟着动。
> 所以：**E 先按本文搭页面骨架，不要把字段名硬编码到 UI 里**；D 看完 §2 的问题清单再动手。
> 定稿后我会把内容并进 `server/API.md`。

---

## 1. 一句话说清分工边界

| 角色 | 负责 | **不**负责 |
|---|---|---|
| D | 计分规则、把 `hintsUsed` / `eggsFound` 报上来 | 排序、存储、榜单分页 |
| C | 存原始指标、算 `score`、排行榜与搭档档案的查询接口 | 决定分数怎么算、页面怎么画 |
| E | 榜单页、搭档档案页、再次邀请入口 | 自己算名次、自己算分数 |

**核心原则：客户端上报"发生了什么"，服务端决定"值多少分、排第几"。**
D 只在 `level.submit` 里多传两个计数，不要在客户端算好分数再传上来——排行榜一旦能被客户端直接写分数，这个功能就没有意义了。

---

## 2. 需要 D 先确认的 5 件事（**阻塞项**）

| # | 问题 | 为什么要 C 现在问 | 我的建议 |
|---|---|---|---|
| 1 | `hintsUsed`（本局用了几次提示）和 `eggsFound`（本局发现了几个彩蛋）怎么算？由谁统计？ | 服务端现在**只有** `bestTimeMs` 和 `attempts`，这两个数一个都没记录。计分公式里占两项，没有它俩公式永远算出 0 | 由 D 的运行时统计，`level.submit` 时作为可选参数传上来 |
| 2 | 分数**越高越好**还是越低越好？ | 决定榜单按 `score` 升序还是降序排、以及"我的名次"怎么算 | 建议越高越好（用时越短、提示越少、彩蛋越多 → 分越高），失败局不计分 |
| 3 | 单人和双人要**分开两个榜**吗？ | 双人局两人共享一次通关，混在一个榜里会被双人刷榜 | 建议 `mode` 必传，榜单按 `mode` 分开查，E 用两个 Tab |
| 4 | 同分怎么排？ | 必须有确定性的 tie-break，否则翻页会重复/漏项 | 建议：同分 → 用时短者优先 → 再按达成时间早者优先 |
| 5 | 只有**正式关卡**计分，`GUIDE` 不进榜，对吗？ | 引导关没有可比性，混进去榜单会很怪 | 建议排除 `GUIDE` |

> 上面 5 条如果你（D）有不同意见，**先改这张表再动手**，别直接写代码。

---

## 3. 排行榜

### 3.1 数据模型：`scores` 集合

**一人 · 一关 · 一模式 只保留最好的一条**（重玩变好就覆盖，变差不覆盖）。
这样榜单天然每人一行，不用在查询时去重，也不会随重玩次数无限增长。

```jsonc
{
  "_id": "openid_L01_solo",     // 固定拼法，保证唯一
  "openid": "oXXXX",
  "levelId": "L01",
  "mode": "solo",               // "solo" | "duo"
  "score": 862,                 // 服务端算，越高越好
  "timeMs": 183000,             // 本局用时（原始指标，不覆盖 bestTimeMs）
  "hintsUsed": 1,               // 原始指标
  "eggsFound": 2,               // 原始指标
  "partnerOpenid": "",          // mode=duo 时填，solo 为空
  "roomCode": "AB3K9Q",         // mode=duo 时留痕，便于排查
  "scoreRuleVersion": 1,        // 计分公式版本，改规则时 +1，不动历史数据
  "clearedAt": 1762900000000,
  "updatedAt": 1762900000000
}
```

要点：

- **`_id` 固定拼 `openid_levelId_mode`**，用 `set()` 覆盖写，天然幂等
- `bestTimeMs` 还留在 `progress` 里（它服务"我的记录"和关卡列表），`scores.timeMs` 是**本局**用时；两者不冲突，别合并
- `scoreRuleVersion` 是为了以后改公式时能区分"旧数据按旧规则算的"，不至于悄悄失真

### 3.2 `level.submit` 的增量（**向后兼容**）

D 只需要在现有入参里加两个**可选**字段：

```jsonc
{
  "levelId": "L01",
  "answer": [...],          // 原有
  "inventory": [...],       // 原有
  "elapsedMs": 183000,      // 原有
  "code": "AB3K9Q",         // 原有（双人必传）

  "hintsUsed": 1,           // ← 新增，可选，缺省 0
  "eggsFound": 2            // ← 新增，可选，缺省 0
}
```

- 两个字段都 `>= 0` 的整数，服务端会 `Math.floor` + 上限截断（`hintsUsed ≤ 99`、`eggsFound ≤ 99`），脏数据不会污染榜单
- **老客户端不传 → 按 0 记录**，不会报错，也不会让接口失败
- 返回值**增加两个字段**（原有字段一个不动）：

```jsonc
{
  "correct": true, "failed": false, "remainAttempts": null, "bestTimeMs": 183000, "unlocks": [...],
  "score": 862,             // ← 新增：本局得分（失败局为 null）
  "rank": 7,                // ← 新增：本局提交后的名次；未上榜/失败为 null
  "isNewBest": true         // ← 新增：这一局有没有刷新自己的最好成绩
}
```

> `rank` 顺手返回，E 的结算页可以直接显示"本关第 7 名"，不用再单独查一次。

### 3.3 `rank.level` —— 某关榜单

```jsonc
// 请求
{ "levelId": "L01", "mode": "solo", "limit": 50 }
// 响应
{
  "levelId": "L01",
  "mode": "solo",
  "total": 128,                    // 该榜总人数
  "list": [
    { "rank": 1, "nickname": "阿岚", "avatarUrl": "https://...", "score": 951, "timeMs": 152000, "isMe": false },
    { "rank": 2, "nickname": "我", "avatarUrl": "", "score": 862, "timeMs": 183000, "isMe": true }
  ],
  "mine": { "rank": 7, "score": 862, "timeMs": 183000, "inTop": false },   // 没参与过 → null
  "scoreRuleVersion": 1
}
```

规则：

- `limit` 默认 20、最大 100，**不做无限滚动**（10 关的量级，Top 50 + 我的名次足够）
- **不返回他人 `openid`** —— 榜单只需要 `nickname` / `avatarUrl` / `rank` / `score`
- `isMe` 由服务端标，E 不要用昵称比对（重名会标错）
- `mine` 即使不在 Top N 里也给，这样 E 能固定在底部显示"我的名次"
- `GUIDE` 查榜直接返回空榜（`total: 0`），不报错

### 3.4 `rank.mine` —— 我的成绩（可选，E 用不上就别做）

```jsonc
// 请求：{ "levelId": "L01" }  不传 levelId = 全部关卡
// 响应：{ "list": [{ levelId, mode, score, rank, total, timeMs, clearedAt }] }
```

> 结算页和记录页都能从 `level.submit` 的返回拿到 `score` / `rank`，`rank.mine` 主要给"我的记录"页补名次。
> **如果 E 说不需要，这个接口可以先不做**，别为它花时间。

### 3.5 索引（部署前必须建）

| 集合 | 索引 | 用途 |
|---|---|---|
| `scores` | `levelId`(升) + `mode`(升) + `score`(**降**) + `clearedAt`(升) | 榜单主查询 + tie-break |
| `scores` | `openid`(升) + `levelId`(升) | 查我的成绩 / 名次 |

---

## 4. 双人搭档档案

### 4.1 数据模型：`partners` 集合

`_id` 沿用存档那套 **`savePairKey`**（两个 openid 升序拼接），保证「A 建房」和「B 建房」算出同一条记录。

```jsonc
{
  "_id": "oAAA_oBBB",            // pairKey
  "partnerId": "p_7f3k2m",       // 给 E 用的短 id，不含 openid
  "openids": ["oAAA", "oBBB"],   // 升序
  "profiles": {                  // 昵称头像快照，最后一次一起玩时更新
    "oAAA": { "nickname": "阿岚", "avatarUrl": "https://..." },
    "oBBB": { "nickname": "小舟", "avatarUrl": "" }
  },
  "clearedLevels": ["L01", "L02"],   // 共同通关过的关卡（去重、按通关先后）
  "clearedCount": 2,
  "playCount": 5,                    // 一起开过多少局（含没通关的）
  "bestRecords": {                   // 每关的最佳合作记录，只留更好的一次
    "L01": { "timeMs": 183000, "score": 862, "clearedAt": 1762900000000 },
    "L02": { "timeMs": 240000, "score": 790, "clearedAt": 1762910000000 }
  },
  "badges": ["first_team", "three_levels"],
  "firstPlayedAt": 1762000000000,
  "lastPlayedAt": 1762910000000
}
```

### 4.2 写入时机（C 侧，D 不用改）

两条路径：

1. **双人通关时** —— 复用 `level.submit` 里已有的「给房内双方都落 cleared」那段（`saveClearedForPlayers` 之后），
   顺带 upsert 搭档档案：`clearedLevels` 去重追加、`bestRecords` 取更优、`badges` 重算
2. **双人开局时**（`room.start`）—— 只更新 `playCount` / `lastPlayedAt` / `profiles` 快照

> 注意：先退出房间的那个人也要能记上，所以参与者一律取 `room.sessionPlayers`（开局快照），不用 `players`。

### 4.3 `partner.list` —— 我的搭档档案列表

```jsonc
// 请求：{ "limit": 20 }
// 响应
{
  "list": [{
    "partnerId": "p_7f3k2m",
    "nickname": "阿岚",           // 对方的昵称（不是你自己的）
    "avatarUrl": "https://...",
    "clearedCount": 2,
    "clearedLevels": ["L01", "L02"],
    "playCount": 5,
    "bestRecords": [ { "levelId": "L01", "timeMs": 183000, "score": 862 } ],
    "badges": [{ "id": "first_team", "title": "初次并肩", "description": "第一次一起通关" }],
    "lastPlayedAt": 1762910000000
  }],
  "total": 3
}
```

- 按 `lastPlayedAt` 降序（最近一起玩的排前面）
- **一条记录里对方是"另一个人"**：服务端按调用者身份挑出对方那份 `profiles` 返回，E 不用自己判断谁是"我"
- **不返回 `openid`**，只用 `partnerId` 做前端 key

### 4.4 徽章规则（**草案，要你 / A 拍板**）

分工只写了「C 记录合作徽章」，没说规则。我先按最容易实现、展示也最直观的 4 个提：

| id | 名称 | 条件 |
|---|---|---|
| `first_team` | 初次并肩 | 第一次一起通关任意一关 |
| `three_levels` | 默契初成 | 共同通关 3 关 |
| `five_levels` | 心有灵犀 | 共同通关 5 关 |
| `all_levels` | 全勤搭档 | 共同通关全部 10 关 |

一条记录达成即永久保留（不因为后来没一起玩而消失）。

### 4.5 「再次邀请搭档」到底要什么（**E 请重点看**）

小游戏**拿不到微信好友关系链**（除非走开放数据域，本期不做），所以：

- 这里的「好友」= **一起玩过一局的人**，不是你的微信好友
- 「再次邀请」= 服务端给不了"直接发给某个人"的能力。E 的实现方式是：
  1. 调已有的 `room.create` 建一个新房间
  2. 用 `wx.shareAppMessage` 把房间码分享出去（微信由玩家自己选发给谁）
  3. 页面上只需要展示搭档昵称 + 一起通关的关数，**不需要传对方 openid**

> 如果 E 的页面设计成"点一下直接把邀请发给这个搭档"，本期做不到，需要改设计。

---

## 5. 给 E 的字段映射（页面 → 接口）

| 页面元素 | 数据来源 |
|---|---|
| 榜单标题「第 N 关 · 双人」 | `rank.level` 的 `levelId` + `mode` |
| 前三名卡片 | `rank.level.list[0..2]` |
| 榜单行（名次/昵称/头像/成绩） | `rank.level.list[i]` 的 `rank` / `nickname` / `avatarUrl` / `score` |
| 高亮自己那一行 | `rank.level.list[i].isMe` |
| 底部「我的名次」 | `rank.level.mine`（为 `null` 时显示"暂无成绩"） |
| 结算页「本关第 N 名」 | `level.submit` 返回的 `rank`（为 `null` 时不显示这一行） |
| 搭档档案卡片 | `partner.list[i]` |
| 徽章 | `partner.list[i].badges[]`（用 `id` 做 key、`title` 做文案） |
| 「再次邀请」按钮 | 先 `room.create`，再 `wx.shareAppMessage` |

**E 不要做的事**：不要自己按 `score` 排序（服务端已排好）、不要自己算名次、不要把 `openid` 显示出来。

---

## 6. 给 D 的改动清单（就三处）

1. 运行时统计本局 `hintsUsed`（用了提示的次数）和 `eggsFound`（本局发现的彩蛋数）
2. `level.submit` 时把这两个数带上（可选字段，缺省 0）
3. 结算页用返回值里的 `score` / `rank` / `isNewBest` 展示（这三个是服务端算的，**D 不要自己算分**）

**不要做**：不要在客户端算 `score` 传上来；不要改 `elapsedMs` 的含义（它现在就是本局用时，服务端还会拿 `room.startedAt` 交叉校验）。

---

## 7. 明确不做的事（避免范围膨胀）

| 不做 | 原因 |
|---|---|
| 好友榜 / 同校榜 | 没有关系链数据，只能做全服榜 |
| 榜单奖励、段位、赛季 | 分工写明「普通关卡排行榜只展示成绩，不设置奖励」 |
| 榜单实时推送 | 榜单是低频页面，进页面拉一次就够 |
| 无限滚动 | 10 关量级，Top 50 + 我的名次够用 |
| 成绩申诉 / 反作弊后台 | 本期只做上限截断 + 服务端算分 |

---

## 8. 时间线（倒推）

| 日期 | 事件 | 谁 |
|---|---|---|
| 11/13 | 本文档发出 | C |
| **11/17** | 确认 §2 的 5 个问题 + 计分规则 | **D** |
| 11/18 | 本文档定稿，并进 `server/API.md` | C |
| **11/20** | `scores` / `partners` 接口可调（含索引建好） | C |
| 11/21–11/24 | E 接页面、D 补上报字段 | D / E |
| 11/25 | 三方联调 | 全员 |

---

## 9. 待确认清单（回复时直接勾）

- [ ] D：§2 五个问题
- [ ] D：`hintsUsed` / `eggsFound` 字段名是否可用（有没有更贴切的名字）
- [ ] E：榜单要不要分「单人 / 双人」两个 Tab
- [ ] E：榜单展示昵称 + 头像，可以吗（涉及他人资料展示范围）
- [ ] E：`rank.mine` 这个接口你需不需要（不需要就不做）
- [ ] 你 / A：§4.4 的四个徽章够不够，要不要加
