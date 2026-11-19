#!/usr/bin/env node
/** 使用本机导出的微信构建配置，独立生成本地调试包或远程美术发布包。 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} 缺少参数`);
  return args[index + 1];
};
const check = args.includes('--check');
const server = value('--server');
const remote = !!server || check;
const release = value('--release') || (check ? 'local-check' : undefined);
if (remote && (!release || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release))) {
  throw new Error('远程发布必须指定 --release，例如 20261119-01；每次发布使用新名称');
}
const base = new URL(server || 'https://assets.example.invalid/');
if (remote && (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password)) {
  throw new Error('--server 必须为不含查询参数、口令的 HTTPS 地址');
}
if (remote && !check && base.hostname.endsWith('.invalid')) throw new Error('占位域名只能用于 --check，不能发布');
if (!base.pathname.endsWith('/')) base.pathname += '/';
const releaseRoot = new URL(`releases/${release}/`, base).href;
const configFile = value('--config');
let options;
if (configFile) options = JSON.parse(readFileSync(resolve(configFile), 'utf8'));
else {
  const profile = join(root, 'client/profiles/v2/packages/builder.json');
  if (!existsSync(profile)) throw new Error('请先在 Cocos 中建立微信构建任务，或用 --config 指定导出的构建 JSON');
  const tasks = JSON.parse(readFileSync(profile, 'utf8')).BuildTaskManager?.taskMap || {};
  options = Object.values(tasks).map(task => task.options).find(option => option?.platform === 'wechatgame');
  if (!options) throw new Error('本机构建记录里没有微信任务，请用 --config 指定导出的微信构建 JSON');
}
if (options.platform !== 'wechatgame') throw new Error('配置必须是 wechatgame 平台');
const creator = value('--creator') || process.env.COCOS_CREATOR ||
  '/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator';
if (!existsSync(creator)) throw new Error('找不到 Cocos，请设置 COCOS_CREATOR 或使用 --creator 指定编辑器可执行文件');
const outputName = remote ? (check ? 'wechatgame-remote-check' : 'wechatgame-remote') : 'wechatgame-local';
Object.assign(options, {
  server: remote ? releaseRoot : '', md5Cache: true, debug: false,
  buildMode: 'normal', buildBundleOnly: false, outputName, taskName: outputName,
  buildPath: 'project://build', useBuiltinServer: false,
  bundleConfigs: [
    { root: 'db://assets/resources', name: 'resources', output: true, compressionType: 'subpackage', isRemote: false },
    { root: 'db://assets/levels', name: 'levels', output: true, compressionType: 'merge_dep', isRemote: remote },
  ],
});
const temporary = mkdtempSync(join(tmpdir(), 'beijiao-assets-'));
const generatedConfig = join(temporary, 'build.json');
writeFileSync(generatedConfig, JSON.stringify(options, null, 2));
console.log(`构建 ${outputName}；详细日志：${join(temporary, 'build.log')}`);
// 3.8.8 的普通构建不采用 bundleConfigs 内的 isRemote；实际读取项目 Bundle 配置。
// 构建期间只覆盖独立 level-art 配置，完成后原样恢复，网页预览始终使用本地资源。
const settingsPath = join(root, 'client/settings/v2/packages/builder.json');
const originalSettings = readFileSync(settingsPath, 'utf8');
const buildSettings = JSON.parse(originalSettings);
buildSettings.bundleConfig.custom['level-art'].configs.miniGame = {
  configMode: 'overwrite', fallbackOptions: { isRemote: false, compressionType: 'merge_dep' },
  overwriteSettings: { wechatgame: { isRemote: remote, compressionType: 'merge_dep' } },
};
let result;
try {
  writeFileSync(settingsPath, JSON.stringify(buildSettings, null, 2) + '\n');
  result = spawnSync(creator, ['--project', join(root, 'client'), '--build', `configPath=${generatedConfig}`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} finally { writeFileSync(settingsPath, originalSettings); }
writeFileSync(join(temporary, 'build.log'), (result.stdout || '') + (result.stderr || ''));
if (result.error || ![0, 36].includes(result.status)) throw result.error || new Error(`Cocos 构建失败：${result.status}，请查看日志`);

const output = join(root, 'client/build', outputName);
const settingsName = readdirSync(join(output, 'src')).find(name => /^settings(?:\..+)?\.json$/.test(name));
const settings = JSON.parse(readFileSync(join(output, 'src', settingsName), 'utf8'));
if (remote && (!settings.assets.remoteBundles.includes('levels') || settings.assets.server !== releaseRoot)) {
  throw new Error('远程配置未生效：检查 levels Bundle 的构建覆盖配置');
}
if (!remote && settings.assets.remoteBundles.includes('levels')) throw new Error('本地构建仍引用远程 levels');
// 远程文件只上传托管，明确排除，避免开发者工具再次把它们算入上传包。
if (remote) {
  const projectPath = join(output, 'project.config.json');
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  project.packOptions ||= {};
  project.packOptions.ignore ||= [];
  for (const entry of [{ type: 'folder', value: 'remote' }, { type: 'file', value: 'asset-release.json' }]) {
    if (!project.packOptions.ignore.some(item => item.type === entry.type && item.value === entry.value)) {
      project.packOptions.ignore.push(entry);
    }
  }
  writeFileSync(projectPath, JSON.stringify(project, null, 2) + '\n');
}
const files = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
  const child = join(path, entry.name);
  return entry.isDirectory() ? files(child) : [child];
});
const bytes = paths => paths.reduce((sum, path) => sum + statSync(path).size, 0);
const mainBytes = bytes(readdirSync(output, { withFileTypes: true })
  .filter(entry => !['remote', 'subpackages', 'asset-release.json'].includes(entry.name))
  .flatMap(entry => entry.isDirectory() ? files(join(output, entry.name)) : [join(output, entry.name)]));
const artPath = join(output, remote ? 'remote/levels' : 'assets/levels');
const manifestName = readdirSync(artPath).find(name => /^config\..+\.json$/.test(name));
if (!manifestName) throw new Error('levels 未输出带 MD5 的清单');
const artConfig = JSON.parse(readFileSync(join(artPath, manifestName), 'utf8'));
if (!Object.values(artConfig.paths).some(info => info[0] === 'bg/L08_train_A')) throw new Error('火车底图未进入 levels');
if (remote && mainBytes >= 4 * 1024 * 1024) throw new Error(`主包过大：${mainBytes} bytes`);
const resourcesPath = join(output, 'subpackages/resources');
const resourcesConfig = JSON.parse(readFileSync(join(resourcesPath,
  readdirSync(resourcesPath).find(name => /^config(?:\..+)?\.json$/.test(name))), 'utf8'));
if (Object.values(resourcesConfig.paths).some(info => /^(bg|details|overlays)\//.test(info[0]))) {
  throw new Error('关卡美术仍泄漏到 resources 分包');
}
const report = {
  mode: check ? 'remote-check-only' : remote ? 'remote' : 'local',
  release: remote ? release : null, mainBytes, artBytes: bytes(files(artPath)),
  resourcesBytes: bytes(files(resourcesPath)), bundleVersion: settings.assets.bundleVers.levels,
  server: remote ? releaseRoot : null,
  manifestUrl: remote ? new URL(`remote/levels/${manifestName}`, releaseRoot).href : null,
  upload: remote ? `将本构建 remote/ 整个目录上传到 releases/${release}/remote/，保留旧版本` : null,
  requiresDomainAndDeviceVerification: remote,
};
writeFileSync(join(output, 'asset-release.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(`产物：${output}${check ? '（占位域名，仅检查构建；不能用于真机游玩）' : ''}`);
