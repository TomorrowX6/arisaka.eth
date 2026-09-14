# Roro 聊天后端

静态站直接将聊天请求发到 Cloudflare Worker，由 Worker 检查来源、输入和调用额度，再调用 DeepSeek。DeepSeek 密钥和 IP 哈希密钥只保存在后端，前端配置仅包含公开接口地址。

前端设置位于 `../../src/config/live2d-chat.ts`，`autoTopics` 默认开启：进入公开文章时，向 Worker 请求一条 AI 生成的简短开场白，此后每 10 秒请求下一条；Worker 从该文的 39 条话题缓存中抽取。首页、归档、About、Friends 等非文章页面每 10 秒轮换动漫语录；加密文章和无公开正文的页面也使用本地语录。统一间隔由 `rotationIntervalMs` 设置。`../../src/components/widget/Live2DChat.astro` 控制气泡和聊天面板，`../../src/scripts/live2d-chat.ts` 管理发送及缓存。气泡只显示回复文字，宽高随内容调整；绿色圆形白色上箭头发送按钮位于输入框内右下角，等待时显示进度环，滚动区域使用细绿色滚动条。

服务端人设和额度位于 `src/policy.ts`，使用 DeepSeek V4.1 Flash（官方 API 名称 `deepseek-flash`），关闭思考模式，普通回复最多 512 token，一次生成话题库最多 6,000 token。Roro 统一用可爱、简短的中文聊天，称呼用户为“主人”，自然使用“啦、呢、哦”等语气词，仅偶尔使用“喵”，不强制追加，也不叠加句末语气词。表情仅能从已有动作白名单中选择。

- 首次生成话题只发送当前页面已显示的公开内容，最多 4,000 字符，不包含 URL 查询参数、表单、评论或加密文章。加密文章即使已解锁，也不会自动发送。
- 动漫语料位于 `../../src/data/anime-quotes.json`，包含抓取、筛选并去重的 1,490 条短语录，保留作品出处。按催泪、百合、恋爱、日常、治愈、神作题材加权，相关偏好位于 `anime-quote-preferences.json`。语料按需加载一次，不为每次换句请求模型或外部语录服务。
- 浏览器每轮缓存 39 条不同语录，抽完后重新选取 39 条，并排除上一轮的全部内容。`sessionStorage` 只保存语料版本、39 个 ID、未播放 ID 和最后一个 ID；刷新可继续本轮，损坏或过期版本的状态会重建。切页共用这一轮缓存。
- 在聊天框中输入文字、中文输入法组合、等待手动聊天回复、标签页隐藏或角色休眠时暂停轮换；恢复后重新计时。每条话题、语录或手动回复显示后保留 10 秒，再继续切换。自动切换只替换气泡，不持续追加聊天记录；打开聊天或发送消息时才保存当前内容，便于围绕它聊天。
- 每篇文章保存 39 条不同的闲聊开场白，每条最多 60 字符，包含称呼和标点。生成结果不足 39 条、重复或过长时，不保存不完整的话题库。
- 相同标题、路径和公开摘录的话题库在 Worker 的 Durable Object 中保存 30 分钟；人设或话题限制更新后自动使用新缓存。服务器只保存开场白及抽取进度，不保存正文或聊天记录。首次响应在保存完成后返回，并发首次访问共用同一份话题库。
- 文章页每次自动切换都会请求 Worker；命中缓存时直接返回下一条，只有缓存缺失或过期才生成新话题库。一个请求完成后再开始下一轮 10 秒计时，避免慢请求重叠。文章页不轮播动漫语录。
- 话题随机抽取，抽完一轮再开始下一轮，跨轮不连续重复。同一标签页在 `sessionStorage` 中只保存最近 10 个页面各自最后一句开场白，刷新后仍能避开它；其他访客的访问不会让该访客立即看到相同内容。
- 同一标签页在内存中暂存最多 10 个页面的对话与草稿；切页时清理超过 30 分钟未使用的记录，刷新页面即清空。再次进入文章会重新挑选开场白，旧页面的延迟响应不会覆盖新页面。
- 后续聊天只发送当前开场白或动漫语录及最近 3 轮对话，历史总长最多 4,000 字符；不重复发送正文。文章开场白的去重提示与当前动漫语录分别保存，语录不会覆盖文章缓存状态。
- 不限制每分钟请求次数；每个 IP 每天最多调用模型 200 次，全站每天最多 2000 次。话题缓存命中不计模型调用。被全站限额拦截的请求不扣个人每日额度；已发起的模型请求即使失败，也计入调用次数。
- 每个 IP 最多同时发起 2 次模型请求，全站不设并发上限。每日额度在 UTC 00:00（北京时间 08:00）重置。

接口保留 `intent: "summary"` 和聊天背景的 `context.summary` 字段名以兼容已有调用方，内容已改为闲聊开场白。话题请求可带 `previousTopic`（最多 60 字符）排除上次内容；它只用于选取语料，不进入模型提示词。

动漫语料来自 [Hitokoto sentences-bundle](https://github.com/hitokoto-osc/sentences-bundle) 的固定版本，使用 AGPL-3.0；完整许可证、抓取版本、筛选规则及数量统计保存在 `../../src/data/`。在仓库根目录运行 `pnpm quotes:sync` 可重新抓取并生成该版本语料，详见 [`../../src/data/README.md`](../../src/data/README.md)。

生产接口是 `https://arisaka-live2d-chat.454565615.workers.dev/chat`，仅允许 `https://arisaka.eth.limo` 来源。`GET /health` 只检查所需密钥是否已配置，不能代替真实聊天验证。静态站使用独立的 Arweave 发布流程。

DeepSeek 账户需要有可用余额。模型 ID 与版本对应关系见 https://api-docs.deepseek.com/quick_start/pricing/ 。使用 JSON 输出模式，服务端继续校验文本和表情；上游错误不会向前端泄露详情。

在仓库根目录准备并启动本地后端：

```powershell
pnpm --dir workers/live2d-chat install --frozen-lockfile
pnpm --dir workers/live2d-chat check
pnpm --dir workers/live2d-chat test
pnpm --dir workers/live2d-chat build
powershell -NoProfile -ExecutionPolicy Bypass -File workers/live2d-chat/scripts/start-local.ps1
```

首次启动会以隐藏输入请求 DeepSeek 密钥，使用 Windows 当前用户的 DPAPI 加密保存在 `%LOCALAPPDATA%\ArisakaLive2D\local-secrets.clixml`，并自动生成 IP 哈希密钥。以后启动复用该文件，只在内存解密并经标准输入传入本地运行时。这里不保存 Cloudflare 账户凭据。

本地 Worker 地址为 `http://127.0.0.1:8787/chat`，允许 Astro 开发站 `http://127.0.0.1:4321` 和 `http://localhost:4321`。它仅在本地适配 Cloudflare 的 IP 请求头；生产包不包含该适配。修改后端后重新执行 `pnpm --dir workers/live2d-chat build`，本地运行时会重新加载构建结果。

生产部署需要在 Worker 中配置 `DEEPSEEK_API_KEY` 和 `IP_HASH_SECRET` 两个 secret，并使用 `wrangler.jsonc` 中的 Durable Object 绑定和迁移。不要把密钥写入 `PUBLIC_*`、前端源码、构建产物或提交记录。
