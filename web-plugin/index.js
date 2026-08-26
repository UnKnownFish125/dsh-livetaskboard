/** TaskBoard - 独立任务看板 Host 插件：/mem-api 代理到 task-board server + 失败任务问 sol。 */
import http from 'node:http'
import fs from 'node:fs'

export const name = 'deepmemory-task-board'
export const inject = ['webServer']

const TARGET_HOST = 'localhost'
const TARGET_PORT = Number(process.env.TASK_BOARD_PORT || 6250)
const PREFIX = '/task-api'
const TOKEN_FILES = [
  process.env.TASK_BOARD_TOKEN_FILE,
  process.env.DSH_HOME ? `${process.env.DSH_HOME}/.dsh-task-board-token` : '',
].filter((path, index, paths) => path && paths.indexOf(path) === index)

function readToken() {
  for (const path of TOKEN_FILES) {
    try {
      const token = fs.readFileSync(path, 'utf8').trim()
      if (token) return token
    } catch {}
  }
  return ''
}

function boardRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const token = readToken()
    const headers = { Accept: 'application/json' }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(payload.length)
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request({
      host: TARGET_HOST,
      port: TARGET_PORT,
      path,
      method,
      headers,
      timeout: 60000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data
        try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `HTTP ${res.statusCode}` } }
        if ((res.statusCode || 500) >= 400) reject(new Error(data.error || `HTTP ${res.statusCode}`))
        else resolve(data)
      })
    })
    req.on('timeout', () => req.destroy(new Error('task-board request timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function resolveSolRoute(llm) {
  try {
    const rawProviders = await llm.listProviders()
    const providers = (rawProviders || []).map((p) => p.id || p.provider || p.name).filter(Boolean)
    for (const name of providers) {
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(name) : []
        const sol = (models || []).find((mm) => /sol/i.test(mm.id || mm.name || ''))
        if (sol) return { provider: name, model: sol.id }
      } catch {}
    }
  } catch {}
  return null
}

export function apply(ctx) {
  // 全量代理：/task-api/* -> task-board server
  ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      let rel = req.url ?? ''
      if (rel.startsWith(PREFIX)) rel = rel.slice(PREFIX.length)
      if (!rel.startsWith('/')) rel = '/' + rel
      const upstreamPath = rel || '/v1/health'
      const headers = { ...req.headers }
      delete headers.origin
      delete headers.authorization
      const token = readToken()
      if (token) headers.authorization = `Bearer ${token}`
      headers.host = `${TARGET_HOST}:${TARGET_PORT}`
      const upstream = http.request(
        {
          host: TARGET_HOST,
          port: TARGET_PORT,
          path: upstreamPath,
          method: req.method ?? 'GET',
          headers,
          timeout: 30000,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        },
      )
      upstream.on('timeout', () => upstream.destroy(new Error('task-board request timeout')))
      upstream.on('error', (error) => {
        try {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String((error && error.message) || error) }))
        } catch {}
      })
      req.pipe(upstream)
    },
  })

  // 失败任务问 sol：llm 调 gpt-5.6-sol 出建议，写回 task-board sol-advice
  ctx.webServer.register({
    kind: 'regex',
    path: new RegExp('^' + PREFIX.replace('/', '\/') + '\/v1\/v2\/tasks\/([^\/]+)\/ask-sol$'),
    handler: async (req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      try {
        const m = String(req.url || '').match(new RegExp('^' + PREFIX.replace('/', '\/') + '\/v1\/v2\/tasks\/([^\/]+)\/ask-sol$'))
        const taskId = m && m[1] ? decodeURIComponent(m[1]) : ''
        const llm = ctx.get('llm')
        if (!llm || typeof llm.stream !== 'function') { send(503, { error: 'llm unavailable' }); return }
        let task = null
        try { task = (await boardRequest('GET', '/v1/v2/tasks/' + encodeURIComponent(taskId))).task } catch (e) { send(404, { error: 'task not found' }); return }
        if (!task) { send(404, { error: 'task not found' }); return }
        const solRoute = await resolveSolRoute(llm)
        if (!solRoute) { send(404, { error: 'no sol model configured in dsh model catalog' }); return }
        const prompt = [
          '你是外援分析器。给一个失败任务提出可行建议。',
          '任务标题: ' + (task.title || ''),
          '描述: ' + (task.description || ''),
          '失败原因: ' + (task.failure_reason || ''),
          '失败证据: ' + (task.failure_evidence || ''),
          '要求: 输出 2-4 条可执行建议（每条一行，bullet 开头），中文，不含凭据字面值。若任务明显不可行，指出并说明如何终止/拒绝。',
        ].join('\n')
        let advice = ''
        try {
          const stream = llm.stream({
            provider: solRoute.provider, model: solRoute.model,
            system: '你是外援分析助手。',
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            temperature: 0.3,
          })
          for await (const chunk of stream) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') advice += chunk.text
            else if (chunk && (chunk.type === 'error' || chunk.type === 'aborted')) break
          }
        } catch (e) { send(502, { error: 'sol stream failed: ' + String(e) }); return }
        if (!advice.trim()) { send(502, { error: 'sol returned empty' }); return }
        let saved = null
        try { saved = await boardRequest('POST', '/v1/v2/tasks/' + encodeURIComponent(taskId) + '/sol-advice', {
          advice: advice.trim(), expected_version: task.version, actor: 'main_agent', reason: 'sol aid for failed task',
        }) } catch (e) { send(500, { ok: false, advice: advice.trim(), error: 'advice save failed: ' + String((e && e.message) || e) }); return }
        send(200, { ok: true, advice: advice.trim(), provider: solRoute.provider, model: solRoute.model, task: saved && saved.task })
      } catch (error) {
        send(500, { error: String((error && error.message) || error) })
      }
    },
  })
}
