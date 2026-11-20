/** 场景左右两侧的大立绘；小轨使用独立的智能头像。 */
import type { EventTouch } from 'cc';
import { Mask, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { DIALOGUE_PORTRAITS, dialogueRoles, type DialogueRole, type DialoguePortraitLayout } from '../common/DialoguePortrait';
import type { ViewId } from '../common/LevelTypes';
import { uiNode } from './UiKitView';

export class DialoguePortraitView {
  private readonly slots: { node: Node; image: Node; sprite: Sprite; role: DialogueRole | null; revision: number }[];
  constructor(parent: Node, private readonly layout: DialoguePortraitLayout,
    private readonly load: (key: string, done: (frame: SpriteFrame | null) => void) => void) {
    const { width, height, leftX, rightX, centerY } = layout;
    this.slots = [-1, 1].map((side) => {
      const node = uiNode(side < 0 ? 'portraitLeft' : 'portraitRight', parent, width, height, 0.5, 0.5);
      node.setPosition(side < 0 ? leftX : rightX, centerY);
      for (const type of [Node.EventType.TOUCH_START, Node.EventType.TOUCH_MOVE, Node.EventType.TOUCH_END, Node.EventType.TOUCH_CANCEL]) {
        node.on(type, (event: EventTouch) => { event.propagationStopped = true; });
      }
      const image = uiNode('image', node, width, height - 24, 0.5, 0.5);
      image.setPosition(0, 10);
      const sprite = image.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      node.active = false;
      return { node, image, sprite, role: null, revision: 0 };
    });
  }
  render(text: string, view: ViewId): void {
    const roles = dialogueRoles(text, view);
    [roles.left, roles.right].forEach((role, index) => this.show(index, role));
  }
  private show(index: number, role: DialogueRole | null): void {
    const slot = this.slots[index];
    if (slot.role === role && (!role || slot.sprite.spriteFrame)) return;
    slot.role = role; const revision = ++slot.revision;
    slot.node.active = false; slot.sprite.spriteFrame = null;
    if (!role) return;
    const portrait = DIALOGUE_PORTRAITS[role];
    this.load(portrait.assetKey, frame => {
      if (!slot.node.isValid || slot.revision !== revision || !frame) return;
      const boxH = portrait.avatar ? this.layout.avatarSize : this.layout.height;
      const boxW = portrait.avatar ? boxH : this.layout.width;
      const { width, height } = frame.originalSize;
      const scale = Math.min(boxW / width, boxH / height);
      slot.image.getComponent(UITransform)!.setContentSize(width * scale, height * scale);
      slot.node.setPosition(index === 0 ? this.layout.leftX : this.layout.rightX,
        portrait.avatar ? this.layout.avatarCenterY : this.layout.bottom + height * scale / 2);
      slot.image.setPosition(0, 0);
      const mask = slot.image.getComponent(Mask) ?? slot.image.addComponent(Mask);
      mask.type = Mask.Type.GRAPHICS_ELLIPSE; mask.enabled = portrait.avatar;
      slot.sprite.spriteFrame = frame; slot.node.active = true;
    });
  }
}
