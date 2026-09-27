import { MINI_PROGRAM_CONFIG } from './AppState';

type WxCloudApi = {
  init: (options: { env: string; traceUser: boolean }) => void;
};

type WxRuntime = {
  cloud?: WxCloudApi;
};

let initialized = false;

export function initWechatCloud(runtime: WxRuntime | undefined = getWxRuntime()): boolean {
  if (initialized) {
    return true;
  }
  if (!runtime) {
    console.warn('[WechatCloud] Non-WeChat runtime, skipped cloud init.');
    return false;
  }
  if (!runtime.cloud) {
    console.error('当前基础库不支持云开发');
    return false;
  }

  runtime.cloud.init({
    env: MINI_PROGRAM_CONFIG.cloudEnv,
    traceUser: true,
  });
  initialized = true;
  return true;
}

export function resetWechatCloudInitForTest(): void {
  initialized = false;
}

function getWxRuntime(): WxRuntime | undefined {
  return (globalThis as { wx?: WxRuntime }).wx;
}
