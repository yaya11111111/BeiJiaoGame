/**
 * 关卡外页面用的本地存储适配层。
 *
 * E 的几个新功能（跨关收藏、双人保存进度、反馈回执）都需要「关掉小游戏还留着」
 * 的数据，但**不能让页面直接碰 `wx`**：
 * 1. Node 单测里没有 `wx`；
 * 2. 浏览器预览里也没有，页面要能安全降级成内存存储，而不是一调就抛。
 *
 * 所以这里只暴露三个同步方法，微信环境走 `wx.*StorageSync`，其余环境退回内存。
 * 真正的云端归属（C 的 `library.*` / `feedback.*` / `room.saveSession`）见
 * `接口需求.md`，本文件只负责「没上云之前别丢」。
 */

export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

interface WxSyncStorage {
  getStorageSync?: (key: string) => unknown;
  setStorageSync?: (key: string, value: unknown) => void;
  removeStorageSync?: (key: string) => void;
}

const memoryValues: Record<string, string> = {};

/**
 * 微信小游戏的同步存储。返回 null 表示当前不在微信环境里 ——
 * 调用方应该退到 `memoryKeyValueStore()`。
 */
export function wxKeyValueStore(): KeyValueStore | null {
  const runtime = (globalThis as { wx?: WxSyncStorage }).wx;
  if (!runtime || typeof runtime.getStorageSync !== 'function' || typeof runtime.setStorageSync !== 'function') {
    return null;
  }
  return {
    read(key: string): string | null {
      try {
        const value = runtime.getStorageSync!(key);
        return typeof value === 'string' && value.length > 0 ? value : null;
      } catch (error) {
        console.warn('[LocalStore] 读取本地缓存失败', key, error);
        return null;
      }
    },
    write(key: string, value: string): void {
      try {
        runtime.setStorageSync!(key, value);
      } catch (error) {
        // 微信本地缓存有 10MB 上限，写满了不该把页面带崩。
        console.warn('[LocalStore] 写入本地缓存失败', key, error);
      }
    },
    remove(key: string): void {
      try {
        if (typeof runtime.removeStorageSync === 'function') runtime.removeStorageSync(key);
        else runtime.setStorageSync!(key, '');
      } catch (error) {
        console.warn('[LocalStore] 删除本地缓存失败', key, error);
      }
    },
  };
}

/** 预览 / 单测用的内存存储。同一次运行内有效，关掉就没了。 */
export function memoryKeyValueStore(): KeyValueStore {
  return {
    read: (key) => (Object.prototype.hasOwnProperty.call(memoryValues, key) ? memoryValues[key] : null),
    write: (key, value) => { memoryValues[key] = value; },
    remove: (key) => { delete memoryValues[key]; },
  };
}

/** 页面启动时调一次：微信里用真存储，别处用内存。 */
export function createKeyValueStore(): KeyValueStore {
  return wxKeyValueStore() ?? memoryKeyValueStore();
}

export function readJson(store: KeyValueStore, key: string): unknown {
  const raw = store.read(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    console.warn('[LocalStore] 本地缓存不是合法 JSON，已忽略', key, error);
    return null;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.write(key, JSON.stringify(value));
  } catch (error) {
    console.warn('[LocalStore] 序列化本地缓存失败', key, error);
  }
}
