__ModuleLoader__.load({
  id: 'dsh-livetaskboard',
  factory: (require) => {
/** TaskBoard - 独立任务看板 browser plugin（从 deepmemory 提取）。 */
const React = require('react')
const name = 'deepmemory-task-board'

const PREFIX = '/task-api'

async function api(method, path, body) {
  try {
    const res = await fetch(PREFIX + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(function () { return {} })
    if (!res.ok) return { error: String((data && data.error) || ('HTTP ' + res.status)) }
    return data
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

const taskBoardState = { open: false, listeners: new Set(), workspaces: null, sessions: null }
function setTaskBoardOpen(open) {
  if (taskBoardState.open === open) return
  taskBoardState.open = open
  for (const l of taskBoardState.listeners) l(open)
}
function useTaskBoardOpen() {
  const [open, setOpen] = React.useState(taskBoardState.open)
  React.useEffect(function () {
    const l = function (v) { setOpen(v) }
    taskBoardState.listeners.add(l)
    return function () { taskBoardState.listeners.delete(l) }
  }, [])
  return [open, setTaskBoardOpen]
}

const TASK_STATUS_LABEL = { draft: '草稿', planned: '规划', todo: '待办', in_progress: '进行中', review: '待验收', completed: '完成', failed: '失败' }
const TASK_STATUS_COLOR = { draft: '#8a8f98', planned: '#c6a52b', todo: '#4c83c3', in_progress: '#e58a32', review: '#3e9b68', completed: '#2f7d5c', failed: '#d94f4f' }

function TaskBoardSurface(props) {
  const [open, setOpen] = useTaskBoardOpen()
  const sessionsState = typeof (props && props.useSessions) === 'function'
    ? props.useSessions(function (state) { return state })
    : { byId: {} }
  const workspaceState = typeof (props && props.useWorkspaces) === 'function'
    ? props.useWorkspaces(function (state) { return state })
    : { items: [], archivedSessionIds: [] }
  const workspaces = workspaceState.items || []
  const archivedIds = new Set((workspaceState.archivedSessionIds || []).map(String))
  const [tasks, setTasks] = React.useState([])
  const [workspaceId, setWorkspaceId] = React.useState('')
  const [sessionId, setSessionId] = React.useState('')
  const [sessionOptions, setSessionOptions] = React.useState([])
  const [draftText, setDraftText] = React.useState('')
  const [draftDesc, setDraftDesc] = React.useState('')
  const [msg, setMsg] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [transferTask, setTransferTask] = React.useState(null)
  const [xferWs, setXferWs] = React.useState('')
  const [xferSid, setXferSid] = React.useState('')
  const [confirmTask, setConfirmTask] = React.useState(null)

  const agentTodos = typeof (props && props.useProjection) === 'function' ? (props.useProjection('todos') || []) : []
  function sessionTitle(sid) {
    if (!sid) return '（未绑定会话）'
    const item = (sessionsState.byId || {})[sid]
    const title = item && item.displayTitle ? String(item.displayTitle) : ''
    return title || String(sid).slice(0, 18)
  }
  function workspaceTitle(wid) {
    for (const w of workspaces) if (String(w.workspaceId || w.id || '') === String(wid || '')) return String(w.title || w.name || w.workspaceId || wid)
    return String(wid || '')
  }

  async function load() {
    if (!workspaceId) return
    const res = await api('GET', '/v1/v2/tasks?workspace_id=' + encodeURIComponent(workspaceId) + '&limit=500')
    if (res && Array.isArray(res.tasks)) setTasks(res.tasks)
  }

  async function addDraft() {
    if (!draftText.trim()) return
    setBusy(true)
    const res = await api('POST', '/v1/v2/tasks', {
      title: draftText.trim(), description: draftDesc.trim(), status: 'draft',
      workspace_id: workspaceId, session_id: sessionId,
    })
    setBusy(false)
    if (res && res.task) { setDraftText(''); setDraftDesc(''); setMsg('草稿已保存'); await load() }
    else setMsg('保存失败: ' + (res.error || ''))
  }

  async function transition(task, toStatus, reason) {
    const res = await api('POST', '/v1/v2/tasks/' + task.id + '/transition', { to_status: toStatus, expected_version: task.version, reason: reason || 'UI move' })
    if (res && res.task) { setMsg('已流转 → ' + (TASK_STATUS_LABEL[toStatus] || toStatus)); await load() }
    else setMsg('流转失败: ' + (res.error || ''))
  }

  async function askSol(task) {
    setBusy(true); setMsg('正在问 sol …')
    const res = await api('POST', '/v1/v2/tasks/' + task.id + '/ask-sol', {})
    setBusy(false)
    if (res && res.ok) { setMsg('sol 建议已记录'); await load() }
    else setMsg('sol 询问失败: ' + (res.error || (res && res.advice) || ''))
  }

  async function requestSubagent(task) {
    setBusy(true); setMsg('正在请求子代理外援 …')
    const res = await api('POST', '/v1/v2/tasks/' + task.id + '/subagent-aid', { expected_version: task.version })
    setBusy(false)
    if (res && res.task) { setMsg('已标记：子代理外援待办（agent 会话将派子代理）'); await load() }
    else setMsg('子代理外援请求失败: ' + (res.error || ''))
  }

  async function removeTask(task) {
    setConfirmTask(task)
  }
  async function doRemoveTask() {
    const task = confirmTask
    setConfirmTask(null)
    if (!task) return
    const res = await api('POST', '/v1/v2/tasks/' + task.id + '/delete', { reason: 'deleted by user' })
    if (res && res.task) { setMsg('已删除'); await load() }
    else setMsg('删除失败: ' + (res.error || ''))
  }

  async function createNewSessionForTransfer() {
    if (!transferTask) return
    const targetWs = xferWs || workspaceId
    if (!targetWs) { setMsg('请选择目标工作区'); return }
    const wsvc = taskBoardState.workspaces
    if (!wsvc || typeof wsvc.connectWorkspace !== 'function') { setMsg('当前环境不支持新建会话'); return }
    setBusy(true)
    try {
      const newSid = await wsvc.connectWorkspace(targetWs)
      setBusy(false)
      if (!newSid) { setMsg('新建会话失败'); return }
      setXferSid(String(newSid))
      setMsg('已创建会话，可继续转入规划（新会话自动连接该工作区记忆）')
    } catch (e) {
      setBusy(false)
      setMsg('新建会话失败: ' + String(e && e.message || e))
    }
  }

  async function commitTransfer() {
    if (!transferTask) return
    const targetWs = xferWs || workspaceId
    const targetSid = xferSid
    if (!targetSid) { setMsg('请选择目标会话'); return }
    const res = await api('POST', '/v1/v2/tasks/' + transferTask.id + '/transition', {
      to_status: 'planned', expected_version: transferTask.version, reason: 'draft -> planned (选择会话: ' + sessionTitle(targetSid) + ')',
    })
    if (res && res.task) {
      await api('POST', '/v1/v2/tasks/' + transferTask.id + '/binding', { workspace_id: targetWs, session_id: targetSid, expected_version: res.task.version })
      setTransferTask(null); setMsg('已转入规划 · ' + sessionTitle(targetSid)); await load()
    } else setMsg('转失败: ' + (res.error || ''))
  }

  React.useEffect(function () {
    if (!open || !workspaceId) return
    const t = window.setTimeout(load, 0)
    return function () { window.clearTimeout(t) }
  }, [open, workspaceId])

  React.useEffect(function () {
    if (!open) return
    const current = sessionsState.byId || {}
    const ids = Object.keys(current)
    const sessionIdNow = ids.length ? String(ids[0]) : ''
    let workspaceIdNow = ''
    for (const w of workspaces) {
      if ((w.sessionIds || []).indexOf(sessionIdNow) >= 0) { workspaceIdNow = String(w.workspaceId || ''); break }
    }
    if (!workspaceIdNow && workspaces.length) workspaceIdNow = String(workspaces[0].workspaceId || workspaces[0].id || '')
    setSessionId(sessionIdNow)
    setWorkspaceId(workspaceIdNow)
    const opts = ids
      .filter(function (sid) { return !archivedIds.has(String(sid)) })
      .map(function (sid) { return { id: String(sid), title: sessionTitle(String(sid)) } })
    if (!opts.length && sessionIdNow && !archivedIds.has(String(sessionIdNow))) opts.push({ id: sessionIdNow, title: sessionIdNow })
    setSessionOptions(opts)
  }, [open])

  const embedded = !!(props && props.embedded)
  if (!embedded && !open) return null
  function openTaskSession(task) {
    const svc = taskBoardState.sessions
    if (svc && typeof svc.open === 'function' && task.session_id) { svc.open(task.session_id); return }
    setMsg('无法打开会话（当前会话未绑定）')
  }
  function taskButtons(task) {
    const cls = 'dsh-mem-btn'
    const danger = 'dsh-mem-btn dsh-mem-btn-danger'
    const out = []
    if (task.status !== 'draft' && task.session_id) out.push(React.createElement('button', { key: 'o', className: cls, onClick: function () { openTaskSession(task) } }, '↗ 打开会话'))
    if (task.status === 'draft') {
      out.push(React.createElement('button', { key: 'a', className: cls, onClick: function () { setTransferTask(task); setXferWs(workspaceId); setXferSid('') } }, '转正式任务'))
      out.push(React.createElement('button', { key: 'g', className: danger, onClick: function () { removeTask(task) } }, '删除'))
    }
    if (task.status === 'failed') out.push(React.createElement('button', { key: 's', className: cls, onClick: function () { askSol(task) } }, '🤖 问 sol'))
    if (task.status === 'failed') out.push(React.createElement('button', { key: 'sb', className: cls, onClick: function () { requestSubagent(task) } }, '👥 派子代理'))
    if (task.status === 'completed' || task.status === 'failed') out.push(React.createElement('button', { key: 'h', className: danger, onClick: function () { removeTask(task) } }, '删除'))
    return out
  }

  const columns = [
    { status: 'draft', title: '草稿 / 想法', hint: '没传给对话的灵感，可随时删除' },
    { status: 'planned', title: '规划', hint: '已写入会话，等待 agent 认领' },
    { status: 'todo', title: '待办', hint: 'agent 已认领，待执行' },
    { status: 'in_progress', title: '进行中', hint: 'agent 正在执行' },
    { status: 'review', title: '待验收', hint: '执行完成，等待验收' },
    { status: 'failed', title: '失败', hint: '多轮失败/外援未成，可重建或删除' },
  ]
  const total = tasks.length
  const activeCount = tasks.filter(function (t) { return t.status === 'in_progress' || t.status === 'todo' }).length
  const empty = total === 0
  const shellStyle = embedded
    ? { width: '100%', height: '100%', overflow: 'auto' }
    : { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(8,11,16,.62)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }
  return React.createElement('div', { style: shellStyle },
    React.createElement('div', { style: embedded ? { width: '100%', height: '100%', background: 'var(--dsw-alias-bg-layer-1, #151a21)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } : { width: 'min(1180px, 96vw)', maxHeight: '90vh', background: 'var(--dsw-alias-bg-layer-1, #151a21)', color: 'var(--dsw-alias-label-primary, #eceff4)', borderRadius: 14, boxShadow: '0 24px 80px rgba(0,0,0,.6)', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
      // Header
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))' } },
        React.createElement('span', { style: { fontSize: 16, fontWeight: 700 } }, '🗂 任务看板'),
        React.createElement('select', { className: 'dsh-mem-select', style: { maxWidth: 220, fontSize: 12 }, value: workspaceId, onChange: function (e) { setWorkspaceId(e.target.value) } },
          workspaces.map(function (w) { return React.createElement('option', { key: String(w.workspaceId || w.id), value: String(w.workspaceId || w.id) }, String(w.title || w.workspaceId || w.id)) }),
        ),
        React.createElement('span', { className: 'dsh-mem-badge' }, total + ' 项'),
        React.createElement('span', { className: 'dsh-mem-badge' }, '进行中 ' + activeCount),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', { className: 'dsh-mem-btn', onClick: load, title: '刷新' }, '↻ 刷新'),
        React.createElement('button', { className: 'dsh-mem-btn', onClick: function () { setOpen(false) } }, '✕ 关闭'),
      ),
      msg ? React.createElement('div', { style: { padding: '4px 18px', fontSize: 12, opacity: .85, background: 'rgba(78,150,255,.08)' } }, msg) : null,
      // Draft input
      React.createElement('div', { style: { padding: '12px 18px', display: 'flex', gap: 10, borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))' } },
        React.createElement('input', { className: 'dsh-mem-input', style: { flex: 2, minWidth: 160 }, placeholder: '✍️ 写下还没传给对话的想法…', value: draftText, onChange: function (e) { setDraftText(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') addDraft() } }),
        React.createElement('input', { className: 'dsh-mem-input', style: { flex: 3, minWidth: 200 }, placeholder: '补充描述（可选）', value: draftDesc, onChange: function (e) { setDraftDesc(e.target.value) } }),
        React.createElement('button', { className: 'dsh-mem-btn dsh-mem-btn-primary', onClick: addDraft, disabled: busy }, busy ? '…' : '存草稿'),
      ),
      // Columns
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, padding: 14, overflow: 'auto', flex: 1, minHeight: 0 } },
        columns.map(function (col) {
          const items = tasks.filter(function (t) { return t.status === col.status })
          return React.createElement('div', { key: col.status, style: { background: 'rgba(128,128,128,.05)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
              React.createElement('span', { style: { width: 10, height: 10, borderRadius: 5, background: TASK_STATUS_COLOR[col.status] } }),
              React.createElement('strong', { style: { fontSize: 13 } }, col.title),
              React.createElement('span', { className: 'dsh-mem-badge' }, String(items.length)),
            ),
            React.createElement('div', { style: { fontSize: 11, opacity: .55, marginBottom: 8 } }, col.hint),
            col.status === 'in_progress' && agentTodos.length ? [
              React.createElement('div', { key: 'agent-todos', style: { fontSize: 11, opacity: .7, marginBottom: 6 } }, '当前会话 agent 任务清单（todo_write 实时同步）:'),
              ...agentTodos.slice(0, 12).map(function (todo, ti) {
                const todoStyle = { background: 'var(--dsw-alias-bg-layer-1, #1d232c)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 13, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15))' }
                const dot = todo.status === 'in_progress' ? '#e58a32' : todo.status === 'completed' ? '#3e9b68' : '#8a8f98'
                return React.createElement('div', { key: 'at-' + ti, style: Object.assign({}, todoStyle, { display: 'flex', gap: 6, alignItems: 'flex-start' }) },
                  React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: dot, marginTop: 4, flex: 'none' } }),
                  React.createElement('div', null,
                    React.createElement('div', { style: { wordBreak: 'break-word' } }, String(todo.content || '')),
                    React.createElement('div', { style: { fontSize: 10, opacity: .55 } }, todo.status),
                  ),
                )
              }),
            ] : null,
            items.length ? items.map(function (task) {
              return React.createElement('div', { key: task.id, style: { background: 'var(--dsw-alias-bg-layer-1, #1d232c)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 13, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.15))' } },
                React.createElement('div', { style: { fontWeight: 600, marginBottom: 2, wordBreak: 'break-word' } }, task.title),
                task.description ? React.createElement('div', { style: { opacity: .7, fontSize: 12, marginBottom: 4, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, task.description) : null,
                React.createElement('div', { style: { fontSize: 11, opacity: .6, marginBottom: 6 } }, '会话: ' + sessionTitle(task.session_id)),
                task.sol_advice ? React.createElement('div', { style: { fontSize: 12, marginBottom: 6, padding: 6, background: 'rgba(78,150,255,.10)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, '💡 sol: ' + task.sol_advice) : null,
                task.failure_reason ? React.createElement('div', { style: { fontSize: 11, opacity: .7, marginBottom: 6 } }, '失败原因: ' + task.failure_reason) : null,
                task.subagent_pending ? React.createElement('div', { style: { fontSize: 11, marginBottom: 6, padding: 6, background: 'rgba(226,130,50,.12)', borderRadius: 6 } }, '👥 子代理外援待办（agent 将派子代理）') : null,
                React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } }, taskButtons(task)),
              )
            }) : React.createElement('div', { style: { opacity: .45, fontSize: 12, textAlign: 'center', padding: '18px 0' } }, '（空）'),
          )
        }),
      ),
      empty ? React.createElement('div', { style: { padding: '0 18px 14px', fontSize: 12, opacity: .5 } }, '暂无任务。顶部输入一条想法存为草稿，或等对话产生任务。') : null,
      // Transfer dialog
      transferTask ? React.createElement('div', { style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: 'var(--dsw-alias-bg-layer-2, #20262f)', borderRadius: 12, padding: 20, width: 460, boxShadow: '0 18px 60px rgba(0,0,0,.55)', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' } },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 6 } }, '草稿转正式任务'),
        React.createElement('div', { style: { fontSize: 13, opacity: .85, marginBottom: 12 } }, '「' + transferTask.title + '」将写入会话，进入规划队列'),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          React.createElement('label', { style: { fontSize: 12, opacity: .8 } }, '目标工作区: ',
            React.createElement('select', { className: 'dsh-mem-select', value: xferWs, onChange: function (e) { setXferWs(e.target.value) } },
              workspaces.map(function (w) { return React.createElement('option', { key: String(w.workspaceId || w.id), value: String(w.workspaceId || w.id) }, String(w.title || w.workspaceId || w.id)) }),
            ),
          ),
          React.createElement('label', { style: { fontSize: 12, opacity: .8 } }, '目标会话（选择后进入该会话规划队列）: ',
            React.createElement('select', { className: 'dsh-mem-select', value: xferSid, onChange: function (e) { setXferSid(e.target.value) } },
              React.createElement('option', { value: '' }, '— 请选择会话 —'),
              sessionOptions.map(function (o) { return React.createElement('option', { key: o.id, value: o.id }, o.title) }),
            ),
          ),
          xferSid ? React.createElement('div', { style: { fontSize: 12, opacity: .65 } }, '会话: ' + sessionTitle(xferSid)) : null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('button', { className: 'dsh-mem-btn', onClick: createNewSessionForTransfer, disabled: busy }, busy ? '…' : '✚ 新建会话'),
            React.createElement('span', { style: { fontSize: 11, opacity: .55 } }, '新会话自动连接该工作区记忆'),
          ),
        ),
        React.createElement('div', { style: { marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          React.createElement('button', { className: 'dsh-mem-btn', onClick: function () { setTransferTask(null) } }, '取消'),
          React.createElement('button', { className: 'dsh-mem-btn dsh-mem-btn-primary', onClick: commitTransfer }, '转入规划'),
        ),
      ) : null,
      // 自定义确认弹窗（不用浏览器 confirm）
      confirmTask ? React.createElement('div', { style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: 'var(--dsw-alias-bg-layer-2, #20262f)', borderRadius: 12, padding: 20, width: 380, boxShadow: '0 18px 60px rgba(0,0,0,.55)', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' } },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 8 } }, '确认删除'),
        React.createElement('div', { style: { fontSize: 13, opacity: .9, marginBottom: 4 } }, '确定删除任务「' + confirmTask.title + '」？'),
        React.createElement('div', { style: { fontSize: 12, opacity: .6, marginBottom: 14 } }, '删除后从看板消失，不可恢复（保留审计）。'),
        React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          React.createElement('button', { className: 'dsh-mem-btn', onClick: function () { setConfirmTask(null) } }, '取消'),
          React.createElement('button', { className: 'dsh-mem-btn dsh-mem-btn-danger', onClick: doRemoveTask }, '确认删除'),
        ),
      ) : null,
    ),
  )
}

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const sessionService = ctx.get('sessions')
  const workspaceService = ctx.get('workspaces')
  if (workspaceService) taskBoardState.workspaces = workspaceService
  if (sessionService) taskBoardState.sessions = sessionService

  slots.inject('sidebar.footer.action', function () {
    return slots.register(
      { name: 'sidebar.footer.action', id: 'task-board', order: 40, label: '任务看板' },
      function () {
        const [open, setOpen] = useTaskBoardOpen()
        return React.createElement('button', {
          title: '任务看板', onClick: function (e) { e.stopPropagation(); setOpen(!open) },
          style: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '6px 8px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: 13 },
        },
          React.createElement('span', null, open ? '⊙' : '◉'),
          React.createElement('span', null, '任务看板'),
        )
      },
    )
  })
  slots.inject('shell.overlay', function () {
    return slots.register(
      { name: 'shell.overlay', id: 'task-board', order: 50, label: '任务看板' },
      function (props) { return React.createElement(TaskBoardSurface, props) },
    )
  })
}
return { name, apply }
  }
})
