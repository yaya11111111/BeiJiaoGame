import { describe, expect, it } from 'vitest';
import { completeLevel, createInitialAppState, getMapNodes, getMapRegions, signinAsGuest } from '../assets/scripts/ui/AppState';
import {
  CAMPUS_MAP,
  CAMPUS_MAP_NODES,
  CAMPUS_MAP_REGIONS,
  coloredMapRegions,
  mapNodePoint,
  mapRegionForLevel,
  shouldColorMapRegion,
} from '../assets/scripts/ui/MapLayout';

describe('campus map layout (new map)', () => {
  it('defines one region patch for each of the eleven levels', () => {
    expect(CAMPUS_MAP_REGIONS).toHaveLength(11);
    const levels = CAMPUS_MAP_REGIONS.map((region) => region.levelId).sort();
    expect(levels).toEqual(['GUIDE', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10']);
    for (const region of CAMPUS_MAP_REGIONS) {
      expect(region.patchAsset.startsWith('images/campus-region-')).toBe(true);
      expect(region.rect.x).toBeGreaterThanOrEqual(0);
      expect(region.rect.y).toBeGreaterThanOrEqual(0);
      expect(region.rect.x + region.rect.width).toBeLessThanOrEqual(1.0001);
      expect(region.rect.y + region.rect.height).toBeLessThanOrEqual(1.0001);
    }
    expect(CAMPUS_MAP.grayAsset).toBe('images/campus-map-gray');
  });

  it('keeps every level marker inside its own color region', () => {
    for (const region of CAMPUS_MAP_REGIONS) {
      const point = mapNodePoint(region.levelId);
      expect(point).not.toBeNull();
      expect(point!.x).toBeGreaterThanOrEqual(region.rect.x);
      expect(point!.x).toBeLessThanOrEqual(region.rect.x + region.rect.width);
      expect(point!.y).toBeGreaterThanOrEqual(region.rect.y);
      expect(point!.y).toBeLessThanOrEqual(region.rect.y + region.rect.height);
    }
    expect(Object.keys(CAMPUS_MAP_NODES)).toHaveLength(11);
  });

  it('starts fully gray: even the guide area stays gray until the guide is cleared', () => {
    expect(shouldColorMapRegion('unlocked', 'GUIDE')).toBe(false);
    expect(shouldColorMapRegion('completed', 'GUIDE')).toBe(true);
    expect(shouldColorMapRegion('unlocked', 'L01')).toBe(true);
    expect(shouldColorMapRegion('locked', 'L01')).toBe(false);

    const fresh = signinAsGuest(createInitialAppState(), 'E 成员');
    expect(coloredMapRegions(getMapNodes(fresh))).toHaveLength(0);
  });

  it('colors the guide and next region right after the guide is cleared', () => {
    const state = completeLevel(
      signinAsGuest(createInitialAppState(), 'E 成员'),
      'GUIDE',
      120,
      ['node_gate_plaza'],
    );
    const colored = coloredMapRegions(getMapNodes(state)).map((region) => region.levelId);

    expect(colored).toEqual(['GUIDE', 'L01']);
  });

  it('looks a region up by level', () => {
    expect(mapRegionForLevel('L05')?.patchAsset).toBe('images/campus-region-l05');
    expect(mapRegionForLevel('nope')).toBeNull();
    expect(mapNodePoint('nope')).toBeNull();
  });

  it('colors the numbered areas in the new order as each station unlocks', () => {
    let state = signinAsGuest(createInitialAppState(), 'E 成员');
    const route = [
      ['L05', 'node_history', '机械楼', 'l06'],
      ['L06', 'node_train_model', '八教', 'l07'],
      ['L07', 'node_sports', '西操场', 'l08'],
    ];

    for (const [clearedId, unlockId, place, patch] of route) {
      state = completeLevel(state, clearedId, 120, [unlockId]);
      const unlocked = getMapNodes(state).find((node) => node.nodeId === unlockId);
      expect(unlocked).toMatchObject({ place, state: 'unlocked' });
      const region = getMapRegions(state).find((view) => view.nodeId === unlockId);
      expect(coloredMapRegions(getMapNodes(state))).toContainEqual(expect.objectContaining({
        levelId: unlocked?.levelId,
        patchAsset: `images/campus-region-${patch}`,
        achievementId: region?.interactionId,
      }));
    }
  });
});
