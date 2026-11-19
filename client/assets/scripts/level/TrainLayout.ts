import type { LocalRect, Size } from '../common/Coord';

export interface TrainSafeInsets { left: number; right: number; top: number; bottom: number }
export interface TrainSceneLayout {
  /** 以画面中心为原点，y 向上。 */
  map: LocalRect;
  controls: LocalRect;
  caption: LocalRect;
}

/** 地图和面板整体居中；右侧上下角的 HUD 各留出一块独立区域。 */
export function trainSceneLayout(box: Size, inset: TrainSafeInsets): TrainSceneLayout {
  const left = -box.width / 2 + inset.left + 20;
  const right = box.width / 2 - inset.right - 20;
  const top = box.height / 2 - inset.top;
  const bottom = -box.height / 2 + inset.bottom;
  const panelW = 292;
  const gap = 16;
  // 切视角：20 边距 + 96 直径 + 12 间距。
  const panelTop = top - 128;
  // 重玩/退出：20 边距 + 两个 44 高按钮 + 8 间距，再留 16 间距。
  const panelBottom = bottom + 132;
  const panelH = Math.min(470, panelTop - panelBottom);
  const mapH = Math.min(top - 16 - (bottom + 82), (right - left - panelW - gap) * 9 / 16);
  const mapW = mapH * 16 / 9;
  const groupLeft = left + (right - left - mapW - panelW - gap) / 2;
  return {
    map: { x: groupLeft, y: (top - 16 + bottom + 82 - mapH) / 2, w: mapW, h: mapH },
    controls: { x: groupLeft + mapW + gap, y: (panelTop + panelBottom - panelH) / 2, w: panelW, h: panelH },
    caption: { x: groupLeft, y: bottom + 6, w: mapW, h: 64 },
  };
}
