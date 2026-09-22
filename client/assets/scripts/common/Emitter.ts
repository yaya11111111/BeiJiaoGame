/**
 * 核心（LevelRuntime）与渲染层（LevelView）之间唯一的事件通道。
 * 不用 Cocos 自带的 EventTarget，是为了让核心不 import cc。
 */

import { setToArray } from './Collections';

export type Listener<P> = (payload: P) => void;

export type Unsubscribe = () => void;

// 约束用 object 而不是 Record<string, unknown>：后者要求索引签名，
// 而事件表写成 interface 时没有索引签名，会报 TS2344
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

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

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // 复制一份再遍历，监听器里调 off() 不会打乱本次遍历。
    // 必须走 setToArray，不能写 [...set] —— 原因见 Collections.ts，
    // 写错的话构建产物里会变成调用 Set 自己，报 "s is not a function"。
    const snapshot = setToArray(set);
    for (const listener of snapshot) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error(`[Emitter] 事件 ${String(event)} 的监听器抛错：`, err);
      }
    }
  }

  clear<K extends keyof Events>(event?: K): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }
}
