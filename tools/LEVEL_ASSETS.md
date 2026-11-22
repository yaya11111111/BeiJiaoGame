# 关卡美术 Bundle 与远程发布

适用 Cocos Creator 3.8.8，微信小游戏。关卡背景、特写、叠图已经连同原有 `.meta` 搬到 `client/assets/levels/{bg,details,overlays}`，Bundle 名为 `levels`。关卡 JSON 中 `bg/...`、`details/...` 等 key 保持不变。A/B 后续的新图放到这里，不再放进 resources。

`resources` 保留关卡 JSON、首页地图和音频；微信仍使用本地 resources 分包。当前未开通托管，默认 Bundle 配置为本地，编辑器预览不依赖 CDN。没有迁移或部署云数据库。

## 当前已验证的结果

- 远程检查构建主包约 2.08 MiB、resources 分包约 4.62 MiB、美术远程 Bundle 约 16.89 MiB。以构建生成的 `asset-release.json` 为准。
- 图片按需加载，不在首次进关时下载整个 Bundle。并发请求合并，失败最多额外重试两次，间隔 400/800ms；不缓存失败结果。
- 普通背景和火车地图显示加载状态，失败可点击重试；特写关闭重开、切视角或重进关也可重新加载。已有缺图仍走占位，不代表该图已交付。
- 保留引用计数、背景缓存淘汰、手工包装纹理释放与退出后的异步回调保护。
- 没有统一缩小图片，避免影响细小线索及原图坐标。原素材内容和 UUID 均保留。

## 本地调试构建

先在 Cocos 的构建面板建立一次微信构建任务，脚本复用本机构建配置。也可指定从面板导出的 JSON：

```bash
node tools/build-level-assets.mjs
# 或
node tools/build-level-assets.mjs --config /绝对路径/微信构建配置.json
```

默认查找 macOS 的 Creator 3.8.8；其他安装位置用 `--creator` 或 `COCOS_CREATOR` 环境变量指定。输出为 `client/build/wechatgame-local/`，仅供调试。完整美术在本地，体积不能视为上线包验收结果。原有 `client/build/wechatgame/` 不被覆盖。

## 未开托管时检查远程包

```bash
node tools/build-level-assets.mjs --check
```

输出为 `client/build/wechatgame-remote-check/`。域名明确使用 `assets.example.invalid`，只用于检查构建、拆包和 MD5，不能用于真机游玩，也不能用于上传提审。

## 获得托管域名后发布

1. 确认可公开读取资源的 HTTPS 托管域名，及微信 `downloadFile` 合法域名配置。CloudBase 默认域名适合测试，正式发布需按实际环境确认域名限制与套餐，不使用手册中的固定免费额度作预算。
2. 每次使用新的 release 名构建，例如：

```bash
node tools/build-level-assets.mjs --server https://你的资源域名/ --release 20261119-01
```

3. 产物在 `client/build/wechatgame-remote/`。查看 `asset-release.json` 的 `manifestUrl` 和上传说明。
4. 构建脚本会自动把 `remote/` 加入微信上传忽略列表；它只交给托管，不随微信代码包上传。将构建里的 **remote 整个目录**上传至托管的 `releases/20261119-01/remote/`。例如实际清单路径为：

```text
https://你的资源域名/releases/20261119-01/remote/levels/config.<hash>.json
```

5. 先验证清单、其引用的 import/native 文件可访问，再在微信开发者工具打开对应发布包，真机验证后上传。

注意：引擎通过 Bundle 名加载时自动在资源服务器根地址后加 `remote/levels/`。不能把 remote 层去掉，也不能只上传原始 JPG/PNG。构建输出采用 UUID 和哈希文件名，不能靠是否存在字面的 bg/details 文件夹判断拆包是否成功；脚本会检查两侧资源清单。

脚本使用项目独立的 `level-art` Bundle 配置。Creator 3.8.8 普通构建不会可靠采用 `bundleConfigs[].isRemote`，因此脚本在构建期间调整该配置，结束后恢复原文件。不要与其他构建同时执行。构建日志与本机构建配置保存在系统临时目录，不提交 AppID 或本地 profiles。

## 版本与回退

采用 **不同发布目录 + MD5 文件名**。新游戏包记录自己的发布目录和 Bundle 哈希；旧版本继续使用旧目录，所以旧发布文件必须保留。

本实现没有提供远程版本清单热更新。**只重新上传 CDN，不会让已安装的旧客户端自动获取新图**。换图后重新构建并发布相应游戏版本；不得覆盖旧版本文件来模拟热更新。如果以后需要不发包更新图片，应另做受控的远程版本清单与兼容验证。

本地回退直接运行无 `--server` 的构建；线上回退选择此前已验收的游戏包与对应完整资源目录。

## 托管上线验收

构建检查不能代替网络和真机验收，以下项目仍须在托管开通后执行：

- 清单和所有资源文件的 URL、读取权限、响应类型正常；无额外目录或重定向错误。
- 微信合法域名校验开启，真机冷启动、再次进入、清缓存后重新进入均可加载。
- 弱网、断网、恢复后点击重试；图片未返回时退出关卡，再进入下一关无异常。
- 检查全部已交付美术、特写和第七关火车；未交付图片单独记录，不能当作网络失败。
- 双人两端分别冷启动，进入同一关能加载；图片请求不影响存档和通关同步。
- 保留旧客户端安装包，发布新目录后确认旧版本仍能加载原有资源。

参考：[Cocos Bundle 及版本规则](https://docs.cocos.com/creator/3.8/manual/en/asset/bundle.html)、[CloudBase 托管域名说明](https://docs.cloudbase.net/hosting/manage)。

## 本次交付的托管目标

C 已提供测试托管域名：`https://cloudbase-d2gvkcghabfaf9768-1492195043.tcloudbaseapp.com/`。已验证域名可达，根目录返回 404，不能由此判断具体资源是否已上传，也不能确认微信合法域名配置。

对应发布目录为 `releases/20261119-01/`，本机构建路径为 `client/build/wechatgame-remote/`。C 已完成托管上传与微信合法域名配置，用户已在真机确认图片显示，第二次进入明显更快。

本次资源清单 `releases/20261119-01/remote/levels/config.0d65b.json` 已确认返回 HTTP 200；托管文件与本地构建内容逐文件匹配。可交给 C 的 ZIP：`client/build/levels-upload-20261119-01.zip`，解压后含完整 `releases/20261119-01/remote/levels/` 层级。上传时保留层级。

## 本次验证记录（2026-11-19）

23 个测试文件、664 项测试通过，普通与 Cocos View 两套类型检查通过。新增验证覆盖同图并发、Bundle 网络失败、有限退避、断网耗尽后恢复重试，以及已有图片引用计数与退出后异步回调测试。编辑器预览实际确认独立 Bundle 的第七关底图与火车显示正常。

本地调试构建、占位域名远程检查构建、C 提供域名的远程发布构建均通过。已确认微信包忽略 remote 目录、资源 ZIP 解压校验通过、资源清单哈希正确、构建结束恢复本地配置。169 个原图/目录元数据文件移动前后内容一致。
