# CTF Worker

34 关顺序解锁的 CTF，运行于 Cloudflare Workers Static Assets + SQLite Durable Objects，不依赖原 VPS 或 I2P 服务。入口保留在博客原终端的加密文件中，使用随机 20 位路径，不进入 sitemap。游戏只展示必要的题目文件、协议与操作界面，没有提示接口或解题说明。

## 工作区

- 以 KDE Plasma 6.3.5 / Breeze Dark 为基准的桌面：官方 Nuvole 深色壁纸、本地 Noto Sans / Hack 字体、随字体调整的窗口装饰、Kickoff、四向面板、任务预览、虚拟桌面、锁屏和快捷键。
- 窗口开关、朝任务图标最小化、最大化/平铺、菜单和弹出面板共享可取消的动画；桌面切换使用 KWin 的弹簧积分，反向时保留速度。系统与桌面“减少动态效果”设置即时生效。
- 38 个可启动的桌面应用，包括 Dolphin、Konsole、Kate、Okular、Ark、Okteta、SQLite、Kleopatra、KDiff3、KolourPaint、数据包查看器、数据工坊、逻辑分析仪、结构检查器、离散数学工坊、eBPF 调试器、信号分析台、图分析台、Minecraft 1.12.2、Firefox 和 YesPlayMusic。
- 数据工坊提供可保存 / 载入 / 重排的字节处理配方，支持 Hex、Base64、位操作、XOR、字节序、截取、压缩和哈希。独立 Worker 可停止；预览明确标注截断，保存始终使用完整结果。
- 逻辑分析仪读取 VCD，保留精确的 64 位时间戳、别名和未知态，支持信号选择、波形缩放 / 平移 / 游标，以及 SPI 四种模式与双位序解码。未知位、时序歧义和不完整传输明确标注，可将完整解码保存到工作区。
- 结构检查器读取 DER / CBOR 与 CBOR 序列，保留精确偏移、头和负载范围，支持嵌套树、键盘、筛选与分页。CBOR 保留重复 map key；长值明确标注预览。可导出完整节点报告和选中原始字节；不把格式解析当作证书信任或签名验证。
- 离散数学工坊提供精确模矩阵消元（行变换、特解、零空间）、广义 CRT、精确有理数 LLL 和 GF(2) 多项式算术。任务可保存 / 重新载入，运算有界且可取消；不内置关卡专用求解器。
- eBPF 调试器读取原始指令及 ELF64 LE ET_REL，绑定 LLVM REL 本地函数和普通数据，提供 F8 / F9 / F10、断点、符号筛选、分支导航、精确寄存器与内存预览、完整反汇编和报告导出。未初始化栈字节显示 `??`，不能伪装成零保存。每次执行最多 50000 条、8 帧；关闭 / 停止终止独立 Worker。它是离线解释器，不是 Linux verifier / JIT，不执行 map FD、helpers、CO-RE、原子操作或外部调用。
- Minecraft 使用 Eaglercraft 1.12.2 u3 的真实客户端，默认选择 WebAssembly GC，也可切换 JavaScript 兼容模式；世界在独立应用域名的 IndexedDB 中按桌面用户保存。关闭前通过游戏菜单保存并退出，两种模式共用存档。
- Firefox 使用 HeyPuter 发布的真实 Gecko WASM 与官方 WISP 网络服务，保留应用自己的 Launch Firefox 启动按钮；需支持 JSPI 和 credentialless iframe 的新版 Chrome / Edge。内嵌会话随桌面页面关闭而结束，可通过工具栏独立打开官方应用。
- YesPlayMusic 使用固定源码版本 0.4.10 的原版界面，默认中文深色，提供搜索、播放、歌词与网易云登录。网页和音乐 API 由独立应用 Worker 提供，设置、缓存与登录状态按桌面用户隔离；最小化继续播放，关闭释放播放器。
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

调试 Minecraft 或 YesPlayMusic 时，另开终端运行 `pnpm runtimes:dev`，使用 `http://127.0.0.1:8788/` 打开桌面。该命令下载并核对固定 SHA-256 的上游文件，按独立锁文件构建 YesPlayMusic，将应用服务启动在 `http://127.0.0.1:8789/`。Firefox 使用官方线上应用。

## 验证

```sh
pnpm check
pnpm test
pnpm build
pnpm runtimes:build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
pnpm test:runtimes
```

`pnpm test` 覆盖随机题目版本的独立解码、重建一致性、部署健康检查、全部关卡附件鉴权、并发提交、账本隔离、实验状态恢复、用户隔离、并发存档配额、重开回收、到期清理和通关凭证。新增 QUIC 密钥 RFC 向量、DNSSEC 认证链、SPI 多次采样取证、配方解压上限、VCD / SPI 精度与未知态测试；FROST RFC 9591 官方向量、跨刷新时期隔离、RS16 拜占庭错误恢复、DER / CBOR 格式边界以及整数格保持和精确消元验证。

`pnpm test:e2e` 自动生成题目、启动随机端口的本地 Worker、检查版本、运行浏览器测试并关闭 Worker；存储与日常开发存档隔离，不更新博客入口，不需要 Cloudflare 部署凭证。它包含：

- `pnpm test:browser`：全部应用启动、文件持久化、用户设置、脚本运行、PDF、SQLite、OpenPGP、窄屏布局，以及快速窗口开关、KWin 弹簧轨迹和反向、减少动态效果、任务预览与启动器键盘操作等真实界面回归。
- `pnpm test:campaign`：只读取私有夹具中的入口，所有 32 个答案均从实际鉴权接口提供的题目文件与协议独立恢复，再经桌面界面提交；验证最终凭证、刷新和浏览器历史导航。
- eBPF 浏览器回归：`node scripts/test-browser.mjs test/bpf-app.browser.test.mjs`，覆盖真实 Worker 单步与断点、ELF 重定位、文件关联、未知栈字节、输入失效、完整分页导出、取消、关闭重开及窄屏。截图位于忽略目录 `.private/bpf-qa/`。
- 顶级工具浏览器回归：`node scripts/test-browser.mjs test/elite-apps.browser.test.mjs`，验证真实 Worker、超出 Number 精度的 LLL 变换、任务往返、结构树键盘、精确字节导出、完整 CBOR、失败恢复和窄屏。截图位于忽略目录 `.private/elite-qa/`。
- 新工具浏览器回归：`node scripts/test-browser.mjs test/analysis-apps.browser.test.mjs`，验证真实分析 Worker、二进制保存、配方往返、完整 VCD / SPI、取消与窄屏键盘操作；截图位于忽略目录 `.private/professional-qa/`。

`pnpm test:runtimes` 单独运行真实引擎验证：检查 IndexedDB 与两类 Worker 的用户隔离，通过 Minecraft 的实际菜单创建、保存、用另一种引擎重开世界，启动 Gecko 并使用真实地址栏访问网页，同时验证缩放与最小化恢复。测试需要联网和较多内存，截图写入忽略目录 `.private/runtime-qa/`。日常 `test:e2e` 只在应用边界替换大型运行时，仍验证启动、消息校验、焦点、取消重启、关闭与最小化行为。

`node scripts/test-runtimes.mjs test/yesplaymusic.browser.test.mjs` 验证真实音乐搜索、完整音频播放、最小化后播放进度、暂停/继续、关闭重开和二维码接口，需要网易云服务可用。默认测试歌曲为 `29723096`，可用 `YESPLAYMUSIC_TRACK_ID` 指定在测试地区可完整播放且超过两分钟的歌曲；音频解码和实际播放断言保持一致。截图写入 `.private/yesplaymusic-qa/`。CI 使用已编译的原版界面和确定性接口夹具，另外验证浏览器存储隔离、重置、登录 Cookie 传输和大歌单分批请求。

`pnpm test:all` 顺序执行上述单元测试和端到端测试。也可用 `CTF_E2E_URL=http://127.0.0.1:8788 pnpm test:e2e` 测试已有本地服务；其版本必须与本地生成的夹具一致。低内存机器不要同时运行 Astro 检查和浏览器测试。

PR Checks 中的独立 CTF 作业会执行两套 Worker 的类型检查和生产构建、单元测试以及完整桌面与关卡回归，不使用生产种子或会话密钥。真实引擎测试由维护者显式运行。

## 部署与博客入口

```sh
pnpm exec wrangler login
pnpm run deploy
```

部署账户在 `wrangler.jsonc` 和 `runtime/wrangler.jsonc` 中配置。脚本首先读取线上健康接口，只接受相同 edition 或生成器显式声明兼容的历史 edition；种子不匹配、关卡数不一致或无法确认线上状态时，不开始发布。随后发布独立的 `arisaka-desktop-apps` Worker，核对版本、完整资源哈希、响应类型和隔离策略，再次确认桌面版本未变化后才发布 `arisaka-afterglow`。两个配置中的应用域名与桌面域名须互相匹配。单独发布应用资源可使用 `pnpm runtimes:deploy`。

已有 Worker 的 `SESSION_SECRET` 始终沿用线上绑定，不因本地没有密钥文件、存在另一份开发密钥或设置了 `CTF_SESSION_SECRET` 而覆盖。首次创建不存在的 Worker 才使用 `pnpm run deploy --bootstrap`，并配置或在本地生成会话密钥。`--bootstrap` 不允许覆盖任何已返回有效健康状态的不兼容版本。密钥轮换是单独的、会影响 Cookie / 凭证的维护操作，不是普通部署的一部分。

### 独立专家版

当暂时拿不到原生产种子时，不把新种子写入原 Worker。使用显式隔离的部署目标：

```sh
# 首次创建独立站点，确认这些名称尚未被其他项目占用后运行
pnpm run deploy --target expert --bootstrap
# 后续更新仍需沿用该专家站点的种子，且会保留其线上会话密钥
pnpm run deploy --target expert
```

- 桌面：`arisaka-afterglow-expert`；资源：`arisaka-desktop-apps-expert`。
- 两个 Worker 使用匹配的独立域名和严格 iframe 父源策略；Durable Objects 绑定各自桌面，不引用生产命名空间。Cookie、IndexedDB / 本地文件和玩家进度与生产分开。
- 专家版不更新博客的任何配对入口文件，不迁移、删除或重置原站存档。它是独立新存档，不是已有玩家的自动升级副本。
- 健康检查通过后，入口、edition、关卡数和版本 ID 记录在 `.private/releases/expert/release.json`；首次生成的专家版会话密钥单独存放在同目录的 `session-secret`。种子仍取自显式 `CTF_BUILD_SEED` 或本 checkout 的 `.private/build-seed`，需妥善保留。
- 线上战役回归可显式设置 `CTF_CAMPAIGN_TIMEOUT_MS=600000`，为远程往返预留完整战役总预算；默认本地仍为 300000 ms，各次浏览器操作仍为 20000 ms，不自动重试失败操作。入口须取自同种子的私有构建记录。
- `--target production` 等同默认更新；`local` 和任意环境名不接受。单独发布专家版资源可用 `pnpm runtimes:deploy --target expert`。

手动 `Deploy CTF` 工作流可选择目标。专家版使用独立的 `CTF_EXPERT_BUILD_SEED` / `CTF_EXPERT_SESSION_SECRET` Secrets，不回退使用生产种子；更新时同样不上传替换会话密钥。工作流只上传指定目标的 `release.json`，生产目标才额外上传配对博客入口；不会上传其他 `.private` 文件。

桌面健康接口的版本与实际关卡数均确认一致后，才更新以下**配对文件**：

- `../../src/data/ctf-deployment.json`
- `../../public/README/README.md`

随后在仓库根目录重新构建博客。上传或健康检查失败不会更新博客入口。`PUBLIC_CTF_URL` 可覆盖 Worker 地址，但不能替代匹配的入口配置和终端密文；生产地址必须为 HTTPS origin。

`Deploy CTF` 工作流仅手动触发。配置下列 GitHub Secrets，运行成功后下载 `ctf-deployment` artifact，将其中两个文件一起用于博客构建。该工作流不会自动发布博客或提交入口文件。

| 变量 | 用途 |
| --- | --- |
| `CTF_BUILD_SEED` | 64 位十六进制构建种子，固定题目、通行码与终端入口 |
| `CTF_SESSION_SECRET` | 首次创建 Worker 时使用的至少 32 字符 Cookie / 通关凭证签名密钥；已有部署不上传覆盖 |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署凭证 |

CI 更新必须配置生产 `CTF_BUILD_SEED` 和 Cloudflare 凭据；首次创建还需要 `CTF_SESSION_SECRET`。本地首次构建创建 `.private/build-seed`，显式首次发布创建 `.private/session-secret`；本地开发另用 `.dev.vars.local`。不要删除、公开或随意轮换生产种子和密钥。要沿用本地版本发布 CI，应将同一组值安全配置为 GitHub Secrets；不能拿新 checkout 自动生成的开发种子替换生产种子。

更换种子或不兼容的题目格式会使旧版存档显示失效，不会静默覆盖旧进度。改变题目生成或校验语义时应同步提升 `build-challenges.mjs` 中的版本域，并重新执行所有测试。回滚时同时恢复 Worker 版本、上述配对入口文件及对应私有种子 / 签名密钥。

## 追加战役与存档兼容

第 26 关保留原编号、附件和回执重建流程；27–29 是面向专业玩家的协议与硬件取证延伸。30–31 是面向顶级玩家的门限密码学与代数编码延伸：FROST 刷新时期 / 多次 nonce-pair 复用转录，以及未知符号基、交织 RS16 纠错与认证封装。第 32 关组合 eBPF ELF 重定位、64 / 32 位语义、ARX 逆变换和两份上游认证材料，不能只用前两关通行码打开。第 33 关是 FIPS 203 ML-KEM-768 掩码 DMA / 不完整 NTT 取证：认证的 64 位提交快照、Montgomery / 字节接线、每个多项式四个擦除、公开矩阵关系，以及包含重加密比较与隐式拒绝的真正解封装。第 34 关从无突发标记的 SigMF 复数基带恢复自定义 OFDM64 遥测：整数 / 小数频偏、I/Q 共轭、深衰落、导频相位跟踪、64-QAM 软判决、打孔卷积码、扰码与认证提交。它明确不是 IEEE 802.11 帧。原 26 / 29 / 31 / 32 / 33 关均有固定测试种子的逐字节摘要回归，不因追加而重写。

信号分析台提供通用 CSV / TRS 查看、精确样本选区、极值保真的波形、双游标、统计 / 直方图、校准单边 FFT 和逐重叠区归一化互相关。输出保留完整数值、参数、trace 元数据及源 SHA-256，不是屏幕预览截取。没有设备泄漏模型或自动猜测密钥。无采样率时明确使用样本单位；非均匀时间轴不偷偷重采样。历史第 25 关 TRS 的可选 0x4b 标签不符合标准长度，应用明确警告并保留原始样本，不以更改历史附件或误认 0x4d 标签的方式掩盖问题；其采样率仍由原 `capture.json` 给出。

图分析台支持有向 / 无向多重图 JSON 和 RFC4180 CSV 边列表，保留自环、平行边、孤立节点、标签和精确整数权重。通用 SCC / 凝聚图 / 拓扑环见证、BFS、DAG / Dijkstra / Bellman–Ford 最短路、Lengauer–Tarjan 支配树及可选支配边界。负环仅污染可达后继，绝不报告伪造的有限距离。完整图 JSON / DOT / 报告包含源 SHA-256；画布最多 400 节点 / 1500 边、表格每页 100 项，均明确区分有界预览和全图计算。文件最多 4 MiB、4096 节点、16384 边；20 秒可取消 Worker，昂贵步骤另有 800 万次运算预算。

桌面静态白名单集中在 `src/public-assets.json`。每次构建会检查入口资源、第一方 ES module 导入（含字面量动态导入）和 Worker 依赖均显式发布，避免漏加新应用文件造成白屏；不会因此放开私有目录、附件或维护端解码器。

生成器显式列出同一种子、同一兼容域的历史 edition。首次访问时在 Durable Object 同步事务内升级已声明兼容的存档，保留玩家身份、开始时间、已解锁位置、尝试次数、冷却、账本和实验绑定，只补建新关卡记录。未通关者继续原位置；已完成 26 关者从 27 开始，已完成 29 关者从 30 开始，均不能越级读取后续附件。

旧通关记录单独保留；Dolphin 状态栏的“通关记录”可重新查看和下载历史凭证，也可通过 `GET /api/proof?cases=26`、`?cases=29` 或 `?cases=31` 获取。多次扩展保留各版已有记录。历史凭证仍可独立验证，不会伪装成扩展战役已完成。未知版本、不同种子或不兼容格式仍要求重开。

存档升级是向前的：已经写入新 edition 的存档，不能直接交给不含迁移逻辑的旧 26 关 Worker 继续。回滚前应保留兼容读取代码或相应存储备份；单纯回滚静态资源或更换种子不会回退进度。

`generate`、`check`、`test`、`build` 默认不修改博客入口。只有本地 `dev` 的显式 `--sync-entrance`，或完成发布健康校验后的部署脚本，才更新配对入口文件。追加后需沿用生产私有种子及会话密钥，不可用新生成的本地种子直接覆盖生产。

## 发布边界

- `public/_puzzles/` 不能直接访问；附件只能通过会话鉴权的 `/api/files/` 读取。脚本运行环境不能绕过解锁限制。
- 题目中的协议缺陷是有意设计，仅作用于合成资料和单个玩家的游戏状态；没有真实资产或外部系统接口。
- `.private/`、`.dev.vars*`、`src/generated/`、生成题目、运行时 bundle、测试日志和原始 rollout 不进入 Git。`scripts/*decoder*` 只供维护测试，不属于静态发布目录。
- 构建会从锁定依赖生成前端 bundle 并附许可证；Python wheels 下载后校验发行版 SHA-256，随后由 Worker 自托管。依赖与美术资源声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
