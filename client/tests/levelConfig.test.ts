import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LevelConfigError, buildIndex, levelConfigPath, parseLevelConfig } from '../assets/scripts/common/LevelConfig';
import { LevelRuntime } from '../assets/scripts/level/LevelRuntime';

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
    expect(config.puzzle!.input).toBe('form');
    // 表单关的提交按钮在面板里，所以不该再放一个提交热点
    expect(config.puzzle!.submitNodeId).toBeUndefined();
  });

  it('level.01.json 能通过校验，并且是「操作通关」型（没有 puzzle）', () => {
    const config = parseLevelConfig(loadRaw('level.01.json'));
    expect(config.levelId).toBe('L01');
    // 第 1 关最后一步是「把券插进 06 号柜」，那是操作不是答题，所以没有 puzzle
    expect(config.puzzle).toBeUndefined();

    const all = [...config.views.A.hotspots, ...config.views.B.hotspots];
    const finisher = all.filter((h) => h.completes);
    expect(finisher).toHaveLength(1);
    expect(finisher[0].nodeId).toBe('hs_a_cabinet');

    // 工具盒是密码门，密码取自初稿：登记=2、盖章=4、领取礼包=1
    const toolbox = all.find((h) => h.nodeId === 'hs_a_toolbox');
    expect(toolbox?.code).toEqual(['2', '4', '1']);
  });

  it('每条真实关卡的通关条件都不止一个 —— 防止改设计时把它删了', () => {
    for (const file of ['level.guide.json', 'level.01.json', 'level.02.json', 'level.03.json', 'level.04.json', 'level.05.json', 'level.06.json']) {
      const config = parseLevelConfig(loadRaw(file));
      const all = [...config.views.A.hotspots, ...config.views.B.hotspots];
      const hasPuzzle = config.puzzle !== undefined;
      const hasFinisher = all.some((h) => h.completes);
      expect(hasPuzzle || hasFinisher, `${file} 没有任何通关条件`).toBe(true);
    }
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
    expect(() => loadRaw(`${levelConfigPath('L02').replace('configs/', '')}.json`)).not.toThrow();
    expect(() => loadRaw(`${levelConfigPath('L03').replace('configs/', '')}.json`)).not.toThrow();
    expect(() => loadRaw(`${levelConfigPath('L04').replace('configs/', '')}.json`)).not.toThrow();
    expect(() => loadRaw(`${levelConfigPath('L05').replace('configs/', '')}.json`)).not.toThrow();
    expect(() => loadRaw(`${levelConfigPath('L06').replace('configs/', '')}.json`)).not.toThrow();
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
    expect(config.puzzle!.answer).toEqual({ 岗位: '接线员', 编号: '07', 地点: '南门内侧' });
  });

  it('有序答案（数组）照旧能用，没有破坏老配置', () => {
    const config = parseLevelConfig(validRaw());
    expect(Array.isArray(config.puzzle!.answer)).toBe(true);
    expect(config.puzzle!.answer).toEqual(['road_north', 'road_west']);
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
    expect(parseLevelConfig(raw).puzzle!.wrongCooldownSec).toBe(10);
  });

  it('不写 wrongCooldownSec → 就是「不惩罚」，不是错', () => {
    expect(parseLevelConfig(validRaw()).puzzle!.wrongCooldownSec).toBeUndefined();
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
    expect(config.puzzle!.input).toBe('none');
    expect(config.puzzle!.submitNodeId).toBe('hs_b_submit');
  });

  it('input 是 none 但没写 submitNodeId → 抛错（没有提交方式，死局）', () => {
    const raw = validRaw();
    delete raw.puzzle.submitNodeId;
    expect(() => parseLevelConfig(raw)).toThrow(/submitNodeId 缺失/);
  });

  it('数字键盘：不写 submitNodeId 也行，提交按钮在键盘上', () => {
    const config = parseLevelConfig(numberpadRaw());
    expect(config.puzzle!.input).toBe('numberpad');
    expect(config.puzzle!.submitNodeId).toBeUndefined();
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
    // 合成产物也要有显示名，否则道具面板会列出 stamped_ticket 这种技术 id
    raw.items['stamped_ticket'] = '已盖章的券';
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

describe('通关条件：答题通 或 操作通，二选一但必须有一个', () => {
  /** 造一个「没有 puzzle、靠 completes 热点通关」的配置 */
  function completesRaw(): Record<string, any> {
    const raw = validRaw();
    delete raw.puzzle;
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_cabinet',
      rect: [10, 10, 10, 10],
      action: 'use',
      acceptedItems: ['road_north'],
      completes: true,
    });
    return raw;
  }

  it('没有 puzzle、但有 completes 热点 → 通过', () => {
    const config = parseLevelConfig(completesRaw());
    expect(config.puzzle).toBeUndefined();
    expect(config.views.A.hotspots.some((h) => h.completes)).toBe(true);
  });

  it('既没有 puzzle 也没有 completes → 抛错（玩家做对了也没反应，死局）', () => {
    const raw = validRaw();
    delete raw.puzzle;
    expect(() => parseLevelConfig(raw)).toThrow(/没有任何通关条件/);
  });

  it('两者都有也允许 —— 有的关卡中途答一题、最后再做个操作', () => {
    const raw = completesRaw();
    // puzzle 是「点热点提交」型，所以必须有 submitNodeId
    raw.puzzle = { type: 'route_rebuild', answer: ['a'], submitNodeId: 'hs_b_submit' };
    expect(() => parseLevelConfig(raw)).not.toThrow();
  });

  it('completes 标在非 use 热点上 → 抛错（别的动作没有「成功」这一步）', () => {
    const raw = validRaw();
    raw.puzzle = { type: 'route_rebuild', answer: ['a'], submitNodeId: 'hs_b_submit' };
    raw.views.A.hotspots[0].completes = true; // pickup
    // 拦在 parseHotspot：「非 use 却写了 use 专属字段」，比在汇总处再查一遍更早也更准
    expect(() => parseLevelConfig(raw)).toThrow(/只有 action 为 use 时才生效/);
  });

  it('submitNodeId 指向 use 热点 → 抛错（use 不经过答题判定，通不了）', () => {
    const raw = completesRaw();
    raw.puzzle = { type: 'route_rebuild', answer: ['a'], submitNodeId: 'hs_a_cabinet' };
    expect(() => parseLevelConfig(raw)).toThrow(/必须是 submit/);
  });
});

describe('密码门（use 热点的 code）', () => {
  function codeRaw(code: unknown): Record<string, any> {
    const raw = validRaw();
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_toolbox',
      rect: [10, 10, 10, 10],
      action: 'use',
      code,
    });
    return raw;
  }

  it('合法的密码能通过校验', () => {
    const config = parseLevelConfig(codeRaw(['2', '4', '1']));
    const toolbox = config.views.A.hotspots.find((h) => h.nodeId === 'hs_a_toolbox');
    expect(toolbox?.code).toEqual(['2', '4', '1']);
  });

  it('密码里有多位数或字母 → 抛错（数字键盘打不出来，死局）', () => {
    expect(() => parseLevelConfig(codeRaw(['10', '2']))).toThrow(/数字键盘打不出来/);
    expect(() => parseLevelConfig(codeRaw(['a']))).toThrow(/数字键盘打不出来/);
  });

  it('密码是空数组 → 抛错', () => {
    expect(() => parseLevelConfig(codeRaw([]))).toThrow(/不能是空数组/);
  });

  it('use 热点既没 acceptedItems 也没 code → 抛错（做什么都对，热点没意义）', () => {
    const raw = validRaw();
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_device',
      rect: [10, 10, 10, 10],
      action: 'use',
    });
    expect(() => parseLevelConfig(raw)).toThrow(/必须提供 acceptedItems.*code.*choices/);
  });

  it('非 use 热点写 code → 抛错（复制粘贴改漏了）', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].code = ['1'];
    expect(() => parseLevelConfig(raw)).toThrow(/只有 action 为 use 时才生效/);
  });

  it('produces 写成数组 = 一次产出多件', () => {
    const raw = validRaw();
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_box',
      rect: [10, 10, 10, 10],
      action: 'use',
      code: ['2', '4', '1'],
      produces: ['road_north', 'road_west'],
    });
    const config = parseLevelConfig(raw);
    const box = config.views.A.hotspots.find((h) => h.nodeId === 'hs_a_box');
    expect(box?.produces).toEqual(['road_north', 'road_west']);
  });
});

describe('固定选项门（choices）的校验', () => {
  function forkRaw(patch: Record<string, unknown>): Record<string, any> {
    const raw = validRaw();
    raw.views.A.hotspots.push({
      nodeId: 'hs_a_fork',
      rect: [10, 10, 10, 10],
      action: 'use',
      choices: ['路灯', '花坛', '长凳'],
      correctChoice: '路灯',
      ...patch,
    });
    return raw;
  }

  it('合法的选项门能通过校验', () => {
    const config = parseLevelConfig(forkRaw({}));
    const fork = config.views.A.hotspots.find((h) => h.nodeId === 'hs_a_fork');
    expect(fork?.choices).toEqual(['路灯', '花坛', '长凳']);
    expect(fork?.correctChoice).toBe('路灯');
  });

  it('correctChoice 不在 choices 里 → 抛错（选遍所有选项也过不去，死局）', () => {
    expect(() => parseLevelConfig(forkRaw({ correctChoice: '操场' }))).toThrow(/不在 choices 里/);
  });

  it('给了 choices 却没写 correctChoice → 抛错（判定时无从比起）', () => {
    const raw = forkRaw({});
    delete raw.views.A.hotspots[raw.views.A.hotspots.length - 1].correctChoice;
    expect(() => parseLevelConfig(raw)).toThrow(/必须配 correctChoice/);
  });

  it('choices 是空数组 → 抛错', () => {
    expect(() => parseLevelConfig(forkRaw({ choices: [], correctChoice: '' }))).toThrow(/不能是空数组/);
  });

  it('非 use 热点写 choices → 抛错（复制粘贴改漏了）', () => {
    const raw = validRaw();
    raw.views.A.hotspots[0].choices = ['a'];
    expect(() => parseLevelConfig(raw)).toThrow(/只有 action 为 use 时才生效/);
  });
});

describe('道具的显示名（items）', () => {
  it('拿得到的道具没写显示名 → 抛错，并列出缺哪几个', () => {
    const raw = validRaw();
    delete raw.items['road_north'];
    expect(() => parseLevelConfig(raw)).toThrow(/这些道具没有显示名：road_north/);
  });

  it('一件都没写 → 抛错（界面上会直接显示技术 id，玩家看不懂）', () => {
    const raw = validRaw();
    delete raw.items;
    expect(() => parseLevelConfig(raw)).toThrow(/没有显示名/);
  });

  it('显示名是空串或非字符串 → 抛错', () => {
    const raw = validRaw();
    raw.items['road_north'] = '';
    expect(() => parseLevelConfig(raw)).toThrow(/items\.road_north/);
  });

  it('道具在运行时会带上显示名 —— 界面显示名字，id 只在配置里流转', () => {
    const config = parseLevelConfig(validRaw());
    const runtime = new LevelRuntime(config, { mode: 'solo' });
    runtime.click('hs_a_road_north');
    expect(runtime.getInventory()[0]).toEqual({
      itemId: 'road_north',
      name: '北路口',
      fromNodeId: 'hs_a_road_north',
    });
  });
});
