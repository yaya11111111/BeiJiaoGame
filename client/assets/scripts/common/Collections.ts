/**
 * Set → 数组。**不要写 `[...set]`。**
 *
 * 踩过的坑（真机上才暴露，浏览器预览完全看不出来）：
 * Cocos 的构建管线用 Babel 的 loose 模式转展开运算符，它把 `[...set]` 编译成
 * `[].concat(set)` —— 而 concat **只展开数组，不展开 Set**。结果拿到的是
 * `[set 自己]` 这么一个单元素数组，于是调用它报：
 *
 *     TypeError: s is not a function
 *
 * 两个后果：
 *   1. `for (const x of [...set]) x()` 会崩，且报错信息完全指不到真凶；
 *   2. `[...set].join(', ')` 不崩，但会拼出 `[object Set]`，
 *      于是「现有节点：xxx」这种用来定位配置错误的提示，恰恰在最需要它的时候失效。
 *
 * 为什么预览里没事：预览保留 ES2015+ 语法，`[...set]` 是原生支持的。
 * 所以这个 bug 只在「构建产物 / 真机」出现 —— 而真机正是本项目的验收口径。
 *
 * 本文件不 import 任何 cc 模块。
 */

export function setToArray<T>(set: ReadonlySet<T>): T[] {
  const out: T[] = [];
  // 用 forEach 而不是迭代协议：这是一次普通的方法调用，
  // Babel 不会去动它，不受 loose 模式影响。
  set.forEach((value) => {
    out.push(value);
  });
  return out;
}
