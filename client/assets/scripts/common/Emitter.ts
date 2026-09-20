/**
 * 极简事件总线 —— 关卡核心（LevelRuntime）与渲染层（LevelView）之间唯一的通信方式。
 *
 * 为什么要它：关卡核心必须保持引擎无关才能单元测试，所以核心不能直接去改 Cocos 的节点。
 * 核心只负责「发生了什么」，通过事件广播出去；渲染层订阅事件，自己去更新 Sprite / Label / 按钮。
 *
 * 不用 Cocos 自带的 EventTarget，是为了让核心不 import cc。
 *
 * 本文件不 import 任何 cc 模块。
 */

export type Listener<P> = (payload: P) => void;

/** 取消订阅的函数，on() 返回它 */
export type Unsubscribe = () => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  /**
   * 订阅事件。返回取消订阅的函数。
   *
   * 用法：
   *   const off = runtime.on('inventory:changed', ({ inventory }) => { ... });
   *   off(); // 不再需要时取消
   */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set!.delete(listener as Listener<never>);
    };
  }

  /** 只触发一次的订阅。 */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /** 广播事件。监听器抛出的异常不会中断其余监听器。 */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // 复制一份再遍历：监听器里调 off() 时不会打乱本次遍历
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error(`[Emitter] 事件 ${String(event)} 的监听器抛错：`, err);
      }
    }
  }

  /** 清空某个事件的全部监听器；不传参数则清空所有。 */
  clear<K extends keyof Events>(event?: K): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }
}
