/**
 * users 集合的批量读取工具。
 *
 * 抽出来是因为榜单和搭档档案都要「一次查一批昵称头像」：
 * 按行 `getDoc` 的话 Top 50 就是 50 次读，而云开发的读次数是要算配额的。
 */

import { C, db } from './db'
import type { UserDoc } from './types'

/** 昵称兜底，和 rank.ts 保持一致：客户端会静默丢掉空昵称的条目，绝不能返回空串 */
export const NICKNAME_FALLBACK = '神秘玩家'

/** 单次 `_.in` 查询的上限。云开发单次 get 默认最多 100 条，超过要分批 */
const CHUNK = 100

/**
 * 批量取用户资料。`users._id` 就是 openid，但这里按 `openid` 字段查 ——
 * 该字段本来就在用（progress 也是这么查的），不依赖 `_id` 的特殊语义。
 *
 * **必须分批**：v3.9 双人榜一队一行、每行两个人，`limit=100` 时会一次要 200 个
 * openid。写死 `.limit(100)` 等于把后一半的人丢掉，那些行的昵称会静默变成
 * `神秘玩家` —— 榜上看着「有人但没名字」，极难排查。
 */
export async function loadProfiles(openids: string[]): Promise<Record<string, UserDoc>> {
  const unique = Array.from(new Set(openids.filter((id) => typeof id === 'string' && id !== '')))
  if (unique.length === 0) return {}

  const map: Record<string, UserDoc> = {}
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK)
    const res = await db
      .collection(C.users)
      .where({ openid: db.command.in(slice) })
      .limit(CHUNK)
      .get()
    const rows: UserDoc[] = (res && res.data) || []
    for (const row of rows) map[row.openid] = row
  }
  return map
}
