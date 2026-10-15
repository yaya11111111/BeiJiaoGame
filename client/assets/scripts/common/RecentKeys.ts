/**
 * 「最近用过的 key」顺序表 —— 给缓存做淘汰用。
 *
 * 为什么抽成纯函数：用它的地方是 `LevelView`（import 'cc'，单测碰不到），
 * 而「淘汰谁」这条规则搞错了后果都不轻 ——
 * **放掉正在显示的那张图**（花屏），或者**该放的不放**（内存下不来，
 * 真机上就是「运行内存不够」被杀掉）。两种都很难一眼看出来。
 *
 * 本文件不 import 'cc'，能在 Node 里直接单测。
 */

export interface RecentKeysResult {
  /** 新的顺序：最近用过的在末尾 */
  order: string[];
  /** 这次被挤出去的，**最老的在前** */
  evicted: string[];
}

/**
 * 把 `key` 记成「最近用过」，返回新的顺序和被淘汰的那些。
 *
 * - `key` 本来在表里的话先摘掉再放末尾（不会重复占位）
 * - **末尾那张永远不会被淘汰** —— 它就是当前正在用的那张（`limit` 兜底 ≥ 1）
 * - **`keep` 里的也永远不动**：那是「精灵此刻真正在显示」的那些。
 *   换画面是**异步**的 —— 新图还在解码时，精灵显示的还是上一张；连着快切几次，
 *   上一张就可能已经被挤出上限了，释放掉它 = 精灵引用一张没有的纹理 = 崩。
 *   所以「顺序表末尾」不够，还得把「正在显示的」也钉住。
 * - 其余超出 `limit` 的从**前面**淘汰（最老的先走）
 */
export function touchRecent(
  order: readonly string[],
  key: string,
  limit: number,
  keep: readonly string[] = [],
): RecentKeysResult {
  const next = order.filter((item) => item !== key);
  next.push(key);

  // limit 至少 1：否则「当前这张」自己就会被淘汰，那是必然的花屏
  const max = Math.max(1, limit);
  const evicted: string[] = [];
  let at = 0;
  while (next.length > max && at < next.length) {
    const candidate = next[at];
    // 当前这张和被钉住的那几张跳过，去看下一个 —— 不能为了凑数把它们放掉
    if (candidate === key || keep.indexOf(candidate) !== -1) {
      at += 1;
      continue;
    }
    next.splice(at, 1);
    evicted.push(candidate);
  }
  return { order: next, evicted };
}
