/**
 * 不打开编辑器就能把关卡跑起来的自动挂载入口，外加一条开发用的关卡切换按钮。
 *
 * 为什么需要自动挂载：手写 .scene 里引用一个组件，写的是那个脚本的 UUID。
 * LevelView 一开始是新建的、还没被 Cocos 导入过，也就没有 .meta、没有 UUID ——
 * 「在编辑器里把 LevelView 拖到场景节点上」这条路当时走不通。这个文件靠
 * director 的场景启动回调把节点建出来，完全绕开 UUID。
 *
 * 长期做法仍然是在编辑器里建 Guide.scene / Level01.scene 并挂 LevelView
 * （那时场景归属表里 D 的那几个文件才算真正落地）。等那几个场景建好，
 * 把下面的 AUTO_BOOT_LEVEL 设成 null 就行，不用删这个文件。
 *
 * 命名注意：本文件 import 了 'cc'，所以文件名必须以 View.ts 结尾。
 * tests/tsconfig.json 靠一条 exclude 把这类文件挡在主 typecheck 外面，
 * 否则 Node 解析不到 'cc'，npm run typecheck 会直接报 TS2307。
 */

import { Director, Node, director, view } from 'cc';
import { EDITOR_NOT_IN_PREVIEW } from 'cc/env';

import { LevelView } from './LevelView';
import { COLOR, addLabel, makeButton, uiNode } from './UiKitView';
import type { PlayMode } from '../common/LevelTypes';

/**
 * 自动挂载哪一关。设成 null 就完全不自动挂载，改走编辑器那条路。
 */
const AUTO_BOOT_LEVEL: string | null = 'GUIDE';

/** 原型阶段先只跑单人；双人等 C 的房间服务就绪后再开 */
const AUTO_BOOT_MODE: PlayMode = 'solo';

/**
 * 默认打开热点调试框。
 *
 * A/B 出图之前界面上只有占位底色，热点框是唯一能看出「触点位置对不对」的东西。
 * 图进 resources/ 之后改成 false —— 现在开着是为了量坐标。
 */
const AUTO_BOOT_DEBUG = true;

/**
 * 预览时能一键切换的关卡。**这是开发工具，不是产品界面。**
 *
 * 正式的选关入口是 E 的地图页（首页 → 选模式 → 地图 → 关卡），E 那边还没开工，
 * 测试时每换一关都要改上面的常量、等重新编译，太慢。等 E 的首页和地图上来了，
 * 删掉这段、把 AUTO_BOOT_LEVEL 设成 null 即可。
 *
 * 列表只放**已经有配置文件**的关卡，写一个没有配置的 id 会白屏。
 */
const DEV_LEVELS = ['GUIDE', 'L01'];

/** 只在「真正跑起来」的环境里挂载 —— 浏览器预览、模拟器、真机、构建产物都算 */
const AUTO_BOOT_OK = !EDITOR_NOT_IN_PREVIEW;

const LEVEL_NODE_NAME = 'LevelView(auto)';
const DEV_BAR_NAME = 'DevLevelBar';

function hostNode(): Node | null {
  const scene = director.getScene();
  if (!scene) return null;
  // 必须挂在 Canvas 下面：UI 相机只渲 Canvas 子树，挂到 Scene 根上什么都看不见
  return scene.getChildByName('Canvas') ?? scene;
}

/**
 * 换关卡。整个节点销毁重建，不走 reset —— 换关连配置都换了，reset 清不干净。
 * 旧的 LevelView 会在 onDestroy 里退掉事件订阅，不会漏。
 */
function mountLevel(levelId: string): void {
  const host = hostNode();
  if (!host) return;

  const previous = host.getChildByName(LEVEL_NODE_NAME);
  if (previous) {
    previous.removeFromParent();
    previous.destroy();
  }

  const visible = view.getVisibleSize();
  const node = uiNode(LEVEL_NODE_NAME, host, visible.width, visible.height, 0.5, 0.5);
  node.setPosition(0, 0, 0);

  const levelView = node.addComponent(LevelView);
  levelView.levelId = levelId;
  levelView.playMode = AUTO_BOOT_MODE;
  levelView.debugHotspots = AUTO_BOOT_DEBUG;

  // 按钮条要在关卡节点**之后**建：同级节点越晚建的越在上面，反了就被盖住点不到
  buildDevBar(host, levelId);
}

/**
 * 左上角的关卡切换条。故意做成一眼能看出不是正式界面的样子
 * （小字标注 + 深色底），免得谁截图时把它当成产品 UI。
 */
function buildDevBar(host: Node, current: string): void {
  const stale = host.getChildByName(DEV_BAR_NAME);
  if (stale) {
    stale.removeFromParent();
    stale.destroy();
  }

  const labelW = 96;
  const buttonW = 104;
  const buttonH = 38;
  const gap = 8;
  const rowW = DEV_LEVELS.length * buttonW + (DEV_LEVELS.length - 1) * gap;
  const barW = labelW + gap + rowW;
  const barH = 38;

  const bar = uiNode(DEV_BAR_NAME, host, barW, barH, 0.5, 0.5);
  const visible = view.getVisibleSize();
  // 顶部状态栏占 56 高，所以往下让一点，别压在上面
  bar.setPosition(-visible.width / 2 + barW / 2 + 12, visible.height / 2 - 84, 0);

  const hint = addLabel(bar, 'hint', '开发用 ·', 18, COLOR.textDim, 0.5, 0.5);
  hint.node.setPosition(-barW / 2 + labelW / 2, 0, 0);

  DEV_LEVELS.forEach((levelId, index) => {
    makeButton(
      bar,
      `dev_${levelId}`,
      levelId,
      buttonW,
      buttonH,
      -barW / 2 + labelW + gap + buttonW / 2 + index * (buttonW + gap),
      0,
      () => {
        if (levelId !== current) mountLevel(levelId);
      },
      // 当前这一关高亮，一眼看出在测哪关
      levelId === current,
    );
  });
}

function boot(): void {
  if (!AUTO_BOOT_OK) return;
  if (AUTO_BOOT_LEVEL === null) return;
  if (!hostNode()) return;

  // 场景切换后会再进来一次，别挂重。（AUTO_BOOT_LEVEL 为 null 时不能建按钮条，
  // 那条路是留给编辑器搭场景的，不该混进开发 UI）
  const existing = hostNode()!.getComponentInChildren(LevelView);
  if (existing) return;

  mountLevel(AUTO_BOOT_LEVEL);
}

director.on(Director.EVENT_AFTER_SCENE_LAUNCH, boot);

// 万一这个模块的加载晚于首个场景的启动（引擎启动顺序在不同平台上有差别），
// 上面的回调就再也不会触发。这里补一次，boot 内部的去重判断保证不会挂两遍。
if (director.getScene()) boot();
