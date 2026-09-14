# Roro 聊天后端

静态站直接将聊天请求发到 Cloudflare Worker，由 Worker 检查来源、输入和调用额度，再调用 DeepSeek。DeepSeek 密钥和 IP 哈希密钥只保存在后端，前端配置仅包含公开接口地址。

前端设置位于 `../../src/config/live2d-chat.ts`，默认在切换页面后自动总结。`../../src/components/widget/Live2DChat.astro` 控制气泡和聊天面板，`../../src/scripts/live2d-chat.ts` 管理发送及缓存。气泡只显示回复文字，宽高随内容调整；发送和自动总结均无需人机验证。

服务端人设和额度位于 `src/policy.ts`，使用 DeepSeek V4.1 Flash（官方 API 名称 `deepseek-flash`），关闭思考模式，输出最多 512 token。Roro 统一用可爱、简短的中文聊天，称呼用户为“主人”，自然使用“啦、呢、哦”等语气词，仅偶尔使用“喵”，不强制追加，也不叠加句末语气词；文章摘要也使用同样语气。表情仅能从已有动作白名单中选择。

- 首次总结只发送当前页面已显示的公开内容，最多 4,000 字符，不包含 URL 查询参数、表单、评论或加密文章。加密文章即使已解锁，也不会自动发送。
- 同一标签页最多暂存 10 个页面的摘要、对话与草稿；切页时清理超过 30 分钟未使用的记录，刷新页面即清空。
- 相同标题、路径和公开摘录的摘要在 Worker 中缓存 30 分钟；人设提示词更新后自动使用新缓存。服务器只缓存短摘要，不保存正文或聊天记录。
- 后续聊天只发送短摘要及最近 3 轮对话，历史总长最多 4,000 字符；不重复发送正文。
- 每个 IP 每分钟最多尝试 10 次（含无效聊天提交，采用滚动 60 秒窗口）；每天最多调用模型 200 次，全站每天最多 2000 次。摘要缓存命中仍计尝试次数，不计模型调用。被全站限额拦截的请求不扣个人每日额度；已发起的模型请求即使失败，也计入调用次数。
- 每个 IP 最多同时请求 1 次，全站最多同时请求 3 次。每日额度在 UTC 00:00（北京时间 08:00）重置。

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
