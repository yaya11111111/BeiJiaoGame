import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 关掉 oxc 自动查找 tsconfig。这一条不能删，原因：
  //
  // client/tsconfig.json 里写的是 extends './temp/tsconfig.cocos.json'，
  // 而 temp/ 要「打开一次 Cocos Creator」才会生成，并且被 .gitignore 排除。
  // 不关的话，任何人 clone 下来第一次跑 npm test 都会撞上：
  //   [TSCONFIG_ERROR] Failed to load tsconfig '../temp/tsconfig.cocos.json': Tsconfig not found
  //
  // 注意 Vite 8 用的是 oxc 不是 esbuild，写成 esbuild.tsconfigRaw 会被忽略并给出告警。
  // 类型定义里还没有这个字段，所以加了 as any。
  oxc: { tsconfig: false } as any,
  test: {
    // 只跑本目录下的用例
    include: ['*.test.ts'],
    environment: 'node',
  },
});
