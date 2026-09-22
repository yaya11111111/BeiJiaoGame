import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { setToArray } from '../assets/scripts/common/Collections';
import { Emitter } from '../assets/scripts/common/Emitter';

const here = dirname(fileURLToPath(import.meta.url));

describe('setToArray', () => {
  it('按插入顺序返回全部元素', () => {
    const set = new Set(['a', 'b', 'c']);
    expect(setToArray(set)).toEqual(['a', 'b', 'c']);
  });

  it('返回的是新数组，改它不影响原 Set', () => {
    const set = new Set([1, 2]);
    const arr = setToArray(set);
    arr.push(3);
    expect(set.size).toBe(2);
    expect(setToArray(set)).toEqual([1, 2]);
  });

  it('空 Set 得到空数组', () => {
    expect(setToArray(new Set<number>())).toEqual([]);
  });

  it('元素本身是对象时不做任何加工', () => {
    const obj = { id: 'x' };
    expect(setToArray(new Set([obj]))[0]).toBe(obj);
  });
});

describe('Emitter 遍历期间被修改', () => {
  type Events = { ping: { n: number } };

  it('监听器里取消订阅不会打乱本次遍历', () => {
    // emit 要先复制一份再遍历。不复制的话，监听器里调 off() 会让 Set 在遍历中途变化，
    // 后面的监听器可能被跳过。
    const emitter = new Emitter<Events>();
    const seen: string[] = [];

    const offSecond = emitter.on('ping', () => seen.push('第二个'));
    emitter.on('ping', () => {
      seen.push('第一个');
      offSecond();
    });

    emitter.emit('ping', { n: 1 });
    expect(seen).toEqual(['第二个', '第一个']);
  });

  it('取消订阅之后不再收到事件', () => {
    const emitter = new Emitter<Events>();
    let count = 0;
    const off = emitter.on('ping', () => {
      count += 1;
    });

    emitter.emit('ping', { n: 1 });
    off();
    emitter.emit('ping', { n: 2 });
    expect(count).toBe(1);
  });

  it('一个监听器抛错不影响同一次事件里的其他监听器', () => {
    const emitter = new Emitter<Events>();
    let reached = false;
    emitter.on('ping', () => {
      throw new Error('故意抛的');
    });
    emitter.on('ping', () => {
      reached = true;
    });

    expect(() => emitter.emit('ping', { n: 1 })).not.toThrow();
    expect(reached).toBe(true);
  });
});

/**
 * 源码守护：禁止对非数组使用展开运算符。
 *
 * 这条不是洁癖，是踩过的坑：Cocos 的构建管线用 Babel 的 loose 模式把 `[...set]`
 * 编译成 `[].concat(set)`，而 concat 只展开数组 —— 拿到的是 `[set 自己]`，
 * 构建产物里一调用就报 `TypeError: s is not a function`。
 *
 * 关键在于**浏览器预览不会暴露它**（预览保留 ES2015+ 语法），
 * 所以本地怎么点都没事，只有真机 / 构建产物炸 —— 而真机正是本项目的验收口径。
 *
 * 用 Set/Map 转数组请走 common/Collections.ts 的 setToArray()。
 */
describe('源码守护：展开运算符只允许用在数组上', () => {
  /** 已确认是数组的展开，逐条登记。新增一项前先确认操作数真的是数组。 */
  const ALLOWED_ARRAY_SPREADS = new Set([
    // rewards.progress 在 LevelTypes 里声明为 string[]
    'this.config.rewards.progress',
    // hotspot.rect 是 [number, number, number, number] 元组
    'hotspot.rect',
  ]);

  const SCRIPTS_DIR = resolve(here, '../assets/scripts');

  function collectTsFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(dir, name));
  }

  it('每个展开运算符的操作数都已登记', () => {
    const offenders: string[] = [];

    for (const file of collectTsFiles(SCRIPTS_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // 跳过注释，注释里会写到这个反例
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

        for (const match of line.matchAll(/\[\.\.\.([^\]]+)\]/g)) {
          const operand = match[1].trim();
          if (ALLOWED_ARRAY_SPREADS.has(operand)) continue;
          offenders.push(`${file.replace(SCRIPTS_DIR, 'assets/scripts')}:${index + 1}  [...${operand}]`);
        }
      });
    }

    expect(
      offenders,
      `发现未登记的展开运算符：\n${offenders.join('\n')}\n\n` +
        '如果是数组，确认后加进 ALLOWED_ARRAY_SPREADS；' +
        '如果是 Set / Map，改用 Collections.ts 的 setToArray()。',
    ).toEqual([]);
  });

  it('守护本身有效：能抓到对 Set 用展开的写法', () => {
    // 防止这条测试因为正则写错而永远通过 —— 空跑的守护等于没有守护
    const sample = 'const arr = [...someSet];';
    const found = [...sample.matchAll(/\[\.\.\.([^\]]+)\]/g)].map((m) => m[1].trim());
    expect(found).toEqual(['someSet']);
    expect(ALLOWED_ARRAY_SPREADS.has('someSet')).toBe(false);
  });
});
