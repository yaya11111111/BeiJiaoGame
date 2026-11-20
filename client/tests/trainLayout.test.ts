import { describe, expect, it } from 'vitest';
import { trainSceneLayout } from '../assets/scripts/level/TrainLayout';

describe('第七站手机布局', () => {
  it.each([
    { width: 1280, height: 720, inset: { left: 0, right: 0, top: 0, bottom: 0 } },
    { width: 1558, height: 720, inset: { left: 87, right: 0, top: 0, bottom: 39 } },
    { width: 1600, height: 720, inset: { left: 100, right: 60, top: 20, bottom: 86 } },
    { width: 1920, height: 720, inset: { left: 0, right: 0, top: 0, bottom: 0 } },
    { width: 960, height: 720, inset: { left: 0, right: 0, top: 0, bottom: 0 } },
  ])('$width×$height：地图居中、贴近面板，行车按钮避开退出/重玩', ({ width, height, inset }) => {
    const { map, controls, caption, manualText } = trainSceneLayout({ width, height }, inset);
    expect(manualText.y + manualText.h).toBeLessThanOrEqual(height / 2 - inset.top - 144);
    expect(manualText.y).toBeGreaterThanOrEqual(-height / 2 + inset.bottom + 124);
    expect(manualText.h).toBeGreaterThan(100);
    expect(map.w / map.h).toBeCloseTo(16 / 9);
    expect(controls.x - map.x - map.w).toBeCloseTo(16);
    // 整组内容的中心与安全区中心一致，超宽手机不会把空白都留在中间。
    expect((map.x + controls.x + controls.w) / 2).toBeCloseTo((inset.left - inset.right) / 2);
    expect(map.x).toBeGreaterThanOrEqual(-width / 2 + inset.left + 20 - 0.001);
    expect(controls.x + controls.w).toBeLessThanOrEqual(width / 2 - inset.right - 20 + 0.001);
    const restartTop = -height / 2 + inset.bottom + 20 + 44 * 2 + 8;
    expect(controls.y - restartTop).toBeGreaterThanOrEqual(16 - 0.001);
    expect(controls.y + 36 - 21).toBeGreaterThan(restartTop);
    const switchBottom = height / 2 - inset.top - 20 - 96;
    expect(switchBottom - (controls.y + controls.h)).toBeGreaterThanOrEqual(12 - 0.001);
    expect(caption.y + caption.h).toBeLessThan(map.y);
    expect(caption.y + caption.h / 2).toBeLessThan(-height / 2 + inset.bottom + 66);
    expect(controls.h - 305).toBeGreaterThan(0);
  });
  it('超宽屏提高地图面积，不再受旧的 560 高度上限限制', () => {
    const { map } = trainSceneLayout({ width: 1920, height: 720 }, { left: 0, right: 0, top: 0, bottom: 0 });
    expect(map.h).toBeGreaterThan(560);
    expect(map.w).toBeGreaterThan(995);
  });
});
