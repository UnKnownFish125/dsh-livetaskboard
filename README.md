# dsh-livetaskboard

动态任务看板插件（从 dsh-deepmemory 派生）：独立的任务状态机 + 存储 + API + Web UI，
可单独安装到 DeepSeek Harness，不与主体记忆系统耦合。

## 架构

```
┌──────────────┐   /task-api 代理   ┌──────────────────┐
│  DSH Web     │ ─────────────────▶ │ board_server.py  │  端口 6250
│  (client.js) │                    │ (HTTP API)       │ │ sqlite: data/board.db
│  (index.js)  │                    │ TaskBoardStore   │ ◀─ 状态机 + sol_advice
└──────────────┘                    └──────────────────┘
```

- `board_domain.py`：`TaskBoardStore` —— 任务生命周期（独立 sqlite，自带迁移与触发器）
- `board_server.py`：独立 HTTP 服务（默认 `127.0.0.1:6250`，token 可选鉴权）
- `web-plugin/`：DSH bundle —— `client.js`（侧栏按钮 + 浮层看板）、`index.js`（`/task-api` prefix 代理 + ask-sol 外援路由）、`dsh.patch.yml`、`package.json`

## 安装

```
# 1. 复制插件到 DSH profile 的 web bundle 目录
cp -r web-plugin /www/dsh/home/profiles/web/node_modules/dsh-livetaskboard
cd /www/dsh/home/profiles/web
python -c "import json,os; d=json.load(open('package.json')); d.setdefault('dsh',{}).setdefault('profile',{}).setdefault('bundles',[]).append('dsh-livetaskboard') if 'dsh-livetaskboard' not in d['dsh']['profile']['bundles'] else None; json.dump(d,open('package.json','w'),ensure_ascii=False,indent=2)"

# 2. 转换 client 为 __ModuleLoader__ 格式
python3 scripts/fix-client-bundle.py node_modules/dsh-livetaskboard/client.js dsh-livetaskboard

# 3. 启动独立 board server（端口 6250；可环境变量覆盖）
TASK_BOARD_PORT=6250 TASK_BOARD_DB=$PWD/.dsh-task-board/board.db \
  TASK_BOARD_TOKEN_FILE=$PWD/.dsh-task-board/api-token \
  python3 board_server.py

# 4. 重启 DSH web 生效
systemctl restart dsh-web
```

## 任务状态机

```
draft → planned → todo → in_progress → review → completed
                ↗                     ↘
              failed（失败/外援未成，可重建或重试）
```

- `draft`：想法/草稿（不占活跃上限，可删除）
- `planned`：已写入会话，等待 agent 认领（规划队列）
- `todo`：agent 已认领待执行
- `in_progress`：agent 正在执行
- `review`：执行完成待验收
- `completed`：验收通过
- `failed`：多轮失败/外援未成，可重建/重试/删除

## API（board_server，端口 6250）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/v2/tasks?workspace_id=..&status=..&session_id=..&limit=..` | 列表（已过滤删除） |
| GET | `/v1/v2/tasks/<id>` | 单任务 |
| GET | `/v1/v2/tasks/<id>/history` | 事件历史 |
| POST | `/v1/v2/tasks` | 创建（`title/status/workspace_id/session_id/max_active_tasks` ...） |
| POST | `/v1/v2/tasks/<id>/transition` | 流转（`to_status/expected_version/reason`） |
| POST | `/v1/v2/tasks/<id>/blocked` | 阻塞/解除 |
| POST | `/v1/v2/tasks/<id>/color` | 颜色 |
| POST | `/v1/v2/tasks/<id>/binding` | 重绑会话 |
| POST | `/v1/v2/tasks/<id>/delete` | 软删除（deleted_at） |
| POST | `/v1/v2/tasks/<id>/sol-advice` | 写 sol 建议（`advice/expected_version`） |
| GET | `/v1/health` | 健康 |

## 外援机制（问 sol）

- `POST /task-api/v1/v2/tasks/<id>/ask-sol`（经 DSH 代理）：自动发现 DSH 模型目录里的 sol 模型（如 `gpt-5.6-sol`），追问失败任务并写回 `sol_advice`。
- 保底子代理：为可配置项预留（`aid.mode: sol | subagent | sol+subagent` 待接 DSH subagent），见 docs/（待补充）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TASK_BOARD_PORT` | `6250` | board server 端口 |
| `TASK_BOARD_DB` | `<repo>/data/board.db` | sqlite 路径 |
| `TASK_BOARD_TOKEN_FILE` | `<repo>/data/api-token` | Bearer token 文件（空则无鉴权） |
| `TASK_BOARD_TOKEN_FILE`（Host） | `DSH_HOME/.dsh-task-board-token` | Host 代理读 token 的路径 |

## 开发

- 测试机验证通过：proxy / create / list / 侧栏按钮 / 浮层六栏。
- 与 `dsh-deepmemory`（主体记忆）解耦：任务独立存储，`/task-api` 前缀不冲突 `/mem-api`。

## 许可

AGPL-3.0-only
