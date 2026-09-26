/**
 * 数据库与微信上下文的唯一出口。
 * 所有 action 都从这里拿 db，不要各自再 init 一次。
 */

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
} as const

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
export async function getDoc(collection: string, id: string): Promise<any | null> {
  try {
    const res = await db.collection(collection).doc(id).get()
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
