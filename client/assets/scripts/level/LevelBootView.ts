/**
 * 不打开编辑器就能把关卡跑起来的自动挂载入口。
 *
 * 为什么需要它：手写 .scene 里引用一个组件，写的是那个脚本的 UUID。而
 * LevelView.ts 是新建的、还没被 Cocos 导入过，也就还没有 .meta、没有 UUID ——
 * 所以「在编辑器里把 LevelView 拖到场景节点上」这条路现在走不通，得等你打开
 * 一次编辑器、让 Cocos 生成 .meta 之后才行。
 *
 * 这个文件靠 director 的场景启动回调把节点建出来，完全绕开 UUID，
 * 让工程在当前状态下就能构建、能在真机上看到画面。
 *
 * 长期做法仍然是在编辑器里建 Guide.scene / Level01.scene 并挂 LevelView
 * （那时场景归属表里 D 的那几个文件才算真正落地）。等那几个场景建好，
 * 把下面的 AUTO_BOOT_LEVEL 设成 null 就行，不用删这个文件。
 *
 * 命名注意：本文件 import 了 'cc'，所以文件名必须以 View.ts 结尾。
 * tests/tsconfig.json 靠 `**\/*View.ts` 把这类文件挡在主 typecheck 外面，
 * 否则 Node 解析不到 'cc'，npm run typecheck 会直接报 TS2307。
 */

import { Director, Layers, Node, UITransform, director, view } from 'cc';
import { EDITOR_NOT_IN_PREVIEW } from 'cc/env';

import { LevelView } from './LevelView';
import type { PlayMode } from '../common/LevelTypes';

/**
 * 自动挂载哪一关。设成 null 就完全不自动挂载，改走编辑器那条路。
 * 换关卡改这里即可，例如 'GUIDE' / 'L01'。
 */
const AUTO_BOOT_LEVEL: string | null = 'GUIDE';

/** 原型阶段先只跑单人；双人等 C 的房间服务就绪后再开 */
const AUTO_BOOT_MODE: PlayMode = 'solo';

/**
 * 默认打开热点调试框。
 *
 * 现在 A/B 还没出图，界面上只有占位底色，热点框是唯一能看出「触点位置对不对」
 * 的东西 —— 这段时间开着比关着有用。A/B 的图进 resources/ 之后改成 false。
 */
const AUTO_BOOT_DEBUG = true;

/**
 * 只在「真正跑起来」的环境里自动挂载 —— 浏览器预览、模拟器、真机、构建产物都算。
 *
 * 唯独排除在编辑器里编辑场景的时候：此时脚本同样会被执行，若不拦住，
 * 打开任意场景都会凭空多出一个 LevelView(auto) 节点，而这个节点**会被存进
 * .scene 文件**，之后谁打开这个场景都带着它，且看不出是谁加的。
 *
 * EDITOR_NOT_IN_PREVIEW 的语义正好是「在编辑器里、但不在编辑器预览中」，
 * 所以 !它 = 预览 + 真机 + 构建产物，正是要的范围。
 */
const AUTO_BOOT_OK = !EDITOR_NOT_IN_PREVIEW;

function boot(): void {
  if (!AUTO_BOOT_OK) return;
  if (AUTO_BOOT_LEVEL === null) return;

  const scene = director.getScene();
  if (!scene) return;

  // 场景切换后会再进来一次，别挂重
  if (scene.getComponentInChildren(LevelView)) return;

  const node = new Node('LevelView(auto)');
  node.layer = Layers.Enum.UI_2D;

  const visible = view.getVisibleSize();
  const ut = node.addComponent(UITransform);
  ut.setAnchorPoint(0.5, 0.5);
  ut.setContentSize(visible.width, visible.height);

  // 必须挂在 Canvas 下面：UI 相机只渲 Canvas 子树，挂到 Scene 根上什么都看不见
  const canvas = scene.getChildByName('Canvas');
  node.parent = canvas ?? scene;
  node.setPosition(0, 0, 0);

  const levelView = node.addComponent(LevelView);
  levelView.levelId = AUTO_BOOT_LEVEL;
  levelView.playMode = AUTO_BOOT_MODE;
  levelView.debugHotspots = AUTO_BOOT_DEBUG;
}

director.on(Director.EVENT_AFTER_SCENE_LAUNCH, boot);

// 万一这个模块的加载晚于首个场景的启动（引擎启动顺序在不同平台上有差别），
// 上面的回调就再也不会触发。这里补一次，boot 内部的去重判断保证不会挂两遍。
if (director.getScene()) boot();
