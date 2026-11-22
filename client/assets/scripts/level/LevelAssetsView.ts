/** 关卡美术 Bundle 桥接。编辑器/本地 Bundle 与远程 Bundle 共用同一路径。 */
import { Asset, AssetManager, ImageAsset, SpriteFrame, assetManager } from 'cc';
import { BundleImageLoader } from '../common/BundleImageLoader';

export type LevelImage = { frame: SpriteFrame; image?: never } | { frame?: never; image: ImageAsset };

function load<T extends Asset>(bundle: AssetManager.Bundle, key: string, type: new (...args: any[]) => T): Promise<T | null> {
  return new Promise(resolve => {
    bundle.load(key, type, (error, asset) => resolve(error || !asset ? null : asset));
  });
}

const loader = new BundleImageLoader<AssetManager.Bundle, LevelImage>({
  bundle: () => {
    const loaded = assetManager.getBundle('levels');
    if (loaded) return Promise.resolve(loaded);
    return new Promise((resolve, reject) => {
      assetManager.loadBundle('levels', (error, bundle) => {
        if (error || !bundle) reject(error || new Error('levels bundle unavailable'));
        else resolve(bundle);
      });
    });
  },
  image: async (bundle, key) => {
    // 先检查清单，未交付的 key 不发起无意义的图片下载。
    if (!bundle.getInfoWithPath(key, SpriteFrame) && !bundle.getInfoWithPath(key + '/spriteFrame', SpriteFrame) &&
        !bundle.getInfoWithPath(key, ImageAsset)) return null;
    const frame = await load(bundle, key, SpriteFrame) || await load(bundle, key + '/spriteFrame', SpriteFrame);
    if (frame) return { frame };
    const image = await load(bundle, key, ImageAsset);
    return image ? { image } : null;
  },
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
});

/** 不永久缓存失败；引用计数和手工包装图的释放仍由 LevelView 管理。 */
export function loadLevelImage(key: string): Promise<LevelImage | null> { return loader.load(key); }
