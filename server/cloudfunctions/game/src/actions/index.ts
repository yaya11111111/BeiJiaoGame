/**
 * action 路由表：字符串 → 处理函数。
 * 新增接口时，只需要在对应模块里写好函数，再来这里加一行。
 * 客户端传的字符串必须和这里的键完全一致。
 */

import * as auth from './auth'
import * as room from './room'
import * as level from './level'
import * as event from './event'
import * as progress from './progress'
import type { ApiContext } from '../shared/types'

type Handler = (params: any, ctx: ApiContext) => Promise<any>

export const ACTIONS: Record<string, Handler> = {
  // 账号
  'auth.login': auth.login,
  'auth.profile': auth.profile,
  'auth.updateProfile': auth.updateProfile,

  // 房间
  'room.create': room.create,
  'room.join': room.join,
  'room.leave': room.leave,
  'room.state': room.state,
  'room.heartbeat': room.heartbeat,

  // 关卡私密数据与判定
  'level.getView': level.getView,
  'level.submit': level.submit,

  // 事件与同步
  'event.publish': event.publish,
  'event.pull': event.pull,
  'event.report': event.report,

  // 进度
  'progress.get': progress.get,
  'progress.save': progress.save,
  'progress.nextLevel': progress.nextLevel,
}
