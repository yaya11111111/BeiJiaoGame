/**
 * 账号相关：登录建档、取档案、改昵称。
 *
 * 说明：项目按「最少必要信息」设计，**不收集真实姓名、手机号、密码**，
 * 身份完全依赖微信的 openid。所以这里没有注册接口——第一次调用 login 就是建档。
 */

import { C, db, getDoc, now, progressId } from '../shared/db'
import { ApiError, ERROR, requireString } from '../shared/errors'
import type { ApiContext, UserDoc } from '../shared/types'

/** 随机昵称兜底：玩家一直不改昵称时也有个能看的显示名 */
function randomNickname(): string {
  const n = Math.floor(1000 + Math.random() * 9000) // 4 位随机数
  return `交大同学${n}`
}

/**
 * auth.login —— 无感登录
 * 客户端启动时调一次。老用户更新 lastLoginAt，新用户建档。
 */
export async function login(_params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const ts = now()

  let user: UserDoc | null = await getDoc(C.users, openid)
  const isNewUser = !user

  if (!user) {
    // 新用户：建档
    user = {
      _id: openid,
      openid,
      nickname: randomNickname(),
      currentLevelId: 'GUIDE', // 所有人从新手引导开始
      createdAt: ts,
      lastLoginAt: ts,
    }
    // add 时手动指定 _id 为 openid，这样以后就能直接用 openid 查，不用再索引
    await db.collection(C.users).add({ data: user })
  } else {
    // 老用户：只更新时间，其他不动
    await db.collection(C.users).doc(openid).update({ data: { lastLoginAt: ts } })
  }

  // 基线进度：不管新老用户都补一次（幂等）
  await ensureBaselineProgress(openid, ts)

  return { nickname: user.nickname, avatarUrl: user.avatarUrl, currentLevelId: user.currentLevelId, isNewUser }
}

/**
 * 基线进度：保证新手引导关有一条 `unlocked` 记录。
 *
 * 为什么必须在服务端做：双人房间的「可玩交集」是按 progress 里的
 * unlocked / cleared 算的，而约定是「零进度玩家只能玩 GUIDE」。
 * 如果这条记录只靠客户端去补，漏调一次（或老账号升级上来）就会出现
 * 「两个新手的交集是空、一关都选不了」的死结。服务端登录时兜底最稳。
 *
 * 幂等：只在记录不存在时 add，已经 cleared 的记录绝不会被降级。
 */
async function ensureBaselineProgress(openid: string, ts: number) {
  const pid = progressId(openid, 'GUIDE')
  const existing = await getDoc(C.progress, pid)
  if (existing) return

  try {
    await db.collection(C.progress).add({
      data: {
        _id: pid,
        openid,
        levelId: 'GUIDE',
        status: 'unlocked',
        bestTimeMs: 0,
        attempts: 0,
        clearedAt: 0,
        updatedAt: ts,
      },
    })
  } catch (e: any) {
    // 极端并发（两个请求同时首次登录）下两边都查到「不存在」，后一个 add 会撞主键。
    // 撞了说明记录已经建好，忽略即可；其他错误照常上抛，交给入口翻译成 5000。
    const msg = String((e && (e.errMsg || e.message)) || '')
    if (!/duplicate|exists|already/i.test(msg)) throw e
  }
}

/**
 * auth.profile —— 档案 + 进度概览，E 的个人记录页用
 */
export async function profile(_params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const user: UserDoc | null = await getDoc(C.users, openid)
  if (!user) {
    // 理论上不会发生（login 一定先跑过）。真出现了就当作要重新登录
    throw new ApiError(ERROR.UNAUTHORIZED)
  }

  // 统计已通关数量与总用时。云开发单次最多取 100 条，10 关绰绰有余
  const res = await db
    .collection(C.progress)
    .where({ openid, status: 'cleared' })
    .limit(100)
    .get()

  const list: any[] = (res && res.data) || []
  const totalTimeMs = list.reduce((sum, p) => sum + (p.bestTimeMs || 0), 0)

  return {
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    currentLevelId: user.currentLevelId,
    clearedCount: list.length,
    totalTimeMs,
  }
}

/**
 * auth.updateProfile —— 改昵称
 */
export async function updateProfile(params: any, ctx: ApiContext) {
  const openid = ctx.openid
  const nickname = requireString(params, 'nickname')

  // 长度校验：1-16 个字符（中文也算 1 个）
  if (nickname.length > 16) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: '昵称不能超过 16 个字符' })
  }

  const avatarUrl = typeof params.avatarUrl === 'string' ? params.avatarUrl.slice(0, 2048) : undefined

  const data: Record<string, unknown> = { nickname }
  if (avatarUrl) data.avatarUrl = avatarUrl
  await db.collection(C.users).doc(openid).update({ data })
  return { nickname, avatarUrl }
}
