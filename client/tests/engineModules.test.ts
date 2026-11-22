import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('实际构建的引擎功能配置', () => {
  it('姓名加粗需要的 RichText 同时启用裁剪开关和构建模块', () => {
    const engine = JSON.parse(readFileSync(new URL('../settings/v2/packages/engine.json', import.meta.url), 'utf8'));
    const config = engine.modules.configs.defaultConfig;
    expect(config.cache['rich-text']._value).toBe(true);
    expect(config.includeModules).toContain('rich-text');
  });
});
