/**
 * 数据库与微信上下文的唯一出口。
 * 所有 action 都从这里拿 db，不要各自再 init 一次。
 */

import { createHash } from 'node:crypto'

// wx-server-sdk 官方没有 TypeScript 类型声明，所以用 require 引入（依赖 @types/node），
// 并显式标注成 any。如果哪天装了带类型的版本，把这里的 any 换成真实类型即可。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cloud: any = require('wx-server-sdk')

// DYNAMIC_CURRENT_ENV 表示「用当前这个云开发环境」，换个环境不用改代码
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
/** 数据库操作符：_.gt / _.inc / _.set 等，写查询和更新条件时要用 */
const _ = db.command

/** 集合名集中在这里，改名只改一处 */
export const C = {
  users: 'users',
  rooms: 'rooms',
  progress: 'progress',
  events: 'events',
  levels: 'levels',
  // 第 8 周新增（FR-14 反馈 / FR-11-13 收藏彩蛋 / FR-15 双人存档）
  feedbacks: 'feedbacks',
  libraries: 'libraries',
  saves: 'saves',
  /** 管理端白名单，_id = openid。名单里的人才能看全量反馈 */
  admins: 'admins',
  /** 关卡榜单（FR-16）。一人 · 一关 · 一模式 只留最好的一条 */
  scores: 'scores',
  /** 双人搭档档案（FR-17）。_id = pairKey，和双人存档同一套拼法 */
  partners: 'partners',
} as const

/**
 * 双人存档的键：两个 openid **升序排序**后拼起来。
 *
 * 排序是必须的 —— 否则「A 建房」和「B 建房」会算出两个不同的 key，
 * 两人再组队时就找不到上一份存档了。
 *
 * pairKey 作为普通字段靠索引查。新文档的 `_id` 由 pairKey 和关卡 ID 的摘要生成。
 */
export function savePairKey(openids: string[]): string {
  return openids.filter(Boolean).sort().join('_')
}

/**
 * 榜单单据 id：一人 · 一关 · 一模式 唯一。
 *
 * 固定拼法而不是让服务端自动生成 —— 这样重玩时用 `set()` 覆盖同一条，
 * 天然幂等，也不会随重玩次数无限增长。
 *
 * 长度估算：28(openid) + 1 + 3(levelId) + 1 + 4(mode) ≈ 37 字符，安全。
 * 注意双人存档那边不能这么拼（两个 openid 会到 60 字符，接近 _id 上限），
 * 所以 saves 走「pairKey + levelId 摘要」的 _id，别把两处的做法搞混。
 */
export function scoreId(openid: string, levelId: string, mode: string): string {
  return `${openid}_${levelId}_${mode}`
}

/**
 * 双人榜单据 id：一队 · 一关 唯一（v3.9 起双人榜按队聚合，不再一人一条）。
 *
 * **不能**像单人榜那样拼明文 —— pairKey 本身就是两个 openid 拼起来（≈57 字符），
 * 再加前缀和关卡 ID 会顶到 `_id` 长度上限。所以和 `saves` 一样走 sha256 摘要。
 * 摘要以固定前缀区分用途，便于在库里一眼看出是双人队记录。
 */
export function duoScoreId(pairKey: string, levelId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([pairKey, levelId])).digest('hex')
  return `duo_${digest.slice(0, 32)}`
}

/**
 * 取当前用户的 openid。
 * 云函数里由微信自动注入，客户端伪造不了——所以我们不需要自己做登录态校验。
 */
export function getOpenid(): string {
  const ctx = cloud.getWXContext() || {}
  return typeof ctx.OPENID === 'string' ? ctx.OPENID : ''
}

/** 当前毫秒时间戳，统一用这个，避免有的地方用秒有的地方用毫秒 */
export function now(): number {
  return Date.now()
}

/**
 * 给房间分配下一个事件序号（seq）。
 *
 * 为什么要用事务而不是「读出来 +1 再写回」？
 * 两个人同时发消息时，两条请求可能读到同一个 lastSeq，然后算出同一个 seq，
 * 事件顺序就乱了。事务能保证「读-改-写」这一步是原子的。
 *
 * 云开发的事务是乐观锁，并发冲突时会自动重试；重试多次仍失败会抛异常，
 * 由入口捕获成 5000，客户端重试一次即可。
 */
export async function nextSeq(roomId: string): Promise<number> {
  let allocated = 1
  await db.runTransaction(async (tx: any) => {
    const res = await tx.collection(C.rooms).doc(roomId).get()
    const room = res && res.data
    if (!room) {
      // 事务里抛异常会回滚，这里用 Error 让上层拿到
      throw new Error('room not found in transaction: ' + roomId)
    }
    allocated = (typeof room.lastSeq === 'number' ? room.lastSeq : 0) + 1
    await tx.collection(C.rooms).doc(roomId).update({ data: { lastSeq: allocated } })
  })
  return allocated
}

/**
 * progress 文档的 _id 规则：`${openid}_${levelId}`。
 * 所有地方都必须调这个函数生成，不要手拼字符串，否则会出现一人一关两条记录。
 */
export function progressId(openid: string, levelId: string): string {
  return `${openid}_${levelId}`
}

/**
 * 按 _id 取一条文档，不存在就返回 null（而不是抛异常）。
 *
 * 注意只把「文档不存在」翻译成 null：数据库抖动、权限错误这类异常会原样上抛，
 * 由入口翻译成 5000。如果在这里吞掉所有异常，网络故障会被误报成
 * 「房间不存在 / 关卡不存在」（2001/4001），排查时会把人带沟里去。
 */
export async function getDoc(collection: string, id: string, source = db): Promise<any | null> {
  try {
    const res = await source.collection(collection).doc(id).get()
    const data = res && res.data
    // 文档不存在时，服务端 SDK 有的版本返回空对象而不是抛错，两种都要识别
    if (!data || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) {
      return null
    }
    return data
  } catch (e: any) {
    const msg = String((e && (e.errMsg || e.message)) || '')
    if (/not exist|not found|DOCUMENT_NOT_FOUND/i.test(msg)) return null
    throw e
  }
}

export { cloud, db, _ }
