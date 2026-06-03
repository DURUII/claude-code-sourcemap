# We're turning Todos into Tasks in Claude Code

**作者**: Thariq (@trq212)
**日期**: 上午7:29 · 2026年1月23日
**链接**: https://x.com/trq212/status/2014480496013803643
**数据**: 324 回复 · 757 次转帖 · 5933 喜欢 · 221.3万 次查看

---

Today, we're upgrading Todos in Claude Code to Tasks. Tasks are a new primitive that help Claude Code track and complete more complicated projects and collaborate on them across multiple sessions or subagents.

As model capabilities grow, one of the most important things we can do is "unhobble" Claude and allow it to use its new capabilities effectively. Compared to previous models, Opus 4.5 is able to run autonomously for longer and keep track of its state better. We found that the TodoWrite Tool was no longer necessary because Claude already knew what it needed to do for smaller tasks.

At the same time, we found ourselves using Claude Code to complete longer projects, sometimes across multiple subagents, context windows or sessions. But projects are more complex, tasks have dependencies and blockers and require coordination when using it across sessions.

It was clear we needed to evolve Todos to help Claude work on longer projects. This need was also emerging in the community and we took inspiration from projects like Beads by Steve Yegge.

Tasks are our new abstraction for coordinating many pieces of work  across projects, Claude can create Tasks with dependencies on each other that are stored in the metadata, which mirrors more how projects work. Additionally, Tasks are stored in the file system so that multiple subagents or sessions can collaborate on them. When one session updates a Task, that is broadcasted to all sessions currently working on the same Task List.

You can ask Claude to create tasks right now, it's especially useful when creating when spinning up subagents. Tasks are stored in `~/.claude/tasks`, you can use this to build additional utilities on top of tasks as well.

To make sessions collaborate on a single Task List, you can set the TaskList as an environment variable and start Claude like so:

```
CLAUDE_CODE_TASK_LIST_ID=groceries claude
```

This also works for claude -p and the AgentSDK.

Tasks are a key building block for allowing Claude to build more complex projects. We're looking forward to seeing how you use it.
