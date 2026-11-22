import type { ViewId } from './LevelTypes';

export type DialogueRole = 'A' | 'B' | 'XiaoGui' | 'XiaoMing';
export const DIALOGUE_PORTRAITS = {
  A: { assetKey: 'overlays/A', title: '海海·大一', avatar: false },
  B: { assetKey: 'overlays/B', title: '海海·毕业', avatar: false },
  XiaoGui: { assetKey: 'overlays/XiaoGui', title: '小轨', avatar: true },
  XiaoMing: { assetKey: 'overlays/小明', title: '小明', avatar: false },
} as const;

/** 只识别实际发言，不因场景介绍、档案或操作提示提到名字就显示人物。 */
export function dialogueRoles(text: string, view: ViewId): { left: DialogueRole | null; right: DialogueRole | null } {
  const roles: DialogueRole[] = [];
  const addName = (name: string) => {
    const role = name === '海海' ? view : name === '小轨' ? 'XiaoGui' : name === '小明' ? 'XiaoMing' : name as ViewId;
    if (roles.indexOf(role) < 0) roles.push(role);
  };
  const patterns = [
    /(?:^|\n)\s*(A|B|海海|小轨|小明)\s*[：:]/g,
    /(?:^|\n)\s*(A|B|海海|小轨|小明)[^\n：:“”]{1,32}[：:][“「"]/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) addName(match[1]);
  }
  if (!roles.length) return { left: null, right: null };
  if (roles.indexOf(view) >= 0) return { left: view, right: roles.find(role => role !== view) ?? null };
  return { left: roles[0], right: roles[1] ?? null };
}

export interface DialoguePortraitLayout {
  width: number; height: number; leftX: number; rightX: number;
  bottom: number; centerY: number; avatarSize: number; avatarCenterY: number;
}

/** 立绘放在场景两侧，顶部避开提示，脚部对齐对话框底边。 */
export function dialoguePortraitLayout(box: { width: number; height: number }, inset: { left: number; right: number; top: number; bottom: number }): DialoguePortraitLayout {
  const left = -box.width / 2 + inset.left;
  const right = box.width / 2 - inset.right;
  const bottom = -box.height / 2 + inset.bottom + 16;
  const top = box.height / 2 - inset.top - 128;
  const height = Math.min(640, top - bottom);
  const width = Math.min(280, (right - left) * 0.18);
  const centerY = bottom + height / 2;
  const avatarSize = Math.min(260, height * 0.5);
  return { width, height, leftX: left + 24 + width / 2, rightX: right - 24 - width / 2,
    bottom, centerY, avatarSize, avatarCenterY: bottom + height * 0.56 };
}

/** 仅加粗发言前缀；先转义原文，避免线索中的尖括号被当作富文本标签。 */
export function formatDialogueText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(^|\n)(\s*)((?:海海|小轨|小明|A|B)\s*[：:])/g, '$1$2<b>$3</b>');
}
