import { describe, expect, it } from 'vitest';
import { dialoguePortraitLayout, dialogueRoles, formatDialogueText } from '../assets/scripts/common/DialoguePortrait';

describe('对话中的海海与其他人物', () => {
  it('海海随过去/现在视角区分，两侧能显示两个时期的同一个人', () => {
    expect(dialogueRoles('海海：我们出发吧。', 'A')).toEqual({ left: 'A', right: null });
    expect(dialogueRoles('海海：那天我没吃完。', 'B')).toEqual({ left: 'B', right: null });
    expect(dialogueRoles('A：你是谁？\nB：四年后的你。', 'A')).toEqual({ left: 'A', right: 'B' });
    expect(dialogueRoles('小轨：归档完成。\n海海：收到。', 'B')).toEqual({ left: 'B', right: 'XiaoGui' });
    expect(dialogueRoles('海海和小明在学四餐厅停下来吃饭。', 'A')).toEqual({ left: null, right: null });
    expect(dialogueRoles('小明把豆浆推了过来：“先吃饭。”', 'A')).toEqual({ left: 'XiaoMing', right: null });
    expect(dialogueRoles('小轨：归档完成。', 'A')).toEqual({ left: 'XiaoGui', right: null });
    expect(dialogueRoles('请先选中借阅卡。', 'B')).toEqual({ left: null, right: null });
  });
  it.each([
    { width: 1280, height: 720, inset: { left: 0, right: 0, top: 0, bottom: 0 } },
    { width: 1600, height: 720, inset: { left: 100, right: 60, top: 20, bottom: 86 } },
    { width: 1920, height: 720, inset: { left: 0, right: 0, top: 0, bottom: 0 } },
  ])('大立绘下移到对话框底边，仍在 $width 画面两侧并避开顶部提示', box => {
    const layout = dialoguePortraitLayout(box, box.inset);
    expect(layout.height).toBeGreaterThan(450);
    expect(layout.avatarSize).toBeGreaterThan(230);
    expect(layout.leftX + layout.width / 2).toBeLessThan(-box.width * 0.2);
    expect(layout.rightX - layout.width / 2).toBeGreaterThan(box.width * 0.2);
    expect(layout.centerY + layout.height / 2).toBeLessThanOrEqual(box.height / 2 - box.inset.top - 128);
    expect(layout.centerY - layout.height / 2).toBeCloseTo(-box.height / 2 + box.inset.bottom + 16);
  });
  it('仅对实际发言的姓名前缀加粗，正文、档案和特殊字符保持原意', () => {
    expect(formatDialogueText('小轨：归档完成。\n海海：收到。')).toBe('<b>小轨：</b>归档完成。\n<b>海海：</b>收到。');
    expect(formatDialogueText('海海和小明在餐厅吃饭。')).toBe('海海和小明在餐厅吃饭。');
    expect(formatDialogueText('A: 2 < 3 & 4 > 1')).toBe('<b>A:</b> 2 &lt; 3 &amp; 4 &gt; 1');
    expect(formatDialogueText('档案：<b>小轨</b>')).toBe('档案：&lt;b&gt;小轨&lt;/b&gt;');
  });
});
