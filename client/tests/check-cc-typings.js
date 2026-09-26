/**
 * typecheck:view 的前置检查：Cocos 有没有生成引擎的类型声明。
 *
 * 为什么需要它：client/temp/ 不入库（编辑器产物），所以**新 clone 下来的人
 * 第一次跑 typecheck:view 必然失败**。而失败的样子是一串
 *   Cannot find module 'cc'
 *   Property 'node' does not exist on type 'LevelView'
 * 看起来像代码坏了，其实只是没打开过编辑器。
 *
 * 更糟的是 README 里对 TS2307 的建议是「先看文件命名跟没跟上 View.ts 约定」——
 * 那会把人往错的方向引。所以在这里先把话说清楚，再让 tsc 跑。
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ccTypes = resolve(here, '../temp/declarations/cc.d.ts');

if (!existsSync(ccTypes)) {
  console.error(
    [
      '',
      `❌ 找不到 ${ccTypes}`,
      '',
      '   typecheck:view 要 Cocos 生成的引擎类型声明，而它不在仓库里（temp/ 不入库）。',
      '   解决：用 Cocos Creator 打开一次 client/ 工程，它会在 temp/declarations/ 下生成。',
      '   新 clone 下来的人第一次必做这一步。',
      '',
      '   引擎无关的部分不受影响 —— npm run typecheck 和 npm test 都不需要 Cocos。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
