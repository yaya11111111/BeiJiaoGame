/**
 * 云函数统一入口：game
 * ==================================================================
 * 为什么所有接口都塞进「一个」云函数？
 *
 * 微信云开发里，每个云函数都是一个独立的 npm 包，函数之间没法直接共享代码。
 * 如果拆成 auth / room / progress 好几个函数，公共代码（数据库连接、错误码、
 * 工具函数）就得复制好几份，改一处要同步好几处——对新手和赶进度的项目是灾难。
 *
 * 所以这里用「单函数 + action 路由」：客户端传一个 action 字符串，
 * 入口查表分发到对应的处理函数。部署仍然只有一次，代码也只有一份。
 *
 * 客户端调用示例：
 *   const res = await wx.cloud.callFunction({
 *     name: 'game',
 *     data: { action: 'room.join', params: { code: 'AB3K9Q' } },
 *   })
 *   // res.result → { ok: true, data: {...} }  或
 *   //              { ok: false, code: 2001, message: '房间不存在，请检查房间码' }
 * ==================================================================
 */

import { ACTIONS } from './src/actions'
import { getOpenid } from './src/shared/db'
import { ERROR, errorEnvelope, okEnvelope, toEnvelope } from './src/shared/errors'

/**
 * 云函数主入口。云开发约定必须导出 main。
 * @param event   客户端传进来的对象，我们约定是 { action, params }
 * @param _context 微信上下文，这里用不到（openid 在 db.getOpenid 里取）
 */
export const main = async (event: any, _context: any): Promise<any> => {
  // 第一步：校验 action 是否存在
  const action = event && typeof event.action === 'string' ? event.action : ''
  const params = (event && event.params) || {}

  const handler = ACTIONS[action]
  if (!handler) {
    return errorEnvelope({
      ...ERROR.PARAM_INVALID,
      message: `未知的接口名：${action || '(空)'}`,
    })
  }

  // 第二步：取用户身份。openid 由微信注入，伪造不了，所以不用自己做登录校验
  const openid = getOpenid()
  if (!openid) {
    return errorEnvelope(ERROR.UNAUTHORIZED)
  }

  // 第三步：执行。业务里抛 ApiError 会被翻译成对应错误码，
  // 其他异常统一记日志并返回 5000，不把内部细节暴露给玩家
  try {
    const data = await handler(params, { openid })
    return okEnvelope(data)
  } catch (err) {
    return toEnvelope(err)
  }
}
