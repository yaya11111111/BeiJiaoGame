/**
 * 校园地图布局（新版手绘地图）。
 *
 * 地图资源由三张图构成：
 * - 彩色图（美术原图）本身不直接铺满：初始整张图是灰的；
 * - 每个关卡对应一块「区域」，区域由标注图上的黑色分区线围出来，
 *   解锁该关后把这块区域的彩色补丁（`campus-region-*.png`）盖回灰底图；
 * - 红色框是关卡点位，只用来确定编号圆标的位置，不参与上色。
 *
 * 坐标全部是**相对底图**的百分比，原点在左上角；渲染时再换算成 Cocos 的
 * 左下原点坐标。这样换分辨率 / 换底图时只需要改这一份表。
 *
 * 这个文件不 import `cc`，也不读 `wx`，单测可以直接跑。
 */

export interface MapRect {
  /** 左边缘，0-1 */
  x: number;
  /** 上边缘，0-1（图片坐标，向下为正） */
  y: number;
  width: number;
  height: number;
}

export interface CampusMapRegionSpec {
  levelId: string;
  /** `resources` 下的彩色补丁路径（不带扩展名） */
  patchAsset: string;
  /** 补丁在底图上的矩形（图片百分比） */
  rect: MapRect;
  /** 图鉴里的地图彩蛋 id，沿用 AppState.MAP_REGIONS 的 interactionId */
  achievementId: string;
}

export interface MapNodePoint {
  /** 0-1，图片左上角原点 */
  x: number;
  y: number;
}

export const CAMPUS_MAP = {
  grayAsset: 'images/campus-map-gray',
  /** 底图原始像素尺寸，用于保持宽高比 */
  width: 1040,
  height: 600,
  aspect: 1040 / 600,
} as const;

/**
 * 11 块区域。矩形来自标注图（图一）黑色分区线的像素级识别：
 * 用关卡点位做种子、沿黑色分区线做连通填充，得到每关自己的那块区域。
 * 补丁文件名后缀是标注图的站次。第 6～8 站换序后，关卡 ID 仍用于存档。
 */
export const CAMPUS_MAP_REGIONS: readonly CampusMapRegionSpec[] = [
  {
    levelId: 'GUIDE',
    patchAsset: 'images/campus-region-guide',
    rect: { x: 0.27788, y: 0.88333, width: 0.3, height: 0.11667 },
    achievementId: 'achievement_south_gate_entrance',
  },
  {
    levelId: 'L01',
    patchAsset: 'images/campus-region-l01',
    rect: { x: 0.35, y: 0.68833, width: 0.21442, height: 0.19 },
    achievementId: 'achievement_south_gate',
  },
  {
    levelId: 'L02',
    patchAsset: 'images/campus-region-l02',
    rect: { x: 0.33558, y: 0.51333, width: 0.23365, height: 0.16333 },
    achievementId: 'achievement_east_west_gates',
  },
  {
    levelId: 'L03',
    patchAsset: 'images/campus-region-l03',
    rect: { x: 0.34615, y: 0.34667, width: 0.24327, height: 0.16167 },
    achievementId: 'achievement_siyuan',
  },
  {
    levelId: 'L04',
    patchAsset: 'images/campus-region-l04',
    rect: { x: 0.59135, y: 0.35167, width: 0.09327, height: 0.40833 },
    achievementId: 'achievement_library',
  },
  {
    levelId: 'L05',
    patchAsset: 'images/campus-region-l05',
    rect: { x: 0.57788, y: 0.77333, width: 0.33365, height: 0.16 },
    achievementId: 'achievement_minghu',
  },
  {
    levelId: 'L06',
    patchAsset: 'images/campus-region-l06',
    rect: { x: 0.69135, y: 0.35167, width: 0.28173, height: 0.40833 },
    achievementId: 'achievement_history',
  },
  {
    levelId: 'L07',
    patchAsset: 'images/campus-region-l07',
    rect: { x: 0.35962, y: 0.01, width: 0.62308, height: 0.33667 },
    achievementId: 'achievement_train',
  },
  {
    levelId: 'L08',
    patchAsset: 'images/campus-region-l08',
    rect: { x: 0.00577, y: 0.005, width: 0.33942, height: 0.34833 },
    achievementId: 'achievement_sports',
  },
  {
    levelId: 'L09',
    patchAsset: 'images/campus-region-l09',
    rect: { x: 0.00577, y: 0.36833, width: 0.3375, height: 0.245 },
    achievementId: 'achievement_service_center',
  },
  {
    levelId: 'L10',
    patchAsset: 'images/campus-region-l10',
    rect: { x: 0.00288, y: 0.63667, width: 0.34135, height: 0.26833 },
    achievementId: 'achievement_main_exhibit',
  },
];

/**
 * 关卡编号圆标的位置（图一红框的中心）。GUIDE 是南门口，0 号。
 * 这些点是**标在建筑上的**，不参与区域上色，只决定可点击圆标画在哪里。
 */
export const CAMPUS_MAP_NODES: Record<string, MapNodePoint> = {
  GUIDE: { x: 0.44, y: 0.935 },
  L01: { x: 0.3991, y: 0.786 },
  L02: { x: 0.411, y: 0.577 },
  L03: { x: 0.3996, y: 0.4298 },
  L04: { x: 0.6418, y: 0.4339 },
  L05: { x: 0.6384, y: 0.8917 },
  L07: { x: 0.8069, y: 0.6868 },
  L08: { x: 0.5647, y: 0.281 },
  L06: { x: 0.1727, y: 0.2033 },
  L09: { x: 0.0652, y: 0.4934 },
  L10: { x: 0.3007, y: 0.7124 },
};

export function mapNodePoint(levelId: string): MapNodePoint | null {
  return CAMPUS_MAP_NODES[levelId] || null;
}

export function mapRegionForLevel(levelId: string): CampusMapRegionSpec | null {
  return CAMPUS_MAP_REGIONS.filter((region) => region.levelId === levelId)[0] || null;
}

/**
 * 这块区域要不要显示成彩色。
 *
 * - 未解锁：灰；
 * - 已解锁 / 已通关：彩色；
 * - **新手引导是例外**：GUIDE 一开始就是「可进入」，但地图应当从全灰开始，
 *   所以 GUIDE 区域要等它**通关**（也就是 L01 解锁）才上色。
 */
export function shouldColorMapRegion(
  nodeState: 'locked' | 'unlocked' | 'completed',
  levelId: string,
): boolean {
  if (nodeState === 'locked') return false;
  if (levelId === 'GUIDE') return nodeState === 'completed';
  return true;
}

/** 当前应当显示的彩色区域（按底图表顺序），供渲染直接遍历 */
export function coloredMapRegions(
  nodes: ReadonlyArray<{ levelId: string; state: 'locked' | 'unlocked' | 'completed' }>,
): CampusMapRegionSpec[] {
  const colored = new Set(
    nodes
      .filter((node) => shouldColorMapRegion(node.state, node.levelId))
      .map((node) => node.levelId),
  );
  return CAMPUS_MAP_REGIONS.filter((region) => colored.has(region.levelId));
}
