# Skillo

> One skill, one source of truth, every agentic tool.

多个 agentic tool 各有一套 `skills/` 目录，同一份技能会被复制成 N 份、各自漂移，链接断了也没人知道。Skillo 用一个 SSOT（单一事实源）加逐技能的 Windows junction 解决这件事：技能内容只存在一处，Claude Code / WorkBuddy / Qoder / Codex 等 harness 通过链接读取，改一次全部生效。

MVP 为个人级、单机、Windows 优先。当前可用命令：`init` / `status` / `link` / `unlink` / `doctor` / `adopt`；`ssot set`、`annotate` 尚未实现。

设计文档见 `plan/PRD.md`、`plan/SPEC.md`、`plan/TECH_DESIGN.md`。

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

| 命令 | 作用 |
|---|---|
| `npm run check` | `tsc --noEmit` 全量类型检查 |
| `npm test` | 单元 + 集成测试（104 项），每个用例在沙箱 `HOME` 内跑 |
| `npm link` | 把 `skillo` 注册为全局命令，之后可直接 `skillo status` |

注意：npm 12 默认拦截 `prepare` 等 install script，`npm link` 不会自动重新构建，装完用的仍是 `dist/` 里**当时**的产物。改了源码后要么先 `npm run build`，要么开发期直接走 `npm run dev --`。卸载用 `npm unlink -g skillo`。

## 命令速查

```
skillo init                 建立锚点 ~/.agents/skills、探测已安装的 harness
skillo status [skill]       技能 × harness 分布，--matrix 看矩阵
skillo link [skill...]      分发到 harness，默认全部技能 × 全部 harness
skillo unlink [skill...]    撤销分发，只删链接不碰内容
skillo doctor [harness]     诊断断链/冲突/锚点异常，--fix 修复
skillo adopt --from <id>    把 harness 里的实体技能目录纳入 SSOT
```

通用选项：`--dry-run` 只输出计划、`-h` / `-v`。`status --json` 可拿机器可读结果。

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
