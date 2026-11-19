/** 与引擎解耦的 Bundle 请求协调：失败不缓存，下次进入或手动重试可恢复。 */
export interface BundleImageSource<B, A> {
  bundle(): Promise<B>;
  image(bundle: B, key: string): Promise<A | null>;
  delay(ms: number): Promise<void>;
}

export class BundleImageLoader<B, A> {
  private pendingBundle: Promise<B> | null = null;
  private readonly pending = new Map<string, Promise<A | null>>();

  constructor(private readonly source: BundleImageSource<B, A>, private readonly retries = 2) {}

  private bundle(): Promise<B> {
    if (this.pendingBundle) return this.pendingBundle;
    const request = this.source.bundle();
    this.pendingBundle = request;
    const clear = (): void => { if (this.pendingBundle === request) this.pendingBundle = null; };
    void request.then(clear, clear);
    return request;
  }

  load(key: string): Promise<A | null> {
    const waiting = this.pending.get(key);
    if (waiting) return waiting;
    const request = this.tryLoad(key);
    this.pending.set(key, request);
    void request.then(() => this.pending.delete(key));
    return request;
  }

  private async tryLoad(key: string): Promise<A | null> {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const image = await this.source.image(await this.bundle(), key);
        if (image) return image;
      } catch { /* 网络失败与缺图均交给有限重试，最后由界面提供恢复入口。 */ }
      if (attempt < this.retries) await this.source.delay(400 * (attempt + 1));
    }
    return null;
  }
}
