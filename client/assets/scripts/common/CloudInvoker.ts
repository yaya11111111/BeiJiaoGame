/**
 * 微信端的云函数调用绑定 —— **本工程里唯一碰 `wx` 的地方**。
 *
 * 为什么单独一个文件：
 * 1. `wx` 在小游戏里是全局的，工程里没有任何官方类型声明，Node 下又没有它；
 * 2. 把它收在这一个文件里，别处（包括 CloudApi）就都是平台无关的代码，
 *    能在 Node 里直接跑单测。
 *
 * **`wx.cloud.init()` 不在这里** —— 那是 E 的启动脚本负责的，全局只做一次。
 * 没 init 就调 `callFunction` 会直接失败，所以下面有个 `isCloudAvailable()`
 * 让调用方先问一句，而不是发一个必然失败的请求。
 */

import { CLOUD_CODE, type CloudEnvelope, type CloudInvoker } from './CloudApi';

/** 只声明我们用到的部分。装了官方类型包的话把这里换掉 */
interface WxCloud {
  callFunction(options: { name: string; data?: unknown }): Promise<{ result?: unknown }>;
}

interface WxGlobal {
  cloud?: WxCloud;
}

declare const wx: WxGlobal | undefined;

/**
 * 云开发是否可用。
 *
 * 三种情况都返回 false，调用方据此走离线路径：
 * - 不在微信环境（**Cocos 的浏览器预览就没有 `wx`**，这条最常碰到）
 * - 基础库太旧，没有云开发
 * - E 的 `wx.cloud.init` 还没执行到
 */
export function isCloudAvailable(): boolean {
  return typeof wx !== 'undefined' && !!wx && !!(wx as WxGlobal).cloud;
}

/**
 * 造一个走微信云的调用器。云开发不可用时返回 **null** ——
 * 让调用方明确知道自己要退到离线路径，而不是等一个必然失败的请求。
 */
export function createWechatCloudInvoker(): CloudInvoker | null {
  if (!isCloudAvailable()) return null;

  const cloud = (wx as WxGlobal).cloud as WxCloud;

  return async (action, params) => {
    const res = await cloud.callFunction({ name: 'game', data: { action, params } });

    // 云函数约定 res.result 就是信封（见 server/API.md 第 1 节）。
    // 拿不到合法信封时不要抛 —— 包成 5000 的失败信封，让上层的错误处理只有一条路
    const result = res && res.result;
    if (!result || typeof result !== 'object') {
      return { ok: false, code: CLOUD_CODE.INTERNAL, message: '云函数没有返回结果' };
    }

    return result as CloudEnvelope<unknown>;
  };
}
