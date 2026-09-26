/**
 * 原图坐标 → 节点坐标的换算。
 *
 * 为什么单独成一个文件：这是适配层里唯一「算错了会让全关卡热点整体错位、
 * 而且肉眼很难立刻发现」的地方。抽成引擎无关的纯函数，就能在 Node 里直接
 * 跑单测，不用开编辑器。
 *
 * 两个坐标系，别混：
 *   原图坐标 —— [x, y, w, h]，原点在图片【左上角】，单位是原图像素。
 *               A/B 在图上量完直接填进配置，不关心屏幕尺寸和缩放。
 *   节点坐标 —— Cocos 的 UI 局部坐标，原点在【左下角】，y 轴向上。
 *               所以原图坐标换过来必须翻 y。
 *
 * 本文件不 import 任何 cc 模块。
 */

export interface Size {
  width: number;
  height: number;
}

/** 与 LevelTypes.HotspotConfig['rect'] 同一个口径 */
export type RawRect = readonly [number, number, number, number];

/** 左下原点坐标系里的矩形 */
export interface LocalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function assertPositiveSize(size: Size, what: string): void {
  if (!(size.width > 0) || !(size.height > 0)) {
    throw new Error(`${what}的宽高必须大于 0，实际是 ${size.width}x${size.height}`);
  }
}

/**
 * 原图尺寸与显示尺寸的比例。
 *
 * x、y 两个方向分开算而不取同一个值：美术给的图比例和显示框比例不一致时
 * （4:3 的图放进 16:9 的屏幕），热点必须跟着图一起被拉伸，否则会出现
 * 「框看着对、点上去偏了」。要等比就得先过 fitContain。
 */
export function scaleFactors(original: Size, displayed: Size): { sx: number; sy: number } {
  assertPositiveSize(original, '原图尺寸');
  assertPositiveSize(displayed, '显示尺寸');
  return { sx: displayed.width / original.width, sy: displayed.height / original.height };
}

/**
 * 把原图坐标的矩形换算到「以图片左下角为原点」的节点局部坐标。
 * 返回值可以当成 `x` / `y` 位置 + `w` / `h` 尺寸，配 anchor(0,0) 的子节点直接用。
 */
export function mapRect(rect: RawRect, original: Size, displayed: Size): LocalRect {
  const [x, y, w, h] = rect;
  const { sx, sy } = scaleFactors(original, displayed);
  // 原图是左上原点，矩形的【下】边缘在 (y + h)，翻到左下原点要减掉它，
  // 而不是减 y。减 y 会让热点上下颠倒 —— 上半张图的框跑到下半张去。
  return {
    x: x * sx,
    y: (original.height - (y + h)) * sy,
    w: w * sx,
    h: h * sy,
  };
}

/**
 * 在 box 里按原图比例撑到最大（contain）并居中，返回图片在 box 内的实际显示矩形
 * （box 内的左下原点坐标）。
 *
 * 点触解谜必须用 contain 而不是 cover：cover 会把图裁掉一块，被裁掉的区域
 * 热点就点不到了，而玩家看不出「这里本来有东西」，只会以为关卡坏了。
 */
export function fitContain(original: Size, box: Size): LocalRect {
  assertPositiveSize(original, '原图尺寸');
  assertPositiveSize(box, '可用区域');
  const scale = Math.min(box.width / original.width, box.height / original.height);
  const w = original.width * scale;
  const h = original.height * scale;
  return { x: (box.width - w) / 2, y: (box.height - h) / 2, w, h };
}

/**
 * 一站式：原图坐标 → 「在 box 内」的节点坐标，contain 的留边一起算进去。
 * 适配层要的就是这个。
 *
 * 单独提供它是为了把「加留边」封在里面。先 fitContain 再 mapRect 的写法很容易
 * 漏掉那一步，而漏了的后果是热点框整体偏一条边 —— 偏移量还随屏幕比例变，
 * 在小屏上偏一点、大屏上偏很多，肉眼极难定位。
 */
export function mapRectIntoBox(rect: RawRect, original: Size, box: Size): LocalRect {
  const content = fitContain(original, box);
  const inner = mapRect(rect, original, { width: content.w, height: content.h });
  return { x: content.x + inner.x, y: content.y + inner.y, w: inner.w, h: inner.h };
}
