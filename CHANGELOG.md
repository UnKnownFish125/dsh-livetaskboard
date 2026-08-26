# Changelog

## [v0.1.0] - 2026-08-26

### Added
- 独立任务看板插件（从 dsh-deepmemory 派生）：`board_domain.py`（TaskBoardStore 状态机 + sol_advice）、`board_server.py`（HTTP API，端口 6250）、`web-plugin/`（DSH bundle：侧栏按钮 + 浮层六栏看板）
- 任务状态机：`draft → planned → todo → in_progress → review → completed`，失败可重建/重试
- `/task-api` 独立前缀代理（不与 deepmemory 的 `/mem-api` 冲突）
- 外援接口：`ask-sol`（自动发现 sol 模型）+ `sol-advice`；保底子代理为可配置预留
- 工作区切换、打开会话、草稿转正式任务（新建会话 + 记忆连接）、自定义确认删除

### Verified
- 测试机（DSH 3091）验证：proxy / create / list / 侧栏按钮 / 浮层六栏渲染全部通过
