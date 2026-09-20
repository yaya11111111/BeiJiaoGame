import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LevelConfigError, buildIndex, parseLevelConfig } from '../assets/scripts/common/LevelConfig';

const here = dirname(fileURLToPath(import.meta.url));

function loadRaw(file: string): unknown {
  return JSON.parse(readFileSync(resolve(here, '../assets/resources/configs', file), 'utf8'));
}

/** 取一份合法配置，按需改字段，用来构造各种非法输入 */
function validRaw(): Record<string, any> {
  return loadRaw('level.01.json') as Record<string, any>;
}

describe('关卡配置校验 —— 合法配置', () => {
  it('level.guide.json 能通过校验', () => {
    const config = parseLevelConfig(loadRaw('level.guide.json'));
    expect(config.levelId).toBe('GUIDE');
    expect(config.views.A.assetKey).toBe('bg/GUIDE_A');
  });

  it('level.01.json 能通过校验', () => {
    const config = parseLevelConfig(loadRaw('level.01.json'));
    expect(config.levelId).toBe('L01');
    expect(config.puzzle.answer).toEqual(['road_north', 'road_west']);
  });

  it('索引能把 nodeId 映射回它所属的视角', () => {
    const config = parseLevelConfig(validRaw());
    const index = buildIndex(config);
    expect(index.nodes.get('hs_b_submit')?.viewId).toBe('B');
    expect(index.nodes.get('hs_a_road_north')?.viewId).toBe('A');
  });

  it('_note 这类给美术看的字段会被忽略，不影响解析', () => {
    const raw = validRaw();
    expect(raw._note).toBeTypeOf('string');
    expect(() => parseLevelConfig(raw)).not.toThrow();
  });
});

describe('关卡配置校验 —— 非法配置必须被拦下', () => {
  it('缺少 levelId', () => {
    const raw = validRaw();
    delete raw.levelId;
    expect(() => parseLevelConfig(raw)).toThrow(LevelConfigError);
  });

  it('nodeId 重复', () => {
    const raw = validRaw();
    raw.views.B.hotspots[0].nodeId = 'hs_a_road_north';
    expect(() => parseLevelConfig(raw)).toThrow(/nodeId 重复/);
  });

  it('pickup 热点没有 itemId', () => {
    const raw = validRaw();
    delete raw.views.A.hotspots[0].itemId;
    expect(() => parseLevelConfig(raw)).toThrow(/pickup/);
  });

  it('rect 不是 4 个数', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].rect = [10, 20, 30];
    expect(() => parseLevelConfig(raw)).toThrow(/rect/);
  });

  it('rect 宽高为 0', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].rect = [10, 20, 0, 30];
    expect(() => parseLevelConfig(raw)).toThrow(/宽高必须大于 0/);
  });

  it('缺 B 视角', () => {
    const raw = validRaw();
    delete raw.views.B;
    expect(() => parseLevelConfig(raw)).toThrow(/views\.B 缺失/);
  });

  it('viewId 和键名不一致（复制粘贴容易犯的错）', () => {
    const raw = validRaw();
    raw.views.B.viewId = 'A';
    expect(() => parseLevelConfig(raw)).toThrow(/与键名不一致/);
  });

  // 下面三条是「死局检测」——配置写错会导致关卡永远通不了，
  // 而且这种错在运行时才暴露、极难排查，所以必须在加载阶段就拦下。
  it('submitNodeId 指向不存在的节点', () => {
    const raw = validRaw();
    raw.puzzle.submitNodeId = 'hs_不存在';
    expect(() => parseLevelConfig(raw)).toThrow(/submitNodeId 指向的节点不存在/);
  });

  it('revealsNode 指向不存在的节点', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].revealsNode = 'hs_不存在';
    expect(() => parseLevelConfig(raw)).toThrow(/revealsNode 指向的节点不存在/);
  });

  it('requiredItems 里的道具在任何热点里都拿不到（死局）', () => {
    const raw = validRaw();
    raw.puzzle.requiredItems = ['road_north', '不存在的道具'];
    expect(() => parseLevelConfig(raw)).toThrow(/死局/);
  });

  it('requiresItem 指向拿不到的道具（死局）', () => {
    const raw = validRaw();
    raw.views.B.hotspots[1].requiresItem = '不存在的道具';
    expect(() => parseLevelConfig(raw)).toThrow(/死局/);
  });

  it('answer 是空数组', () => {
    const raw = validRaw();
    raw.puzzle.answer = [];
    expect(() => parseLevelConfig(raw)).toThrow(/answer 不能是空数组/);
  });

  it('hints 为空', () => {
    const raw = validRaw();
    raw.hints = [];
    expect(() => parseLevelConfig(raw)).toThrow(/hints 不能为空/);
  });

  it('mode 写错', () => {
    const raw = validRaw();
    raw.mode = ['single'];
    expect(() => parseLevelConfig(raw)).toThrow(/mode/);
  });

  it('timeLimitSec 是 0', () => {
    const raw = validRaw();
    raw.timeLimitSec = 0;
    expect(() => parseLevelConfig(raw)).toThrow(/timeLimitSec/);
  });

  it('报错信息里带 levelId，方便定位是哪个关卡', () => {
    const raw = validRaw();
    raw.hints = [];
    try {
      parseLevelConfig(raw);
      expect.unreachable('应该抛错');
    } catch (err) {
      expect((err as Error).message).toContain('L01');
    }
  });
});
