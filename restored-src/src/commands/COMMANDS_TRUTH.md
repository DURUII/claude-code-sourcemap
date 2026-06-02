# Claude Code 命令列表

按字母序排列。

## 普通用户可用（CLI 交互式会话）

- `/add-dir` - 添加新的工作目录
- `/agents` - 管理代理配置
- `/branch` - 创建当前对话的分支
- `/btw` - 快速提问不中断主对话
- `/clear` - 清除对话历史
- `/color` - 设置提示栏颜色
- `/compact` - 清除历史但保留摘要
- `/commit` - 提交更改
- `/commit-push-pr` - 提交、推送并创建 PR
- `/config` - 打开配置面板
- `/context` - 上下文使用情况可视化
- `/copy` - 复制 Claude 最后响应到剪贴板
- `/cost` - 显示会话成本和持续时间
- `/diff` - 查看未提交更改和每轮差异
- `/doctor` - 诊断 Claude Code 安装和设置
- `/effort` - 设置模型努力级别
- `/exit` - 退出 REPL
- `/export` - 导出对话到文件或剪贴板
- `/feedback` - 提交反馈
- `/help` - 显示帮助和可用命令
- `/hooks` - 查看工具事件钩子配置
- `/ide` - 管理 IDE 集成
- `/install-github-app` - 设置 Claude GitHub Actions
- `/keybindings` - 打开快捷键配置文件
- `/login` - 登录 Anthropic 账户
- `/logout` - 登出 Anthropic 账户
- `/mcp` - 管理 MCP 服务器
- `/memory` - 编辑 Claude 内存文件
- `/model` - 设置 AI 模型
- `/permissions` - 管理工具权限规则
- `/plan` - 启用计划模式或查看会话计划
- `/plugin` - 插件管理
- `/pr_comments` - 获取 GitHub PR 评论
- `/release-notes` - 查看发布说明
- `/reload-plugins` - 重载插件
- `/rename` - 重命名当前对话
- `/resume` - 恢复之前的对话
- `/review` - 审查代码更改
- `/rewind` - 恢复代码和/或对话到之前的点
- `/sandbox` - 切换沙箱模式
- `/security-review` - 安全审查
- `/skills` - 列出可用技能
- `/stats` - 显示使用统计
- `/status` - 显示 Claude Code 状态
- `/stickers` - 订购 Claude Code 贴纸
- `/tasks` - 列出和管理后台任务
- `/terminal-setup` - 安装终端按键绑定
- `/theme` - 更改主题
- `/version` - 显示版本信息
- `/vim` - 切换 Vim/正常编辑模式

## 需要特定条件

- `/bridge` - 远程控制会话（需要 BRIDGE_MODE feature flag）
- `/extra-usage` - 配置额外使用量（需要 isOverageProvisioningAllowed）
- `/fast` - 切换快速模式（需要 isFastModeEnabled）
- `/passes` - 分享免费使用（需要 eligibility 检查）
- `/privacy-settings` - 隐私设置（需要 isConsumerSubscriber）
- `/statsig` - 年度回顾（需要 tengu_thinkback feature gate）

## 仅 Web 可用（availability: ['claude-ai']）

- `/chrome` - Chrome 集成设置
- `/desktop` - 在 Claude Desktop 继续
- `/install-slack-app` - 安装 Slack 应用
- `/remote-env` - 远程环境配置
- `/remote-setup` - Web 设置
- `/usage` - 计划使用限制
- `/voice` - 语音模式

## 内部专用（需要 USER_TYPE === 'ant'）

- `/files` - 列出上下文中的文件
- `/tag` - 切换会话标签

## Stub 占位符（无实际实现）

以下命令仅有 isEnabled: () => false，无实际功能：

- `/ant-trace`
- `/autofix-pr`
- `/backfill-sessions`
- `/bughunter`
- `/ctx_viz`
- `/debug-tool-call`
- `/env`
- `/good-claude`
- `/mock-limits`
- `/oauth-refresh`
- `/onboarding`
- `/perf-issue`
- `/summary`
- `/teleport`