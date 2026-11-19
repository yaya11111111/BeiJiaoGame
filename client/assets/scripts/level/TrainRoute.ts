/** 第七站：原图左上原点，1536×864。站点判定、移动、高亮共用这组中心线。 */
export type TrackPoint = readonly [number, number];
export type TrainRouteId = 'round1' | 'round2a' | 'round2b' | 'formal';
export type TrainStation = 'southGate' | 'shadeRoad' | 'siyuan' | 'library' | 'canteen4' |
  'mechanical' | 'teaching8' | 'westField' | 'studentCenter' | 'depot' | 'mainExhibit';
export const TRAIN_STATION_NAMES: Record<TrainStation, string> = {
  southGate: '南门', shadeRoad: '林荫路', siyuan: '思源楼', library: '图书馆',
  canteen4: '学四餐厅', mechanical: '机械楼', teaching8: '八教', westField: '西操场',
  studentCenter: '学生活动中心', depot: '测试回库', mainExhibit: '天佑会堂前主展区',
};
export interface TrainLeg { station: TrainStation; points: readonly TrackPoint[]; duration: number }
const gate: TrackPoint = [785, 838];
const shade: TrackPoint = [685, 730];
const siyuan: TrackPoint = [735, 220];
const library: TrackPoint = [1490, 270];
const canteen: TrackPoint = [1380, 665];
const mechanical: TrackPoint = [1104, 449];
const teaching: TrackPoint = [1000, 14];
const west: TrackPoint = [27, 442];
const student: TrackPoint = [147, 636];
function leg(station: TrainStation, points: readonly TrackPoint[]): TrainLeg {
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return { station, points, duration: Math.max(0.6, Math.min(1.8, distance / 400)) };
}
const approach = [
  leg('shadeRoad', [gate, [756, 801], [723, 766], shade]),
  leg('siyuan', [shade, [648, 676], [622, 626], [603, 575], [595, 527], [601, 480],
    [619, 431], [644, 379], [673, 324], [702, 272], siyuan]),
];
const outer = leg('westField', [siyuan, [680, 218], [624, 212], [572, 199], [521, 181],
  [466, 164], [412, 148], [358, 135], [308, 124], [282, 114], [239, 141], [194, 174],
  [151, 211], [111, 253], [78, 300], [51, 350], [33, 398], west]);
const inner = [
  leg('library', [siyuan, [850, 208], [970, 198], [1090, 188], [1210, 180], [1330, 170],
    [1440, 162], [1465, 202], library]),
  leg('canteen4', [library, [1510, 344], [1516, 418], [1505, 483], [1478, 546], [1436, 607], canteen]),
  leg('mechanical', [canteen, [1320, 724], [1256, 763], [1205, 779], [1181, 758],
    [1159, 714], [1139, 662], [1120, 608], [1103, 554], [1096, 506], mechanical]),
];
const afterC = [
  leg('teaching8', [mechanical, [1120, 405], [1145, 365], [1169, 321], [1186, 274],
    [1197, 224], [1201, 174], [1193, 123], [1174, 75], [1147, 32], [1122, 14], teaching]),
  leg('westField', [teaching, [900, 10], [790, 10], [670, 13], [550, 25], [440, 48],
    [340, 79], [249, 125], [194, 174], [151, 211], [111, 253], [78, 300], [51, 350], [33, 398], west]),
];
const toStudent = leg('studentCenter', [west, [32, 490], [50, 539], [79, 583], [111, 615], student]);
const returnHome = [
  leg('depot', [student, [169, 687], [220, 737], [294, 779], [384, 809], [485, 826]]),
  leg('southGate', [[485, 826], [585, 837], [680, 842], gate]),
];
export const TRAIN_ROUTES: Record<TrainRouteId, readonly TrainLeg[]> = {
  round1: approach.concat(outer, toStudent, returnHome),
  round2a: approach.concat(inner),
  round2b: afterC.concat(toStudent, returnHome),
  formal: approach.concat(inner, afterC, toStudent,
    leg('mainExhibit', [student, [201, 646], [282, 650], [375, 650], [465, 650]])),
};
export const TRAIN_DWELL_SEC = 0.25;
export function trainRouteDuration(route: TrainRouteId): number {
  return TRAIN_ROUTES[route].reduce((sum, entry) => sum + entry.duration + TRAIN_DWELL_SEC, 0);
}
export function trainRoutePoints(route: TrainRouteId): TrackPoint[] {
  return TRAIN_ROUTES[route].reduce<TrackPoint[]>((all, entry) => all.concat(entry.points.slice(all.length ? 1 : 0)), []);
}
/** 按折线长度插值，弯道不会直接连站点切角。图片车头朝右，角度转成 Cocos 的逆时针。 */
export function sampleTrainRoute(route: TrainRouteId, elapsed: number): { point: TrackPoint; angle: number; passed: TrainStation[] } {
  const passed: TrainStation[] = [];
  const legs = TRAIN_ROUTES[route];
  let time = Math.max(0, elapsed);
  let current = legs[legs.length - 1];
  for (const entry of legs) {
    current = entry;
    if (time < entry.duration) break;
    passed.push(entry.station);
    if (time < entry.duration + TRAIN_DWELL_SEC) { time = entry.duration; break; }
    time -= entry.duration + TRAIN_DWELL_SEC;
    if (entry === legs[legs.length - 1]) time = entry.duration;
  }
  const lengths = current.points.slice(1).map((p, i) => Math.hypot(p[0] - current.points[i][0], p[1] - current.points[i][1]));
  let distance = lengths.reduce((a, b) => a + b, 0) * Math.min(1, time / current.duration);
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] || i === lengths.length - 1) {
      const start = current.points[i], end = current.points[i + 1];
      const ratio = Math.min(1, distance / (lengths[i] || 1));
      return { point: [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio],
        angle: -Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI, passed };
    }
    distance -= lengths[i];
  }
  return { point: gate, angle: 0, passed };
}
