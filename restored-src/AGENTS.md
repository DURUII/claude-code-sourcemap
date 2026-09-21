This is restored-src of claude v2.1.88 (2026-04-01).

## Rules

关于 Agent Harness 工程设计，除了参考本代码仓库外，还应该参考：

0. https://github.com/SWE-agent/mini-SWE-agent
1. https://github.com/OpenHands/
2. https://github.com/anomalyco/opencode/
3. https://github.com/openai/codex/codex-rs/

## Others

- `querySource` 可以理解为一次 LLM 模型请求的 entrypoint / purpose / attribution label，判断这次调用为什么发起、属于主对话/SDK/后台任务/agent/工具子请求/压缩摘要等哪条执行路径。