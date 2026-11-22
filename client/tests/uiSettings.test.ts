import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsFromUnknown } from '../assets/scripts/ui/AppState';
import { loadUiSettings, saveUiSettings, SETTINGS_STORAGE_KEY } from '../assets/scripts/ui/SettingsStore';
import { memoryKeyValueStore } from '../assets/scripts/ui/LocalStore';

describe('outer settings persistence (OUT-21)', () => {
  it('falls back to defaults for an empty cache', () => {
    const store = memoryKeyValueStore();

    expect(loadUiSettings(store)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips every switch through local storage', () => {
    const store = memoryKeyValueStore();
    saveUiSettings(store, {
      bgmEnabled: false,
      sfxEnabled: true,
      tutorialEnabled: false,
      vibrationEnabled: false,
    });

    expect(loadUiSettings(store)).toEqual({
      bgmEnabled: false,
      sfxEnabled: true,
      tutorialEnabled: false,
      vibrationEnabled: false,
    });
  });

  it('repairs partial or dirty cached settings', () => {
    expect(settingsFromUnknown({ bgmEnabled: false, sfxEnabled: 'yes' })).toEqual({
      ...DEFAULT_SETTINGS,
      bgmEnabled: false,
    });
    expect(settingsFromUnknown('oops')).toEqual(DEFAULT_SETTINGS);
  });

  it('writes only the known fields', () => {
    const store = memoryKeyValueStore();
    saveUiSettings(store, { ...DEFAULT_SETTINGS, bgmEnabled: false });

    const raw = JSON.parse(store.read(SETTINGS_STORAGE_KEY) || '{}');
    expect(Object.keys(raw).sort()).toEqual(['bgmEnabled', 'sfxEnabled', 'tutorialEnabled', 'vibrationEnabled']);
    expect(raw.bgmEnabled).toBe(false);
  });
});
