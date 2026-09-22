/** 统一的错误码表。客户端拿到的 ok:false 里，code 一定来自这里。 */
export interface ErrorShape {
  code: number
  message: string
}

export const ERROR = {
  /** 云函数拿不到 openid，一般是用户没进过小游戏或环境没配对 */
  UNAUTHORIZED: { code: 1001, message: '未能获取用户身份，请重新进入小游戏' },
  ROOM_NOT_FOUND: { code: 2001, message: '房间不存在，请检查房间码' },
  ROOM_FULL: { code: 2002, message: '房间已满，每间房最多 2 人' },
  ROOM_CLOSED: { code: 2003, message: '房间已关闭' },
  NOT_IN_ROOM: { code: 2004, message: '你不在这个房间里' },
  PARAM_INVALID: { code: 3001, message: '参数缺失或格式不正确' },
  LEVEL_NOT_FOUND: { code: 4001, message: '关卡数据缺失，请联系管理员' },
  INTERNAL: { code: 5000, message: '服务端出错了，请稍后重试' },
} as const

/**
 * 业务异常。想返回错误码时，就 `throw new ApiError(ERROR.ROOM_FULL)`，
 * 入口会自动把它翻译成 { ok:false, code, message }。
 * 不要自己 return 错误对象，统一抛异常，出口才唯一。
 */
export class ApiError extends Error {
  code: number
  constructor(shape: ErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.code = shape.code
  }
}

/** 成功信封 */
export function okEnvelope(data: unknown) {
  return { ok: true, data }
}

/** 失败信封 */
export function errorEnvelope(shape: ErrorShape) {
  return { ok: false, code: shape.code, message: shape.message }
}

/**
 * 把任意异常转成信封。
 * - ApiError（我们自己抛的）→ 原样透出，客户端看得懂
 * - 其他异常（数据库超时等）→ 只记日志，对外统一说"服务端出错"，避免把内部细节泄露给玩家
 */
export function toEnvelope(err: unknown) {
  if (err instanceof ApiError) {
    return errorEnvelope({ code: err.code, message: err.message })
  }
  console.error('[game] 未捕获异常：', err)
  return errorEnvelope(ERROR.INTERNAL)
}

/** 取字符串参数，空或不是字符串就抛 3001 */
export function requireString(params: any, key: string): string {
  const v = params && params[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: `参数 ${key} 缺失或不是非空字符串` })
  }
  return v.trim()
}

/** 取数组参数 */
export function requireArray(params: any, key: string): any[] {
  const v = params && params[key]
  if (!Array.isArray(v)) {
    throw new ApiError({ ...ERROR.PARAM_INVALID, message: `参数 ${key} 必须是数组` })
  }
  return v
}
