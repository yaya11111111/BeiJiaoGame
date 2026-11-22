/**
 * 外层设置（背景音乐 / 操作音效 / 新手提示）的本地持久化。
 *
 * 验收用例 OUT-21 要求「离开设置页再返回并重启后，开关状态与实际效果一致」。
 * 这几项是**设备级偏好**，不属于账号进度，所以走本地缓存而不是 C 的接口。
 */

import type { UserSettings } from './AppState';
import { settingsFromUnknown } from './AppState';
import type { KeyValueStore } from './LocalStore';
import { readJson, writeJson } from './LocalStore';

export const SETTINGS_STORAGE_KEY = 'bjg:ui-settings';

export function loadUiSettings(store: KeyValueStore): UserSettings {
  return settingsFromUnknown(readJson(store, SETTINGS_STORAGE_KEY));
}

export function saveUiSettings(store: KeyValueStore, settings: UserSettings): void {
  writeJson(store, SETTINGS_STORAGE_KEY, {
    bgmEnabled: settings.bgmEnabled,
    sfxEnabled: settings.sfxEnabled,
    tutorialEnabled: settings.tutorialEnabled,
    vibrationEnabled: settings.vibrationEnabled,
  });
}
