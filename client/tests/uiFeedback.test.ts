import { describe, expect, it } from 'vitest';
import {
  buildFeedbackContext,
  buildFeedbackPayload,
  createFeedbackLocalId,
  FEEDBACK_CATEGORIES,
  FEEDBACK_HISTORY_LIMIT,
  feedbackCategoryLabel,
  feedbackContextSummary,
  formatFeedbackTime,
  loadFeedbackHistory,
  pushFeedbackReceipt,
  saveFeedbackHistory,
  validateFeedbackContent,
} from '../assets/scripts/ui/Feedback';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';

describe('feedback form (FR-14)', () => {
  it('asks for a description with a minimum length and a hard cap', () => {
    expect(validateFeedbackContent('')).toBe('请先写一下遇到了什么。');
    expect(validateFeedbackContent('   ')).toBe('请先写一下遇到了什么。');
    expect(validateFeedbackContent('卡了')).toContain('再写');
    expect(validateFeedbackContent('第 3 关点了通知板没有反应')).toBeNull();
    expect(validateFeedbackContent('x'.repeat(301))).toContain('300');
  });

  it('always builds a context with strings, never undefined', () => {
    const context = buildFeedbackContext({});

    expect(context).toEqual({
      levelId: '',
      levelTitle: '',
      mode: '',
      viewId: '',
      page: '',
      roomCode: '',
    });
  });

  it('keeps the view id only for duo mode', () => {
    const solo = buildFeedbackContext({ mode: 'solo', viewId: 'A' });
    const duo = buildFeedbackContext({ mode: 'duo', viewId: 'B', roomCode: 'AB3K9Q' });

    expect(solo.viewId).toBe('');
    expect(duo.viewId).toBe('B');
    expect(duo.roomCode).toBe('AB3K9Q');
  });

  it('trims the content and carries the optional screenshot file id', () => {
    const payload = buildFeedbackPayload({
      category: 'bug',
      content: '  第 3 关点了通知板没反应  ',
      screenshotFileId: 'cloud://env/feedback/a.jpg',
      context: buildFeedbackContext({ levelId: 'L03', levelTitle: '第 3 关 · 思源楼前', mode: 'duo', viewId: 'B', page: 'settings' }),
      submittedAt: 1700000000000,
      clientVersion: 'test',
    });

    expect(payload.content).toBe('第 3 关点了通知板没反应');
    expect(payload.screenshotFileId).toBe('cloud://env/feedback/a.jpg');
    expect(payload.context.page).toBe('settings');
    expect(payload.context.submittedAt).toBe(1700000000000);
    expect(payload.clientVersion).toBe('test');
  });

  it('drops the screenshot field down to an empty string when none is attached', () => {
    const payload = buildFeedbackPayload({
      category: 'suggestion',
      content: '希望加个提示开关',
      context: buildFeedbackContext({ page: 'settings' }),
      submittedAt: 1,
    });

    expect(payload.screenshotFileId).toBe('');
  });

  it('summarises the auto-attached context for the form', () => {
    expect(feedbackContextSummary(buildFeedbackContext({}))).toBe('未进入关卡');
    expect(feedbackContextSummary(buildFeedbackContext({
      levelTitle: '第 5 关 · 学四餐厅',
      mode: 'duo',
      viewId: 'A',
      roomCode: 'AB3K9Q',
    }))).toBe('第 5 关 · 学四餐厅 · 双人 · 视角 A · 房间 AB3K9Q');
  });

  it('maps category ids to readable labels', () => {
    expect(FEEDBACK_CATEGORIES).toHaveLength(4);
    expect(feedbackCategoryLabel('stuck')).toBe('卡住了');
    expect(feedbackCategoryLabel('newmode')).toBe('新玩法');
  });

  it('keeps at most three receipts, newest first', () => {
    const base = {
      localId: 'fb-0',
      category: 'bug' as const,
      content: 'x',
      screenshotAttached: false,
      submittedAt: 1,
      status: 'submitted' as const,
      message: 'ok',
    };
    const history = pushFeedbackReceipt([base], { ...base, localId: 'fb-1', submittedAt: 2 });
    const capped = pushFeedbackReceipt(
      pushFeedbackReceipt(history, { ...base, localId: 'fb-2', submittedAt: 3 }),
      { ...base, localId: 'fb-3', submittedAt: 4 },
    );

    expect(capped).toHaveLength(FEEDBACK_HISTORY_LIMIT);
    expect(capped[0].localId).toBe('fb-3');
  });

  it('round-trips receipts through local storage and ignores junk', () => {
    const store = memoryKeyValueStore();
    const receipt = {
      localId: createFeedbackLocalId(1700000000000, 0.5),
      category: 'bug' as const,
      content: '点了没反应',
      screenshotAttached: true,
      submittedAt: 1700000000000,
      status: 'submitted' as const,
      message: '已提交',
    };

    saveFeedbackHistory(store, [receipt]);
    expect(loadFeedbackHistory(store)).toEqual([receipt]);

    store.write('bjg:feedback-history', '{"not":"an array"}');
    expect(loadFeedbackHistory(store)).toEqual([]);
  });

  it('formats submit time as month-day hour:minute', () => {
    const stamp = new Date(2026, 10, 2, 16, 5).getTime();
    expect(formatFeedbackTime(stamp)).toBe('11-02 16:05');
  });
});
