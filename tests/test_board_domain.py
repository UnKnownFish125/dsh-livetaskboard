"""dsh-livetaskboard board_domain 单元测试。"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from board_domain import TaskBoardStore, InvalidTransition, ConflictError, NotFoundError


class BoardStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, 'board.db')
        self.store = TaskBoardStore(self.db)
        self.store.migrate()

    def _create(self, title='t', status='planned', ws='ws1', sid='s1', **kw):
        return self.store.create_task(title, status=status, workspace_id=ws, session_id=sid, **kw)

    def test_migrate_schema(self):
        import sqlite3
        c = sqlite3.connect(self.db)
        cols = [r[1] for r in c.execute('PRAGMA table_info(tasks)')]
        for col in ('deleted_at', 'sol_advice', 'subagent_pending', 'aid_attempts', 'aid_state'):
            self.assertIn(col, cols, f'missing {col}')
        sql = c.execute("SELECT sql FROM sqlite_master WHERE name='tasks'").fetchone()[0]
        self.assertIn('draft', sql)
        self.assertIn('review', sql)

    def test_full_lifecycle(self):
        t = self._create(status='draft')
        self.assertEqual('draft', t['status'])
        for nxt in ('planned', 'todo', 'in_progress', 'review', 'completed'):
            t = self.store.transition_task(t['id'], nxt, t['version'], reason='step')
        self.assertEqual('completed', t['status'])

    def test_failed_and_retry(self):
        t = self._create(status='todo')
        t = self.store.transition_task(t['id'], 'in_progress', t['version'], reason='go')
        t = self.store.transition_task(t['id'], 'failed', t['version'], reason='外援失败')
        self.assertEqual('failed', t['status'])
        self.assertEqual('外援失败', t['failure_reason'])
        t = self.store.transition_task(t['id'], 'todo', t['version'], reason='重试')
        self.assertEqual('todo', t['status'])
        self.assertEqual(2, t['attempt'])

    def test_sol_advice_and_subagent_pending(self):
        t = self._create(status='todo')
        t = self.store.transition_task(t['id'], 'in_progress', t['version'], reason='go')
        t = self.store.transition_task(t['id'], 'failed', t['version'], reason='fail')
        t = self.store.set_task_sol_advice(t['id'], '- 换路线', t['version'])
        self.assertIn('换路线', t['sol_advice'])
        t = self.store.mark_subagent_pending(t['id'], t['version'])
        self.assertEqual(1, t['subagent_pending'])
        self.assertEqual(1, t['aid_attempts'])
        self.assertEqual('subagent_pending', t['aid_state'])

    def test_soft_delete_hides_from_list(self):
        t = self._create(status='draft')
        self.store.delete_task(t['id'], actor='user')
        self.assertEqual([], self.store.list_tasks('ws1'))
        with self.assertRaises(ConflictError):
            self.store.delete_task(t['id'], actor='user')

    def test_active_limit_ignores_draft(self):
        ws = 'ws-limit'
        self._create(status='draft', ws=ws, max_active_tasks=2)
        self._create(status='draft', ws=ws, max_active_tasks=2)
        self._create(status='planned', ws=ws, max_active_tasks=2)
        self._create(status='planned', ws=ws, max_active_tasks=2)
        with self.assertRaises(InvalidTransition):
            self._create(status='planned', ws=ws, max_active_tasks=2)

    def test_illegal_transition(self):
        t = self._create(status='draft')
        with self.assertRaises(InvalidTransition):
            self.store.transition_task(t['id'], 'completed', t['version'], reason='skip')


if __name__ == '__main__':
    unittest.main(verbosity=2)
