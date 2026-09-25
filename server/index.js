import express from 'express'
import { db } from './db.js'

const app = express()
app.use(express.json())

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
const now = () => new Date().toLocaleString('zh-CN')

// 高等级预警（红/橙）触发时自动建档危机事件
const AUTO_LEVELS = ['red', 'orange']
const LV_TEXT = { red: '红色', orange: '橙色', yellow: '黄色' }

class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// 统一事务：单条录入与批量导入共用，任一步失败整体回滚
function withTx(fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    // 个别底层错误会导致事务自动回滚，忽略此处二次 ROLLBACK 的报错
    try { db.exec('ROLLBACK') } catch { /* 已无活动事务 */ }
    throw e
  }
}

// 录入项规整与校验（单条/批量共用）。兼容旧单条请求：字段缺省仍按默认值兜底
function normalizePost(body = {}, idxMsg = '') {
  const title = (body.title ?? '').toString().trim()
  const content = (body.content ?? '').toString().trim()
  if (!title) throw new ApiError(`舆情${idxMsg}标题不能为空`)
  if (!content) throw new ApiError(`舆情《${title}》${idxMsg}正文不能为空`)
  let sourceId = Number(body.source_id)
  if (!Number.isFinite(sourceId) || sourceId <= 0) sourceId = 1
  if (!q1('SELECT id FROM sources WHERE id=?', sourceId)) throw new ApiError(`舆情《${title}》${idxMsg}渠道不存在`)
  const topic = (body.topic ?? '').toString().trim() || '新增'
  const media = (body.media ?? '').toString().trim()
  return { title, content, source_id: sourceId, topic, media }
}

// 危机列表（含来源规则、未解除预警数、时间线）
function crisisList(withTimeline = false) {
  const list = q(`SELECT c.*, a.title alert_title,
    (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=c.id AND ae.status='open') open_events
    FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id ORDER BY c.id DESC`)
  if (!withTimeline) return list
  return list.map((c) => ({ ...c, timeline: q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id) }))
}

// 简易情感打分（演示用，规则匹配）
const NEG = ['慢', '卫生', '投诉', '延期', '质疑', '故障', '涨价', '维权', '不满', '告', '退款', '坑', '吐槽', '回应迟']
const POS = ['好评', '回升', '利好', '积极', '满意', '点赞', '惠民', '提升', '突破', '肯定', '有效']
function analyze(text) {
  let score = 0
  NEG.forEach((w) => { if (text.includes(w)) score -= 0.5 })
  POS.forEach((w) => { if (text.includes(w)) score += 0.5 })
  score = Math.max(-1, Math.min(1, score))
  return { sentiment: score < -0.2 ? 'negative' : score > 0.2 ? 'positive' : 'neutral', score }
}

// ===== 总览 =====
app.get('/api/state', (req, res) => {
  const posts = q('SELECT * FROM posts')
  const total = posts.length
  const pos = posts.filter((p) => p.sentiment === 'positive').length
  const neg = posts.filter((p) => p.sentiment === 'negative').length
  const neu = total - pos - neg
  const hot = q('SELECT * FROM hot_words ORDER BY weight DESC LIMIT 12')
  const activeAlerts = q('SELECT * FROM alerts WHERE active=1')
  const crises = crisisList()
  const sources = q('SELECT s.*, COUNT(p.id) cnt FROM sources s LEFT JOIN posts p ON p.source_id=s.id GROUP BY s.id')
  // 热度趋势（近7时段）
  const nowH = new Date().getHours()
  const trend = []
  for (let i = 6; i >= 0; i--) {
    const seg = nowH - i
    const label = (seg + 24) % 24
    const len = posts.length
    const v = Math.round((len * (0.55 + ((i % 3) * 0.15))) + (Math.sin(i * 1.7) * 6))
    trend.push({ label, value: Math.max(18, v) })
  }
  res.json({
    sources, hotWords: hot, activeAlerts, crises,
    stats: { total, pos, neg, neu, negRate: total ? Math.round((neg / total) * 100) : 0, hot: posts.filter((p) => p.hot).length, topHeat: Math.max(...posts.map((p) => p.heat), 0) },
    trend
  })
})

// ===== 舆情列表（支持筛选） =====
app.get('/api/posts', (req, res) => {
  const { sentiment, source, topic, q: kw } = req.query
  let sql = 'SELECT * FROM posts WHERE 1=1'
  const args = []
  if (sentiment && sentiment !== 'all') { args.push(sentiment); sql += ` AND sentiment=?` }
  if (source && source !== 'all') { args.push(+source); sql += ` AND source_id=?` }
  if (topic) { args.push(topic); sql += ` AND topic LIKE ?`; args.push(`%${topic}%`) }
  if (kw) { args.push(`%${kw}%`); args.push(`%${kw}%`); sql += ` AND (title LIKE ? OR content LIKE ?)` }
  sql += ' ORDER BY published DESC'
  res.json(q(sql, ...args))
})
app.get('/api/topics', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT topic FROM posts').all().map((r) => r.topic))
})

// 统一预警触发 → 危机自动建档/并入（事务内调用，不单独开事务）
// 返回本次命中的预警明细；高等级预警同规则有未结案危机时去重并入，否则自动建档
function checkAlertsTx(postId) {
  const p = q1('SELECT * FROM posts WHERE id=?', postId)
  const alerts = q('SELECT * FROM alerts WHERE active=1')
  const fired = []
  for (const al of alerts) {
    const kwHit = !al.keyword || (p.title + p.content).includes(al.keyword)
    const sentHit = !al.sentiment || p.sentiment === al.sentiment
    const heatHit = p.heat >= al.heat_min
    if (!(kwHit && sentHit && heatHit)) continue
    run('UPDATE alerts SET trigger_count=trigger_count+1 WHERE id=?', al.id)
    const detail = `命中关键词「${al.keyword || '全部'}」· ${al.sentiment ? '情感：' + al.sentiment : '不限情感'} · 热度${p.heat}`
    // 闭环：高等级预警 → 危机事件。同规则存在未结案危机则去重并入，否则自动建档
    let crisisId = null, deduped = false
    if (AUTO_LEVELS.includes(al.level)) {
      const open = q1("SELECT * FROM crisis WHERE alert_id=? AND status!='closed' ORDER BY id DESC LIMIT 1", al.id)
      if (open) {
        crisisId = open.id
        deduped = true
        run('UPDATE crisis SET updated=? WHERE id=?', now(), open.id)
        run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)',
          open.id, '预警再次触发', `${detail} · 关联舆情《${p.title}》`, now())
      } else {
        const r = run('INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          al.title, al.level, 'monitoring', '',
          `由${LV_TEXT[al.level]}预警「${al.title}」自动建档：命中关键词「${al.keyword || '全部'}」，首条关联舆情《${p.title}》（热度${p.heat}）。`,
          now(), now(), '', al.keyword, al.id, 'auto')
        crisisId = Number(r.lastInsertRowid)
        run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)',
          crisisId, '自动建档', `高等级预警触发：${detail}`, now())
      }
    }
    const ev = run('INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved) VALUES (?,?,?,?,?,?,?)',
      al.id, postId, crisisId, detail, now(), 'open', null)
    fired.push({ alert: al.title, alertId: al.id, level: al.level, eventId: Number(ev.lastInsertRowid), crisisId, deduped })
  }
  return fired
}

// 统一录入管线（须在事务内调用）：逐条情感分析 → 入库 → 预警触发 → 危机建档/并入
// 返回该条结果；任一步抛错由外层 withTx 整体回滚
function ingestOneTx(body, idxMsg = '') {
  const item = normalizePost(body, idxMsg)
  const text = item.title + ' ' + item.content
  const a = analyze(text)
  // 热度与负面关键词命中数挂钩，便于稳定演示预警触发
  const negHits = NEG.filter((w) => text.includes(w)).length
  const heat = Math.min(100, 35 + negHits * 12 + Math.round(Math.random() * 12) + (a.sentiment === 'negative' ? 8 : 0))
  const r = run('INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    item.title, item.content, item.source_id, a.sentiment, a.score, heat,
    a.sentiment === 'negative' ? 1 : 0, item.topic, item.media, now(), now())
  const id = Number(r.lastInsertRowid)
  const triggered = checkAlertsTx(id)
  return { id, title: item.title, source_id: item.source_id, topic: item.topic, media: item.media, sentiment: a.sentiment, score: a.score, heat, triggered }
}

// 新增舆情（单条录入，与批量导入共用统一管线；失败回滚，不产生半截数据）
app.post('/api/posts', (req, res, next) => {
  try {
    const result = withTx(() => ingestOneTx(req.body))
    res.json({ ok: true, ...result })
  } catch (e) { next(e) }
})

// 批量导入：逐条分析、统一预警触发与危机建档/并入
// mode=all-or-nothing（默认）：任一条失败整体回滚；mode=partial：跳过失败条目，成功部分提交
app.post('/api/posts/batch', (req, res, next) => {
  try {
    let items = req.body?.items
    if (!Array.isArray(items)) items = Array.isArray(req.body) ? req.body : null
    if (!items) throw new ApiError('请求体需为舆情数组或 { items: [...] }')
    if (!items.length) throw new ApiError('导入列表为空')
    if (items.length > 200) throw new ApiError('单次最多导入 200 条')
    const partial = req.body?.mode === 'partial'

    // partial 模式：先逐条预校验，合法条目在同一事务内提交，非法条目原样回报
    if (partial) {
      const valid = [], invalid = []
      items.forEach((it, i) => {
        try { valid.push(normalizePost(it, `第${i + 1}条 `)) }
        catch (e) { invalid.push({ index: i + 1, title: it?.title || '', error: e.message }) }
      })
      if (!valid.length) {
        return res.json({ ok: false, mode: 'partial', total: items.length, success: 0, failedCount: invalid.length, results: [], failedItems: invalid, triggered: [], crisesCreated: [], crisesMerged: [] })
      }
      const results = withTx(() => valid.map((v) => ingestOneTx(v)))
      return res.json(batchSummary('partial', items.length, results, invalid))
    }

    // 默认整批事务：失败回滚，已写入的舆情/预警/危机全部撤销
    try {
      const results = withTx(() => items.map((it, i) => ingestOneTx(it, `第${i + 1}条 `)))
      res.json(batchSummary('all-or-nothing', items.length, results, []))
    } catch (e) {
      if (e instanceof ApiError) return res.status(422).json({ ok: false, rolledBack: true, error: e.message })
      throw e
    }
  } catch (e) { next(e) }
})

// 汇总批量结果：成功/失败、触发预警、自动建档/并入的危机去重列表
function batchSummary(mode, total, results, invalid) {
  const triggered = [], crisesCreated = [], crisesMergedSet = new Set(), crisesMerged = []
  for (const r of results) {
    for (const t of r.triggered) {
      triggered.push({ postId: r.id, title: r.title, ...t })
      if (t.crisisId && !t.deduped && !crisesCreated.some((c) => c.crisisId === t.crisisId)) {
        crisesCreated.push({ crisisId: t.crisisId, alert: t.alert, level: t.level, title: r.title })
      }
      if (t.deduped && !crisesMergedSet.has(t.crisisId)) {
        crisesMergedSet.add(t.crisisId)
        crisesMerged.push({ crisisId: t.crisisId, alert: t.alert, level: t.level })
      }
    }
  }
  return {
    ok: true, mode,
    total, success: results.length, failedCount: invalid.length,
    results: results.map(({ triggered, ...rest }) => ({ ...rest, triggeredCount: triggered.length })),
    failedItems: invalid,
    triggered, crisesCreated, crisesMerged
  }
}

// ===== 热门词 =====
app.post('/api/hotwords', (req, res) => {
  const { word, weight, sentiment = 'neutral' } = req.body
  run('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)', word, weight, sentiment)
  res.json({ ok: true })
})
app.delete('/api/hotwords/:id', (req, res) => {
  run('DELETE FROM hot_words WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ===== 预警 =====
app.get('/api/alerts', (req, res) => {
  res.json({
    alerts: q('SELECT * FROM alerts ORDER BY id DESC'),
    events: q(`SELECT ae.*, p.title pt, p.heat heat, p.sentiment sent, c.title crisis_title
      FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN crisis c ON c.id=ae.crisis_id
      ORDER BY ae.id DESC LIMIT 60`)
  })
})
app.post('/api/alerts', (req, res) => {
  const { title, level, keyword, sentiment, heat_min } = req.body
  run('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count) VALUES (?,?,?,?,?,1,?,0)',
    title, level, keyword || '', sentiment || '', heat_min || 0, now())
  res.json({ ok: true })
})
app.post('/api/alerts/:id/toggle', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  run('UPDATE alerts SET active=? WHERE id=?', al.active ? 0 : 1, al.id)
  res.json({ ok: true, active: al.active ? 0 : 1 })
})
app.delete('/api/alerts/:id', (req, res) => {
  run('DELETE FROM alerts WHERE id=?', req.params.id)
  run('DELETE FROM alert_events WHERE alert_id=?', req.params.id)
  res.json({ ok: true })
})

// 解除单条触发记录：同步危机时间线，返回该危机剩余未解除数
app.post('/api/alert-events/:id/resolve', (req, res) => {
  const ev = q1('SELECT * FROM alert_events WHERE id=?', req.params.id)
  if (!ev) return res.status(404).json({ error: 'not found' })
  if (ev.status === 'resolved') return res.json({ ok: true, already: true, crisisId: ev.crisis_id })
  const note = (req.body.note || '').trim() || '风险指标回落，预警解除'
  run("UPDATE alert_events SET status='resolved', resolved=? WHERE id=?", now(), ev.id)
  let openLeft = 0
  if (ev.crisis_id) {
    const c = q1('SELECT * FROM crisis WHERE id=?', ev.crisis_id)
    if (c && c.status !== 'closed') {
      run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', c.id, '预警解除', note, now())
      run('UPDATE crisis SET updated=? WHERE id=?', now(), c.id)
    }
    openLeft = q1("SELECT COUNT(*) c FROM alert_events WHERE crisis_id=? AND status='open'", ev.crisis_id).c
  }
  res.json({ ok: true, crisisId: ev.crisis_id, openLeft })
})

// 批量解除某规则全部未解除触发（按危机合并写入时间线）
app.post('/api/alerts/:id/resolve', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const events = q("SELECT * FROM alert_events WHERE alert_id=? AND status='open'", al.id)
  const note = (req.body.note || '').trim() || '风险指标回落，批量解除'
  const byCrisis = {}
  for (const ev of events) {
    run("UPDATE alert_events SET status='resolved', resolved=? WHERE id=?", now(), ev.id)
    if (ev.crisis_id) (byCrisis[ev.crisis_id] ||= []).push(ev)
  }
  for (const [cid, evs] of Object.entries(byCrisis)) {
    const c = q1('SELECT * FROM crisis WHERE id=?', cid)
    if (c && c.status !== 'closed') {
      run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)',
        c.id, '预警解除', `${note}（一并解除 ${evs.length} 条触发记录）`, now())
      run('UPDATE crisis SET updated=? WHERE id=?', now(), c.id)
    }
  }
  res.json({ ok: true, resolved: events.length })
})

// ===== 危机处置 =====
app.get('/api/crisis', (req, res) => {
  res.json(crisisList(true))
})
app.post('/api/crisis', (req, res) => {
  const { title, level, keyword, plan, analysis, linked_email } = req.body
  const r = run("INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,origin) VALUES (?,?,?,?,?,?,?,?,?,'manual')",
    title, level || 'orange', 'monitoring', plan || '', analysis || '', now(), now(), linked_email || '', keyword || '')
  const id = Number(r.lastInsertRowid)
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', id, '事件建档', '人工建档，初始响应', now())
  res.json({ ok: true, id })
})
app.post('/api/crisis/:id/status', (req, res) => {
  const { status, action, note } = req.body
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  run('UPDATE crisis SET status=?, updated=? WHERE id=?', status || c.status, now(), c.id)
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', c.id, action || '状态更新', note || '', now())
  res.json({ ok: true })
})
app.post('/api/crisis/:id/timeline', (req, res) => {
  const { action, note } = req.body
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', req.params.id, action, note || '', now())
  run('UPDATE crisis SET updated=? WHERE id=?', now(), req.params.id)
  res.json({ ok: true })
})

// 回溯：危机档案 + 关联预警触发记录 + 统计
app.get('/api/crisis/:id/review', (req, res) => {
  const c = q1('SELECT c.*, a.title alert_title FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id WHERE c.id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  const timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
  const events = q(`SELECT ae.*, p.title pt, p.heat, p.sentiment sent, a.title alert_title, a.level alert_level
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts a ON a.id=ae.alert_id
    WHERE ae.crisis_id=? ORDER BY ae.id DESC`, c.id)
  const open = events.filter((e) => e.status === 'open').length
  res.json({
    crisis: c, timeline, events,
    stats: {
      triggers: events.length,
      open,
      resolved: events.length - open,
      firstAt: events.length ? events[events.length - 1].time : null,
      lastAt: events.length ? events[0].time : null
    }
  })
})

// 结案：写入回溯总结，级联解除关联的未解除预警，完成闭环
app.post('/api/crisis/:id/close', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status === 'closed') return res.json({ ok: true, already: true })
  const summary = (req.body.summary || '').trim() || '预警解除，舆情回落，完成处置闭环。'
  const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", c.id)
  for (const ev of opens) run("UPDATE alert_events SET status='resolved', resolved=? WHERE id=?", now(), ev.id)
  run("UPDATE crisis SET status='closed', updated=? WHERE id=?", now(), c.id)
  const auto = opens.length ? `（同步解除 ${opens.length} 条未解除预警）` : ''
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', c.id, '事件结案', summary + auto, now())
  res.json({ ok: true, resolved: opens.length })
})
app.delete('/api/crisis/:id', (req, res) => {
  run('DELETE FROM crisis_timeline WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 统一错误处理：ApiError 按其状态码返回，其余视为服务器错误（事务已回滚）
app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status === 500) console.error('[PUBMON]', err)
  res.status(status).json({ ok: false, error: err.message || '服务器错误' })
})

const PORT = 4130
app.listen(PORT, () => console.log(`[PUBMON] API running at http://localhost:${PORT}`))