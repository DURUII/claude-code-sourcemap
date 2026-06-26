# claude-code restored source

> [!WARNING]
> This directory is **unofficial** and is reconstructed from the public npm package and source map analysis, **for research purposes only**.
> It does **not** represent the original internal development repository structure.
>
> 本目录为 **非官方** 源码还原目录，基于公开 npm 发布包与 source map 分析整理，**仅供研究、阅读与本地调试使用**。
> **不代表**官方原始内部开发仓库结构。

## 概述

本目录基于上游仓库 [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap) 与公开 npm 包 [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code) 中的 source map，整理还原 Claude Code `2.1.88` 的 TypeScript 源码结构；在此基础上，本工作区补充了本地 CLI 入口，并修复部分运行时依赖解析问题，依赖恢复原则与验证记录见 [`RESTORATION.md`](./RESTORATION.md)。

## 运行

本地入口为：

```bash
./bin/claude
```

常用验证命令：

```bash
./bin/claude --version
./bin/claude --help
./bin/claude --bare -p --max-turns 1 'Respond exactly: RESTORED_OK'
```

也可通过 npm scripts 调用：

```bash
npm start -- --help
npm run claude -- --version
```

`bin/claude` 是一个很小的 Bash wrapper，负责设置还原运行时需要的工作目录与配置目录，然后交给 Bun 加载 TypeScript CLI 入口。默认配置目录为 repo-local `.claude`。如需使用其他配置目录，可显式指定：

```bash
CLAUDE_CONFIG_DIR=~/.claude ./bin/claude
```

## Telemetry / GrowthBook 配置

本地配置中 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 会阻止 GrowthBook、内部 analytics、内部 metrics 等非必要网络流量。

如果要做可观测性实验，可新建配置目录，或在启动命令里显式传入环境变量。

例如，临时测试 OTLP：

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
./bin/claude
```

也可以将长期配置可以放在自定义 `CLAUDE_CONFIG_DIR/settings.local.json` 的 `env` 字段中，例如：

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example.com",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer REPLACE_ME"
  }
}
```

GrowthBook 当前代码默认使用 Anthropic 的 GrowthBook host 和 client key。

`USER_TYPE=ant` 会打开大量内部调试、prompt、bridge、analytics 分支。

若要接自己的 GrowthBook，建议显式补一个小 patch，让外部运行也能读取类似下面的占位符：

```json
{
  "env": {
    "CLAUDE_CODE_GB_BASE_URL": "https://growthbook.example.com",
    "CLAUDE_CODE_GB_CLIENT_KEY": "sdk-REPLACE_ME"
  }
}
```

## 目录结构

```text
restored-src/
├── bin/claude             # 本地 CLI wrapper
├── src/entrypoints/       # CLI / SDK / MCP 等入口
├── src/main.tsx           # CLI 主流程
├── src/tools/             # 工具实现
├── src/commands/          # 命令实现
├── src/services/          # API、MCP、analytics 等服务
├── src/utils/             # 工具函数
├── src/components/        # Ink / React TUI 组件
├── src/screens/           # 终端界面
├── src/skills/            # bundled skills
└── src/native-ts/         # native 包的 TypeScript 还原实现
```

## 说明

- 本目录不是 Anthropic 官方源码仓库。
- source map 还原不保证文件组织、构建脚本与官方内部仓库完全一致。
- 涉及动态生成、native binding 或运行时注入的模块，需要结合实际运行结果单独核验。

## 声明

- 源码版权归 [Anthropic](https://www.anthropic.com) 所有
- 本目录仅用于技术研究、学习与本地调试，请勿用于商业用途
- 如有侵权，请联系删除
