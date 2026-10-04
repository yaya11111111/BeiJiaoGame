#!/usr/bin/env node
/**
 * 构建后补一个 index.js —— Cocos 3.8.8 生成小游戏分包时的入口文件名不一致。
 *
 * 症状：预览/上传时报
 *   ENOENT: no such file or directory, open '.../subpackages/resources/index.js'
 *
 * 原因（对着构建产物核过）：
 *   - 主包里的每个 bundle 都叫 index.js（assets/main/index.js、assets/internal/index.js）
 *   - 而分包生成出来的是 game.js（subpackages/resources/game.js）
 *   - 两个 config.json 都写着 hasPreloadScript: true，说明运行时确实要加载这个入口脚本，
 *     它按 <分包目录>/index.js 去找，文件不在 → ENOENT
 *
 * 修法：把 game.js 复制一份成 index.js（两个都留着）——
 * WeChat 那侧要 game.js（小游戏分包的入口约定），Cocos 运行时那侧要 index.js，
 * 缺哪个都不行。
 *
 * **每次在 Cocos 里重新构建之后都要跑一遍**（构建产物是 gitignored 的，不进仓库）：
 *   node tools/fix-subpackage-entry.js
 *
 * 这个脚本是幂等的，重复跑没有副作用。等 Cocos 修了这个命名（或升级引擎版本）之后，
 * 这个文件就可以删掉了 —— 到那时它会报「没有需要修的」。
 */

const fs = require('node:fs');
const path = require('node:path');

const SUBPACKAGES = path.resolve(__dirname, '..', 'client', 'build', 'wechatgame', 'subpackages');

if (!fs.existsSync(SUBPACKAGES)) {
  console.log('[fix-subpackage] 没有 subpackages 目录 —— 这次构建没有分包，不用修。');
  process.exit(0);
}

let fixed = 0;
let alreadyOk = 0;

for (const name of fs.readdirSync(SUBPACKAGES)) {
  const dir = path.join(SUBPACKAGES, name);
  if (!fs.statSync(dir).isDirectory()) continue;

  const entry = path.join(dir, 'game.js');
  const target = path.join(dir, 'index.js');

  if (!fs.existsSync(entry)) {
    console.warn(`[fix-subpackage] ${name}: 没有 game.js，跳过（结构变了？去看看构建产物）`);
    continue;
  }
  if (fs.existsSync(target)) {
    alreadyOk += 1;
    continue;
  }

  fs.copyFileSync(entry, target);
  console.log(`[fix-subpackage] ${name}: 补上 index.js`);
  fixed += 1;
}

console.log(
  fixed > 0
    ? `[fix-subpackage] 修好了 ${fixed} 个分包入口。现在可以去微信开发者工具预览了。`
    : `[fix-subpackage] 没有需要修的（${alreadyOk} 个分包入口都在）。`,
);
