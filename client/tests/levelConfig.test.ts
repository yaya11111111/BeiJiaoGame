import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LevelConfigError, buildIndex, levelConfigPath, parseLevelConfig } from '../assets/scripts/common/LevelConfig';

const here = dirname(fileURLToPath(import.meta.url));

/** 读真实关卡配置（assets/resources/configs/） */
function loadRaw(file: string): unknown {
  return JSON.parse(readFileSync(resolve(here, '../assets/resources/configs', file), 'utf8'));
}

/** 读测试夹具。构造非法输入时改它，别改真实关卡 —— 理由见 levelRuntime.test.ts */
function loadFixture(file: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(here, './fixtures', file), 'utf8')) as Record<string, any>;
}

/** 取一份合法配置，按需改字段，用来构造各种非法输入 */
function validRaw(): Record<string, any> {
  return loadFixture('level.route.json');
}

describe('关卡配置校验 —— 真实关卡能通过校验', () => {
  // 这一组是 smoke 测试：A/B 改设计之后，配置至少得还能被解析出来，
  // 否则真机上就是加载失败、白屏。机制层面的覆盖在夹具那组做。
  it('level.guide.json 能通过校验，并且用的是表单输入', () => {
    const config = parseLevelConfig(loadRaw('level.guide.json'));
    expect(config.levelId).toBe('GUIDE');
    expect(config.views.A.assetKey).toBe('bg/GUIDE_A');
    expect(config.puzzle.input).toBe('form');
    // 表单关的提交按钮在面板里，所以不该再放一个提交热点
    expect(config.puzzle.submitNodeId).toBeUndefined();
  });

  it('level.01.json 能通过校验，并且用的是数字键盘', () => {
    const config = parseLevelConfig(loadRaw('level.01.json'));
    expect(config.levelId).toBe('L01');
    expect(config.puzzle.input).toBe('numberpad');
    expect(config.puzzle.answer).toEqual(['2', '4', '1']);
  });
});

describe('关卡配置校验 —— 字典类字段', () => {
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
    expect(() => parseLevelConfig(raw)).toThrow(/answer 是数组时不能为空/);
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

describe('配置文件路径映射', () => {
  it('引导关映射到 level.guide', () => {
    expect(levelConfigPath('GUIDE')).toBe('configs/level.guide');
  });

  it('正式关映射到 level.01 这种两位数编号', () => {
    expect(levelConfigPath('L01')).toBe('configs/level.01');
    expect(levelConfigPath('L10')).toBe('configs/level.10');
  });

  it('每一位都指到真实存在的文件 —— 防止配置改名后这里忘了跟', () => {
    // 引导关和 L01 的文件在库里，映射必须和它们对得上，否则真机上是白屏
    expect(() => loadRaw(`${levelConfigPath('GUIDE').replace('configs/', '')}.json`)).not.toThrow();
    expect(() => loadRaw(`${levelConfigPath('L01').replace('configs/', '')}.json`)).not.toThrow();
  });

  it('路径不带扩展名 —— resources.load 的路径口径就是不带扩展名', () => {
    expect(levelConfigPath('L01')).not.toContain('.json');
  });

  it('levelId 不合规时抛错，而不是拼出一个加载不到的路径', () => {
    expect(() => levelConfigPath('L1')).toThrow(LevelConfigError);
    expect(() => levelConfigPath('level01')).toThrow(/GUIDE/);
    expect(() => levelConfigPath('')).toThrow(LevelConfigError);
  });
});

describe('答案形状 —— 数组是有序答案，对象是按键答案', () => {
  it('按键答案（对象）能通过校验，原样保留', () => {
    const raw = validRaw();
    raw.puzzle.answer = { 岗位: '接线员', 编号: '07', 地点: '南门内侧' };
    const config = parseLevelConfig(raw);
    expect(config.puzzle.answer).toEqual({ 岗位: '接线员', 编号: '07', 地点: '南门内侧' });
  });

  it('有序答案（数组）照旧能用，没有破坏老配置', () => {
    const config = parseLevelConfig(validRaw());
    expect(Array.isArray(config.puzzle.answer)).toBe(true);
    expect(config.puzzle.answer).toEqual(['road_north', 'road_west']);
  });

  it('按键答案里混进非字符串的值 → 抛错，并指明是哪个键', () => {
    const raw = validRaw();
    raw.puzzle.answer = { 岗位: '接线员', 编号: 7 };
    expect(() => parseLevelConfig(raw)).toThrow(/编号/);
  });

  it('按键答案是空对象 → 抛错', () => {
    const raw = validRaw();
    raw.puzzle.answer = {};
    expect(() => parseLevelConfig(raw)).toThrow(/不能为空/);
  });

  it('answer 写成字符串 / 数字 / null → 抛错，且说清只能写数组或对象', () => {
    for (const bad of ['241', 241, true, null]) {
      const raw = validRaw();
      raw.puzzle.answer = bad;
      expect(() => parseLevelConfig(raw)).toThrow(/必须是数组（有序答案）或对象（按键答案）/);
    }
  });
});

describe('答错惩罚的配置', () => {
  it('wrongCooldownSec 是正数 → 通过', () => {
    const raw = validRaw();
    raw.puzzle.wrongCooldownSec = 10;
    expect(parseLevelConfig(raw).puzzle.wrongCooldownSec).toBe(10);
  });

  it('不写 wrongCooldownSec → 就是「不惩罚」，不是错', () => {
    expect(parseLevelConfig(validRaw()).puzzle.wrongCooldownSec).toBeUndefined();
  });

  it('wrongCooldownSec 写 0 → 抛错并提示「不想惩罚就别写这个字段」', () => {
    // 0 是最常见的写错法：本意是「不惩罚」，但字段还在，语义含糊
    const raw = validRaw();
    raw.puzzle.wrongCooldownSec = 0;
    expect(() => parseLevelConfig(raw)).toThrow(/不要写这个字段/);
  });

  it('wrongCooldownSec 是负数 / 字符串 / null → 抛错', () => {
    for (const bad of [-1, '10', null]) {
      const raw = validRaw();
      raw.puzzle.wrongCooldownSec = bad;
      expect(() => parseLevelConfig(raw)).toThrow(/wrongCooldownSec/);
    }
  });
});

describe('输入方式的校验', () => {
  /** 造一份「数字键盘」配置 */
  function numberpadRaw(): Record<string, any> {
    const raw = validRaw();
    raw.puzzle.input = 'numberpad';
    raw.puzzle.answer = ['2', '4', '1'];
    delete raw.puzzle.submitNodeId;
    delete raw.puzzle.requiredItems;
    return raw;
  }

  /** 造一份「表单」配置 */
  function formRaw(): Record<string, any> {
    const raw = validRaw();
    raw.puzzle.input = 'form';
    raw.puzzle.answer = { 岗位: '接线员', 编号: '07' };
    raw.puzzle.fieldOptions = {
      岗位: ['接线员', '志愿者', '社团负责人'],
      编号: ['07', '03', '12'],
    };
    delete raw.puzzle.submitNodeId;
    delete raw.puzzle.requiredItems;
    return raw;
  }

  it('不写 input 就是 none，提交点必填', () => {
    const raw = validRaw();
    delete raw.puzzle.input;
    const config = parseLevelConfig(raw);
    expect(config.puzzle.input).toBe('none');
    expect(config.puzzle.submitNodeId).toBe('hs_b_submit');
  });

  it('input 是 none 但没写 submitNodeId → 抛错（没有提交方式，死局）', () => {
    const raw = validRaw();
    delete raw.puzzle.submitNodeId;
    expect(() => parseLevelConfig(raw)).toThrow(/submitNodeId 缺失/);
  });

  it('数字键盘：不写 submitNodeId 也行，提交按钮在键盘上', () => {
    const config = parseLevelConfig(numberpadRaw());
    expect(config.puzzle.input).toBe('numberpad');
    expect(config.puzzle.submitNodeId).toBeUndefined();
  });

  it('数字键盘：答案是对象 → 抛错', () => {
    const raw = numberpadRaw();
    raw.puzzle.answer = { a: '1' };
    expect(() => parseLevelConfig(raw)).toThrow(/answer 必须是数字数组/);
  });

  it('数字键盘：答案里有多位数或字母 → 抛错（键盘根本打不出来，死局）', () => {
    for (const bad of [['10'], ['a'], ['2', '4', '1', 'x']]) {
      const raw = numberpadRaw();
      raw.puzzle.answer = bad;
      expect(() => parseLevelConfig(raw)).toThrow(/数字键盘打不出来/);
    }
  });

  it('表单：不写 fieldOptions → 抛错', () => {
    const raw = formRaw();
    delete raw.puzzle.fieldOptions;
    expect(() => parseLevelConfig(raw)).toThrow(/必须提供 fieldOptions/);
  });

  it('表单：答案是数组 → 抛错', () => {
    const raw = formRaw();
    raw.puzzle.answer = ['a', 'b'];
    expect(() => parseLevelConfig(raw)).toThrow(/answer 必须写成对象/);
  });

  it('表单：某个空没有候选项 → 抛错', () => {
    const raw = formRaw();
    delete raw.puzzle.fieldOptions['岗位'];
    expect(() => parseLevelConfig(raw)).toThrow(/缺少 "岗位"/);
  });

  it('表单：候选项里有多余的键 → 抛错（两边必须一一对应）', () => {
    const raw = formRaw();
    raw.puzzle.fieldOptions['备注'] = ['a'];
    expect(() => parseLevelConfig(raw)).toThrow(/没有对应的空/);
  });

  it('表单：某个空的候选项里没有正确答案 → 抛错（点遍所有选项也填不对，死局）', () => {
    const raw = formRaw();
    raw.puzzle.fieldOptions['岗位'] = ['志愿者', '社团负责人'];
    expect(() => parseLevelConfig(raw)).toThrow(/没有正确答案/);
  });

  it('表单：候选项是空数组 → 抛错', () => {
    const raw = formRaw();
    raw.puzzle.fieldOptions['岗位'] = [];
    expect(() => parseLevelConfig(raw)).toThrow(/至少一项的字符串数组/);
  });

  it('input 写了不认识的值 → 抛错', () => {
    const raw = validRaw();
    raw.puzzle.input = 'keyboard';
    expect(() => parseLevelConfig(raw)).toThrow(/input 必须是/);
  });
});

describe('use 热点（在装置上使用道具）的校验', () => {
  /** 给夹具的 A 视角塞一个 use 热点 */
  function withUseHotspot(patch: Record<string, unknown>): Record<string, any> {
    const raw = validRaw();
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_device',
      rect: [10, 10, 10, 10],
      action: 'use',
      acceptedItems: ['road_north'],
      ...patch,
    });
    return raw;
  }

  it('合法的 use 热点能通过校验', () => {
    const config = parseLevelConfig(withUseHotspot({}));
    const device = config.views.A.hotspots.find((h) => h.nodeId === 'hs_a_device');
    expect(device?.acceptedItems).toEqual(['road_north']);
  });

  it('use 热点没写 acceptedItems → 抛错（挑什么都对，这热点没意义）', () => {
    const raw = withUseHotspot({});
    delete raw.views.A.hotspots[raw.views.A.hotspots.length - 1].acceptedItems;
    expect(() => parseLevelConfig(raw)).toThrow(/必须提供 acceptedItems/);
  });

  it('acceptedItems 里的道具拿不到 → 抛错（永远用不了，死局）', () => {
    expect(() => parseLevelConfig(withUseHotspot({ acceptedItems: ['不存在的道具'] }))).toThrow(
      /acceptedItems 里的道具拿不到/,
    );
  });

  it('consumes 里的道具拿不到 → 抛错（死局）', () => {
    expect(() => parseLevelConfig(withUseHotspot({ consumes: ['拿不到的东西'] }))).toThrow(
      /consumes 里的道具拿不到/,
    );
  });

  it('produces 出来的道具算「拿得到」，可以给别的热点当条件', () => {
    // 合成产物（如「已盖章的领取券」）只由 use 产出，不经过 pickup。
    // 收集全集时漏掉它，会把一个合法配置误判成死局
    const raw = validRaw();
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_stamp',
      rect: [10, 10, 10, 10],
      action: 'use',
      acceptedItems: ['road_north'],
      consumes: ['road_north'],
      produces: 'stamped_ticket',
    });
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_cabinet',
      rect: [20, 20, 10, 10],
      action: 'use',
      acceptedItems: ['stamped_ticket'],
      consumes: ['stamped_ticket'],
    });
    expect(() => parseLevelConfig(raw)).not.toThrow();
  });

  it('不是 use 的热点写了 use 专属字段 → 抛错（复制粘贴改漏了）', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].acceptedItems = ['road_north'];
    expect(() => parseLevelConfig(raw)).toThrow(/只有 action 为 use 时才生效/);
  });

  it('itemId 写成数组 = 一次拾取多件', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].itemId = ['road_north', 'road_west'];
    const config = parseLevelConfig(raw);
    expect(config.views.A.hotspots[0].itemId).toEqual(['road_north', 'road_west']);
  });

  it('itemId 写成空数组 → 抛错', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].itemId = [];
    expect(() => parseLevelConfig(raw)).toThrow(/不能为空/);
  });
});
