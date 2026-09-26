# claude-code-sourcemap

[![linux.do](https://img.shields.io/badge/linux.do-huo0-blue?logo=linux&logoColor=white)](https://linux.do)

> [!WARNING]
> This repository is **unofficial** and is reconstructed from the public npm package and source map analysis, **for research purposes only**.
> It does **not** represent the original internal development repository structure.
>
> 本仓库为**非官方**整理版，基于公开 npm 发布包与 source map 分析还原，**仅供研究使用**。
> **不代表**官方原始内部开发仓库结构。
> 一切基于L站"飘然与我同"的情报提供

## 概述

本仓库通过 npm 发布包（`@anthropic-ai/claude-code`）内附带的 source map（`cli.js.map`）还原的 TypeScript 源码，版本为 `2.1.88`。

## 来源

- npm 包：[@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- 还原版本：`2.1.88`
- 还原文件数：**4756 个**（含 1884 个 `.ts`/`.tsx` 源文件）
- 还原方式：提取 `cli.js.map` 中的 `sourcesContent` 字段

## 目录结构

```
restored-src/src/
├── main.tsx              # CLI 入口
├── tools/                # 工具实现（Bash、FileEdit、Grep、MCP 等 30+ 个）
├── commands/             # 命令实现（commit、review、config 等 40+ 个）
├── services/             # API、MCP、分析等服务
├── utils/                # 工具函数（git、model、auth、env 等）
├── context/              # React Context
├── coordinator/          # 多 Agent 协调模式
├── assistant/            # 助手模式（KAIROS）
├── buddy/                # AI 伴侣 UI
├── remote/               # 远程会话
├── plugins/              # 插件系统
├── skills/               # 技能系统
├── voice/                # 语音交互
└── vim/                  # Vim 模式
```

## 声明

- 源码版权归 [Anthropic](https://www.anthropic.com) 所有
- 本仓库仅用于技术研究与学习，请勿用于商业用途
- 如有侵权，请联系删除

## 友情链接

- https://www.swebench.com/
- https://github.com/novasky-ai/skyrl
- https://github.com/radixark/miles
- https://github.com/lmnr-ai/lmnr
- https://github.com/mlflow/mlflow
- https://arxiv.org/abs/2411.15100
- https://fastapi.tiangolo.com/tutorial/first-steps/#openapi
- https://gorilla.cs.berkeley.edu/leaderboard.html
- https://openrouter.ai/
- https://mini-swe-agent.com/latest/
- https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/openhands-tools/openhands/tools/file_editor/definition.py
- https://aider.chat/docs/more/edit-formats.html
- https://github.com/OpenHands/software-agent-sdk/blob/df2ea8fa5542d5d2a543e108bc8b2d4fbbab34b1/openhands-tools/openhands/tools/preset/gpt5.py
- https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/opencode/src/tool/registry.ts
- https://github.com/openai/codex/blob/16ff14c266179e6a762dc8081e9dab73a96683e0/codex-rs/apply-patch/src/parser.rs
- https://github.com/NVIDIA-NeMo/ProRL-Agent-Server/tree/6a1ead6bfac054fce6c1e62d1a77b330d96c58db/src/polar/agent
- https://playwright.dev/docs/locators
- https://playwright.dev/docs/test-assertions
- https://playwright.dev/docs/test-snapshots
- https://playwright.dev/docs/test-snapshots
- https://playwright.dev/docs/test-assertions
- https://jykoh.com/blog/whats-the-point-of-computer-use-agents/
- https://huggingface.co/docs/transformers/en/main_classes/tokenizer