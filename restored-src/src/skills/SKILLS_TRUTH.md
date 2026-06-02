# Bundled Skills 清单

## 公开（所有用户）

- `/batch`
- `/claude-api` (feature flag: BUILDING_CLAUDE_APPS)
- `/claude-in-chrome` (需要 Chrome 扩展连接)
- `/debug`
- `/loop` (feature flag: AGENT_TRIGGERS)
- `/simplify`
- `/update-config`

## 公开但用户不可直接调用

- `/keybindings-help` (userInvocable: false, 模型专用)

## 内部专用（USER_TYPE === 'ant'）

- `/lorem-ipsum`
- `/remember`
- `/skillify`
- `/stuck`
- `/verify`

## 编译时 feature flag 控制（源码不在 restored-src）

- `dream` (KAIROS / KAIROS_DREAM)
- `hunter` (REVIEW_ARTIFACT)
- `runSkillGenerator` (RUN_SKILL_GENERATOR)
