"""TaskBoard - 独立任务看板存储域（任务生命周期，从 deepmemory v2_domain 独立）。"""
import json
import sqlite3
import time
import uuid


class DomainError(Exception):
    pass


class NotFoundError(DomainError):
    pass


class ConflictError(DomainError):
    pass


class PermissionDenied(DomainError):
    pass


class InvalidTransition(DomainError):
    pass


def _json(value):
    if value is None:
        return "[]"
    if isinstance(value, (str, bytes)):
        return value
    return json.dumps(value, ensure_ascii=False)


def _ensure_columns(conn, table, columns):
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, ddl in columns:
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


TASK_STATUSES = ("draft", "planned", "todo", "in_progress", "review", "completed", "failed")
TASK_COLORS = ("neutral", "red", "orange", "yellow", "green", "blue")
CARD_ACTORS = ("user", "main_agent", "system")

V2_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT REFERENCES tasks(id),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  task_color TEXT NOT NULL DEFAULT 'neutral',
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('draft','planned','todo','in_progress','review','completed','failed')),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  block_reason TEXT NOT NULL DEFAULT '',
  missing_conditions TEXT NOT NULL DEFAULT '[]',
  completion_criteria TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  failure_evidence TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  source_message_id TEXT NOT NULL DEFAULT '',
  trace_id TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  CHECK(blocked = 0 OR status = 'in_progress')
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL
    CHECK(event_type IN ('created','status_changed','blocked','unblocked','failed','reopened')),
  from_status TEXT,
  to_status TEXT,
  reason TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  actor TEXT NOT NULL DEFAULT 'main_agent'
    CHECK(actor IN ('user','main_agent','system')),
  source_message_id TEXT NOT NULL DEFAULT '',
  trace_id TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);
"""

TASK_TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS task_events_immutable_update
BEFORE UPDATE ON task_events BEGIN
  SELECT RAISE(ABORT, 'task events are immutable');
END;
"""


def install_schema(conn):
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(V2_SCHEMA)
    conn.executescript(TASK_TRIGGERS)
    _ensure_columns(conn, "tasks", (
        ("task_color", "TEXT NOT NULL DEFAULT 'neutral'"),
        ("workspace_id", "TEXT NOT NULL DEFAULT ''"),
        ("session_id", "TEXT NOT NULL DEFAULT ''"),
        ("deleted_at", "REAL"),
        ("sol_advice", "TEXT NOT NULL DEFAULT ''"),
        ("subagent_pending", "INTEGER NOT NULL DEFAULT 0"),
        ("aid_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("aid_state", "TEXT NOT NULL DEFAULT ''"),
    ))
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id,status,updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id,updated_at)")


class TaskBoardStore:
    """独立任务看板存储。"""

    def __init__(self, db_path):
        self.db_path = db_path

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def migrate(self):
        with self._connect() as conn:
            install_schema(conn)

    def create_task(self, title, status="planned", parent_task_id=None, **fields):
        if status not in TASK_STATUSES:
            raise InvalidTransition(f"unknown task status: {status}")
        task_id = fields.pop("task_id", None) or str(uuid.uuid4())
        now = time.time()
        blocked = bool(fields.get("blocked", False))
        task_color = fields.get("task_color", "neutral") or "neutral"
        if task_color not in TASK_COLORS:
            raise InvalidTransition(f"unknown task color: {task_color}")
        if blocked and status != "in_progress":
            raise InvalidTransition("only in_progress tasks may be blocked")
        workspace_id = str(fields.get("workspace_id") or "").strip()
        session_id = str(fields.get("session_id") or "").strip()
        if not workspace_id:
            raise DomainError("tasks require workspace_id")
        if not session_id:
            raise DomainError("tasks require session_id")
        max_active = int(fields.get("max_active_tasks", 0) or 0)
        if max_active > 0:
            with self._connect() as conn:
                count = conn.execute(
                    "SELECT COUNT(*) c FROM tasks WHERE workspace_id=? AND status IN "
                    "('planned','todo','in_progress','review')",
                    (workspace_id,),
                ).fetchone()["c"]
            if count >= max_active:
                raise InvalidTransition(
                    f"task limit reached: {count} active tasks in workspace (max {max_active}); "
                    "finish or archive some before adding more"
                )
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO tasks (id,parent_task_id,workspace_id,session_id,title,description,"
                "task_color,status,blocked,block_reason,missing_conditions,completion_criteria,"
                "source_message_id,trace_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    task_id,
                    parent_task_id,
                    workspace_id,
                    session_id,
                    title,
                    fields.get("description", ""),
                    task_color,
                    status,
                    int(blocked),
                    fields.get("block_reason", ""),
                    _json(fields.get("missing_conditions", [])),
                    fields.get("completion_criteria", ""),
                    fields.get("source_message_id", ""),
                    fields.get("trace_id", ""),
                    now,
                    now,
                ),
            )
            self._task_event(conn, task_id, "created", None, status, 1, fields)
        return self.get_task(task_id)

    def get_task(self, task_id):
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"task not found: {task_id}")
        result = dict(row)
        result["missing_conditions"] = json.loads(result["missing_conditions"] or "[]")
        return result

    def transition_task(
        self,
        task_id,
        to_status,
        expected_version,
        reason="",
        evidence="",
        actor="main_agent",
        source_message_id="",
        trace_id="",
    ):
        allowed = {
            "draft": {"planned"},
            "planned": {"todo"},
            "todo": {"in_progress"},
            "in_progress": {"review", "failed"},
            "review": {"completed", "failed"},
            "failed": {"draft", "todo", "in_progress"},
            "completed": set(),
        }
        if to_status not in TASK_STATUSES:
            raise InvalidTransition(f"unknown task status: {to_status}")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["version"] != expected_version:
                raise ConflictError(
                    f"task version conflict: expected {expected_version}, current {row['version']}"
                )
            if to_status not in allowed[row["status"]]:
                raise InvalidTransition(f"cannot move {row['status']} to {to_status}")
            if to_status in ("completed", "failed") and row["blocked"]:
                raise InvalidTransition("unblock a task before closing its attempt")
            if to_status == "failed" and not reason:
                raise InvalidTransition("failed tasks require a reason")
            reopened = row["status"] == "failed"
            attempt = row["attempt"] + (1 if reopened else 0)
            failure_reason = reason if to_status == "failed" else row["failure_reason"]
            failure_evidence = evidence if to_status == "failed" else row["failure_evidence"]
            conn.execute(
                "UPDATE tasks SET status=?,attempt=?,failure_reason=?,failure_evidence=?,"
                "version=version+1,updated_at=? WHERE id=?",
                (to_status, attempt, failure_reason, failure_evidence, time.time(), task_id),
            )
            event_type = "reopened" if reopened else ("failed" if to_status == "failed" else "status_changed")
            self._task_event(
                conn,
                task_id,
                event_type,
                row["status"],
                to_status,
                attempt,
                {
                    "reason": reason,
                    "evidence": evidence,
                    "actor": actor,
                    "source_message_id": source_message_id,
                    "trace_id": trace_id,
                },
            )
        return self.get_task(task_id)

    def delete_task(self, task_id, actor="user", reason="deleted by user"):
        """Soft-delete one task: set deleted_at and record a status_changed event."""
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["deleted_at"] is not None:
                raise ConflictError("task already deleted")
            conn.execute(
                "UPDATE tasks SET deleted_at=?,version=version+1,updated_at=? WHERE id=?",
                (time.time(), time.time(), task_id),
            )
            self._task_event(
                conn,
                task_id,
                "status_changed",
                row["status"],
                row["status"],
                row["attempt"],
                {"reason": reason, "actor": actor},
            )
        return self.get_task(task_id)

    def set_task_blocked(
        self,
        task_id,
        blocked,
        expected_version,
        reason="",
        missing_conditions=None,
        actor="main_agent",
    ):
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["version"] != expected_version:
                raise ConflictError("task version conflict")
            if blocked and row["status"] != "in_progress":
                raise InvalidTransition("only in_progress tasks may be blocked")
            conn.execute(
                "UPDATE tasks SET blocked=?,block_reason=?,missing_conditions=?,"
                "version=version+1,updated_at=? WHERE id=?",
                (
                    int(bool(blocked)),
                    reason if blocked else "",
                    _json(missing_conditions or []),
                    time.time(),
                    task_id,
                ),
            )
            self._task_event(
                conn,
                task_id,
                "blocked" if blocked else "unblocked",
                row["status"],
                row["status"],
                row["attempt"],
                {"reason": reason, "actor": actor},
            )
        return self.get_task(task_id)

    def mark_subagent_pending(self, task_id, expected_version, actor="user", reason=""):
        """标记失败任务为「待子代理外援」（DSH agent 会话负责真正 spawn；此处只记录状态）。"""
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["version"] != expected_version:
                raise ConflictError(
                    f"task version conflict: expected {expected_version}, current {row['version']}"
                )
            conn.execute(
                "UPDATE tasks SET subagent_pending=1,aid_attempts=aid_attempts+1,"
                "aid_state='subagent_pending',version=version+1,updated_at=? WHERE id=?",
                (time.time(), task_id),
            )
            self._task_event(
                conn, task_id, "status_changed", row["status"], row["status"],
                row["attempt"],
                {"reason": reason or "subagent aid pending", "actor": actor},
            )
        return self.get_task(task_id)

    def set_task_sol_advice(self, task_id, advice, expected_version, actor="main_agent", reason=""):
        """Store the sol-provided advice for a failed task (one-time aid; versioned)."""
        if not advice or not str(advice).strip():
            raise DomainError("sol advice is required")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["version"] != expected_version:
                raise ConflictError(
                    f"task version conflict: expected {expected_version}, current {row['version']}"
                )
            conn.execute(
                "UPDATE tasks SET sol_advice=?,version=version+1,updated_at=? WHERE id=?",
                (str(advice).strip(), time.time(), task_id),
            )
            self._task_event(
                conn,
                task_id,
                "status_changed",
                row["status"],
                row["status"],
                row["attempt"],
                {"reason": reason or "sol advice recorded", "actor": actor},
            )
        return self.get_task(task_id)

    def set_task_color(self, task_id, task_color, expected_version):
        if task_color not in TASK_COLORS:
            raise InvalidTransition(f"unknown task color: {task_color}")
        with self._connect() as conn:
            row = conn.execute("SELECT version FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["version"] != expected_version:
                raise ConflictError("task version conflict")
            conn.execute(
                "UPDATE tasks SET task_color=?,version=version+1,updated_at=? WHERE id=?",
                (task_color, time.time(), task_id),
            )
        return self.get_task(task_id)

    @staticmethod
    def _task_event(conn, task_id, event_type, from_status, to_status, attempt, fields):
        actor = fields.get("actor", "main_agent")
        if actor not in CARD_ACTORS:
            raise PermissionDenied("sub-agent/model paths cannot mutate the main task board")
        conn.execute(
            "INSERT INTO task_events (id,task_id,event_type,from_status,to_status,reason,"
            "evidence,attempt,actor,source_message_id,trace_id,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                str(uuid.uuid4()),
                task_id,
                event_type,
                from_status,
                to_status,
                fields.get("reason", ""),
                fields.get("evidence", ""),
                attempt,
                actor,
                fields.get("source_message_id", ""),
                fields.get("trace_id", ""),
                time.time(),
            ),
        )

    def task_history(self, task_id):
        with self._connect() as conn:
            exists = conn.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone()
            if exists is None:
                raise NotFoundError(f"task not found: {task_id}")
            rows = conn.execute(
                "SELECT * FROM task_events WHERE task_id=? ORDER BY created_at,id", (task_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def list_tasks(self, workspace_id, status=None, parent_task_id=None, session_id=None, limit=100):
        """Return a bounded task-board view without exposing raw sqlite rows."""
        workspace_id = str(workspace_id or "").strip()
        if not workspace_id:
            raise DomainError("workspace_id is required")
        clauses, args = ["workspace_id=?", "deleted_at IS NULL"], [workspace_id]
        if status:
            if status not in TASK_STATUSES:
                raise DomainError(f"unknown task status: {status}")
            clauses.append("status=?")
            args.append(status)
        if parent_task_id is not None:
            clauses.append("parent_task_id=?")
            args.append(parent_task_id)
        if session_id is not None:
            clauses.append("session_id=?")
            args.append(str(session_id))
        limit = max(1, min(int(limit), 500))
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM tasks{where} ORDER BY created_at DESC LIMIT ?",
                args + [limit],
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["missing_conditions"] = json.loads(item["missing_conditions"] or "[]")
            result.append(item)
        return result

    def rebind_task(self, task_id, workspace_id, session_id, expected_version):
        """Rebind one task to a conversation inside its owning workspace."""
        workspace_id = str(workspace_id or "").strip()
        session_id = str(session_id or "").strip()
        if not workspace_id or not session_id:
            raise DomainError("workspace_id and session_id are required")
        with self._connect() as conn:
            row = conn.execute("SELECT version,workspace_id FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            if row["version"] != expected_version:
                raise ConflictError("task version conflict")
            if row["workspace_id"] and row["workspace_id"] != workspace_id:
                raise InvalidTransition("task workspace cannot be changed; only its conversation may be rebound")
            conn.execute(
                "UPDATE tasks SET workspace_id=?,session_id=?,version=version+1,updated_at=? WHERE id=?",
                (workspace_id, session_id, time.time(), task_id),
            )
        return self.get_task(task_id)
