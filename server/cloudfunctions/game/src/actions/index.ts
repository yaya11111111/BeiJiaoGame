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
import * as feedback from './feedback'
import * as library from './library'
import * as save from './save'
import * as admin from './admin'
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
  'room.setLevel': room.setLevel, // 房主换关（2026-10-10 新增）
  'room.start': room.start,
  'room.heartbeat': room.heartbeat,

  // 关卡私密数据与判定
  'level.list': level.list,
  'level.getView': level.getView,
  'level.submit': level.submit,

  // 事件与同步
  'event.publish': event.publish,
  'event.pull': event.pull,
  'event.report': event.report,

  // 进度
  'progress.get': progress.get,
  'progress.save': progress.save,

  // 第 8 周新增：玩家反馈（FR-14）
  'feedback.submit': feedback.submit,

  // 第 8 周新增：跨关收藏与图鉴彩蛋（FR-11 / FR-12 / FR-13）
  'library.get': library.get,
  'library.add': library.add,

  // 第 8 周新增：双人关卡存档（FR-15）
  'save.write': save.write,
  'save.load': save.load,
  'save.clear': save.clear,

  // 第 8 周新增：管理端（反馈查看，仅 admins 名单）
  // 注意不是 feedback.list —— 那个名字留给「玩家看自己的反馈」
  'admin.whoami': admin.whoami,
  'admin.feedback.list': admin.list,
}
