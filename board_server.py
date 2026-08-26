"""TaskBoard - 独立任务看板 HTTP 服务（端口 6250）。"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from board_domain import (
    TaskBoardStore, DomainError, NotFoundError, ConflictError,
    PermissionDenied, InvalidTransition,
)

PORT = int(os.environ.get("TASK_BOARD_PORT", "6250"))
DB_PATH = os.environ.get("TASK_BOARD_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "board.db"))
API_TOKEN_FILE = os.environ.get("TASK_BOARD_TOKEN_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "api-token"))


def _read_token():
    try:
        with open(API_TOKEN_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def _authorized(handler):
    token = _read_token()
    if not token:
        return True
    header = handler.headers.get("Authorization", "")
    if header.startswith("Bearer ") and header[7:] == token:
        return True
    return False


class Handler(BaseHTTPRequestHandler):
    server_version = "task-board/0.1"

    def log_message(self, fmt, *args):
        print("[http]", self.address_string(), fmt % args, flush=True)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def _v2_call(self, operation):
        try:
            return self._send(200, {"ok": True, **operation()})
        except NotFoundError as exc:
            return self._send(404, {"error": str(exc)})
        except ConflictError as exc:
            return self._send(409, {"error": str(exc)})
        except PermissionDenied as exc:
            return self._send(403, {"error": str(exc)})
        except (DomainError, InvalidTransition, ValueError, KeyError, TypeError) as exc:
            return self._send(400, {"error": str(exc)})

    def _store(self):
        store = TaskBoardStore(DB_PATH)
        store.migrate()
        return store

    def _guard(self):
        if not _authorized(self):
            self._send(401, {"error": "bearer token required"})
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        parsed = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        path = unquote(self.path.split("?", 1)[0])
        parts = [unquote(part) for part in path.strip("/").split("/")]
        if path == "/v1/health":
            return self._send(200, {"status": "ok", "service": "task-board"})
        if path == "/v1/v2/tasks":
            return self._v2_call(lambda: {"tasks": self._store().list_tasks(
                workspace_id=parsed.get("workspace_id", [None])[0],
                status=parsed.get("status", [None])[0],
                parent_task_id=parsed.get("parent_task_id", [None])[0],
                session_id=parsed.get("session_id", [None])[0],
                limit=parsed.get("limit", [100])[0],
            )})
        if len(parts) >= 4 and parts[2] == "tasks":
            task_id = parts[3]
            store = self._store()
            if len(parts) == 5 and parts[4] == "history":
                return self._v2_call(lambda: {"task_id": task_id, "events": store.task_history(task_id)})
            return self._v2_call(lambda: {"task": store.get_task(task_id)})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._guard():
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})
        path = unquote(self.path)
        parts = [unquote(part) for part in path.strip("/").split("/")]
        if path in ("/v1/v2/tasks",):
            if not body.get("title"):
                return self._send(400, {"error": "title is required"})
            return self._v2_call(lambda: {"task": self._store().create_task(
                body["title"], status=body.get("status", "planned"),
                parent_task_id=body.get("parent_task_id"), **{
                    key: body[key] for key in (
                        "description", "task_color", "blocked", "block_reason", "missing_conditions",
                        "completion_criteria", "source_message_id", "trace_id", "workspace_id", "session_id",
                        "max_active_tasks",
                    ) if key in body
                })})
        if len(parts) >= 5 and parts[2] == "tasks":
            task_id = parts[3]
            store = self._store()
            if parts[4] == "delete":
                return self._v2_call(lambda: {"task": store.delete_task(
                    task_id, actor=body.get("actor", "user"),
                    reason=body.get("reason", "deleted by user"),
                )})
            if parts[4] == "sol-advice":
                return self._v2_call(lambda: {"task": store.set_task_sol_advice(
                    task_id, body.get("advice", ""),
                    int(body.get("expected_version", 0)),
                    actor=body.get("actor", "main_agent"),
                    reason=body.get("reason", ""),
                )})
            if parts[4] == "transition":
                return self._v2_call(lambda: {"task": store.transition_task(
                    task_id, body["to_status"], int(body["expected_version"]),
                    reason=body.get("reason", ""), evidence=body.get("evidence", ""),
                    actor=body.get("actor", "main_agent"),
                    source_message_id=body.get("source_message_id", ""), trace_id=body.get("trace_id", ""),
                )})
            if parts[4] == "blocked":
                return self._v2_call(lambda: {"task": store.set_task_blocked(
                    task_id, bool(body.get("blocked")), int(body["expected_version"]),
                    reason=body.get("reason", ""), missing_conditions=body.get("missing_conditions", []),
                    actor=body.get("actor", "main_agent"),
                )})
            if parts[4] == "color":
                return self._v2_call(lambda: {"task": store.set_task_color(
                    task_id, body.get("task_color", "neutral"), int(body["expected_version"]),
                )})
            if parts[4] == "binding":
                return self._v2_call(lambda: {"task": store.rebind_task(
                    task_id, body.get("workspace_id"), body.get("session_id"),
                    int(body["expected_version"]),
                )})
        return self._send(404, {"error": "not found"})


def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    store = TaskBoardStore(DB_PATH)
    store.migrate()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"task-board server listening on http://127.0.0.1:{PORT} (db={DB_PATH})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
