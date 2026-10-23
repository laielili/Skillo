# Skillo

> One skill, one source of truth, every agentic tool.

多个 agentic tool 各有一套 `skills/` 目录，同一份技能会被复制成 N 份、各自漂移，链接断了也没人知道。Skillo 用一个 SSOT（单一事实源）加逐技能的 Windows junction 解决这件事：技能内容只存在一处，Claude Code / WorkBuddy / Qoder / Codex 等 harness 通过链接读取，改一次全部生效。

MVP 为个人级、单机、Windows 优先。当前可用命令：`init` / `status` / `link` / `unlink` / `doctor` / `adopt`；`ssot set`、`annotate` 尚未实现。

设计文档见 `plan/PRD.md`、`plan/SPEC.md`、`plan/TECH_DESIGN.md`。

## 安装

已发布到 npm：**[skillo](https://www.npmjs.com/package/skillo)**，要求 Node ≥ 18。

```bash
npx skillo --help        # 免安装直接用
npm i -g skillo          # 或者装成全局命令，之后直接 skillo <command>
```

上手三步。`init` 会写 `~/.skillo/config.json` 并建立锚点 `~/.agents/skills`；第三步加了 `--dry-run`，只打印计划，不动任何 harness 目录：

```bash
npx skillo init
npx skillo status
npx skillo link --dry-run     # 确认无误后再去掉 --dry-run
```

## 开发模式启动

开发时**不需要编译**。源码中的 import 带着 `.ts` 后缀，直接由 Node 的原生类型擦除（type stripping）执行。

前置条件：

- Node **≥ 22.18**（原生擦除类型默认开启）。`node -v` 确认，本仓库在 v22.22.2 上验证。
- 在仓库根目录执行（`package.json` 里的脚本用的是相对路径）。
- 依赖安装：`npm install`。`prepare` 钩子声明了构建，但 npm 12 默认拦截 install script（会提示 `install-scripts ... blocked`），实际不会执行；dev 流程不需要它。

```bash
npm run dev -- --help
npm run dev -- init
npm run dev -- status --matrix
npm run dev -- link find-skills --to workbuddy --dry-run
```

命令与参数之间的 `--` 不可省略，否则参数会被 npm 吃掉。

## 构建

```bash
npm run build     # tsc -p tsconfig.build.json → dist/
```

- 输入 `src/**/*.ts`，输出 `dist/**/*.js`（附带 `.js.map`），入口为 `dist/bin/skillo.js`，shebang 已保留，可直接 `node dist/bin/skillo.js`。
- `rewriteRelativeImportExtensions` 在构建时把 `.ts` 后缀改写为 `.js`，因此 `dist/` 可在 Node 18+ 运行（`engines` 声明的下限），只有 dev 模式需要 22.18+。
- 想看到源码行号：`node --enable-source-maps dist/bin/skillo.js status`。

其他脚本：

| 命令              | 作用                                 |
| --------------- | ---------------------------------- |
| `npm run check` | `tsc --noEmit` 全量类型检查              |
| `npm test`      | 单元 + 集成测试（104 项），每个用例在沙箱 `HOME` 内跑 |
| `npm link`      | 把本地源码注册成全局 `skillo`，覆盖 npm 上的同名命令  |

注意：npm 12 默认拦截 `prepare` 等 install script，`npm link` 不会自动重新构建，装完用的仍是 `dist/` 里**当时**的产物。改了源码后要么先 `npm run build`，要么开发期直接走 `npm run dev --`。卸载用 `npm unlink -g skillo`。

同理，`npx skillo` 和全局 `skillo` 跑的都是**已发布的包**，不是本地源码。想确认本地改动是否生效，只认 `npm run dev --`。

### 发布

```bash
npm run build && npm pack --dry-run   # 确认 dist 是最新的、README 已进包
npm publish
```

npm 12 会拦截 `prepare`，所以别指望 `npm publish` 自动构建 —— 先手动 `npm run build`，否则发出去的是 `dist/` 里的旧代码。

## 命令速查

```
skillo init                 建立锚点 ~/.agents/skills、探测已安装的 harness
skillo list [skill]         技能 × harness 分布，--matrix 看矩阵
skillo link [skill...]      分发到 harness，默认全部技能 × 全部 harness
skillo unlink [skill...]    撤销分发，只删链接不碰内容
skillo doctor [harness]     诊断断链/冲突/锚点异常，--fix 修复
skillo adopt --from <id>    把 harness 里的实体技能目录纳入 SSOT
```

通用选项：`--dry-run` 只输出计划、`-h` / `-v`。`status --json` 可拿机器可读结果。

## Doctor

`skillo doctor [harness]` 按「锚点 → 各 harness」两层扫描，只列问题不改动；加 `--fix` 才执行修复，`--dry-run` 打印将要做的修复但不落盘。带上 harness id 只查那一个。不带 `--fix` 时只要出现 `error` 级发现，退出码就非 0，可以挂进定时任务当健康检查。

```
skillo doctor            # 全量诊断
skillo doctor [harness]  # 只看一个 harness
skillo doctor --dry-run  # 只说要修什么
skillo doctor --fix      # 真修
```

发现项分三档：

| 档       | 常见项                                           | 处置           |
| ------- | --------------------------------------------- | ------------ |
| ✓ ok    | 锚点 junction 正常 / 原生读取锚点 / 已禁用 / N 个技能未分发到此    | 无需动作         |
| ! warn  | 锚点是实体目录 / harness 目录不存在 / N 个链接绕过锚点           | 后两类可 `--fix` |
| ✗ error | 锚点断链 / skills 目录本身是链接 / N 个链接断链 / 同名实体目录或文件占位 | 见下           |

修复范围刻意收得很窄，只做四件事：**拆掉整目录 junction 并立即按技能重建**（不留空窗，但那一瞬该工具可能读不到技能）、**重建断掉的链接**、**把绕过锚点的链接重定向回锚点**、**创建缺失的 harness 目录**。

同样重要的是它**不**做什么：不重建锚点（断链时重建一个空的，会让技能看起来凭空消失）；不删除任何技能内容；不替你扩大分发范围——断链和绕道锚点的修复只针对出问题的技能，原本没分发的不会被顺手分发（唯一的例外是整目录 junction，它本来就靠全量重建）；不碰它自己没创建的条目。

需要人工介入的两种：同名实体目录占位，跑 `skillo adopt --from <harness>` 纳入 SSOT；锚点断链，恢复原路径（盘没挂载就挂回来），doctor 只会告诉你它原本指向哪里。至于同名**文件**占位，Skillo 同样不删，需要你手动处理。

## 目录结构

```
src/
  bin/skillo.ts     进程入口，只负责读写 stdout/stderr
  cli/              参数解析、路由、配色输出
  commands/         init / status / link / unlink / doctor / adopt
  core/             锚点检测、配置持久化、扫描、relation、安全文件操作
  presets/          harness 默认路径表
  util/             错误、frontmatter、哈希、文本
test/
  unit/             纯函数
  integration/      在临时 HOME 里跑完整 CLI
```

配置写在 `~/.skillo/config.json`（原子写入，损坏时报错而不会覆盖）；被 `adopt` 替换掉的原目录移入 `~/.skillo/.trash/`。
