import { MINI_PROGRAM_CONFIG } from './AppState';

type WxCloudApi = {
  init: (options: { env: string; traceUser: boolean }) => void;
  uploadFile?: (options: {
    cloudPath: string;
    filePath: string;
    success: (result: { fileID: string }) => void;
    fail: (error: unknown) => void;
  }) => void;
  getTempFileURL?: (options: {
    fileList: string[];
    success: (result: { fileList?: Array<{ fileID: string; tempFileURL?: string; status?: number }> }) => void;
    fail: (error: unknown) => void;
  }) => void;
};

type WxRuntime = {
  cloud?: WxCloudApi;
  getUserProfile?: (options: {
    desc: string;
    success: (result: { userInfo?: { nickName?: string; avatarUrl?: string } }) => void;
    fail: (error: unknown) => void;
  }) => void;
  chooseMedia?: (options: {
    count: number;
    mediaType: ['image'];
    sourceType: Array<'album' | 'camera'>;
    success: (result: { tempFiles?: Array<{ tempFilePath?: string }> }) => void;
    fail: (error: unknown) => void;
  }) => void;
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

  try {
    runtime.cloud.init({
      env: MINI_PROGRAM_CONFIG.cloudEnv,
      traceUser: true,
    });
    initialized = true;
    return true;
  } catch (error) {
    // A wrong AppID, missing environment, or an invalid developer session can
    // make wx.cloud.init throw before any callFunction is attempted.
    console.error('[WechatCloud] cloud init error:', error);
    initialized = false;
    return false;
  }
}

export function resetWechatCloudInitForTest(): void {
  initialized = false;
}

export function requestWechatProfile(): Promise<{ nickname: string; avatarUrl?: string }> {
  const runtime = getWxRuntime();
  if (!runtime?.getUserProfile) {
    return Promise.reject(new Error('当前微信基础库不支持资料授权'));
  }
  return new Promise((resolve, reject) => {
    runtime.getUserProfile!({
      desc: '用于显示你的昵称和头像',
      success: ({ userInfo }) => resolve({
        nickname: userInfo?.nickName?.trim() || '',
        avatarUrl: userInfo?.avatarUrl,
      }),
      fail: reject,
    });
  });
}

export async function chooseAndUploadWechatAvatar(): Promise<{ fileID: string; previewUrl: string }> {
  const runtime = getWxRuntime();
  if (!runtime?.chooseMedia) {
    throw new Error('当前微信基础库不支持选择图片');
  }
  if (!runtime.cloud?.uploadFile) {
    throw new Error('当前云环境不支持头像上传');
  }

  const filePath = await new Promise<string>((resolve, reject) => {
    runtime.chooseMedia!({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (result) => {
        const selected = result.tempFiles?.[0]?.tempFilePath;
        selected ? resolve(selected) : reject(new Error('没有选择图片'));
      },
      fail: reject,
    });
  });
  const extension = filePath.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)?.[1]?.toLowerCase() || 'jpg';
  const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
  const fileID = await new Promise<string>((resolve, reject) => {
    runtime.cloud!.uploadFile!({
      cloudPath,
      filePath,
      success: (result) => resolve(result.fileID),
      fail: reject,
    });
  });
  return { fileID, previewUrl: filePath };
}

export function resolveWechatImageUrl(fileID: string): Promise<string> {
  if (!fileID.startsWith('cloud://')) return Promise.resolve(fileID);
  const cloud = getWxRuntime()?.cloud;
  if (!cloud?.getTempFileURL) return Promise.reject(new Error('当前云环境无法读取头像'));
  return new Promise((resolve, reject) => {
    cloud.getTempFileURL!({
      fileList: [fileID],
      success: (result) => {
        const item = result.fileList?.[0];
        item?.tempFileURL ? resolve(item.tempFileURL) : reject(new Error('头像临时地址获取失败'));
      },
      fail: reject,
    });
  });
}

function getWxRuntime(): WxRuntime | undefined {
  return (globalThis as { wx?: WxRuntime }).wx;
}
