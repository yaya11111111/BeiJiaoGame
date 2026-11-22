/**
 * 玩家反馈（FR-14）的表单校验、上下文拼装与提交载荷。
 *
 * 页面在 `AppShellView`（`feedback` 页），这里只放**不依赖 cc** 的部分，方便单测：
 * - 分类与文案；
 * - 提交前校验；
 * - 「自动附带」的关卡 / 模式 / 视角 / 来源页 / 时间；
 * - 最近几条提交回执（本地缓存，用来在页面上回显状态）。
 *
 * 云端落库归 C；E 只负责把字段按接口约定发出去，见 `接口需求.md`。
 */

import type { KeyValueStore } from './LocalStore';
import { readJson, writeJson } from './LocalStore';

export type FeedbackCategory = 'bug' | 'stuck' | 'suggestion' | 'newmode';

export interface FeedbackCategoryOption {
  id: FeedbackCategory;
  label: string;
  hint: string;
}

export const FEEDBACK_CATEGORIES: readonly FeedbackCategoryOption[] = [
  { id: 'bug', label: 'Bug', hint: '闪退、卡死、按钮点不动' },
  { id: 'stuck', label: '卡住了', hint: '不知道下一步该做什么' },
  { id: 'suggestion', label: '建议', hint: '体验、画面、节奏上的改进' },
  { id: 'newmode', label: '新玩法', hint: '希望后面版本加入的内容' },
];

export const FEEDBACK_CONTENT_MIN = 5;
export const FEEDBACK_CONTENT_MAX = 300;
export const FEEDBACK_HISTORY_LIMIT = 3;
export const FEEDBACK_STORAGE_KEY = 'bjg:feedback-history';

/** 提交时自动附带的上下文。字段名与 `接口需求.md` 一致，改之前先改那边。 */
export interface FeedbackContext {
  levelId: string;
  levelTitle: string;
  mode: 'solo' | 'duo' | '';
  viewId: 'A' | 'B' | '';
  /** 用户从哪个页面点进来的：settings / result / room ... */
  page: string;
  roomCode: string;
}

export interface FeedbackContextInput {
  levelId?: string;
  levelTitle?: string;
  mode?: 'solo' | 'duo' | null;
  viewId?: 'A' | 'B' | null;
  page?: string;
  roomCode?: string;
}

export interface FeedbackPayload {
  category: FeedbackCategory;
  content: string;
  /** 云存储 fileID；没传截图就是空字符串 */
  screenshotFileId: string;
  context: FeedbackContext & { submittedAt: number };
  clientVersion: string;
}

export interface FeedbackReceipt {
  /** 本地生成的 id，服务端返回 id 时不覆盖它，只用于列表去重 */
  localId: string;
  category: FeedbackCategory;
  content: string;
  screenshotAttached: boolean;
  submittedAt: number;
  status: 'submitted' | 'failed';
  /** 失败原因 / 成功提示，直接显示给玩家 */
  message: string;
}

export const FEEDBACK_CLIENT_VERSION = '0.2.0';

export function feedbackCategoryLabel(category: FeedbackCategory): string {
  const option = FEEDBACK_CATEGORIES.filter((item) => item.id === category)[0];
  return option ? option.label : category;
}

/** 返回错误文案；null 表示可以提交。 */
export function validateFeedbackContent(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return '请先写一下遇到了什么。';
  if (trimmed.length < FEEDBACK_CONTENT_MIN) return '再写 ' + (FEEDBACK_CONTENT_MIN - trimmed.length) + ' 个字，方便我们定位问题。';
  if (content.length > FEEDBACK_CONTENT_MAX) return '最多 ' + FEEDBACK_CONTENT_MAX + ' 个字，请精简一下。';
  return null;
}

export function buildFeedbackPayload(input: {
  category: FeedbackCategory;
  content: string;
  screenshotFileId?: string;
  context: FeedbackContext;
  submittedAt: number;
  clientVersion?: string;
}): FeedbackPayload {
  return {
    category: input.category,
    content: input.content.trim(),
    screenshotFileId: input.screenshotFileId || '',
    context: {
      levelId: input.context.levelId,
      levelTitle: input.context.levelTitle,
      mode: input.context.mode,
      viewId: input.context.viewId,
      page: input.context.page,
      roomCode: input.context.roomCode,
      submittedAt: input.submittedAt,
    },
    clientVersion: input.clientVersion || FEEDBACK_CLIENT_VERSION,
  };
}

/**
 * 把当前页面状态折成上下文。缺省值一律给空串而不是 undefined ——
 * 服务端写库时不用再判一遍类型。
 */
export function buildFeedbackContext(input: FeedbackContextInput): FeedbackContext {
  const mode = input.mode === 'duo' || input.mode === 'solo' ? input.mode : '';
  // 视角只有双人模式才有意义：单人是在一台设备上切 A/B，附上去反而误导排查。
  const viewId = mode === 'duo' && (input.viewId === 'A' || input.viewId === 'B') ? input.viewId : '';
  return {
    levelId: input.levelId || '',
    levelTitle: input.levelTitle || '',
    mode,
    viewId,
    page: input.page || '',
    roomCode: input.roomCode || '',
  };
}

export function feedbackContextSummary(context: FeedbackContext): string {
  const parts: string[] = [];
  if (context.levelTitle) parts.push(context.levelTitle);
  else if (context.levelId) parts.push(context.levelId);
  if (context.mode === 'duo') parts.push('双人');
  else if (context.mode === 'solo') parts.push('单人');
  if (context.mode === 'duo' && context.viewId) parts.push('视角 ' + context.viewId);
  if (context.roomCode) parts.push('房间 ' + context.roomCode);
  return parts.length > 0 ? parts.join(' · ') : '未进入关卡';
}

export function formatFeedbackTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => (value < 10 ? '0' : '') + value;
  return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 新回执放最前面，最多留 3 条。 */
export function pushFeedbackReceipt(history: FeedbackReceipt[], receipt: FeedbackReceipt): FeedbackReceipt[] {
  return [receipt].concat(history).slice(0, FEEDBACK_HISTORY_LIMIT);
}

export function loadFeedbackHistory(store: KeyValueStore): FeedbackReceipt[] {
  const raw = readJson(store, FEEDBACK_STORAGE_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isFeedbackReceipt)
    .slice(0, FEEDBACK_HISTORY_LIMIT)
    .map((receipt) => ({ ...receipt }));
}

export function saveFeedbackHistory(store: KeyValueStore, history: FeedbackReceipt[]): void {
  writeJson(store, FEEDBACK_STORAGE_KEY, history.slice(0, FEEDBACK_HISTORY_LIMIT));
}

/** 本地回执 id：时间戳 + 随机后缀，不用引入 uuid */
export function createFeedbackLocalId(now = Date.now(), random = Math.random()): string {
  return 'fb-' + now.toString(36) + '-' + Math.floor(random * 1e6).toString(36);
}

function isFeedbackReceipt(value: unknown): value is FeedbackReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<FeedbackReceipt>;
  return typeof receipt.localId === 'string'
    && typeof receipt.category === 'string'
    && typeof receipt.content === 'string'
    && typeof receipt.submittedAt === 'number'
    && (receipt.status === 'submitted' || receipt.status === 'failed');
}
