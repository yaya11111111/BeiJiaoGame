import { describe, expect, it } from 'vitest';

import { fitContain, mapRect, mapRectIntoBox, scaleFactors, type Size } from '../assets/scripts/common/Coord';

const square: Size = { width: 1000, height: 1000 };

/** 换算是浮点乘法，边界值会有 1e-16 级的误差，比较「有没有超出」时要留容差 */
const EPS = 1e-9;

describe('坐标换算 —— scaleFactors', () => {
  it('原图和显示同尺寸时比例是 1', () => {
    expect(scaleFactors(square, square)).toEqual({ sx: 1, sy: 1 });
  });

  it('等比缩小时两个方向的比例相同', () => {
    expect(scaleFactors(square, { width: 500, height: 500 })).toEqual({ sx: 0.5, sy: 0.5 });
  });

  it('非等比时两个方向分开算 —— 图被拉伸时热点必须跟着拉伸', () => {
    expect(scaleFactors({ width: 1000, height: 500 }, { width: 1000, height: 1000 })).toEqual({ sx: 1, sy: 2 });
  });

  it('原图或显示尺寸为 0 时直接抛错，不返回 NaN 或 Infinity', () => {
    expect(() => scaleFactors({ width: 0, height: 100 }, square)).toThrow(/原图尺寸/);
    expect(() => scaleFactors(square, { width: 100, height: 0 })).toThrow(/显示尺寸/);
  });
});

describe('坐标换算 —— mapRect 翻 y', () => {
  it('左上角的矩形翻到底下原点后 y 落在顶部', () => {
    // 原图 1000x1000、等比显示 1000x1000，左上 100x100 的框
    const r = mapRect([0, 0, 100, 100], square, square);
    // 左下原点的 y = 1000 - (0 + 100) = 900，也就是贴着上边缘
    expect(r).toEqual({ x: 0, y: 900, w: 100, h: 100 });
  });

  it('左下角的矩形翻过来 y 是 0', () => {
    expect(mapRect([0, 900, 100, 100], square, square)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('翻的是下边缘而不是上边缘 —— 这是最容易写错的一处', () => {
    // 若错写成 original.height - y，这个 300 会被算成 700，热点上下颠倒
    const r = mapRect([200, 300, 100, 50], square, square);
    expect(r.y).toBe(650);
    expect(r.y).not.toBe(700);
  });

  it('带缩放时位置和尺寸一起缩放', () => {
    const r = mapRect([200, 300, 100, 50], square, { width: 500, height: 500 });
    expect(r).toEqual({ x: 100, y: 325, w: 50, h: 25 });
  });

  it('两个方向比例不同时分别应用', () => {
    const r = mapRect([0, 0, 100, 100], { width: 1000, height: 500 }, { width: 1000, height: 1000 });
    expect(r).toEqual({ x: 0, y: 800, w: 100, h: 200 });
  });

  it('整张原图映射过去正好铺满显示区', () => {
    const displayed = { width: 640, height: 360 };
    const r = mapRect([0, 0, 1000, 1000], square, displayed);
    expect(r).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });

  it('原图内的矩形换算后不会跑到显示区外面', () => {
    const displayed = { width: 800, height: 600 };
    // 采样点必须让整个矩形落在 1000x1000 的原图内，否则测的就不是这条性质了
    const positions = [0, 100, 400, 700, 899];
    for (const p of positions) {
      const r = mapRect([p, p, 100, 100], square, displayed);
      expect(r.x).toBeGreaterThanOrEqual(-EPS);
      expect(r.x + r.w).toBeLessThanOrEqual(displayed.width + EPS);
      expect(r.y).toBeGreaterThanOrEqual(-EPS);
      expect(r.y + r.h).toBeLessThanOrEqual(displayed.height + EPS);
    }
  });
});

describe('坐标换算 —— fitContain', () => {
  it('框比图更宽时左右留边、竖直方向顶满', () => {
    // 1000x1000 的图放进 2000x1000 的框 → 缩放 1，水平居中留边 500
    expect(fitContain(square, { width: 2000, height: 1000 })).toEqual({ x: 500, y: 0, w: 1000, h: 1000 });
  });

  it('框比图更高时上下留边、水平方向顶满', () => {
    expect(fitContain(square, { width: 1000, height: 2000 })).toEqual({ x: 0, y: 500, w: 1000, h: 1000 });
  });

  it('框与图同比时不留边', () => {
    expect(fitContain(square, { width: 500, height: 500 })).toEqual({ x: 0, y: 0, w: 500, h: 500 });
  });

  it('始终等比 —— 内容宽高比与原图一致', () => {
    const wide: Size = { width: 1600, height: 900 };
    for (const box of [
      { width: 960, height: 640 },
      { width: 640, height: 960 },
      { width: 1920, height: 1080 },
    ]) {
      const r = fitContain(wide, box);
      expect(r.w / r.h).toBeCloseTo(wide.width / wide.height, 10);
    }
  });

  it('图片完整落在框内，永远不会被裁掉一块', () => {
    // cover 会把图裁掉，被裁的区域热点点不到 —— 这正是不能用 cover 的原因
    const box = { width: 960, height: 640 };
    const r = fitContain({ width: 1600, height: 900 }, box);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(box.width);
    expect(r.y + r.h).toBeLessThanOrEqual(box.height);
  });

  it('尺寸非法时抛错', () => {
    expect(() => fitContain(square, { width: 0, height: 640 })).toThrow(/可用区域/);
  });
});

describe('坐标换算 —— mapRectIntoBox 把留边一起算了', () => {
  it('结果等于 fitContain 的留边 + mapRect 的图内位置', () => {
    const box = { width: 2000, height: 1000 };
    const displayed = fitContain(square, box); // {x:500,y:0,w:1000,h:1000}
    const inner = mapRect([0, 0, 100, 100], square, { width: displayed.w, height: displayed.h });

    expect(inner).toEqual({ x: 0, y: 900, w: 100, h: 100 });
    expect(mapRectIntoBox([0, 0, 100, 100], square, box)).toEqual({
      x: displayed.x + inner.x,
      y: displayed.y + inner.y,
      w: inner.w,
      h: inner.h,
    });
  });

  it('左右留边的框会把 x 整体推进去', () => {
    expect(mapRectIntoBox([0, 0, 100, 100], square, { width: 2000, height: 1000 })).toEqual({
      x: 500,
      y: 900,
      w: 100,
      h: 100,
    });
  });

  it('上下留边的框会把 y 整体抬上去', () => {
    // 1000x1000 的图放进 1000x2000 的框 → 缩放 1，竖直居中留边 500，
    // 左上角的框在图内是 y=900，所以最终 y = 500 + 900 = 1400
    expect(mapRectIntoBox([0, 0, 100, 100], square, { width: 1000, height: 2000 })).toEqual({
      x: 0,
      y: 1400,
      w: 100,
      h: 100,
    });
  });

  it('不留边时与直接 mapRect 一致', () => {
    const box = { width: 500, height: 500 };
    expect(mapRectIntoBox([200, 300, 100, 50], square, box)).toEqual(
      mapRect([200, 300, 100, 50], square, box),
    );
  });

  it('整张图铺满 box 内后，任何一个热点都落在 box 范围内', () => {
    // 这条守的是「热点跑到屏幕外点不到」这类只在某种屏幕比例下才犯的错
    const box = { width: 960, height: 640 };
    const corners: Array<[number, number, number, number]> = [
      [0, 0, 1, 1],
      [999, 0, 1, 1],
      [0, 999, 1, 1],
      [999, 999, 1, 1],
    ];
    for (const rect of corners) {
      const r = mapRectIntoBox(rect, square, box);
      expect(r.x).toBeGreaterThanOrEqual(-EPS);
      expect(r.y).toBeGreaterThanOrEqual(-EPS);
      expect(r.x + r.w).toBeLessThanOrEqual(box.width + EPS);
      expect(r.y + r.h).toBeLessThanOrEqual(box.height + EPS);
    }
  });
});
