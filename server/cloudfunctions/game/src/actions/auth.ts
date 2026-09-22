/**
 * 账号相关：登录建档、取档案、改昵称。
 *
 * 说明：项目按「最少必要信息」设计，**不收集真实姓名、手机号、密码**，
 * 身份完全依赖微信的 openid。所以这里没有注册接口——第一次调用 login 就是建档。
 */

import { C, db, getDoc, now } from '../shared/db'
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
    return { nickname: user.nickname, currentLevelId: user.currentLevelId, isNewUser: true }
  }

  // 老用户：只更新时间，其他不动
  await db.collection(C.users).doc(openid).update({ data: { lastLoginAt: ts } })
  return { nickname: user.nickname, currentLevelId: user.currentLevelId, isNewUser: false }
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

  await db.collection(C.users).doc(openid).update({ data: { nickname } })
  return { nickname }
}
