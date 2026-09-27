import { _decorator, Color, Component, Graphics, Label, Node, UITransform, Vec3 } from 'cc';
import {
  AppState,
  CollectionEntry,
  CampusGateView,
  MapAnchor,
  MAP_NODES,
  MINI_PROGRAM_CONFIG,
  MapNodeView,
  completeLevel,
  createInitialAppState,
  createLocalRoom,
  formatTime,
  getMapNodes,
  getMapRegions,
  getCampusGates,
  getSelectedMapNode,
  joinLocalRoom,
  leaveRoom,
  navigateTo,
  selectMapNode,
  selectMode,
  signinAsGuest,
  startSelectedLevel,
  toggleSetting,
} from './AppState';
import { mountLevel } from '../level/LevelMountView';
import { initWechatCloud } from './WechatCloud';

const { ccclass } = _decorator;

const W = 1280;
const H = 720;
const TOPBAR_H = 78;

interface MapFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface Rect extends Point {
  width: number;
  height: number;
}

interface RotatedCampusPoints {
  southGate: Point;
  westGate: Point;
  eastGate: Point;
  northGate: Point;
  library: Point;
  siyuan: Point;
  fourthTeaching: Point;
  eighthTeaching: Point;
  lake: Point;
  sports: Point;
  serviceCenter: Point;
  yifu: Point;
}

interface CampusBuildingSpec {
  anchor: MapAnchor;
  label: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  fill: Color;
  roof?: Color;
}

const C = {
  ink: new Color(41, 51, 68, 255),
  muted: new Color(119, 128, 146, 255),
  bg: new Color(232, 237, 243, 255),
  paper: new Color(255, 250, 240, 255),
  blue: new Color(107, 145, 201, 255),
  blueDeep: new Color(65, 105, 163, 255),
  mint: new Color(156, 207, 189, 255),
  coral: new Color(242, 147, 120, 255),
  yellow: new Color(244, 201, 106, 255),
  line: new Color(210, 202, 185, 255),
  green: new Color(95, 147, 108, 255),
  locked: new Color(157, 163, 159, 255),
  white: Color.WHITE,
};

/**
 * 两位补零。
 *
 * **不要用 `String.prototype.padStart`** —— 它是 ES2017 的 API，而 Cocos 的
 * target/lib 是 ES2015，用了会在编辑器里报 TS2550（和 `Array.prototype.includes`
 * 是同一类坑，README 里记着）。
 *
 * 这个错单测抓不到：vitest 的 target 更高，`padStart` 在那边完全合法。
 * 只有 `npm run typecheck:view`（对齐 Cocos 的编译参数）和真机才会暴露。
 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

@ccclass('AppShellView')
export class AppShellView extends Component {
  private state: AppState = createInitialAppState();
  private root: Node | null = null;
  private placedBuildingRects: Rect[] = [];
  private placedLabelRects: Rect[] = [];

  onLoad(): void {
    initWechatCloud();
    this.ensureCanvas();
    this.root = this.makeNode('E-AppRoot', this.node, W, H, -W / 2, -H / 2);
    this.render();
  }

  private ensureCanvas(): void {
    const ui = this.node.getComponent(UITransform) || this.node.addComponent(UITransform);
    ui.setContentSize(W, H);
  }

  private render(): void {
    if (!this.root) return;
    this.root.removeAllChildren();
    this.rect(this.root, W, H, 0, 0, C.bg);
    this.drawTopbar();

    if (this.state.page === 'signin') this.drawSignin();
    if (this.state.page === 'home') this.drawHome();
    if (this.state.page === 'mode') this.drawModeSelect();
    if (this.state.page === 'room') this.drawRoom();
    if (this.state.page === 'map') this.drawMap();
    if (this.state.page === 'levels') this.drawLevels();
    if (this.state.page === 'collection') this.drawCollection();
    if (this.state.page === 'settings') this.drawSettings();
    if (this.state.page === 'level-bridge') this.drawLevelBridge();
    if (this.state.page === 'result') this.drawResult();
  }

  private drawTopbar(): void {
    this.rect(this.root!, W, TOPBAR_H, 0, H - TOPBAR_H, new Color(255, 250, 240, 232), new Color(225, 218, 205, 255));
    this.roundRect(this.root!, 40, 40, 42, H - 59, C.yellow, C.ink, 10);
    this.text('知', 62, H - 39, 24, C.ink, 36, 'CENTER', true);
    this.text('知行谜站', 94, H - 36, 17, C.ink, 150, 'LEFT', true);

    if (!this.state.profile) {
      this.text('北京交通大学 · 校园协作解谜', 226, H - 39, 14, C.muted, 260, 'LEFT');
      return;
    }

    this.topNav('首页', 360, 'home');
    this.topNav('校园地图', 455, 'map');
    this.topNav('关卡目录', 575, 'levels');
    this.topNav('成就图鉴', 695, 'collection');
    this.topNav('设置', 815, 'settings');
    this.text('已连接本地演示', 985, H - 39, 14, C.green, 180, 'LEFT', true);
    this.circle(1190, H - 39, 18, C.blue);
    this.text('E', 1190, H - 39, 18, C.white, 36, 'CENTER', true);
  }

  private topNav(title: string, x: number, page: 'home' | 'map' | 'levels' | 'collection' | 'settings'): void {
    const active = this.state.page === page;
    this.button(title, x, H - 39, page === 'home' || page === 'settings' ? 76 : 100, 38, () => this.setState(navigateTo(this.state, page)), active ? C.white : new Color(0, 0, 0, 0), active ? C.ink : C.muted, false);
  }

  private drawSignin(): void {
    this.cardPanel(320, 210, 640, 350);
    this.text('知行谜站', 640, 450, 42, C.ink, 360, 'CENTER', true);
    this.text('微信小游戏端外层页面原型', 640, 405, 20, C.muted, 420, 'CENTER');
    this.text('AppID ' + MINI_PROGRAM_CONFIG.appId + ' · Env ' + MINI_PROGRAM_CONFIG.cloudEnv, 640, 372, 15, C.muted, 560, 'CENTER');
    this.button('微信登录 / 本地演示', 640, 310, 290, 58, () => this.setState(signinAsGuest(this.state, '玩家 E')), C.blueDeep, C.white);
    this.text('后续接 C 的 wx.login、users、progress 接口。', 640, 250, 16, C.muted, 440, 'CENTER');
  }

  private drawHome(): void {
    this.contentTitle('北京交通大学 · 校园协作解谜', '知行谜站，', '把另一半线索说出来。');
    this.button('开始游戏', 180, 310, 150, 52, () => this.setState(navigateTo(this.state, 'mode')), C.blueDeep, C.white);
    this.button('查看校园地图', 360, 310, 170, 52, () => this.setState(navigateTo(this.state, 'map')), C.white, C.ink);
    this.levelSketchCard(720, 212, 470, 300);
    this.featureCard('⌁', '校园地图', 90, 82, C.mint);
    this.featureCard('◎', '单人 / 好友', 310, 82, C.yellow);
    this.featureCard('▤', '成就图鉴', 530, 82, C.coral);
    this.progressPanel(750, 82, 410, 100);
  }

  private drawModeSelect(): void {
    this.pageHeading('选择游玩方式', '第一阶段网页原型里的模式弹窗，在小游戏端拆成独立页面。');
    this.modeCard('单人模式', '一台设备内切换 A / B 两个视角，适合先跑通剧情与谜题。', 185, 275, C.mint, () => this.setState(selectMode(this.state, 'solo')));
    this.modeCard('好友双人', '创建房间或输入房间码，各持一个视角协作找线索。', 665, 275, C.yellow, () => this.setState(selectMode(this.state, 'duo')));
    this.backButton('home');
  }

  private drawRoom(): void {
    this.pageHeading('好友双人房间', 'C 的房间接口未接入前，这里先保留本地演示状态。');
    const room = this.state.room;
    this.cardPanel(110, 215, 500, 250);
    this.text(room ? '房间码 ' + room.inviteCode : '还没有房间', 360, 400, 34, C.ink, 360, 'CENTER', true);
    this.text(room ? '玩家 ' + room.playerCount + '/2 · 已准备 ' + room.readyCount : '创建房间或加入 2048 进行演示。', 360, 352, 19, C.muted, 380, 'CENTER');
    this.button('创建房间', 270, 280, 150, 50, () => this.setState(createLocalRoom(this.state)), C.blueDeep, C.white);
    this.button('加入 2048', 450, 280, 150, 50, () => this.setState(joinLocalRoom(this.state, '2048')), C.white, C.ink);
    this.cardPanel(690, 245, 360, 190);
    this.text('准备进入地图', 870, 380, 28, C.ink, 280, 'CENTER', true);
    this.text('双人同步、断线重连、邀请分享等待 C 的 API。', 870, 335, 17, C.muted, 300, 'CENTER');
    this.button('进入地图', 870, 280, 160, 50, () => this.setState(navigateTo(this.state, 'map')), C.green, C.white);
    this.button('离开房间', 870, 220, 160, 42, () => this.setState(leaveRoom(this.state)), C.white, C.ink);
    this.backButton('mode');
  }

  private drawMap(): void {
    this.drawCampusMap(30, 28, 1220, 590);
  }

  private drawCampusMap(x: number, y: number, w: number, h: number): void {
    this.text('校园地图', x, y + h - 8, 34, C.ink, 220, 'LEFT', true);
    this.roundRect(this.root!, w, h - 52, x, y, new Color(223, 234, 208, 255), C.ink, 18);
    const mapX = x + 22;
    const mapY = y + 22;
    const mapW = w - 44;
    const mapH = h - 96;
    this.relativeCampusBase(mapX, mapY, mapW, mapH);
    this.drawMapRegions(mapX, mapY, mapW, mapH);
    const nodes = getMapNodes(this.state).filter((node) => node.visible !== false);
    this.drawLevelRoute(nodes, mapX, mapY, mapW, mapH);
    nodes.forEach((node, index) => this.mapNode(node, index + 1, mapX, mapY, mapW, mapH));
  }

  private drawMapRegions(x: number, y: number, w: number, h: number): void {
    getMapRegions(this.state).forEach((region) => {
      const rect = this.relativeRect(
        { x, y, width: w, height: h },
        region.anchor,
        region.widthCells,
        region.heightCells,
        region.offsetX,
        region.offsetY,
      );
      const regionX = rect.x;
      const regionY = rect.y;
      const regionW = rect.width;
      const regionH = rect.height;
      if (region.state === 'locked') {
        this.drawFogRegion(regionX, regionY, regionW, regionH, region.order);
      } else {
        const border = region.state === 'completed'
          ? new Color(217, 154, 79, 155)
          : new Color(242, 147, 120, 150);
        this.outlineRect(this.root!, regionW, regionH, regionX, regionY, border, 2);
        this.regionTag(region.title, regionX, regionY + regionH - 20, regionW);
        this.mapInteractionPoint(region, regionX, regionY, regionW, regionH);
      }
    });
  }

  private drawLevelRoute(nodes: MapNodeView[], x: number, y: number, w: number, h: number): void {
    const frame: MapFrame = { x, y, width: w, height: h };
    const points = nodes.map((node) => this.nodePosition(node, x, y, w, h));
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const color = nodes[i].state === 'locked' ? C.locked : C.coral;
      const path = this.levelRoutePath(i - 1, a, b, frame);
      for (let j = 1; j < path.length; j += 1) {
        // Keep every dashed segment inside the painted campus frame. This is
        // intentionally stricter than clamping the level nodes themselves:
        // route waypoints must never leak into the outer page background.
        const start = this.clampPointToFrame(path[j - 1], frame, 24);
        const end = this.clampPointToFrame(path[j], frame, 24);
        if (Math.abs(start.x - end.x) > 1 || Math.abs(start.y - end.y) > 1) {
          this.dashedLine(start.x, start.y, end.x, end.y, color);
        }
      }
    }
  }

  private levelRoutePath(index: number, start: Point, end: Point, frame: MapFrame): Point[] {
    const campus = this.rotatedCampusPoints(frame);
    const center = campus.library;
    const southRoad = campus.southGate;
    const northRoad = campus.northGate;
    const westRoad = campus.westGate;
    const eastRoad = campus.eastGate;

    switch (index) {
      case 0:
        return [start, { x: start.x, y: end.y }, end];
      case 1:
        return [start, southRoad, { x: eastRoad.x, y: southRoad.y }, { x: eastRoad.x, y: end.y }, end];
      case 2:
        return [start, { x: eastRoad.x, y: start.y }, { x: eastRoad.x, y: center.y }, { x: center.x, y: center.y }, end];
      case 3:
        return [start, { x: center.x, y: northRoad.y - frame.height * 0.28 }, { x: eastRoad.x, y: northRoad.y - frame.height * 0.28 }, end];
      case 4:
        return [start, { x: eastRoad.x, y: start.y }, { x: westRoad.x, y: start.y }, { x: westRoad.x, y: end.y }, end];
      case 5:
        return [start, { x: westRoad.x, y: start.y }, { x: westRoad.x, y: end.y }, end];
      case 6:
        return [start, { x: westRoad.x, y: start.y }, { x: eastRoad.x, y: start.y }, { x: eastRoad.x, y: end.y }, end];
      case 7:
        return [start, { x: eastRoad.x, y: southRoad.y }, { x: westRoad.x, y: southRoad.y }, { x: westRoad.x, y: end.y }, end];
      default:
        return [start, { x: start.x, y: end.y }, end];
    }
  }

  private drawFogRegion(x: number, y: number, width: number, height: number, seed: number): void {
    // A soft fog bank keeps the map readable while making locked areas feel undiscovered.
    this.rect(this.root!, width, height, x, y, new Color(92, 101, 105, 12));

    const patterns = [
      [
        [0.16, 0.68, 0.27, 0.28], [0.39, 0.78, 0.31, 0.24], [0.66, 0.68, 0.32, 0.3],
        [0.86, 0.48, 0.25, 0.26], [0.58, 0.38, 0.35, 0.24], [0.27, 0.32, 0.3, 0.25],
      ],
      [
        [0.12, 0.42, 0.28, 0.25], [0.32, 0.66, 0.34, 0.3], [0.62, 0.76, 0.33, 0.25],
        [0.84, 0.58, 0.3, 0.3], [0.7, 0.28, 0.34, 0.22], [0.27, 0.22, 0.3, 0.24],
      ],
      [
        [0.2, 0.78, 0.34, 0.25], [0.48, 0.58, 0.34, 0.3], [0.78, 0.76, 0.3, 0.28],
        [0.82, 0.38, 0.34, 0.25], [0.52, 0.22, 0.3, 0.22], [0.18, 0.3, 0.25, 0.2],
      ],
    ];
    const pattern = patterns[(seed - 1) % patterns.length];

    pattern.forEach((item, index) => {
      const cx = x + width * item[0];
      const cy = y + height * item[1];
      const rx = width * item[2] / 2;
      const ry = height * item[3] / 2;
      this.ellipse(cx + 3, cy - 2, rx, ry, new Color(116, 123, 125, 24), new Color(0, 0, 0, 0));
      this.ellipse(cx, cy, rx, ry, new Color(224, 227, 224, index % 2 === 0 ? 62 : 50), new Color(0, 0, 0, 0));
    });

    const wisps = [
      [0.18, 0.58, 0.38, 0.08],
      [0.51, 0.48, 0.45, 0.09],
      [0.78, 0.32, 0.31, 0.07],
    ];
    wisps.forEach((wisp, index) => {
      this.ellipse(
        x + width * wisp[0],
        y + height * wisp[1],
        width * wisp[2] / 2,
        height * wisp[3] / 2,
        new Color(242, 243, 239, index === 1 ? 34 : 26),
        new Color(0, 0, 0, 0),
      );
    });
  }

  private placeRelativeTo(frame: MapFrame, anchor: MapAnchor, offsetX = 0, offsetY = 0): Point {
    const cellWidth = frame.width / 3;
    const cellHeight = frame.height / 3;
    const columns: Record<MapAnchor, number> = {
      southWest: 0, south: 1, southEast: 2,
      west: 0, center: 1, east: 2,
      northWest: 0, north: 1, northEast: 2,
    };
    const rows: Record<MapAnchor, number> = {
      southWest: 0, south: 0, southEast: 0,
      west: 1, center: 1, east: 1,
      northWest: 2, north: 2, northEast: 2,
    };
    return {
      x: frame.x + cellWidth * (columns[anchor] + 0.5) + offsetX,
      y: frame.y + cellHeight * (rows[anchor] + 0.5) + offsetY,
    };
  }

  private relativeRect(
    frame: MapFrame,
    anchor: MapAnchor,
    widthCells: number,
    heightCells: number,
    offsetX = 0,
    offsetY = 0,
  ): Rect {
    const center = this.placeRelativeTo(frame, anchor, offsetX, offsetY);
    const cellWidth = frame.width / 3;
    const cellHeight = frame.height / 3;
    return {
      x: center.x - cellWidth * widthCells / 2,
      y: center.y - cellHeight * heightCells / 2,
      width: cellWidth * widthCells,
      height: cellHeight * heightCells,
    };
  }

  private nodePosition(node: MapNodeView, x: number, y: number, w: number, h: number): Point {
    const landmark = this.landmarkPointForLevel(node.levelId, { x, y, width: w, height: h });
    if (landmark) return this.clampPointToFrame(landmark, { x, y, width: w, height: h }, 28);
    return this.clampPointToFrame(this.placeRelativeTo(
      { x, y, width: w, height: h },
      node.anchor,
      node.offsetX,
      node.offsetY,
    ), { x, y, width: w, height: h }, 28);
  }

  /**
   * The official map is read with the south gate as the origin. These points
   * are shared by the landmark drawings and the level markers so a marker
   * cannot drift away when a background building is reflowed.
   */
  private landmarkPointForLevel(levelId: string, frame: MapFrame): Point | null {
    const campus = this.rotatedCampusPoints(frame);
    const points: Record<string, Point> = {
      L01: campus.southGate,
      L02: { x: campus.southGate.x + 18, y: campus.southGate.y + 70 },
      L03: campus.siyuan,
      L04: campus.library,
      L05: { x: campus.lake.x + 12, y: campus.lake.y - 20 },
      L06: campus.sports,
      L07: campus.fourthTeaching,
      L08: campus.eighthTeaching,
      L09: campus.serviceCenter,
      L10: campus.yifu,
    };
    return points[levelId] || null;
  }

  private rotatedCampusPoints(frame: MapFrame): RotatedCampusPoints {
    const { x, y, width, height } = frame;
    // The 3D reference is treated as a slightly clockwise-rotated plan:
    // south-west at the lower-left, north-east at the upper-right.
    return {
      southGate: { x: x + width * 0.24, y: y + height * 0.1 },
      westGate: { x: x + width * 0.08, y: y + height * 0.48 },
      eastGate: { x: x + width * 0.9, y: y + height * 0.28 },
      northGate: { x: x + width * 0.78, y: y + height * 0.9 },
      library: { x: x + width * 0.5, y: y + height * 0.52 },
      siyuan: { x: x + width * 0.57, y: y + height * 0.36 },
      fourthTeaching: { x: x + width * 0.42, y: y + height * 0.28 },
      eighthTeaching: { x: x + width * 0.66, y: y + height * 0.67 },
      lake: { x: x + width * 0.71, y: y + height * 0.79 },
      sports: { x: x + width * 0.29, y: y + height * 0.78 },
      serviceCenter: { x: x + width * 0.27, y: y + height * 0.25 },
      yifu: { x: x + width * 0.7, y: y + height * 0.24 },
    };
  }

  private clampPointToFrame(point: Point, frame: MapFrame, padding: number): Point {
    return {
      x: Math.max(frame.x + padding, Math.min(frame.x + frame.width - padding, point.x)),
      y: Math.max(frame.y + padding, Math.min(frame.y + frame.height - padding, point.y)),
    };
  }

  private regionTag(title: string, x: number, y: number, width: number): void {
    const tagWidth = Math.min(width - 12, Math.max(92, title.length * 14 + 20));
    this.roundRect(this.root!, tagWidth, 22, x + (width - tagWidth) / 2, y, new Color(255, 250, 240, 190), new Color(255, 255, 255, 0), 5);
    this.text(title, x + width / 2, y + 11, 12, C.ink, tagWidth - 8, 'CENTER', true);
  }

  private mapInteractionPoint(region: { state: string; achievementFound: boolean }, x: number, y: number, w: number, h: number): void {
    const pointX = x + w * 0.22;
    const pointY = y + h * 0.3;
    if (region.achievementFound) {
      this.circle(pointX, pointY, 10, C.coral, C.ink);
      this.circle(pointX + 7, pointY - 8, 4, C.green, C.ink);
      this.text('★', pointX + 16, pointY + 1, 15, C.yellow, 22, 'CENTER', true);
      return;
    }
    this.circle(pointX, pointY, 8, new Color(255, 250, 240, 220), C.coral);
    this.circle(pointX, pointY, 3, C.coral);
  }

  private relativeCampusBase(x: number, y: number, w: number, h: number): void {
    this.placedBuildingRects = [];
    this.placedLabelRects = [];
    const frame: MapFrame = { x, y, width: w, height: h };
    const cellWidth = w / 3;
    const cellHeight = h / 3;
    const campus = this.rotatedCampusPoints(frame);
    const { westGate, eastGate, southGate, northGate } = campus;
    // Cocos UI coordinates grow upward. The requested geographic orientation
    // is therefore represented by explicit gate points rather than by assuming
    // that a larger y value means "south".
    const southAxis = southGate;
    const libraryPoint = campus.library;
    const westTeachingPoint = campus.fourthTeaching;
    const eastTeachingPoint = campus.siyuan;
    const eighthTeachingPoint = campus.eighthTeaching;
    const lakePoint = campus.lake;
    const sportsPoint = campus.sports;
    const servicePoint = campus.serviceCenter;
    const yifuPoint = campus.yifu;

    // 校园边界：保持原来的浅绿手绘纸张风格，但明确上北下南、左西右东。
    this.polygon([
      [x + cellWidth * 0.12, y + cellHeight * 0.18],
      [x + cellWidth * 0.32, y + cellHeight * 0.05],
      [x + cellWidth * 2.7, y + cellHeight * 0.05],
      [x + cellWidth * 2.9, y + cellHeight * 0.18],
      [x + cellWidth * 2.9, y + cellHeight * 2.78],
      [x + cellWidth * 2.68, y + cellHeight * 2.94],
      [x + cellWidth * 0.3, y + cellHeight * 2.94],
      [x + cellWidth * 0.12, y + cellHeight * 2.78],
    ], new Color(185, 214, 157, 255), new Color(76, 102, 79, 255), 4);

    // 外环路：把南门、北门、西门、东门串成一圈。
    this.smallRoad(x + cellWidth * 0.28, y + cellHeight * 0.15, x + cellWidth * 2.72, y + cellHeight * 0.15);
    this.smallRoad(x + cellWidth * 0.28, y + cellHeight * 2.85, x + cellWidth * 2.72, y + cellHeight * 2.85);
    this.smallRoad(x + cellWidth * 0.16, y + cellHeight * 0.28, x + cellWidth * 0.16, y + cellHeight * 2.72);
    this.smallRoad(x + cellWidth * 2.84, y + cellHeight * 0.28, x + cellWidth * 2.84, y + cellHeight * 2.72);

    // 两条主干道：南北直通，东西横穿图书馆南侧。
    this.mapRoad(southGate.x, southGate.y, northGate.x, northGate.y, 25);
    this.mapRoad(westGate.x, westGate.y, eastGate.x, eastGate.y, 25);
    // Secondary paths remain part of the campus fabric and are intentionally
    // narrower and slightly darker than the two main roads.
    this.smallRoad(x + cellWidth * 0.18, y + cellHeight * 0.34, x + cellWidth * 0.82, y + cellHeight * 0.34);
    this.smallRoad(x + cellWidth * 0.28, y + cellHeight * 0.62, x + cellWidth * 0.5, y + cellHeight * 0.62);
    this.smallRoad(x + cellWidth * 1.42, y + cellHeight * 0.46, x + cellWidth * 2.62, y + cellHeight * 0.46);
    this.smallRoad(x + cellWidth * 1.9, y + cellHeight * 0.22, x + cellWidth * 1.9, y + cellHeight * 1.72);
    this.smallRoad(x + cellWidth * 2.22, y + cellHeight * 1.22, x + cellWidth * 2.78, y + cellHeight * 1.22);

    // 西北：西操场。西侧看台用浅色短条强调。
    const sportsWidth = cellWidth * 0.72;
    const sportsHeight = cellHeight * 0.46;
    this.sportsField(
      sportsPoint.x - sportsWidth / 2,
      sportsPoint.y - sportsHeight / 2,
      sportsWidth,
      sportsHeight,
    );
    for (let i = 0; i < 4; i += 1) {
      this.rect(this.root!, cellWidth * 0.05, cellHeight * 0.06, x + cellWidth * 0.38, y + cellHeight * (2.18 + i * 0.1), new Color(210, 213, 206, 255), C.ink);
    }

    // 中心：图书馆和南侧喷泉广场。
    this.landmarkBuilding(frame, libraryPoint, 0.58, 0.34, new Color(199, 210, 216, 255), '图书馆');
    const fountain = { x: libraryPoint.x, y: libraryPoint.y - cellHeight * 0.38 };
    this.circle(fountain.x, fountain.y, cellHeight * 0.12, new Color(239, 231, 211, 230), new Color(128, 119, 101, 122));
    this.circle(fountain.x, fountain.y, cellHeight * 0.045, new Color(143, 208, 213, 255), new Color(95, 141, 145, 255));

    // 南部：思源楼在主干道东侧，四教在主干道西侧。
    this.landmarkBuilding(frame, eastTeachingPoint, 0.42, 0.28, new Color(210, 213, 206, 255), '思源楼');
    this.steps(eastTeachingPoint.x - cellWidth * 0.22, eastTeachingPoint.y - cellHeight * 0.18, cellWidth * 0.2);
    this.landmarkBuilding(frame, westTeachingPoint, 0.5, 0.3, new Color(217, 130, 117, 255), '四教');

    // 东北：明湖与湖畔餐厅。
    this.lake(lakePoint.x, lakePoint.y, cellWidth * 0.48, cellHeight * 0.46);
    const restaurantPoint = { x: lakePoint.x + 10, y: lakePoint.y - 58 };
    this.landmarkBuilding(frame, restaurantPoint, 0.3, 0.22, C.yellow, '明湖餐厅');
    this.umbrella(restaurantPoint.x + cellWidth * 0.17, restaurantPoint.y + cellHeight * 0.05);

    // 东侧：第八教学楼紧挨东西主干道，门前放小火车模型。
    this.landmarkBuilding(frame, eighthTeachingPoint, 0.42, 0.2, new Color(210, 213, 206, 255), '八教');
    const train = eighthTeachingPoint;
    this.train(train.x - cellWidth * 0.12, train.y, cellWidth * 0.24);

    // 西南：学生活动服务中心和社团帐篷。
    this.landmarkBuilding(frame, servicePoint, 0.5, 0.32, C.yellow, '学生活动中心');
    this.triangle(x + cellWidth * 0.48, y + cellHeight * 0.76, x + cellWidth * 0.53, y + cellHeight * 0.92, x + cellWidth * 0.58, y + cellHeight * 0.76, C.coral);
    this.triangle(x + cellWidth * 0.61, y + cellHeight * 0.76, x + cellWidth * 0.66, y + cellHeight * 0.92, x + cellWidth * 0.71, y + cellHeight * 0.76, C.blue);

    // 东南：逸夫楼和迎新主展区舞台。
    this.landmarkBuilding(frame, yifuPoint, 0.46, 0.28, new Color(181, 90, 75, 255), '逸夫楼');
    this.rect(this.root!, cellWidth * 0.34, cellHeight * 0.1, x + cellWidth * 2.2, y + cellHeight * 0.82, C.coral, C.ink);
    this.triangle(x + cellWidth * 2.13, y + cellHeight * 0.92, x + cellWidth * 2.37, y + cellHeight * 1.05, x + cellWidth * 2.61, y + cellHeight * 0.92, C.yellow);

    // Official main-campus labels: small named blocks fill in the surrounding
    // campus fabric without replacing the larger landmark drawings above.
    this.drawNamedCampusBuildings(frame);

    // 南门在最下方中央，拱门和小树林是第一关的核心识别物。
    this.southGateArch(southGate.x - cellWidth * 0.27, y + cellHeight * 0.02, cellWidth * 0.54, cellHeight * 0.34);
    const groveX = southGate.x - 118;
    this.southGateGrove(groveX, southGate.y + 16, 150, 88);
    this.drawCampusGates(frame);

    this.mapLabel('西操场', sportsPoint.x, sportsPoint.y + sportsHeight * 0.58);
    this.mapLabel('明湖', lakePoint.x, lakePoint.y + 58);
    this.mapLabel('南门小树林', groveX + 75, southGate.y + 112);
  }

  private landmarkBuilding(
    frame: MapFrame,
    center: Point,
    widthCells: number,
    heightCells: number,
    fill: Color,
    label: string,
  ): void {
    const cellWidth = frame.width / 3;
    const cellHeight = frame.height / 3;
    const requestedRect = this.fitRectInsideFrame({
      x: center.x - cellWidth * widthCells / 2,
      y: center.y - cellHeight * heightCells / 2,
      width: cellWidth * widthCells,
      height: cellHeight * heightCells,
    }, frame, 5);
    // Core landmarks are the reference geometry. Never move them to satisfy
    // a background-building collision; the background layer must yield.
    const rect = requestedRect;
    this.placedBuildingRects.push(rect);
    this.rect(this.root!, rect.width, rect.height, rect.x, rect.y, fill, C.ink);
    this.rect(this.root!, rect.width * 0.82, rect.height * 0.16, rect.x + rect.width * 0.09, rect.y + rect.height * 0.2, new Color(255, 250, 240, 105));
    const windowCount = Math.max(2, Math.floor(rect.width / 18));
    for (let i = 0; i < windowCount; i += 1) {
      this.rect(
        this.root!,
        Math.max(4, rect.width * 0.07),
        Math.max(3, rect.height * 0.12),
        rect.x + rect.width * (0.12 + i * 0.76 / Math.max(1, windowCount - 1)),
        rect.y + rect.height * 0.46,
        new Color(143, 208, 213, 190),
        new Color(95, 141, 145, 130),
      );
    }
    this.rect(this.root!, rect.width * 0.12, rect.height * 0.22, rect.x + rect.width * 0.44, rect.y, C.paper, C.ink);
    this.drawBuildingLabel(frame, label, rect);
  }

  private drawNamedCampusBuildings(frame: MapFrame): void {
    const mutedRoof = new Color(255, 250, 240, 120);
    const redRoof = new Color(181, 90, 75, 210);
    const blueRoof = new Color(143, 174, 191, 220);
    const specs: CampusBuildingSpec[] = [
      // 只保留官方主校区中能帮助识别方位的教学楼、办公楼和实验设施。
      // 核心地标已经先绘制并固定，背景建筑不允许覆盖核心区域。
      { anchor: 'northWest', label: '第五教学楼', width: 0.42, height: 0.16, offsetX: -0.42, offsetY: -0.1, fill: new Color(217, 130, 117, 255), roof: redRoof },
      { anchor: 'northWest', label: '第七教学楼', width: 0.38, height: 0.15, offsetX: 0.38, offsetY: -0.1, fill: new Color(217, 130, 117, 255), roof: redRoof },
      { anchor: 'north', label: '第一教学楼', width: 0.42, height: 0.16, offsetX: -0.35, offsetY: 0.06, fill: new Color(217, 130, 117, 255), roof: redRoof },
      { anchor: 'north', label: '第九教学楼', width: 0.36, height: 0.14, offsetX: 0.54, offsetY: 0.34, fill: new Color(217, 130, 117, 255), roof: redRoof },
      { anchor: 'northEast', label: '运输设备教学馆', width: 0.38, height: 0.14, offsetX: 0.34, offsetY: -0.05, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'northEast', label: '机械工程楼', width: 0.4, height: 0.15, offsetX: -0.44, offsetY: -0.42, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'northEast', label: '工程训练楼', width: 0.34, height: 0.14, offsetX: 0.86, offsetY: -0.18, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'northEast', label: '6号办公楼', width: 0.3, height: 0.13, offsetX: 0.72, offsetY: -0.62, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'northEast', label: '12号办公楼', width: 0.3, height: 0.13, offsetX: 0.9, offsetY: -0.42, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'west', label: '思源西楼', width: 0.36, height: 0.15, offsetX: -0.05, offsetY: 0.02, fill: new Color(199, 210, 216, 255), roof: blueRoof },
      { anchor: 'west', label: '信息中心', width: 0.34, height: 0.14, offsetX: -0.52, offsetY: -0.55, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'west', label: '修缮服务中心', width: 0.38, height: 0.14, offsetX: 0.42, offsetY: -0.88, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'southWest', label: '建筑与艺术楼', width: 0.38, height: 0.15, offsetX: 0.08, offsetY: 0.16, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'southWest', label: '天佑会堂', width: 0.36, height: 0.15, offsetX: -0.5, offsetY: -0.48, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'southWest', label: '后勤集团', width: 0.34, height: 0.13, offsetX: -0.68, offsetY: -0.76, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'east', label: '科学会堂', width: 0.34, height: 0.15, offsetX: 0.64, offsetY: -0.22, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'east', label: '电气工程楼', width: 0.36, height: 0.15, offsetX: 0.46, offsetY: 0.66, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'east', label: '工程结构实验室', width: 0.4, height: 0.14, offsetX: 0.9, offsetY: 0.42, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'east', label: '热力站', width: 0.24, height: 0.12, offsetX: 0.96, offsetY: -0.36, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'east', label: '向阳办公区', width: 0.34, height: 0.14, offsetX: 0.92, offsetY: -0.78, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'northWest', label: '光波楼', width: 0.3, height: 0.13, offsetX: -0.82, offsetY: -0.58, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
      { anchor: 'northWest', label: '隧道中心', width: 0.3, height: 0.13, offsetX: -0.42, offsetY: -0.76, fill: new Color(210, 213, 206, 255), roof: mutedRoof },
    ];

    specs.forEach((spec) => this.detailedBuilding(frame, spec));

    // Named open-air facilities from the official campus map.
    this.basketballCourt(frame, '图书馆东侧篮球场', 'northEast', -0.42, -0.92);
    this.basketballCourt(frame, '天佑南侧篮球场', 'southWest', 0.42, -0.82);
    this.basketballCourt(frame, '东运动场', 'northEast', 0.72, 0.62);
    this.basketballCourt(frame, '西运动场看台', 'northWest', -0.18, 0.05);
  }

  private basketballCourt(frame: MapFrame, label: string, anchor: MapAnchor, offsetX: number, offsetY: number): void {
    const cellWidth = frame.width / 3;
    const cellHeight = frame.height / 3;
    const rect = this.fitRectInsideFrame(
      this.relativeRect(frame, anchor, 0.28, 0.18, offsetX * cellWidth, offsetY * cellHeight),
      frame,
      4,
    );
    this.rect(this.root!, rect.width, rect.height, rect.x, rect.y, new Color(143, 208, 213, 220), C.ink);
    this.rect(this.root!, rect.width * 0.46, rect.height * 0.8, rect.x + rect.width * 0.27, rect.y + rect.height * 0.1, new Color(255, 250, 240, 120), C.ink);
    this.mapLabelInFrame(frame, label, rect.x + rect.width / 2, rect.y + rect.height + 6);
  }

  private detailedBuilding(frame: MapFrame, spec: CampusBuildingSpec): void {
    const cellWidth = frame.width / 3;
    const cellHeight = frame.height / 3;
    const safeFrame: MapFrame = {
      x: frame.x + 48,
      y: frame.y + 48,
      width: frame.width - 96,
      height: frame.height - 96,
    };
    const requestedRect = this.fitRectInsideFrame(this.relativeRect(
      frame,
      spec.anchor,
      spec.width,
      spec.height,
      spec.offsetX * cellWidth,
      spec.offsetY * cellHeight,
    ), safeFrame, 5);
    const rect = this.resolveBuildingRect(requestedRect, safeFrame);
    if (!rect) return;
    this.placedBuildingRects.push(rect);
    const roof = spec.roof || new Color(255, 250, 240, 100);
    this.rect(this.root!, rect.width, rect.height, rect.x, rect.y, new Color(41, 51, 68, 38));
    this.rect(this.root!, rect.width, rect.height, rect.x, rect.y + 3, spec.fill, C.ink);
    this.rect(this.root!, rect.width * 0.92, rect.height * 0.18, rect.x + rect.width * 0.04, rect.y + rect.height * 0.08, roof, new Color(76, 82, 83, 120));
    const windowCount = Math.max(2, Math.floor(rect.width / 18));
    for (let i = 0; i < windowCount; i += 1) {
      this.rect(
        this.root!,
        Math.max(4, rect.width * 0.07),
        Math.max(3, rect.height * 0.12),
        rect.x + rect.width * (0.12 + i * 0.76 / Math.max(1, windowCount - 1)),
        rect.y + rect.height * 0.46,
        new Color(143, 208, 213, 190),
        new Color(95, 141, 145, 130),
      );
    }
    this.rect(this.root!, rect.width * 0.12, rect.height * 0.22, rect.x + rect.width * 0.44, rect.y, C.paper, C.ink);
    this.drawBuildingLabel(frame, spec.label, rect);
  }

  private fitRectInsideFrame(rect: Rect, frame: MapFrame, padding: number): Rect {
    const width = Math.min(rect.width, frame.width - padding * 2);
    const height = Math.min(rect.height, frame.height - padding * 2);
    return {
      width,
      height,
      x: Math.max(frame.x + padding, Math.min(rect.x, frame.x + frame.width - padding - width)),
      y: Math.max(frame.y + padding, Math.min(rect.y, frame.y + frame.height - padding - height)),
    };
  }

  private mapLabelInFrame(frame: MapFrame, text: string, x: number, y: number): void {
    const estimatedWidth = Math.max(78, Math.min(180, text.length * 13 + 24));
    const clampedX = Math.max(frame.x + estimatedWidth / 2 + 4, Math.min(frame.x + frame.width - estimatedWidth / 2 - 4, x));
    const clampedY = Math.max(frame.y + 14, Math.min(frame.y + frame.height - 14, y));
    this.mapLabel(text, clampedX, clampedY);
  }

  private relativeBuilding(
    frame: MapFrame,
    anchor: MapAnchor,
    widthCells: number,
    heightCells: number,
    fill: Color,
    label: string,
    offsetX = 0,
    offsetY = 0,
  ): void {
    const requestedRect = this.fitRectInsideFrame(
      this.relativeRect(frame, anchor, widthCells, heightCells, offsetX, offsetY),
      frame,
      5,
    );
    const rect = this.resolveBuildingRect(requestedRect, frame);
    if (!rect) return;
    this.placedBuildingRects.push(rect);
    this.rect(this.root!, rect.width, rect.height, rect.x, rect.y, fill, C.ink);
    this.rect(this.root!, rect.width * 0.82, rect.height * 0.16, rect.x + rect.width * 0.09, rect.y + rect.height * 0.2, new Color(255, 250, 240, 105));
    this.drawBuildingLabel(frame, label, rect);
  }

  private resolveBuildingRect(requested: Rect, frame: MapFrame): Rect | null {
    const gap = 35;
    const candidates: Rect[] = [];
    for (let step = 0; step <= 4; step += 1) {
      const distance = step * (requested.width + gap);
      candidates.push(
        { ...requested, y: requested.y - distance },
        { ...requested, y: requested.y + distance },
        { ...requested, x: requested.x - distance },
        { ...requested, x: requested.x + distance },
        { ...requested, x: requested.x - distance, y: requested.y - distance },
        { ...requested, x: requested.x + distance, y: requested.y + distance },
      );
    }
    const valid = candidates
      .map((candidate) => this.fitRectInsideFrame(candidate, frame, 5))
      .find((candidate) => this.placedBuildingRects.every((placed) => !this.rectsOverlap(candidate, placed, gap)));
    if (valid) return valid;

    // A smaller fallback is allowed for low-priority buildings; if it still
    // collides, omit that building instead of breaking the 35px spacing rule.
    const compact = this.fitRectInsideFrame({
      x: requested.x,
      y: requested.y,
      width: requested.width * 0.72,
      height: requested.height * 0.72,
    }, frame, 5);
    return this.placedBuildingRects.every((placed) => !this.rectsOverlap(compact, placed, gap))
      ? compact
      : null;
  }

  private rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
    return !(
      a.x + a.width + gap <= b.x
      || b.x + b.width + gap <= a.x
      || a.y + a.height + gap <= b.y
      || b.y + b.height + gap <= a.y
    );
  }

  private drawBuildingLabel(frame: MapFrame, text: string, building: Rect): void {
    const labelWidth = Math.max(54, Math.min(150, text.length * 10 + 18));
    const above = {
      x: building.x + building.width / 2 - labelWidth / 2,
      y: building.y + building.height + 8,
      width: labelWidth,
      height: 18,
    };
    const below = {
      x: building.x + building.width / 2 - labelWidth / 2,
      y: building.y - 26,
      width: labelWidth,
      height: 18,
    };
    const aboveFits = this.labelFits(above, frame) && this.placedLabelRects.every((label) => !this.rectsOverlap(above, label, 4));
    const label = aboveFits ? above : below;
    const safeLabel = this.fitRectInsideFrame(label, frame, 3);
    this.placedLabelRects.push(safeLabel);
    this.roundRect(this.root!, safeLabel.width, safeLabel.height, safeLabel.x, safeLabel.y, new Color(255, 250, 240, 198), new Color(255, 255, 255, 0), 4);
    this.text(text, safeLabel.x + safeLabel.width / 2, safeLabel.y + safeLabel.height / 2, 10, C.ink, safeLabel.width - 6, 'CENTER', true);
  }

  private labelFits(label: Rect, frame: MapFrame): boolean {
    return label.x >= frame.x && label.y >= frame.y
      && label.x + label.width <= frame.x + frame.width
      && label.y + label.height <= frame.y + frame.height;
  }

  private drawCampusGates(frame: MapFrame): void {
    const gates = getCampusGates(this.state);
    gates.forEach((gate) => {
      const point = this.gatePosition(frame, gate.gateId);
      const color = gate.unlocked ? C.coral : new Color(128, 135, 135, 102);
      if (gate.gateId === 'south') {
        this.circle(point.x, point.y, 15, color, new Color(C.ink.r, C.ink.g, C.ink.b, gate.unlocked ? 255 : 102));
        return;
      }
      this.roundRect(this.root!, 56, 26, point.x - 28, point.y - 13, new Color(255, 250, 240, 210), color, 6);
      this.text(gate.unlocked ? gate.title : '灰雾 · ' + gate.title, point.x, point.y, 12, gate.unlocked ? C.ink : C.locked, 50, 'CENTER', true);
    });
  }

  private gatePosition(frame: MapFrame, gate: CampusGateView['gateId']): Point {
    const campus = this.rotatedCampusPoints(frame);
    if (gate === 'south') return campus.southGate;
    if (gate === 'west') return campus.westGate;
    if (gate === 'east') return campus.eastGate;
    return campus.northGate;
  }

  private sportsField(x: number, y: number, width: number, height: number): void {
    this.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, C.coral, C.ink);
    this.ellipse(x + width / 2, y + height / 2, width * 0.38, height * 0.31, new Color(121, 185, 121, 255), C.paper);
    this.rect(this.root!, width * 0.48, 3, x + width * 0.26, y + height / 2 - 2, C.paper);
  }

  private lake(x: number, y: number, width: number, height: number): void {
    this.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, C.paper, C.paper);
    this.ellipse(x + width / 2, y + height / 2, width * 0.44, height * 0.4, new Color(143, 208, 213, 255), new Color(95, 141, 145, 255));
    this.wave(x + width * 0.18, y + height * 0.56, x + width * 0.8, y + height * 0.56);
    this.arcBridge(x + width * 0.73, y + height * 0.6, x + width * 0.94, y + height * 0.6);
  }

  private mapRoad(x1: number, y1: number, x2: number, y2: number, width: number): void {
    this.road(x1, y1, x2, y2, width + 8, new Color(106, 119, 105, 180));
    this.road(x1, y1, x2, y2, width, new Color(246, 241, 228, 245));
    this.road(x1, y1, x2, y2, Math.max(2, width * 0.08), new Color(207, 198, 174, 210));
  }

  private smallRoad(x1: number, y1: number, x2: number, y2: number): void {
    this.road(x1, y1, x2, y2, 18, new Color(166, 157, 139, 135));
    this.road(x1, y1, x2, y2, 12, new Color(232, 224, 208, 245));
    this.road(x1, y1, x2, y2, 2, new Color(196, 185, 163, 170));
  }

  private nodeInspector(x: number, y: number, w: number, h: number): void {
    const selected = getSelectedMapNode(this.state) || getMapNodes(this.state).filter((node) => node.visible !== false)[0];
    this.cardPanel(x, y, w, h);
    this.text(selected.title, x + 26, y + h - 55, 28, C.ink, w - 52, 'LEFT', true);
    this.text(selected.place, x + 26, y + h - 96, 19, C.muted, w - 52, 'LEFT');
    this.text('章节：' + selected.chapter, x + 26, y + h - 140, 18, C.ink, w - 52, 'LEFT');
    this.text('状态：' + this.stateText(selected), x + 26, y + h - 175, 18, this.stateColor(selected), w - 52, 'LEFT', true);
    this.text('最好用时：' + formatTime(selected.bestTimeSec), x + 26, y + h - 210, 18, C.ink, w - 52, 'LEFT');
    this.text('隐藏收集：' + selected.hiddenFound + '/' + selected.hiddenTotal, x + 26, y + h - 245, 18, C.ink, w - 52, 'LEFT');
    this.text(selected.state === 'locked' ? selected.unlockText : '点击进入即挂载 D 的关卡，通关后自动回到结算页。', x + 26, y + 132, 16, C.muted, w - 52, 'LEFT');
    this.button(selected.state === 'locked' ? '未解锁' : '进入当前关卡', x + w / 2, y + 58, 210, 50, () => this.enterLevel(), selected.state === 'locked' ? C.locked : C.blueDeep, C.white);
  }

  /**
   * 从地图进关卡。
   *
   * 真正的挂载交给 D 的 `LevelMountView`：关卡节点建在 Canvas 上盖住这一层，
   * 这一层先被整个藏起来、拆关卡时自动恢复 —— 所以**退出就是回地图**，
   * 不用另外切页面（进关卡前后 `state.page` 一直是 `map`）。
   *
   * 只有通关才记进度。失败（超时 / 次数用完）时关卡还停在自己的「再来一次」
   * 界面上，那种时候点亮地图节点是错的。
   */
  private enterLevel(): void {
    // 没选中的话退回地图上第一个能玩的节点，和 nodeInspector 当年的兜底一致。
    // 不这么写的话「没选中 → 静默 return」—— 点了没反应，最难查的那种。
    const nodes = getMapNodes(this.state).filter((node) => node.visible !== false);
    const selected = getSelectedMapNode(this.state)
      ?? nodes.filter((node) => node.state !== 'locked')[0]
      ?? null;
    if (!selected || selected.state === 'locked') return;

    const ok = mountLevel({
      levelId: selected.levelId,
      // **先钉死单人**，不看 state.mode：duo 模式下 D 的运行时不让切视角
      // （视角要由服务端指派），而 C 的房间服务还没做 —— 真放进 duo，
      // 玩家只能守住一半线索，那关必通不了。等房间就绪再把 mode 透进来。
      playMode: 'solo',
      // 挂载期间把外层整层藏起来：两层 UI 同屏时 E 的按钮只是被盖住、没被挡住，
      // 关卡里的点击会顺手把地图上的按钮也点掉
      hideWhileMounted: this.root,
      onComplete: (review) => {
        this.setState(completeLevel(this.state, review.levelId, review.elapsedSec, review.unlockedNodeIds));
      },
    });

    // 只有拿不到 Canvas 才会走到这儿 —— 退回桥接页说清楚，别静默什么都不发生
    if (!ok) this.setState(startSelectedLevel(this.state));
  }

  private drawLevels(): void {
    this.pageHeading('关卡目录', '查看 1-10 关状态，和地图使用同一份进度数据。');
    const nodes = getMapNodes(this.state).filter((node) => node.visible !== false);
    nodes.forEach((node, index) => {
      const col = index % 5;
      const row = Math.floor(index / 5);
      const x = 72 + col * 238;
      const y = 345 - row * 135;
      this.cardPanel(x, y, 205, 104);
      this.roundRect(this.root!, 42, 42, x + 18, y + 44, this.stateColor(node), C.ink, 12);
      this.text(pad2(index + 1), x + 39, y + 65, 17, C.white, 42, 'CENTER', true);
      this.text(node.place, x + 72, y + 66, 16, C.ink, 110, 'LEFT', true);
      this.text(this.stateText(node), x + 72, y + 35, 14, C.muted, 110, 'LEFT');
    });
    this.backButton('home');
  }

  private drawCollection(): void {
    this.pageHeading('成就图鉴', '通关后自动点亮漫画卡，后续替换 A/B 的正式纪念物图片。');
    this.state.collection.forEach((entry, index) => this.collectionCard(entry, index));
    this.backButton('home');
  }

  private drawSettings(): void {
    this.pageHeading('设置', '背景音乐、操作音效、新手提示和隐私入口。');
    this.cardPanel(90, 245, 360, 230);
    this.circle(145, 410, 28, C.yellow);
    this.text('E', 145, 410, 24, C.ink, 56, 'CENTER', true);
    this.text('玩家 E', 185, 420, 26, C.ink, 180, 'LEFT', true);
    this.text('本地演示账号', 185, 385, 16, C.muted, 180, 'LEFT');
    this.settingRow('背景音乐', this.state.settings.bgmEnabled, 520);
    this.settingRow('操作音效', this.state.settings.sfxEnabled, 445);
    this.settingRow('新手提示', this.state.settings.vibrationEnabled, 370);
    this.text('隐私口径：只保留微信身份标识、昵称、进度、用时与必要日志，不采集真实定位。', 520, 260, 16, C.muted, 560, 'LEFT');
    this.backButton('home');
  }

  /**
   * 关卡没挂上时的兜底页。
   *
   * 正常路径根本走不到这里 —— `enterLevel()` 会直接挂 D 的关卡。只有场景里
   * 找不到 Canvas 节点时才落回来，说清楚缺什么。
   *
   * 这里原来放着「模拟通关并解锁下一站」的按钮（写死 286 秒），已删掉：
   * 真正的通关走 `mountLevel` 的 onComplete。
   */
  private drawLevelBridge(): void {
    const selected = getSelectedMapNode(this.state) || getMapNodes(this.state)[1];
    this.cardPanel(300, 175, 680, 330);
    this.text('关卡没能打开', 640, 430, 36, C.ink, 440, 'CENTER', true);
    this.text(selected.levelId + ' · ' + selected.place, 640, 380, 22, C.muted, 460, 'CENTER');
    this.text('场景里找不到 Canvas 节点，D 的 LevelMountView 没能挂载。', 640, 335, 18, C.muted, 620, 'CENTER');
    this.text('请确认默认场景还在、且 AppShellView 挂在 Canvas 上。', 640, 305, 18, C.muted, 620, 'CENTER');
    this.button('返回地图', 640, 235, 150, 46, () => this.setState(navigateTo(this.state, 'map')), C.blueDeep, C.white);
  }

  private drawResult(): void {
    this.cardPanel(320, 220, 640, 260);
    this.text('通关结算', 640, 410, 38, C.ink, 360, 'CENTER', true);
    this.text('已记录最好用时、点亮图鉴，并解锁下一处校园节点。', 640, 355, 20, C.muted, 520, 'CENTER');
    this.button('回到地图', 550, 285, 160, 52, () => this.setState(navigateTo(this.state, 'map')), C.blueDeep, C.white);
    this.button('查看图鉴', 735, 285, 160, 52, () => this.setState(navigateTo(this.state, 'collection')), C.white, C.ink);
  }

  private contentTitle(eyebrow: string, titleA: string, titleB: string): void {
    this.text(eyebrow, 90, 565, 14, C.blueDeep, 420, 'LEFT', true);
    this.text(titleA, 90, 508, 50, C.ink, 520, 'LEFT', true);
    this.text(titleB, 90, 452, 50, C.blueDeep, 620, 'LEFT', true);
  }

  private pageHeading(title: string, body: string): void {
    this.text(title, 70, 590, 36, C.ink, 500, 'LEFT', true);
    this.text(body, 70, 550, 18, C.muted, 760, 'LEFT');
  }

  private levelSketchCard(x: number, y: number, w: number, h: number): void {
    const node = this.currentPreviewNode();
    this.roundRect(this.root!, w, h, x, y, new Color(185, 216, 205, 255), C.ink, 22);
    this.text(node.title + ' · ' + node.place, x + 30, y + h - 34, 17, C.ink, w - 60, 'LEFT', true);
    this.drawLevelSketch(node.levelId, x + 24, y + 30, w - 48, h - 82);
  }

  private currentPreviewNode(): MapNodeView {
    const nodes = getMapNodes(this.state).filter((node) => node.visible !== false);
    return nodes.filter((node) => node.state === 'unlocked')[0] || nodes.filter((node) => node.state === 'completed')[nodes.length - 1] || nodes[0];
  }

  private drawLevelSketch(levelId: string, x: number, y: number, w: number, h: number): void {
    this.ellipse(x + w * 0.48, y + h * 0.24, w * 0.45, h * 0.18, new Color(142, 196, 173, 255), C.ink);
    if (levelId === 'L02') {
      this.road(x + w * 0.12, y + h * 0.36, x + w * 0.86, y + h * 0.36, 26);
      this.road(x + w * 0.28, y + h * 0.16, x + w * 0.42, y + h * 0.7, 18);
      this.road(x + w * 0.42, y + h * 0.7, x + w * 0.78, y + h * 0.58, 18);
      this.rect(this.root!, w * 0.13, h * 0.24, x + w * 0.14, y + h * 0.42, C.yellow, C.ink);
      this.rect(this.root!, w * 0.15, h * 0.18, x + w * 0.67, y + h * 0.46, new Color(199, 210, 216, 255), C.ink);
      this.signpost(x + w * 0.5, y + h * 0.66, '思源楼');
      this.text('封路绕行', x + w * 0.24, y + h * 0.08, 14, C.ink, 120, 'CENTER', true);
    } else if (levelId === 'L03') {
      this.rect(this.root!, w * 0.3, h * 0.32, x + w * 0.34, y + h * 0.35, new Color(210, 213, 206, 255), C.ink);
      this.steps(x + w * 0.37, y + h * 0.3, w * 0.24);
      this.noticeBoard(x + w * 0.12, y + h * 0.44, '通知 A');
      this.noticeBoard(x + w * 0.67, y + h * 0.43, '通知 B');
      this.text('找出有效集合安排', x + w * 0.5, y + h * 0.1, 14, C.ink, 180, 'CENTER', true);
    } else if (levelId === 'L04') {
      this.rect(this.root!, w * 0.38, h * 0.32, x + w * 0.3, y + h * 0.38, new Color(199, 210, 216, 255), C.ink);
      this.circle(x + w * 0.49, y + h * 0.33, h * 0.08, new Color(239, 231, 211, 230), new Color(128, 119, 101, 122));
      this.rect(this.root!, w * 0.14, h * 0.06, x + w * 0.42, y + h * 0.57, C.paper, C.ink);
      this.text('图书馆半页提示', x + w * 0.5, y + h * 0.13, 14, C.ink, 180, 'CENTER', true);
    } else if (levelId === 'L05') {
      this.ellipse(x + w * 0.65, y + h * 0.58, w * 0.17, h * 0.12, new Color(143, 208, 213, 255), new Color(95, 141, 145, 255));
      this.rect(this.root!, w * 0.24, h * 0.22, x + w * 0.18, y + h * 0.36, C.yellow, C.ink);
      this.umbrella(x + w * 0.58, y + h * 0.28);
      this.text('明湖餐厅套餐牌', x + w * 0.34, y + h * 0.14, 14, C.ink, 180, 'CENTER', true);
    } else if (levelId === 'L06') {
      this.ellipse(x + w * 0.46, y + h * 0.5, w * 0.32, h * 0.19, C.coral, C.ink);
      this.ellipse(x + w * 0.46, y + h * 0.5, w * 0.24, h * 0.13, new Color(121, 185, 121, 255), C.paper);
      this.road(x + w * 0.24, y + h * 0.2, x + w * 0.72, y + h * 0.74, 5);
      this.text('接力顺序', x + w * 0.5, y + h * 0.12, 16, C.ink, 150, 'CENTER', true);
    } else if (levelId === 'L07') {
      this.rect(this.root!, w * 0.22, h * 0.25, x + w * 0.22, y + h * 0.34, C.coral, C.ink);
      this.rect(this.root!, w * 0.22, h * 0.25, x + w * 0.5, y + h * 0.34, C.coral, C.ink);
      this.noticeBoard(x + w * 0.2, y + h * 0.66, '校史');
      this.noticeBoard(x + w * 0.52, y + h * 0.66, '排序');
      this.text('校史展板重排', x + w * 0.5, y + h * 0.12, 14, C.ink, 180, 'CENTER', true);
    } else if (levelId === 'L08') {
      this.rect(this.root!, w * 0.34, h * 0.28, x + w * 0.18, y + h * 0.42, new Color(210, 213, 206, 255), C.ink);
      this.train(x + w * 0.24, y + h * 0.28, w * 0.5);
      this.text('列车模型车厢顺序', x + w * 0.5, y + h * 0.12, 14, C.ink, 190, 'CENTER', true);
    } else if (levelId === 'L09') {
      this.rect(this.root!, w * 0.28, h * 0.28, x + w * 0.18, y + h * 0.34, C.yellow, C.ink);
      this.noticeBoard(x + w * 0.55, y + h * 0.45, '任务单');
      this.noticeBoard(x + w * 0.68, y + h * 0.28, '记录');
      this.text('两份任务记录对照', x + w * 0.5, y + h * 0.12, 14, C.ink, 190, 'CENTER', true);
    } else if (levelId === 'L10') {
      this.rect(this.root!, w * 0.42, h * 0.28, x + w * 0.3, y + h * 0.34, new Color(181, 90, 75, 255), C.ink);
      this.triangle(x + w * 0.28, y + h * 0.62, x + w * 0.51, y + h * 0.76, x + w * 0.74, y + h * 0.62, C.yellow);
      for (let i = 0; i < 5; i += 1) {
        this.rect(this.root!, w * 0.055, h * 0.08, x + w * (0.34 + i * 0.065), y + h * 0.42, C.paper, C.ink);
      }
      this.text('迎新主展区', x + w * 0.5, y + h * 0.12, 14, C.ink, 180, 'CENTER', true);
    } else {
      this.triangle(x + w * 0.28, y + h * 0.42, x + w * 0.46, y + h * 0.72, x + w * 0.64, y + h * 0.42, C.coral);
      this.rect(this.root!, w * 0.32, h * 0.22, x + w * 0.3, y + h * 0.2, C.yellow, C.ink);
      this.grove(x + w * 0.55, y + h * 0.18, w * 0.22, h * 0.2);
      this.text('南门入口', x + w * 0.5, y + h * 0.08, 14, C.ink, 140, 'CENTER', true);
    }
  }

  private signpost(x: number, y: number, text: string): void {
    this.road(x, y - 34, x, y, 4);
    this.roundRect(this.root!, 88, 28, x - 44, y, C.paper, C.ink, 6);
    this.text(text, x, y + 14, 13, C.ink, 80, 'CENTER', true);
  }

  private noticeBoard(x: number, y: number, text: string): void {
    this.roundRect(this.root!, 84, 58, x, y, C.paper, C.ink, 8);
    this.road(x + 12, y + 40, x + 72, y + 40, 2);
    this.road(x + 12, y + 28, x + 66, y + 28, 2);
    this.text(text, x + 42, y + 13, 12, C.ink, 78, 'CENTER', true);
  }

  private featureCard(icon: string, title: string, x: number, y: number, color: Color): void {
    this.cardPanel(x, y, 200, 95);
    this.roundRect(this.root!, 42, 42, x + 22, y + 28, color, C.ink, 12);
    this.text(icon, x + 43, y + 49, 24, C.ink, 42, 'CENTER', true);
    this.text(title, x + 82, y + 49, 19, C.ink, 98, 'LEFT', true);
  }

  private progressPanel(x: number, y: number, w: number, h: number): void {
    const completed = getMapNodes(this.state).filter((node) => node.state === 'completed').length;
    const unlocked = getMapNodes(this.state).filter((node) => node.state !== 'locked').length;
    this.cardPanel(x, y, w, h);
    this.text('地图进度', x + 24, y + 76, 20, C.ink, 160, 'LEFT', true);
    this.text('已开放 ' + unlocked + '/' + MAP_NODES.length + ' · 已通关 ' + completed + '/' + MAP_NODES.length, x + 24, y + 40, 16, C.muted, 250, 'LEFT');
  }

  private modeCard(title: string, body: string, x: number, y: number, color: Color, onClick: () => void): void {
    this.cardPanel(x, y, 360, 210);
    this.roundRect(this.root!, 58, 58, x + 26, y + 126, color, C.ink, 16);
    this.text(title, x + 100, y + 160, 30, C.ink, 210, 'LEFT', true);
    this.text(body, x + 34, y + 92, 17, C.muted, 292, 'LEFT');
    this.button('选择', x + 278, y + 42, 116, 42, onClick, C.blueDeep, C.white);
  }

  private collectionCard(entry: CollectionEntry, index: number): void {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = 70 + col * 286;
    const y = 365 - row * 135;
    const fill = entry.unlocked ? C.paper : new Color(228, 229, 225, 255);
    this.cardPanel(x, y, 240, 110, fill);
    this.roundRect(this.root!, 62, 62, x + 18, y + 24, entry.unlocked ? C.mint : C.locked, C.ink, 14);
    this.text(entry.unlocked ? '✓' : '?', x + 49, y + 55, 28, C.white, 62, 'CENTER', true);
    this.text(entry.unlocked ? entry.title : '未发现', x + 96, y + 66, 18, entry.unlocked ? C.ink : C.locked, 120, 'LEFT', true);
    this.text(entry.sourceLevelId, x + 96, y + 35, 14, C.muted, 120, 'LEFT');
  }

  private settingRow(title: string, enabled: boolean, y: number): void {
    const key = title === '背景音乐' ? 'bgmEnabled' : title === '操作音效' ? 'sfxEnabled' : 'vibrationEnabled';
    this.cardPanel(520, y - 28, 500, 56);
    this.text(title, 548, y, 18, C.ink, 160, 'LEFT', true);
    this.button(enabled ? '开' : '关', 950, y, 74, 34, () => this.setState(toggleSetting(this.state, key)), enabled ? C.mint : C.locked, C.ink);
  }

  private backButton(page: 'home' | 'mode'): void {
    this.button('返回', 98, 105, 110, 42, () => this.setState(navigateTo(this.state, page)), C.white, C.ink);
  }

  private setState(state: AppState): void {
    this.state = state;
    this.render();
  }

  private stateText(node: MapNodeView): string {
    if (node.state === 'completed') return '已通关';
    if (node.state === 'unlocked') return '当前 / 可进入';
    return '未解锁';
  }

  private stateColor(node: MapNodeView): Color {
    if (node.state === 'completed') return C.yellow;
    if (node.state === 'unlocked') return C.coral;
    return C.locked;
  }

  private mapNode(node: MapNodeView, number: number, mapX: number, mapY: number, mapW: number, mapH: number): void {
    const point = this.nodePosition(node, mapX, mapY, mapW, mapH);
    const x = point.x;
    const y = point.y;
    this.circle(x + 4, y - 4, 21, new Color(41, 51, 68, 55));
    this.circle(x, y, 21, this.stateColor(node), C.ink);
    this.text(String(number), x, y, 21, C.ink, 42, 'CENTER', true);
    this.button('', x, y, 56, 56, () => {
      // 选中之后就进关卡。
      //
      // 为什么不「先选中、再点详情面板上的按钮」：地图现在铺满整个内容区，
      // 没地方再摆一块节点详情面板了 —— 原来那个 nodeInspector() 是更早一版
      // 布局（右边留了一条）的遗留，**从来没有被调用过**，所以地图上一直
      // 没有任何能进关卡的入口，点节点等于什么都没发生。
      this.setState(selectMapNode(this.state, node.nodeId));
      this.enterLevel();
    }, new Color(0, 0, 0, 0), C.white, false);
  }

  private mapLabel(text: string, x: number, y: number): void {
    this.roundRect(this.root!, 90, 22, x - 45, y - 11, new Color(255, 255, 255, 190), new Color(255, 255, 255, 0), 4);
    this.text(text, x, y, 12, C.ink, 86, 'CENTER', true);
  }

  private polygon(points: number[][], fill: Color, stroke: Color, lineWidth: number): void {
    const node = this.makeNode('polygon', this.root!, W, H, 0, 0);
    const g = node.addComponent(Graphics);
    g.fillColor = fill;
    g.strokeColor = stroke;
    g.lineWidth = lineWidth;
    g.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      g.lineTo(points[i][0], points[i][1]);
    }
    g.close();
    g.fill();
    g.stroke();
  }

  private wave(x1: number, y: number, x2: number, _y2: number): void {
    const node = this.makeNode('wave', this.root!, W, H, 0, 0);
    const g = node.addComponent(Graphics);
    g.strokeColor = new Color(95, 141, 145, 255);
    g.lineWidth = 3;
    const mid = (x1 + x2) / 2;
    g.moveTo(x1, y);
    g.bezierCurveTo(x1 + 24, y + 12, mid - 8, y - 12, mid + 18, y);
    g.bezierCurveTo(mid + 42, y + 12, x2 - 22, y - 12, x2, y);
    g.stroke();
  }

  private arcBridge(x1: number, y: number, x2: number, _y2: number): void {
    const node = this.makeNode('bridge', this.root!, W, H, 0, 0);
    const g = node.addComponent(Graphics);
    g.strokeColor = new Color(139, 128, 112, 255);
    g.lineWidth = 6;
    g.moveTo(x1, y);
    g.bezierCurveTo(x1 + 18, y + 24, x2 - 18, y + 24, x2, y);
    g.stroke();
  }

  private train(x: number, y: number, width: number): void {
    this.rect(this.root!, width * 0.28, 15, x, y, C.coral, C.ink);
    this.rect(this.root!, width * 0.34, 15, x + width * 0.33, y, C.yellow, C.ink);
    this.rect(this.root!, width * 0.24, 15, x + width * 0.72, y, new Color(143, 208, 213, 255), C.ink);
    this.circle(x + width * 0.12, y - 5, 4, C.ink);
    this.circle(x + width * 0.5, y - 5, 4, C.ink);
    this.circle(x + width * 0.83, y - 5, 4, C.ink);
  }

  private umbrella(x: number, y: number): void {
    this.triangle(x - 18, y, x, y + 28, x + 18, y, C.coral);
    this.road(x, y, x, y - 22, 3);
    this.circle(x + 40, y, 7, C.yellow, C.ink);
  }

  private steps(x: number, y: number, width: number): void {
    for (let i = 0; i < 5; i += 1) {
      this.road(x + i * 8, y - i * 7, x + width - i * 8, y - i * 7, 3);
    }
  }

  private gate(x: number, y: number, w: number, h: number): void {
    const cx = x + w * 0.47;
    const baseY = y + h * 0.08;
    const gateW = w * 0.24;
    const gateH = h * 0.22;
    this.ellipse(cx, baseY + gateH * 0.92, gateW * 0.58, gateH * 0.17, new Color(239, 231, 211, 230), new Color(128, 119, 101, 122));
    this.rect(this.root!, gateW * 0.18, gateH * 0.62, cx - gateW * 0.48, baseY + gateH * 0.13, new Color(217, 173, 86, 255), C.ink);
    this.rect(this.root!, gateW * 0.18, gateH * 0.62, cx + gateW * 0.3, baseY + gateH * 0.13, new Color(217, 173, 86, 255), C.ink);
    this.triangle(cx - gateW * 0.6, baseY + gateH * 0.72, cx, baseY + gateH * 1.12, cx + gateW * 0.6, baseY + gateH * 0.72, C.coral);
    this.rect(this.root!, gateW * 0.83, gateH * 0.16, cx - gateW * 0.415, baseY + gateH * 0.57, C.yellow, C.ink);
    this.rect(this.root!, gateW * 0.48, gateH * 0.32, cx - gateW * 0.24, baseY + gateH * 0.16, C.paper, C.ink);
    this.text('南门', cx, baseY + gateH * 0.69, 14, C.ink, gateW * 0.7, 'CENTER', true);
  }

  private southGateArch(x: number, y: number, width: number, height: number): void {
    const center = x + width / 2;
    this.ellipse(center, y + height * 0.8, width * 0.48, height * 0.18, new Color(239, 231, 211, 230), new Color(128, 119, 101, 122));
    this.rect(this.root!, width * 0.15, height * 0.64, x + width * 0.03, y + height * 0.18, new Color(217, 173, 86, 255), C.ink);
    this.rect(this.root!, width * 0.15, height * 0.64, x + width * 0.82, y + height * 0.18, new Color(217, 173, 86, 255), C.ink);
    this.triangle(center - width * 0.53, y + height * 0.73, center, y + height * 1.08, center + width * 0.53, y + height * 0.73, C.coral);
    this.rect(this.root!, width * 0.8, height * 0.14, x + width * 0.1, y + height * 0.58, C.yellow, C.ink);
    this.rect(this.root!, width * 0.46, height * 0.32, x + width * 0.27, y + height * 0.17, C.paper, C.ink);
    this.text('南门', center, y + height * 0.69, 15, C.ink, width * 0.64, 'CENTER', true);
  }

  private southGateGrove(x: number, y: number, w: number, h: number): void {
    const trees = [
      [0.08, 0.22, 18], [0.2, 0.48, 22], [0.32, 0.18, 16], [0.42, 0.58, 24],
      [0.55, 0.28, 20], [0.68, 0.58, 23], [0.8, 0.2, 17], [0.92, 0.45, 21],
      [0.28, 0.82, 17], [0.58, 0.86, 18], [0.78, 0.82, 16],
    ];
    trees.forEach((tree, index) => {
      const color = index % 3 === 0 ? new Color(65, 111, 75, 255) : new Color(83, 135, 84, 255);
      this.circle(x + w * tree[0], y + h * tree[1], tree[2], color, new Color(52, 88, 61, 255));
      this.circle(x + w * tree[0] - 4, y + h * tree[1] + 4, tree[2] * 0.58, new Color(109, 159, 96, 210));
    });
    this.ellipse(x + w * 0.5, y + h * 0.53, w * 0.46, h * 0.17, new Color(76, 112, 73, 75), new Color(52, 88, 61, 120));
  }

  private grove(x: number, y: number, w: number, h: number): void {
    const spots = [
      [0.12, 0.25], [0.34, 0.38], [0.55, 0.22], [0.76, 0.42],
      [0.22, 0.68], [0.5, 0.72], [0.82, 0.72], [0.68, 0.12],
    ];
    spots.forEach((spot, index) => {
      this.circle(x + w * spot[0], y + h * spot[1], index % 2 === 0 ? 14 : 16, new Color(74, 124, 89, 255), new Color(55, 96, 70, 255));
    });
    this.rect(this.root!, w * 0.28, 6, x + w * 0.18, y + h * 0.02, new Color(143, 118, 94, 255), new Color(101, 77, 61, 255));
    this.rect(this.root!, w * 0.28, 6, x + w * 0.58, y, new Color(143, 118, 94, 255), new Color(101, 77, 61, 255));
  }

  private treeRows(x: number, y: number, w: number, h: number): void {
    for (let i = 0; i < 7; i += 1) {
      const yy = y + h * (0.18 + i * 0.09);
      this.circle(x + w * 0.46, yy, 8, new Color(93, 147, 97, 255), new Color(55, 96, 70, 255));
      this.circle(x + w * 0.54, yy, 8, new Color(93, 147, 97, 255), new Color(55, 96, 70, 255));
    }
  }

  private makeNode(name: string, parent: Node, width: number, height: number, x: number, y: number): Node {
    const node = new Node(name);
    parent.addChild(node);
    const ui = node.addComponent(UITransform);
    ui.setContentSize(width, height);
    ui.setAnchorPoint(0, 0);
    node.setPosition(new Vec3(x, y, 0));
    return node;
  }

  private cardPanel(x: number, y: number, width: number, height: number, fill: Color = new Color(255, 250, 240, 230)): void {
    this.roundRect(this.root!, width, height, x, y, fill, new Color(210, 202, 185, 255), 18);
  }

  private rect(parent: Node, width: number, height: number, x: number, y: number, fill: Color, stroke?: Color): Node {
    const node = this.makeNode('rect', parent, width, height, x, y);
    const g = node.addComponent(Graphics);
    g.fillColor = fill;
    g.rect(0, 0, width, height);
    g.fill();
    if (stroke) {
      g.strokeColor = stroke;
      g.lineWidth = 2;
      g.rect(0, 0, width, height);
      g.stroke();
    }
    return node;
  }

  private outlineRect(parent: Node, width: number, height: number, x: number, y: number, stroke: Color, lineWidth: number): Node {
    const node = this.makeNode('outline-rect', parent, width, height, x, y);
    const g = node.addComponent(Graphics);
    g.strokeColor = stroke;
    g.lineWidth = lineWidth;
    g.rect(0, 0, width, height);
    g.stroke();
    return node;
  }

  private roundRect(parent: Node, width: number, height: number, x: number, y: number, fill: Color, stroke: Color, radius: number): Node {
    const node = this.makeNode('round-rect', parent, width, height, x, y);
    const g = node.addComponent(Graphics);
    g.fillColor = fill;
    g.roundRect(0, 0, width, height, radius);
    g.fill();
    if (stroke.a > 0) {
      g.strokeColor = stroke;
      g.lineWidth = 2;
      g.roundRect(0, 0, width, height, radius);
      g.stroke();
    }
    return node;
  }

  private text(text: string, x: number, y: number, size: number, color: Color, width: number, align: 'LEFT' | 'CENTER', bold = false): Node {
    const node = this.makeNode('text', this.root!, width, size + 12, x, y);
    const ui = node.getComponent(UITransform)!;
    ui.setAnchorPoint(align === 'CENTER' ? 0.5 : 0, 0.5);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = size;
    label.lineHeight = size + 8;
    label.color = color;
    label.horizontalAlign = align === 'CENTER' ? Label.HorizontalAlign.CENTER : Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.isBold = bold;
    label.overflow = Label.Overflow.SHRINK;
    return node;
  }

  private button(text: string, x: number, y: number, width: number, height: number, onClick: () => void, fill: Color, textColor: Color, border = true): Node {
    const node = this.roundRect(this.root!, width, height, x - width / 2, y - height / 2, fill, border ? C.line : new Color(0, 0, 0, 0), Math.min(14, height / 3));
    node.name = 'button-' + text;
    if (text.length > 0) {
      const labelNode = this.makeNode('button-label', node, width, height, 0, 0);
      const label = labelNode.addComponent(Label);
      label.string = text;
      label.fontSize = Math.min(21, height - 18);
      label.lineHeight = label.fontSize + 6;
      label.color = textColor;
      label.horizontalAlign = Label.HorizontalAlign.CENTER;
      label.verticalAlign = Label.VerticalAlign.CENTER;
      label.isBold = true;
      label.overflow = Label.Overflow.SHRINK;
    }
    node.on(Node.EventType.TOUCH_END, onClick, this);
    return node;
  }

  private circle(x: number, y: number, radius: number, fill: Color, stroke?: Color): void {
    const node = this.makeNode('circle', this.root!, radius * 2, radius * 2, x - radius, y - radius);
    const g = node.addComponent(Graphics);
    g.fillColor = fill;
    g.circle(radius, radius, radius);
    g.fill();
    if (stroke) {
      g.strokeColor = stroke;
      g.lineWidth = 3;
      g.circle(radius, radius, radius);
      g.stroke();
    }
  }

  private ellipse(x: number, y: number, rx: number, ry: number, fill: Color, stroke: Color): void {
    const node = this.makeNode('ellipse', this.root!, rx * 2, ry * 2, x - rx, y - ry);
    const g = node.addComponent(Graphics);
    g.fillColor = fill;
    g.strokeColor = stroke;
    g.lineWidth = 3;
    g.ellipse(rx, ry, rx, ry);
    g.fill();
    g.stroke();
  }

  private triangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, fill: Color): void {
    const node = this.makeNode('triangle', this.root!, W, H, 0, 0);
    const g = node.addComponent(Graphics);
    g.fillColor = fill;
    g.strokeColor = C.ink;
    g.lineWidth = 2;
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineTo(x3, y3);
    g.close();
    g.fill();
    g.stroke();
  }

  private road(x1: number, y1: number, x2: number, y2: number, width: number, color: Color = C.paper): void {
    const node = this.makeNode('road', this.root!, W, H, 0, 0);
    const g = node.addComponent(Graphics);
    g.strokeColor = color;
    g.lineWidth = width;
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  }

  private dashedLine(x1: number, y1: number, x2: number, y2: number, color: Color): void {
    const node = this.makeNode('dashed-line', this.root!, W, H, 0, 0);
    const g = node.addComponent(Graphics);
    g.strokeColor = color;
    g.lineWidth = 4;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    const dash = 12;
    const gap = 9;
    let distance = 0;
    while (distance < length) {
      const start = distance / length;
      const end = Math.min(distance + dash, length) / length;
      g.moveTo(x1 + dx * start, y1 + dy * start);
      g.lineTo(x1 + dx * end, y1 + dy * end);
      distance += dash + gap;
    }
    g.stroke();
  }
}
