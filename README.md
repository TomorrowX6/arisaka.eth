<div align="center">
<img src="public/favicon/arisaka-icon.svg" width='300' alt='logo'>  

# Arisaka.ETH

**一个永久发布、链上可追溯、支持文章加密的个人博客。**

基于 [Fuwari](https://github.com/saicaca/fuwari) 的视觉与内容系统，面向 Arweave、ENS 与个人数字身份进行了深度改造。

[![PR Checks](https://github.com/TomorrowX6/arisaka.eth/actions/workflows/ci.yml/badge.svg)](https://github.com/TomorrowX6/arisaka.eth/actions/workflows/ci.yml)
[![Deploy Permaweb](https://github.com/TomorrowX6/arisaka.eth/actions/workflows/permaweb.yml/badge.svg)](https://github.com/TomorrowX6/arisaka.eth/actions/workflows/permaweb.yml)
[![Astro 5](https://img.shields.io/badge/Astro-5-BC52EE?logo=astro&logoColor=white)](https://astro.build/)
[![Arweave](https://img.shields.io/badge/storage-Arweave-222?logo=arweave&logoColor=white)](https://www.arweave.org/)
[![ENS](https://img.shields.io/badge/routing-ENS-5298FF?logo=ethereum&logoColor=white)](https://ens.domains/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

> [!IMPORTANT]
> 本仓库已经不是 Fuwari 的通用模板镜像，而是 **Arisaka.ETH 的站点工程**。它保留了 Fuwari 的 UI 基础，同时加入了永久存储、ENS 发布、发布溯源、文章加密、浏览器 MIDI 合成器、Live2D 终端、天文历法驱动的节日日历等站点级功能。若需要可直接套用的原版主题，请使用上游项目。

## 与原版 Fuwari 的核心差异

| 方向 | 原版 Fuwari | Arisaka.ETH |
| --- | --- | --- |
| 发布方式 | 构建静态文件，部署平台由用户选择 | 内置 Turbo 增量上传、Arweave Path Manifest 与 ENS `contenthash` 更新 |
| 发布溯源 | 无站点级溯源面板 | 文章页实时解析并展示 `ENS → Manifest TX → Article TX → SHA-256 → App-Version` 元数据 |
| 私密内容 | 文章正文默认公开 | scrypt 派生 KEK、随机 DEK、AES-256-GCM 加密正文 |
| 音频 | 无 | 浏览器内 MIDI 合成器、SoundFont、播放列表与顺序/随机/单曲循环 |
| 桌面交互 | 常规博客 UI | Live2D 桌面角色 + 可操作的虚拟终端与站点文件系统 |
| 日历 | 无 | 公历月历；用天文公式推算农历节日及清明、冬至日期 |
| 身份展示 | GitHub 仓库卡片 | 额外支持 ENS、PGP、Tuta 身份与 ERC-721 挑战币卡片 |
| 社区功能 | 无内置评论与友链页 | Waline 评论、独立友链页、申请规则与状态分组 |
| 自动化 | 上游通用构建/格式检查 | 聚焦 PR 的 CI、Permaweb 发布工作流、永久增量上传缓存 |

## 核心能力

### 1. Arweave 永久发布与 ENS 寻址

`pnpm deploy:perma` 将构建、上传和域名更新串成一条发布链：

```text
Markdown / Astro
       ↓ build
     dist/
       ↓ SHA-256 内容缓存，仅上传变化文件
 ArDrive Turbo / Arweave
       ↓ 生成或复用 Path Manifest
   ar://<manifest-tx>
       ↓ 写入 ENS Resolver contenthash
 https://<name>.eth.limo
```

与普通“把 `dist/` 上传到某个平台”相比，这套流程额外处理了：

- 按 SHA-256 与 MIME 类型复用已成功记录的上传，同一批次的相同内容也只上传一次；
- 并发上传时串行、原子写入缓存，中断后只重试尚未成功的内容；
- 为 Astro 的尾斜杠路由补齐 Manifest 别名；
- 正确标记 HTML、CSS、JavaScript、WASM、Pagefind、Live2D 等 MIME 类型；
- 将 `GITHUB_SHA`（本地缺省为时间戳）写入 Manifest 的 `App-Version` 标签；
- 更新 ENS 前校验主网、Resolver 能力与写入权限；
- 支持 `--dry-run`、`--skip-ens` 与 `--force`；
- 通过 `.permaweb-cache.json` 在本地和 GitHub Actions 之间共享永久上传缓存。

文章页底部的 **Provenance** 卡片会在读者浏览时，从配置的公共 RPC 与 Arweave 网关解析并展示当前发布链路：

```text
ENS contenthash
  → Arweave Manifest TX
  → 当前文章 File TX
  → Content Digest (SHA-256)
  → Manifest 中记录的 App-Version 标签
```

> [!NOTE]
> Provenance 提供的是便于人工检查的实时溯源元数据，不是独立的密码学证明。它信任首个成功响应的已配置 RPC/网关，不验证 Arweave 数据项签名、交易包含证明或上传者身份，也不会把显示的摘要与另一个受信摘要自动比对。

### 2. KEK / DEK 文章加密

加密文章在构建阶段先渲染为 HTML，再生成版本化加密信封：

```text
读者密码
  └─ scrypt (N=2^17, r=8, p=1, 随机 16-byte salt)
       └─ 256-bit KEK
            └─ AES-256-GCM 解包随机 256-bit DEK
                 └─ AES-256-GCM 解密文章 HTML
```

主要安全设计：

- 每次构建生成随机 DEK、Salt 与两组独立 IV；
- KEK 只包装 DEK，不直接加密正文；
- 版本、算法、KDF 参数、Salt、用途与文章 Slug 均进入 AAD；
- 浏览器运行 scrypt 前严格校验信封、长度与参数；
- 密码不会进入 URL、生成的 HTML、日志或浏览器持久化存储；
- Swup 导航与 `pagehide` 会清除解密 DOM，并使仍在运行的解密结果失效；
- 加密正文不会进入首页摘要、RSS 正文、Pagefind 或初始目录。

完整威胁模型、公开信息范围和配置方法见 [docs/ARTICLE_ENCRYPTION.md](docs/ARTICLE_ENCRYPTION.md)。

### 3. 浏览器 MIDI 合成器

侧栏播放器使用 [SpessaSynth](https://github.com/spessasus/SpessaSynth) 在浏览器中合成 MIDI：

- 支持 `.mid`、`.midi` 与 `.rmi`；
- 支持顺序、随机不重复、单曲循环；
- 提供进度拖动、上一首/下一首和完整播放列表；
- 仅在用户首次播放时懒加载合成器、AudioWorklet 与 SoundFont；
- `dev` / `build` 前自动扫描 `public/midi/` 并生成 `playlist.json`；
- 扫描时尝试将文件名中的空格改为下划线；若目标名冲突会保留原名，Permaweb 发布前需手动消除路径中的空格。

添加音乐只需把文件放进 `public/midi/`：

```sh
pnpm midi:scan
```

### 4. Live2D 与虚拟终端

桌面端会加载本地 Live2D 模型。角色菜单可打开一个不会离开页面的终端窗口，终端实现了真实的命令解析、历史记录、Tab 补全与虚拟文件系统。

角色也可与访客聊天：公开文章每 10 秒向 Cloudflare Worker 请求下一条 AI 话题，Worker 为每篇文章缓存 39 条简短开场白；非文章页面从 1,490 条有作品出处的动漫语录中按偏好抽取，每轮缓存 39 条、同样每 10 秒更换一句。优先催泪、百合、恋爱、日常、治愈及神作题材，输入或等待回复时暂停。发送按钮为输入框内的绿色圆形上箭头。配置、运行与缓存说明见 [Roro 聊天后端](workers/live2d-chat/README.md)，语料来源和更新方式见 [动漫语料说明](src/data/README.md)。

```text
~/README/       ← public/README 中的真实文件
~/posts/        ← 当前内容集合生成的文章条目
~/about.md      ← About 页面入口
```

可用命令包括 `ls`、`cd`、`pwd`、`cat`、`open`、`whoami`、`uname`、`date`、`neofetch`、`history`、`clear` 与 `exit`。`open` 会通过 Swup 打开文章，或安全下载同源静态文件。

### 5. 天文历法驱动的节日日历

侧栏显示的是公历月历与当月节日列表；农历和太阳黄经计算用于确定节日落在哪个公历日期，而不是在界面中展示完整农历日期：

- 依据 Meeus 天文公式计算新月和太阳黄经；
- 使用 UTC+8 中国本地日序构造农历月份和闰月；
- 推算春节、端午、中秋等农历节日，以及清明、冬至日期；
- 同时支持公历固定日期和“某月第 N 个星期几”规则；
- 根据站点语言显示中文或英文节日名称。

### 6. 数字身份、评论与友链

除上游已有的 GitHub 仓库卡片外，Markdown 新增四类站点组件：

```md
::ens{name="arisaka.eth"}

::pgp{fingerprint="3E78 ... 21FF" algo="Ed25519" key="/pubkey.asc"}

::tuta{email="name@tuta.com" fingerprint="..." algo="Ed25519" version="v0"}

::coin{collection="arisaka-eth" contract="0x1111111111111111111111111111111111111111" name="Arisaka.ETH Coin" edition="3"}
```

同时还包括：

- 与主题样式和 Swup 生命周期集成的 Waline 评论；
- 独立友链页、状态分组、申请规则、链接复制与失败头像降级；
- Arisaka.ETH ERC-721 挑战币的 2D 翻转卡片与完整设计/GLB 素材。

## 保留自 Fuwari 的能力

本项目仍使用并持续受益于上游的核心设计：

- Astro + Svelte + Tailwind CSS；
- 响应式布局、明暗模式与主题色；
- Swup 页面切换与平滑动画；
- Pagefind 静态搜索；
- RSS、归档、标签、分类与文章目录；
- Expressive Code、数学公式、Admonition 与 GitHub 卡片；
- 图片预览、SEO 元数据和多语言 UI。

## 本地运行

### 环境要求

- Node.js 22（两个 GitHub Actions 工作流的验证版本）；
- pnpm 9.14.4（由 `packageManager` 固定）。

### 启动

```sh
git clone https://github.com/TomorrowX6/arisaka.eth.git
cd arisaka.eth
pnpm install
pnpm dev
```

开发服务器默认运行在 `http://localhost:4321`。

> [!NOTE]
> 仓库包含 Arisaka.ETH 专用的文章、身份、Live2D、MIDI、ENS 和部署配置。复用为自己的站点时，请先替换下方列出的站点配置与资产，不要直接沿用 `arisaka.eth` 或现有密钥标识。

## 配置入口

| 路径 | 用途 |
| --- | --- |
| `src/config.ts` | 站点、个人资料、导航、MIDI、评论、Provenance、许可证 |
| `src/friends.ts` | 友链数据与状态 |
| `src/content/posts/` | Markdown / MDX 文章 |
| `src/content/spec/` | About 等特殊页面内容 |
| `public/midi/` | MIDI、SoundFont 与生成的播放列表 |
| `public/live2d/` | Live2D 模型、贴图与动作 |
| `public/README/` | 虚拟终端中的 `~/README` 文件 |
| `public/coin/`、`design/coin/` | 挑战币网页素材与设计源文件 |
| `astro.config.mjs` | Astro 集成、Markdown/rehype 插件与站点 URL |
| `.github/workflows/permaweb.yml` | Arweave + ENS 自动发布 |

## 写文章

```sh
pnpm new-post my-post
```

普通文章：

```yaml
---
title: My Post
published: 2026-08-05
description: Public summary
tags: [Astro, Web3]
category: Notes
draft: false
lang: zh_CN
---
```

加密文章推荐从私有环境变量读取密码：

```yaml
---
title: Private Notes
published: 2026-08-05
encrypted: true
passwordEnv: PRIVATE_NOTES_PASSWORD
passwordHint: "公开可见的可选提示"
---
```

本地可将密码写入已被 Git 忽略的 `.env`，或只供生产构建使用的 `.env.production`：

```dotenv
PRIVATE_NOTES_PASSWORD=一段高熵口令
```

随后正常运行 `pnpm dev` 或 `pnpm build`。页面通过 `astro:env/server` 的 `getSecret()` 在服务端按名称读取密码；CI 仍应通过 Actions Secrets 映射同名环境变量。

也支持 `password` 内联字段，但它只适合源代码仓库本身为私有的场景。

## 构建与部署

### 普通静态构建

```sh
pnpm build
pnpm preview
```

生成目录为 `dist/`，可直接部署到以域名根路径提供内容的静态托管平台。若部署到子路径，需要同步调整 Astro `base` 和代码中的根相对资源路径。

### Arweave + ENS

推荐把本地密钥放在被 Git 忽略的 `.env.permaweb`：

```dotenv
ARWEAVE_WALLET_FILE=wallet.json
DEPLOY_EVM_PRIVATE_KEY=0xYOUR_ENS_UPDATER_PRIVATE_KEY
ETH_RPC_URL=https://your-ethereum-mainnet-rpc.example
ENS_NAME=your-name.eth
APP_NAME=your-blog
```

上传签名优先使用 `ARWEAVE_WALLET_FILE`（默认 `wallet.json`）；若文件不存在，则使用 `DEPLOY_EVM_PRIVATE_KEY`（兼容别名 `ETH_PRIVATE_KEY`）通过 Turbo 上传。ENS 更新同样需要这个有 Resolver 权限的 EVM 私钥。使用共享 Turbo Credits 时可额外配置 `TURBO_PAID_BY`。

脚本默认读取 `.env.permaweb`，也可通过 `--env-file <path>` 追加其他环境文件；`BUILD_DIR` 可覆盖默认的 `dist`。

```sh
# 只查看上传计划，不花费 Credits 或 Gas
pnpm deploy:perma -- --dry-run

# 上传到 Arweave，但不修改 ENS
pnpm deploy:perma -- --skip-ens

# 完整构建、增量上传并更新 ENS
pnpm deploy:perma
```

> [!WARNING]
> 永远不要提交 `wallet.json`、`.env*` 或任何私钥。`.permaweb-cache.json` 只保存公开的内容哈希、交易 ID 与 MIME 信息，故意提交到仓库以复用已确认的上传并尽量减少重复付费。

缓存格式损坏时，发布会在上传前停止，不会静默丢弃缓存并重新付费上传全站。`--force` 才会显式忽略旧缓存。文件改名或删除会更新 Manifest 路径；内容和 MIME 未变的文件仍复用原交易，历史缓存保留供以后使用。`--dry-run` 同时报告文件复用数量和 Manifest 计划。

GitHub Actions 串行执行发布，在上传前合并目标分支的最新缓存，避免排队任务使用旧快照。上传后的缓存通过独立 worktree 合并到最新分支；推送发生竞争时自动重试，保留期间的新源码提交。即使上传或回写失败，工作流也会保存缓存 artifact，便于恢复已成功上传的记录。

GitHub Actions 发布工作流使用以下仓库 Secrets：

- `ARWEAVE_WALLET_JSON`
- `DEPLOY_EVM_PRIVATE_KEY`
- `ETH_RPC_URL`
- 加密文章所引用的密码环境变量（如有，需显式映射到构建步骤）

首次用于自己的 ENS 名称时，还需要修改 `.github/workflows/permaweb.yml` 中的 `ENS_NAME`。可为独立部署钱包授权或撤销当前名称的 Resolver 写入权限（脚本从 `.env.permaweb` 读取 `OWNER_PRIVATE_KEY`，兼容 `ETH_PRIVATE_KEY`）：

```sh
pnpm exec tsx scripts/grant-ens-delegate.ts 0xDELEGATE_ADDRESS
pnpm exec tsx scripts/grant-ens-delegate.ts 0xDELEGATE_ADDRESS --revoke
```

若本地/CI 缓存与线上 Manifest 脱节，可在构建后按线上交易重建缓存：

```sh
pnpm build
node scripts/sync-cache-from-manifest.mjs <manifest-txid>
```

恢复脚本会从网关下载 Manifest 引用的每个不同交易，流式计算远端文件的 SHA-256、大小和 MIME，确认后才写入缓存。路径相同但内容或 MIME 不同的本地文件不会误用旧交易；改名文件可通过内容哈希复用。原有历史记录会保留，旧版按路径误配的记录会修正；所有远端验证成功后才原子保存，失败时原缓存保持不变。需要明确丢弃损坏缓存再恢复时，可追加 `--force`。

### 兼容上传器

`pnpm deploy` 保留了较早的 `scripts/deploy-ardrive.mjs` 流程，但它与 `deploy:perma` 并不等价：它默认读取 `.env`、优先使用 `ETH_PRIVATE_KEY`、写入本地 `.deploy-cache.json`、不补尾斜杠路由别名、不更新 ENS，并且每次创建新的 Manifest。新部署应优先使用 `pnpm deploy:perma`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 扫描 MIDI 后启动开发服务器 |
| `pnpm new-post <name>` | 创建文章模板 |
| `pnpm midi:scan` | 重建 MIDI 播放列表 |
| `pnpm test` | 运行文章加密与密码解析测试 |
| `pnpm check` | 运行 Astro 类型和模板检查 |
| `pnpm type-check` | 运行 TypeScript 声明检查 |
| `pnpm lint` | 使用 Biome 检查并修复 `src/` |
| `pnpm format` | 格式化 `src/` |
| `pnpm build` | 扫描 MIDI、构建 Astro、生成 Pagefind 索引 |
| `pnpm build:clean` | 清理缓存后重新构建 |
| `pnpm preview` | 预览 `dist/` |
| `pnpm deploy` | 运行旧版兼容上传器（不同配置、无 ENS 更新） |
| `pnpm deploy:perma` | 完整 Arweave + ENS 发布流程 |

## 技术栈

| 组件 | 用途 |
| --- | --- |
| [Astro](https://astro.build/) / [Svelte](https://svelte.dev/) | 静态内容与交互组件 |
| [Tailwind CSS](https://tailwindcss.com/) / [Swup](https://swup.js.org/) | 主题样式与页面切换 |
| [Pagefind](https://pagefind.app/) | 静态全文搜索 |
| [ArDrive Turbo SDK](https://ardrive.io/turbo/) | Arweave 数据与 Manifest 上传 |
| [viem](https://viem.sh/) / ENS Content Hash | ENS 解析、权限检查与 `contenthash` 更新 |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) / Web Crypto | scrypt、AES-256-GCM 与加密信封 |
| [SpessaSynth](https://github.com/spessasus/SpessaSynth) | 浏览器 MIDI 合成 |
| [Waline](https://waline.js.org/) | 评论系统 |

## 安全边界

- 文章加密保护的是**生成后的正文 HTML**，不是仓库中的 Markdown 源文件；
- 标题、描述、标签、分类、提示、封面、附件、评论与密文长度默认公开；
- 加密信封可被下载后离线猜测密码，因此必须使用高熵口令；
- Arweave 上已经发布的旧版本无法撤回，换密码只影响新部署；
- Provenance 只解析并展示当前 ENS 与 Arweave 元数据，不验证数据项签名、交易包含证明、上传者身份或源码一致性；
- 部署密钥应来自被 Git 忽略的钱包文件、本地环境或 Actions Secrets；内联文章密码只适用于私有源码仓库。

更多细节见 [文章加密安全说明](docs/ARTICLE_ENCRYPTION.md)。

## 致谢与许可证

- UI、内容集合与基础博客能力来自 [saicaca/fuwari](https://github.com/saicaca/fuwari)；
- 文章解锁交互参考了 [LyraVoid/Mizuki](https://github.com/LyraVoid/Mizuki)，密码学信封在本项目中重新设计；
- 动漫语录来自 Hitokoto，选集与同步脚本采用 AGPL-3.0-only，来源和完整许可见 [语料说明](src/data/README.md)；
- 感谢 Astro、Arweave、ENS、ArDrive、SpessaSynth、Waline 及所有开源依赖。

> [!NOTE]
> `docs/README.*.md` 是从上游保留的多语言基础说明，只覆盖 Fuwari 原有能力；本 README 是当前分支功能与运维方式的权威入口。

项目以 [MIT License](LICENSE) 发布。上游 Fuwari 同样采用 MIT License。
