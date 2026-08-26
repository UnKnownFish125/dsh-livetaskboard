# Changelog

## [v0.1.1] - 2026-08-26

### Added
- 外援配置项：`TASK_BOARD_AID_MODE`（sol / subagent / sol+subagent / none）+ `TASK_BOARD_SUBAGENT_MAX_RETRIES`
- `POST /v1/v2/tasks/<id>/subagent-aid`：标记失败任务待子代理外援（`subagent_pending`/`aid_attempts`/`aid_state`）
- `GET /v1/v2/config`：返回外援配置；health 附带 aid_mode
- 失败卡 UI：「👥 派子代理」按钮 + 子代理待办状态展示
- 文档：README 外援机制段（sol + 保底子代理 + 可配置）

## [v0.1.0] - 2026-08-26

### Added
- 独立任务看板插件（从 dsh-deepmemory 派生）：`board_domain.py`（TaskBoardStore 状态机 + sol_advice）、`board_server.py`（HTTP API，端口 6250）、`web-plugin/`（DSH bundle：侧栏按钮 + 浮层六栏看板）
- 任务状态机：`draft → planned → todo → in_progress → review → completed`，失败可重建/重试
- `/task-api` 独立前缀代理（不与 deepmemory 的 `/mem-api` 冲突）
- 外援接口：`ask-sol`（自动发现 sol 模型）+ `sol-advice`；保底子代理为可配置预留
- 工作区切换、打开会话、草稿转正式任务（新建会话 + 记忆连接）、自定义确认删除

### Verified
- 测试机（DSH 3091）验证：proxy / create / list / 侧栏按钮 / 浮层六栏渲染全部通过
