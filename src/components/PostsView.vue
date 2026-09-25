<template>
  <div class="posts">
    <div class="toolbar">
      <form class="filters" @submit.prevent="load">
        <select v-model="f.sentiment"><option value="all">全部情感</option><option value="positive">正面</option><option value="neutral">中性</option><option value="negative">负面</option></select>
        <select v-model="f.source"><option value="all">全部渠道</option><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <input v-model="f.q" placeholder="搜索关键词…" />
        <button class="btn" type="submit">查询</button>
      </form>
      <div class="entry-tabs">
        <button :class="{ active: showAdd === 'single' }" @click="openEntry('single')">＋ 录入舆情</button>
        <button :class="{ active: showAdd === 'batch' }" @click="openEntry('batch')">📥 批量导入</button>
      </div>
    </div>

    <!-- 单条录入（原有方式，走与批量导入相同的后端管线） -->
    <form v-if="showAdd==='single'" class="add-form" @submit.prevent="submit">
      <input v-model="form.title" placeholder="标题" required />
      <textarea v-model="form.content" placeholder="舆情正文（将自动进行情感分析）" required></textarea>
      <div class="row">
        <select v-model="form.source_id"><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <input v-model="form.topic" placeholder="话题分类" />
        <input v-model="form.media" placeholder="来源媒体，如 澎湃新闻" />
      </div>
      <div class="row">
        <button class="save" type="submit">收录并分析</button>
        <button type="button" class="ghost" @click="showAdd=false">取消</button>
      </div>
    </form>

    <!-- 批量导入：解析 → 逐条预检 → 统一提交（后端逐条分析+预警触发+危机建档/并入，失败回滚） -->
    <div v-if="showAdd==='batch'" class="add-form batch">
      <div class="batch-head">
        <div class="row">
          <select v-model="batchDefault.source_id">
            <option v-for="s in store.sources" :key="s.id" :value="s.id">默认渠道：{{ s.name }}</option>
          </select>
          <input v-model="batchDefault.topic" placeholder="默认话题分类" />
          <input v-model="batchDefault.media" placeholder="默认来源媒体" />
        </div>
        <div class="row">
          <label class="file-btn">选择文件
            <input type="file" accept=".txt,.csv,.json" @change="onFile" hidden />
          </label>
          <button type="button" class="ghost" @click="loadSample">填充示例</button>
          <button type="button" class="ghost" @click="clearBatch">清空</button>
        </div>
      </div>
      <textarea v-model="batchText" class="batch-input" :placeholder="batchHint"></textarea>
      <div class="row parse-row">
        <button type="button" class="save" @click="parseRows">解析并预检</button>
        <span class="fmt-tip">每行一条：<code>标题 | 正文 | 渠道 | 话题 | 媒体</code>（后三项可省略）；也可粘贴 JSON 数组</span>
      </div>

      <!-- 逐条预检结果 -->
      <div v-if="rows.length" class="preview">
        <div class="preview-head">
          <b>逐条预检（{{ rows.length }} 条）</b>
          <span v-if="invalidRows.length" class="pv-err">{{ invalidRows.length }} 条无法识别</span>
          <span v-else class="pv-ok">全部可导入</span>
        </div>
        <div class="pv-scroll">
          <div v-for="(r, i) in rows" :key="i" class="pv-row" :class="{ bad: !r.ok }">
            <span class="pv-idx">{{ i + 1 }}</span>
            <span class="pv-title" :title="r.title">{{ r.title || '（缺少标题）' }}</span>
            <span class="pv-src">{{ srcName(r.source_id) }}</span>
            <span class="pv-topic">#{{ r.topic }}</span>
            <span v-if="r.ok" class="pv-oktxt">待分析</span>
            <span v-else class="pv-errtxt">{{ r.error }}</span>
          </div>
        </div>
        <div class="row submit-row">
          <button class="save" :disabled="submitting || !validRows.length" @click="submitBatch('all-or-nothing')">
            {{ submitting ? '导入中…' : `统一导入 ${validRows.length} 条（失败整批回滚）` }}
          </button>
          <button class="ghost" :disabled="submitting || !validRows.length" @click="submitBatch('partial')">
            跳过异常导入（{{ validRows.length }}/{{ rows.length }}）
          </button>
          <button type="button" class="ghost" :disabled="submitting" @click="showAdd=false">取消</button>
        </div>
      </div>

      <!-- 导入结果：逐条分析 + 预警/危机汇总 -->
      <div v-if="result" class="result" :class="{ rolled: result.rolledBack }">
        <template v-if="result.rolledBack">
          <b class="rs-err">❌ 导入失败，已整批回滚（未写入任何数据）</b>
          <p class="rs-detail">{{ result.error }}</p>
        </template>
        <template v-else>
          <b>导入完成：成功 {{ result.success }} 条<span v-if="result.failedCount">，失败 {{ result.failedCount }} 条</span></b>
          <div v-if="result.triggered?.length" class="rs-block">
            <p class="rs-warn">⚠️ 统一触发预警 {{ result.triggered.length }} 次
              <span v-if="result.crisesCreated.length" class="rs-crisis">· 自动建档 {{ result.crisesCreated.length }} 起</span>
              <span v-if="result.crisesMerged.length">· 并入已有危机 {{ result.crisesMerged.length }} 起</span>
            </p>
            <div class="rs-tags">
              <span v-for="(t, i) in result.triggered" :key="i" class="rs-tag" :class="t.level">
                {{ t.alert }} · 《{{ t.title }}》
                <template v-if="t.deduped">→ 并入 #{{ t.crisisId }}</template>
                <template v-else-if="t.crisisId">→ 建档 #{{ t.crisisId }}</template>
              </span>
            </div>
          </div>
          <div v-else class="rs-block"><span class="rs-ok">未触发预警</span></div>
          <div class="pv-scroll rs-scroll">
            <div v-for="(r, i) in result.results" :key="i" class="pv-row done">
              <span class="pv-idx">{{ i + 1 }}</span>
              <span class="pv-title" :title="r.title">{{ r.title }}</span>
              <span class="chip sent" :class="r.sentiment">{{ sentText(r.sentiment) }}</span>
              <span class="score-mini">{{ (r.score>=0?'+':'')+r.score.toFixed(2) }}</span>
              <span class="heat-mini">热度 {{ r.heat }}</span>
              <span v-if="r.triggeredCount" class="pv-fire">⚠️ {{ r.triggeredCount }}</span>
            </div>
          </div>
          <div v-if="result.failedItems?.length" class="rs-block">
            <p class="rs-err-sm">以下条目未导入：</p>
            <div v-for="(fi, i) in result.failedItems" :key="i" class="pv-row bad">
              <span class="pv-idx">{{ fi.index }}</span><span class="pv-title">{{ fi.title || '（无标题）' }}</span>
              <span class="pv-errtxt">{{ fi.error }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div class="list">
      <div v-for="p in posts" :key="p.id" class="post" :class="p.sentiment">
        <div class="head">
          <span class="chip sent" :class="p.sentiment">{{ sentText(p.sentiment) }}</span>
          <span class="score"><i :style="scoreBar(p.sentiment_score)"></i>{{ (p.sentiment_score>=0?'+':'')+p.sentiment_score.toFixed(2) }}</span>
          <span v-if="p.hot" class="hot">🔥 热点</span>
          <span class="heat">热度 {{ p.heat }}</span>
          <span class="time">{{ p.published }}</span>
        </div>
        <b class="title">{{ p.title }}</b>
        <p class="content">{{ p.content }}</p>
        <div class="meta">
          <span class="src">{{ srcName(p.source_id) }}</span>
          <span class="topic">#{{ p.topic }}</span>
          <span class="media">{{ p.media }}</span>
        </div>
      </div>
      <div v-if="!posts.length" class="none">没有匹配的舆情</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const posts = ref([])
const f = ref({ sentiment: 'all', source: 'all', q: '' })
const showAdd = ref(false)
const form = ref({ title: '', content: '', source_id: null, topic: '', media: '' })

// ===== 批量导入状态 =====
const batchText = ref('')
const batchDefault = ref({ source_id: 1, topic: '', media: '' })
const rows = ref([])
const result = ref(null)
const submitting = ref(false)
const batchHint = '每行一条，格式：标题 | 正文 | 渠道 | 话题 | 媒体（后三项可省略，渠道用名称或序号）；也可直接粘贴 JSON 数组。'

async function load() {
  const qs = {}
  if (f.value.sentiment !== 'all') qs.sentiment = f.value.sentiment
  if (f.value.source !== 'all') qs.source = f.value.source
  if (f.value.q) qs.q = f.value.q
  posts.value = await store.fetchPosts(qs)
}

function openEntry(mode) {
  if (showAdd.value === mode) { showAdd.value = false; return }
  showAdd.value = mode
  result.value = null
  if (mode === 'single' && !form.value.source_id) form.value.source_id = store.sources[0]?.id ?? 1
  if (mode === 'batch' && !batchDefault.value.source_id) batchDefault.value.source_id = store.sources[0]?.id ?? 1
}

async function submit() {
  await store.addPost({ ...form.value, source_id: Number(form.value.source_id || 1) })
  form.value = { title: '', content: '', source_id: null, topic: '', media: '' }
  showAdd.value = false
  await load()
}

// 渠道名 → id（支持名称或数字序号）
function resolveSource(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return batchDefault.value.source_id
  if (/^\d+$/.test(s)) {
    const id = Number(s)
    if (store.sources.some((x) => x.id === id)) return id
  }
  const hit = store.sources.find((x) => x.name === s)
  return hit ? hit.id : batchDefault.value.source_id
}

// 解析输入文本为结构化行（JSON 数组 或 逐行 | 分隔），并逐条做本地预检
function parseRows() {
  result.value = null
  const text = batchText.value.trim()
  if (!text) { rows.value = []; store.msg('请先粘贴或选择要导入的舆情', 'info'); return }
  let parsed = []
  if (text[0] === '[' || text[0] === '{') {
    try {
      const j = JSON.parse(text)
      parsed = Array.isArray(j) ? j : j.items
      if (!Array.isArray(parsed)) throw new Error('JSON 需为数组')
    } catch (e) {
      store.msg('JSON 解析失败：' + e.message, 'warn')
      return
    }
  } else {
    parsed = text.split(/\r?\n/).map((line) => {
      if (!line.trim()) return null
      const parts = line.split('|').map((x) => x.trim())
      return { title: parts[0], content: parts[1], source: parts[2], topic: parts[3], media: parts[4] }
    }).filter(Boolean)
  }
  rows.value = parsed.map((r) => {
    const title = (r.title ?? '').toString().trim()
    const content = (r.content ?? '').toString().trim()
    if (!title) return { ...r, title, ok: false, error: '标题为空' }
    if (!content) return { ...r, title, ok: false, error: '正文为空' }
    return {
      title, content,
      source_id: resolveSource(r.source_id ?? r.source),
      topic: (r.topic ?? '').toString().trim() || batchDefault.value.topic || '新增',
      media: (r.media ?? '').toString().trim() || batchDefault.value.media,
      ok: true
    }
  })
  store.msg(`已解析 ${rows.value.length} 条，可导入 ${rows.value.filter((r) => r.ok).length} 条`, 'info')
}

const validRows = computed(() => rows.value.filter((r) => r.ok))
const invalidRows = computed(() => rows.value.filter((r) => !r.ok))

async function submitBatch(mode) {
  const items = validRows().map(({ ok, error, source, ...rest }) => rest)
  if (!items.length) return
  submitting.value = true
  try {
    // 统一提交：后端逐条情感分析、统一预警触发与危机建档/并入；失败整体回滚
    result.value = await store.addPostsBatch({ items, mode })
    await load()
    if (result.value.rolledBack) store.msg('导入失败，已整批回滚', 'warn')
    else store.msg(`批量导入完成：成功 ${result.value.success} 条`, result.value.failedCount ? 'warn' : 'success')
  } catch (e) {
    result.value = { rolledBack: true, error: e.message }
    store.msg('导入失败，已回滚：' + e.message, 'warn')
  } finally {
    submitting.value = false
  }
}

function onFile(ev) {
  const file = ev.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    batchText.value = String(reader.result || '')
    rows.value = []
    result.value = null
    store.msg(`已载入文件 ${file.name}`, 'info')
  }
  reader.readAsText(file)
  ev.target.value = ''
}

function loadSample() {
  const s = store.sources
  batchText.value = [
    '多家门店被曝后厨卫生问题 消费者投诉集中爆发 | 暗访视频曝光后厨操作不规范，网友纷纷投诉要求彻查，相关话题热度持续攀升。 | 微博 | 食品安全 | 新浪科技',
    '社区便民服务升级获居民点赞 | 新增多个便民窗口与上门服务，居民满意度明显提升，社区回应积极。 | 微信 | 民生 | 本地资讯',
    '某品牌充电桩故障频发引车主不满 | 高峰期多位车主反映充电故障、回应迟缓，吐槽维修等待时间过长。 | 抖音 | 新能源 | 汽车之家',
    ' | 这条缺少标题用于测试回滚 | 知乎'
  ].join('\n')
  rows.value = []
  result.value = null
}

function clearBatch() {
  batchText.value = ''
  rows.value = []
  result.value = null
}

function sentText(x) { return x === 'positive' ? '😊 正面' : x === 'negative' ? '😟 负面' : '😐 中性' }
function scoreBar(score) { const w = Math.min(100, Math.abs(score) * 100); return { width: w + '%', background: score >= 0 ? '#66bb6a' : '#ef5350' } }
function srcName(id) { return store.sources.find((s) => s.id === id)?.name || '未知' }
onMounted(load)
</script>

<style scoped>
.posts{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between;}
.filters{display:flex;gap:8px;flex-wrap:wrap;}
.entry-tabs{display:flex;gap:6px;}
.entry-tabs button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer;}
.entry-tabs button.active{background:linear-gradient(135deg,#43a047,#2e7d32);color:#fff;border-color:transparent;font-weight:600;}
select,input,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:56px;}
.btn{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.add-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.batch{gap:10px;}
.batch-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.add-form .row:last-child{margin-top:4px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.save:disabled{opacity:.5;cursor:not-allowed;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.ghost:disabled{opacity:.5;cursor:not-allowed;}
.file-btn{background:#16263f;border:1px solid rgba(120,160,220,0.2);color:#8ba2c8;border-radius:8px;padding:8px 10px;font-size:12px;cursor:pointer;}
.batch-input{min-height:150px;font-size:12px;line-height:1.7;}
.fmt-tip{font-size:11px;color:#5b6f94;}
.fmt-tip code{background:#0c1730;padding:1px 5px;border-radius:4px;color:#90caf9;}
.parse-row{gap:10px;}
.preview,.result{background:#0c1730;border:1px solid rgba(120,160,220,0.14);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
.result.rolled{border-color:#ef535055;}
.preview-head{display:flex;gap:12px;align-items:center;font-size:12px;}
.pv-ok,.rs-ok{color:#66bb6a;}
.pv-err{color:#ef5350;}
.rs-err{color:#ef5350;font-size:13px;}
.rs-err-sm{color:#ef9a9a;font-size:11px;margin:0;}
.pv-scroll{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:4px;}
.rs-scroll{max-height:240px;}
.pv-row{display:flex;gap:10px;align-items:center;background:#13233f;border-radius:7px;padding:6px 10px;font-size:12px;}
.pv-row.bad{background:#3a1620;}
.pv-row.done{background:#0f1b38;}
.pv-idx{color:#5b6f94;font-size:11px;width:18px;text-align:center;flex-shrink:0;}
.pv-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dbe4f3;}
.pv-src{color:#8ba2c8;font-size:11px;flex-shrink:0;}
.pv-topic{color:#90caf9;font-size:11px;flex-shrink:0;}
.pv-errtxt{color:#ef9a9a;font-size:11px;flex-shrink:0;}
.pv-oktxt{color:#66bb6a;font-size:11px;flex-shrink:0;}
.pv-fire{color:#ffb300;font-size:11px;flex-shrink:0;}
.score-mini{color:#8ba2c8;font-size:11px;width:42px;flex-shrink:0;}
.heat-mini{color:#ffb300;font-size:11px;width:58px;flex-shrink:0;}
.submit-row{margin-top:2px;}
.result b{font-size:13px;}
.rs-block{display:flex;flex-direction:column;gap:6px;}
.rs-warn{color:#ffcc80;font-size:12px;margin:0;}
.rs-crisis{color:#ef9a9a;}
.rs-detail{color:#ef9a9a;font-size:12px;margin:0;}
.rs-tags{display:flex;flex-wrap:wrap;gap:6px;}
.rs-tag{font-size:11px;padding:2px 8px;border-radius:6px;background:#37474f;color:#cfd8dc;}
.rs-tag.red{background:#b71c1c;color:#ffcdd2;}
.rs-tag.orange{background:#e65100;color:#ffe0b2;}
.rs-tag.yellow{background:#f9a825;color:#3e2723;}
.chip{font-size:11px;padding:2px 8px;border-radius:6px;}
.chip.positive{background:#1b5e20;color:#a5d6a7;}.chip.negative{background:#b71c1c;color:#ffcdd2;}.chip.neutral{background:#37474f;color:#b0bec5;}
.list{display:flex;flex-direction:column;gap:12px;}
.post{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;border-left:4px solid #90a4ae;}
.post.negative{border-left-color:#ef5350;}.post.positive{border-left-color:#66bb6a;}.post.neutral{border-left-color:#90a4ae;}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
.score{display:flex;align-items:center;gap:5px;color:#8ba2c8;font-size:11px;}
.score i{height:5px;border-radius:3px;width:40px;background:#0c1730;}
.hot{font-size:10px;color:#ffd54f;}
.heat{font-size:11px;color:#ffb300;}
.time{margin-left:auto;color:#5b6f94;font-size:11px;}
.title{color:#fff;font-size:15px;display:block;margin-bottom:4px;}
.content{color:#aebadd;font-size:13px;line-height:1.5;margin:0 0 8px;}
.meta{display:flex;gap:12px;font-size:11px;color:#8ba2c8;}
.src{font-weight:600;}
.topic{color:#90caf9;}
.media{color:#5b6f94;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>
