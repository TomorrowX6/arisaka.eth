# CTF Worker

26 关顺序解锁的 CTF，运行于 Cloudflare Workers Static Assets + SQLite Durable Objects，不依赖原 VPS 或 I2P 服务。入口保留在博客原终端的加密文件中，使用随机 20 位路径，不进入 sitemap。游戏只展示必要的题目文件、协议与操作界面，没有提示接口或解题说明。

## 工作区

- Plasma 6 / Breeze 风格桌面：窗口拖动、缩放、平铺、虚拟桌面、任务栏、用户切换、锁屏、主题、壁纸和快捷键。
- 28 个可启动的桌面应用，包括 Dolphin、Konsole、Kate、Okular、Ark、Okteta、SQLite、Kleopatra、KDiff3、KolourPaint 和数据包查看器。
- JavaScript / Web Crypto / WebAssembly 与 Python 执行环境；Python 提供 NumPy、SymPy、mpmath、PyCryptodome。运行时和依赖均由同一 Worker 提供。
- 文件通过 IndexedDB 按存档隔离保存，支持目录、导入、回收站、还原和多标签页写入冲突检测。脚本通过有界文件 RPC 读写工作区，不能直接联网；游戏内协议使用限定范围的 `net` API。
- 服务端校验通行码、解锁附件、保存进度，并签发可独立验证的通关凭证。交互式实验的绑定在 Durable Object 休眠后保持不变。

这是浏览器实现的工作区，不是 KDE 官方发行版或完整 Linux 系统。桌面用户密码只用于本地锁屏；服务端匿名存档依靠 HttpOnly Cookie 标识。清除 Cookie 后不能自动恢复原存档，重开前应导出需要保留的文件和笔记。

同一入口身份最多保存 8 个用户（含默认用户），配额由服务端持久化校验，重开不会重置配额。重开会删除被替换的服务端存档；若响应丢失，上一份 Cookie 只能恢复同一用户的这次重开，不能读取旧存档或创建其他用户。在系统设置中删除用户后才释放其配额。入口身份和其全部存档在首次创建后 180 天到期，由 Durable Object alarm 清除存储；用户切换和重开不延长该期限。此版本的 Cookie 绑定稳定入口身份，更新前的本地开发 Cookie 需通过终端入口重新建立。

## 本地运行

需要 Node.js 22.13+ 和 pnpm 9.14.4。在仓库根目录安装两套依赖：

```sh
pnpm install --frozen-lockfile
pnpm --dir workers/ctf-game install --frozen-lockfile
pnpm ctf:dev
```

在另一个终端运行 `pnpm dev`。博客终端解密后的入口会转入 `http://localhost:8788/`。新会话必须通过入口校验，已有存档可以直接继续。不要混用 `localhost` 和 `127.0.0.1` 的 Cookie / 本地存储。

以下命令均在 `workers/ctf-game` 中运行。

## 验证

```sh
pnpm check
pnpm test
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

`pnpm test` 覆盖随机题目版本的独立解码、重建一致性、部署健康检查、26 关附件鉴权、并发提交、账本隔离、实验状态恢复、用户隔离、并发存档配额、重开回收、到期清理和通关凭证。

`pnpm test:e2e` 自动生成题目、启动随机端口的本地 Worker、检查版本、运行浏览器测试并关闭 Worker；存储与日常开发存档隔离，不更新博客入口，不需要 Cloudflare 部署凭证。它包含：

- `pnpm test:browser`：全部应用启动、文件持久化、用户设置、脚本运行、PDF、SQLite、OpenPGP、窄屏布局等真实界面回归。
- `pnpm test:campaign`：只读取私有夹具中的入口，所有 26 个答案均从实际鉴权接口提供的题目文件与协议独立恢复，再经桌面界面提交；验证最终凭证、刷新和浏览器历史导航。

`pnpm test:all` 顺序执行上述单元测试和端到端测试。也可用 `CTF_E2E_URL=http://127.0.0.1:8788 pnpm test:e2e` 测试已有本地服务；其版本必须与本地生成的夹具一致。低内存机器不要同时运行 Astro 检查和浏览器测试。

PR Checks 中的独立 CTF 作业会执行类型检查、单元测试、生产构建以及完整浏览器回归，不使用生产种子或会话密钥。

## 部署与博客入口

```sh
pnpm exec wrangler login
pnpm deploy
```

部署账户在 `wrangler.jsonc` 中配置。脚本先构建和上传 Worker，确认健康接口的版本与实际关卡数均一致后，才更新以下**配对文件**：

- `../../src/data/ctf-deployment.json`
- `../../public/README/README.md`

随后在仓库根目录重新构建博客。上传或健康检查失败不会更新博客入口。`PUBLIC_CTF_URL` 可覆盖 Worker 地址，但不能替代匹配的入口配置和终端密文；生产地址必须为 HTTPS origin。

`Deploy CTF` 工作流仅手动触发。配置下列 GitHub Secrets，运行成功后下载 `ctf-deployment` artifact，将其中两个文件一起用于博客构建。该工作流不会自动发布博客或提交入口文件。

| 变量 | 用途 |
| --- | --- |
| `CTF_BUILD_SEED` | 64 位十六进制构建种子，固定题目、通行码与终端入口 |
| `CTF_SESSION_SECRET` | 至少 32 字符的 Cookie / 通关凭证签名密钥 |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署凭证 |

CI 发布必须配置三个变量。本地首次构建创建 `.private/build-seed`，首次发布创建 `.private/session-secret`；本地开发另用 `.dev.vars.local`。不要删除、公开或随意轮换生产种子和密钥。要沿用本地版本发布 CI，应将同一组值安全配置为 GitHub Secrets。

更换种子或不兼容的题目格式会使旧版存档显示失效，不会静默覆盖旧进度。改变题目生成或校验语义时应同步提升 `build-challenges.mjs` 中的版本域，并重新执行所有测试。回滚时同时恢复 Worker 版本、上述配对入口文件及对应私有种子 / 签名密钥。

## 发布边界

- `public/_puzzles/` 不能直接访问；附件只能通过会话鉴权的 `/api/files/` 读取。脚本运行环境不能绕过解锁限制。
- 题目中的协议缺陷是有意设计，仅作用于合成资料和单个玩家的游戏状态；没有真实资产或外部系统接口。
- `.private/`、`.dev.vars*`、`src/generated/`、生成题目、运行时 bundle、测试日志和原始 rollout 不进入 Git。`scripts/*decoder*` 只供维护测试，不属于静态发布目录。
- 构建会从锁定依赖生成前端 bundle 并附许可证；Python wheels 下载后校验发行版 SHA-256，随后由 Worker 自托管。依赖与美术资源声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
