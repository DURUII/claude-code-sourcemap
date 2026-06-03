# How we use Claude Code in Slack

**作者**: Thariq (@trq212)
**日期**: 上午5:33 · 2026年1月31日
**链接**: https://x.com/trq212/status/2017350486756888917
**数据**: 38 回复 · 63 次转帖 · 980 喜欢 · 30.2万 次查看

---

One of the biggest differences between how we use Claude Code at Anthropic and how the broader world uses it is how much we use it in Slack.

In particular, we use it for answering questions, acting on feedback, and trying out prototypes.

Answering Questions

When people in go-to market, customer support, marketing, product, etc. have a question about Claude Code, they ask Claude directly in Slack. While we keep our docs up to date, they don't cover every possible question. The ultimate source of truth is in the codebase.

Because it has access to git, it can answer questions like  "When was this feature released?" or "who is responsible for this code?", which can help you find the right owners.

Protip: Go even further and add skills with access to things like your event store or analytics dashboard to answer questions about feature usage or error logs.

Acting on Feedback

We have very active Claude Code feedback channels. When someone sends in feedback, we will very often tag [@Claude](https://x.com/@Claude) to try and solve it with some guiding context. It's not always possible, but a PR can be a way of exploring or understanding how something can be done.

Every Claude in Slack instance is visible on Claude Code on the web, so my chat history in [claude.ai/code](https://claude.ai/code) is almost like my jira board, where feedback PRs are listed just waiting to be acted on.

Building Prototypes

I don't really send memos or make mockups anymore, I just make CC prototypes. If I have an idea I might kick off the prototype via Claude in Slack and wait to see how it comes out before figuring out if it's worth investing in.

Some tips for using Claude in Slack well:

- Investing in the configuration (e.g. Claude.MDs, hooks, verification, etc) is even more valuable, because it lets non technical people use Claude in Slack better.
- You still need to check it out, test and read the code. We're not just merging from Slack into main.
- Set a 'default repo' for a channel to make it easier for Claude in Slack to tell where it can make changes.

Read the docs and get started with Claude in Slack here: https://code.claude.com/docs/en/slack

If you're already using it, give us feedback!
