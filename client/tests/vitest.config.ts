import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 不能删。client/tsconfig.json extends 的 './temp/tsconfig.cocos.json' 要打开一次
  // Cocos 才生成、且不进版本库，不关掉的话 clone 下来第一次 npm test 必挂。
  // Vite 8 用的是 oxc 不是 esbuild，且类型定义里还没这个字段。
  oxc: { tsconfig: false } as any,
  // Backend builds emit adjacent JS; tests must exercise the TS modules and injected DB.
  resolve: { extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'] },
  test: {
    include: ['*.test.ts'],
    environment: 'node',
  },
});
