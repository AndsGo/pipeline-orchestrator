/* 流水线控制台前端：无框架，hash 路由，所有数据来自 /api。 */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const main = $('#main');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTs = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');
  const fmtAgo = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
  };
  const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

  // markdown：仓库文档由流水线会话生成，仍不让内嵌 html 在控制台源下执行——html 块按文本显示
  if (window.marked) marked.use({ renderer: { html(t) { return esc(typeof t === 'string' ? t : t.text); } } });
  // 阶段工件开头是 --- 包起来的元数据块（ticket/stage/status/inputs…）：剥出来做成一行小字，不让它渲染成一坨粗体
  function splitFrontMatter(s) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s || '');
    if (!m) return { meta: null, body: s || '' };
    const meta = [];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv && kv[2] !== '' && kv[2] !== '[]') meta.push([kv[1], kv[2]]);
    }
    return { meta, body: s.slice(m[0].length) };
  }
  const mdRaw = (s) => (window.marked ? marked.parse(s || '') : `<pre>${esc(s)}</pre>`);
  const md = (s) => {
    const { meta, body } = splitFrontMatter(s);
    const head = meta?.length ? `<p class="meta">${meta.map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('')}</p>` : '';
    return head + mdRaw(body);
  };
  // 日志里是 UTC（…Z），页面其他地方都是本地时间：显示前换成本地，免得同一件事差 8 小时
  const localizeIso = (text) => text.replace(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  });
  // 事件类型的中文名（时间线上不露内部名）
  const EVENT_LABEL = {
    'ticket.created': '建单', triage: '分诊', 'stage.start': '开始', 'stage.end': '完成', 'question.asked': '提问', 'question.answered': '已答',
    'gate.asked': '卡点', 'gate.answered': '已决', 'knowledge.stale': '知识复核', 'human.message': '人的补充', release: '上线', amend: '修正',
    rewind: '回退', pause: '暂停', resume: '继续', halt: '挂起', done: '收尾', error: '出错', 'card.lost': '卡片失效',
  };
  const EVENT_CLASS = { halt: 'bad', error: 'bad', 'gate.asked': 'warn', 'question.asked': 'warn', done: 'info', release: 'good', 'stage.end': 'good' };
  const plain = (s) => String(s ?? '').replace(/\*\*|__|`/g, '');
  const DOC_NAME = {
    '00-intake.md': '需求原文', '05-knowledge-hints.md': '知识提示', '06-glossary.md': '术语', '07-map-hint.md': '系统地图提示', '07-project-profile.md': '项目画像',
    '10-prd.md': 'PRD', '20-plan.md': '实现计划', '25-impl-report.md': '实现报告', '40-acceptance.md': '验收', '90-retro.md': '复盘', '92-suggestions.json': '沉淀建议',
    '93-terms.json': '新术语', '95-delivery.md': '交付文档', '96-knowledge.json': '知识条目', 'ledger.md': '台账', 'feedback.md': '反馈', 'prototype/index.html': '结果预览',
  };
  const docName = (f) => DOC_NAME[f] || (/^30-review-r(\d+)\.md$/.exec(f) ? `评审第 ${/^30-review-r(\d+)/.exec(f)[1]} 轮` : f);

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 401) { location.reload(); throw new Error('未登录'); }
    const type = r.headers.get('content-type') || '';
    const body = type.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error(body?.error || body || `HTTP ${r.status}`);
    return body;
  }
  const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });
  const put = (p, b) => api(p, { method: 'PUT', body: JSON.stringify(b || {}) });

  const stateClass = { 在跑: 'good', 挂起: 'bad', 闭环: 'info', 等人工: 'warn', 已暂停: '' };
  const reqClass = { 梳理中: 'info', 待确认: 'warn', 待排期: 'warn', 已排期: 'good', 已转工单: 'good', 已交付: 'info', 重复: '', 搁置: '', 不做: '' };
  const pill = (s, cls) => `<span class="pill ${cls || ''}">${esc(s)}</span>`;

  // ---------- 总览 ----------
  const ATTN_CLASS = { 挂起: 'bad', 等回答: 'warn', 需求待确认: 'warn', 需求待排期: 'warn', 久未推进: '' };
  function attentionHtml(items) {
    if (!items.length) return '<div class="card muted">没有需要你处理的事。</div>';
    return `<div class="wrap"><table class="fixed"><colgroup><col style="width:7.5rem"><col style="width:6.5rem"><col><col style="width:6.5rem"></colgroup><tbody>
      ${items.map((a) => {
        const href = a.ref.startsWith('REQ-') ? `#/reqs/${a.ref}` : `#/tickets/${a.ref}`;
        return `<tr><td>${pill(a.kind, ATTN_CLASS[a.kind])}</td><td><a href="${href}">${esc(a.ref)}</a></td>
          <td><div>${esc(a.title || '')}</div><div class="muted small">${esc(plain(a.detail).slice(0, 120))}</div></td>
          <td class="muted">${a.since ? fmtAgo(Date.now() - Date.parse(a.since)) : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  let overviewTimer;
  async function overview(refresh = false) {
    const o = await api('/api/overview');
    if (refresh && !$('#ovRoot')) return; // 已离开总览
    const rt = o.runtime;
    const fresh = rt && rt.ageSec < 30;
    const alive = o.daemon.alive;
    const doctorOut = refresh ? $('#doctorOut')?.outerHTML : null;
    const doctorBusy = refresh && $('#doctor')?.disabled;
    const notices = [
      o.stopPending ? '<div class="notice">停止信号已写入，daemon 会在空闲时退出，看门狗随后拉起。</div>' : '',
      o.reloadPending ? '<div class="notice">.env 热重载信号待 daemon 处理（10 秒内）。</div>' : '',
      rt && !fresh && alive ? '<div class="notice">心跳已过期但 pid 仍在：daemon 可能卡住，看看日志。</div>' : '',
    ].join('');
    main.innerHTML = `
      <div id="ovRoot" hidden></div>
      <div class="head"><h1>总览</h1><span class="aside">每 10 秒自动刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span></div>
      ${notices ? `<div class="notices">${notices}</div>` : ''}
      <section class="sec"><h2>运行情况</h2>
      <div class="tiles">
        <div class="tile"><div class="k">daemon</div><div class="v"><span class="dot ${alive ? 'good' : 'bad'}"></span>${alive ? '在线' : '不在线'}</div>
          <div class="s">${rt ? `心跳 ${rt.ageSec} 秒前 · pid ${rt.pid} · 已运行 ${fmtAgo(Date.now() - rt.startedAt).replace('前', '')}` : '无心跳文件（daemon 尚未升级到带心跳的版本，或未启动）'}</div></div>
        <div class="tile"><div class="k">并发闸门</div><div class="v">${rt ? `${rt.concurrency.inUse}/${rt.concurrency.max}` : '–'}</div><div class="s">${rt?.concurrency.waiting ? `排队 ${rt.concurrency.waiting}` : '无排队'}</div></div>
        <div class="tile"><div class="k">在跑工单</div><div class="v">${o.tickets.running}</div><div class="s">${rt?.active.length ? esc(rt.active.join('、')) : '—'}</div></div>
        <div class="tile"><div class="k">待人回答</div><div class="v">${rt ? Object.values(rt.pending).reduce((s, l) => s + l.length, 0) : '–'}</div>
          <div class="s">${rt ? esc(Object.entries(rt.pending).map(([k, v]) => `${k}：${v.join('、')}`).join('；')) || '—' : ''}</div></div>
        <div class="tile"><div class="k">工单</div><div class="v">${o.tickets.total}</div><div class="s">挂起 ${o.tickets.halted} · 闭环 ${o.tickets.closed}</div></div>
        <div class="tile"><div class="k">需求池</div><div class="v">${o.reqs.open}</div><div class="s">进行中 / 共 ${o.reqs.total}</div></div>
        <div class="tile"><div class="k">今日阶段成本</div><div class="v">${money(o.todayCost)}</div><div class="s">${rt?.adhoc.count ? `本次运行临时执行 ${rt.adhoc.count} 次 · ${money(rt.adhoc.cost)}` : '—'}</div></div>
        <div class="tile"><div class="k">上次看门狗重启</div><div class="v">${o.lastRestart ? fmtAgo(o.lastRestart.minutesAgo * 60000) : '无记录'}</div><div class="s">${o.lastRestart ? esc(o.lastRestart.at.replace('T', ' ')) : ''}</div></div>
      </div>
      </section>
      <div class="split wide-left">
        <section class="sec"><h2>需要你处理（${o.attention.length}）</h2>${attentionHtml(o.attention)}</section>
        <section class="sec"><h2>体检</h2>
          <div class="card"><div class="row"><button id="doctor" ${doctorBusy ? 'disabled' : ''}>跑一次体检（零成本，约 20 秒）</button><span class="muted small">依赖、配置、连通性；不输出凭据值</span></div>${doctorOut || '<pre id="doctorOut" class="log short" hidden style="margin-top:.8rem"></pre>'}</div>
        </section>
      </div>`;
    $('#doctor').onclick = async (e) => {
      e.target.disabled = true;
      const out = () => $('#doctorOut'); // 自动刷新会重建 DOM，每次现取
      out().hidden = false;
      out().textContent = '运行中…';
      try {
        const r = await post('/api/doctor');
        out().textContent = r.lines.filter((l) => !/^\[(info|error)\]/.test(l)).join('\n') + `\n\n退出码 ${r.code}`;
      } catch (err) { out().textContent = `失败：${err.message}`; }
      if ($('#doctor')) $('#doctor').disabled = false;
    };
    if (!refresh) {
      clearInterval(overviewTimer);
      overviewTimer = setInterval(() => overview(true).catch(() => {}), 10_000);
      window.addEventListener('hashchange', () => clearInterval(overviewTimer), { once: true });
    }
  }

  // ---------- 任务 ----------
  // 需处理的排前面：挂起 → 等人工 → 已暂停 → 在跑 → 闭环；同档内最近有动静的在前
  const STATE_RANK = { 挂起: 0, 等人工: 1, 已暂停: 2, 在跑: 3, 闭环: 4 };
  const pref = {
    get(k, d) { try { const v = localStorage.getItem(`console.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`console.${k}`, JSON.stringify(v)); } catch { /* 无痕模式 */ } },
  };
  async function tickets() {
    const all = await api('/api/tickets');
    const showClosed = pref.get('showClosed', false);
    const rows = all.filter((r) => showClosed || r.state !== '闭环')
      .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (b.lastAt || '').localeCompare(a.lastAt || ''));
    const closedN = all.filter((r) => r.state === '闭环').length;
    const groups = new Map();
    for (const r of rows) groups.set(r.project || '未归属', [...(groups.get(r.project || '未归属') || []), r]);
    const table = (list) => `<div class="wrap"><table class="fixed"><colgroup><col style="width:6rem"><col><col style="width:7rem"><col style="width:6rem"><col style="width:6rem"><col style="width:6.5rem"></colgroup>
      <thead><tr><th>工单</th><th>需求 / 最近</th><th>阶段</th><th>状态</th><th class="num">成本</th><th>动静</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><a href="#/tickets/${esc(r.ticket)}">${esc(r.ticket)}</a></td>
        <td><div class="clip">${esc(r.title || '')}</div><div class="muted small clip">${esc(plain(r.waiting || ''))}</div></td>
        <td>${esc(r.stage)}</td><td>${pill(r.state, stateClass[r.state])}</td><td class="num">${money(r.cost)}</td>
        <td class="muted">${r.lastAt ? fmtAgo(Date.now() - Date.parse(r.lastAt)) : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
    main.innerHTML = `<div class="head"><h1>任务</h1>
        <label class="row small" style="gap:.4rem"><input type="checkbox" id="showClosed" style="width:auto" ${showClosed ? 'checked' : ''}>显示已闭环（${closedN}）</label></div>` +
      (rows.length ? [...groups.entries()].map(([p, list]) => `<section class="sec"><h2>${esc(p)}（${list.length}）</h2>${table(list)}</section>`).join('') : `<p class="muted">${all.length ? '没有未闭环的工单。' : '暂无工单'}</p>`);
    $('#showClosed').onchange = (e) => { pref.set('showClosed', e.target.checked); tickets(); };
  }

  async function ticket(id) {
    const d = await api(`/api/tickets/${encodeURIComponent(id)}`);
    const st = d.snapshot;
    const state = d.state;
    const closed = state === '闭环';
    // 预览与控制台同在 web 服务里，同源相对链接即可
    const docLink = (f) => f === 'prototype/index.html'
      ? `<a href="/preview/${esc(id)}/" target="_blank" rel="noopener">${esc(docName(f))} ↗</a>`
      : `<a href="#/docs/${esc(st?.project || '')}/${esc(id)}/${esc(f)}" title="${esc(f)}">${esc(docName(f))}</a>`;
    const notices = [
      st?.haltedReason ? `<div class="notice bad">挂起：${esc(st.haltedReason)}</div>` : '',
      st?.pendingGate ? `<div class="notice">待答卡点 ${esc(st.pendingGate.gate)}：${esc(plain(st.pendingGate.summary))}</div>` : '',
      d.pending.length ? `<div class="notice">等回答：${esc(d.pending.join('、'))}</div>` : '',
    ].join('');
    main.innerHTML = `
      <div class="head"><h1>${esc(id)} ${pill(state, stateClass[state])}</h1><a class="aside" href="#/tickets">← 任务列表</a></div>
      ${d.title ? `<p class="lead">${esc(d.title)}</p>` : ''}
      <div class="split">
        <div class="stack">
          <section class="sec"><h2>各阶段会话（${st?.runs.length || 0}）</h2>
            <div class="wrap"><table><thead><tr><th>时间</th><th>阶段</th><th>模型</th><th class="num">轮数</th><th class="num">成本</th><th>结果</th><th>参数</th></tr></thead><tbody>
            ${(st?.runs || []).map((r) => `<tr><td class="muted">${fmtTs(r.startedAt)}</td><td>${esc(r.stage)}</td><td>${esc(r.model || '')}</td><td class="num">${r.turns}</td><td class="num">${money(r.costUsd)}</td><td>${esc(r.status)}${r.verdict ? ` · ${esc(r.verdict)}` : ''}</td><td class="mono">${esc(r.extraArgs || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">尚无</td></tr>'}
            </tbody></table></div>
          </section>
          <section class="sec"><h2>时间线（${d.events.length}）</h2>
            <ul class="timeline">${d.events.slice().reverse().map((e) => `<li><span class="ts">${fmtTs(e.ts).slice(5)}</span><span>${pill(EVENT_LABEL[e.type] || e.type, EVENT_CLASS[e.type])} ${esc(plain(e.summary))}</span></li>`).join('')}</ul>
          </section>
        </div>
        <aside class="stack">
          ${notices ? `<div class="notices">${notices}</div>` : ''}
          ${closed ? '' : `<div class="card stack" style="gap:.75rem">
            <div class="actions"><button id="resume" class="primary">继续</button><button id="pause">暂停（阶段边界停住）</button></div>
            <span class="muted small">${st?.haltedReason ? '挂起通常需要人先拍板（如评审仲裁）。点继续会清掉挂起标记并由 daemon 重新接手，结果发到群里。' : '由 daemon 接手并在群里回话；卡点卡原样重发，问题卡重新提问。'}</span>
          </div>`}
          <div class="tiles two">
            <div class="tile"><div class="k">项目</div><div class="v">${esc(st?.project || '?')}</div><div class="s">${esc(st?.lane === 'fast' ? '快车道' : '全流水线')}</div></div>
            <div class="tile"><div class="k">${closed ? '最后阶段' : '下一阶段'}</div><div class="v">${esc(st?.cursor || '?')}</div><div class="s">${st?.pendingReverify ? `修完回到 ${esc(st.pendingReverify)} 复验` : ''}</div></div>
            <div class="tile"><div class="k">累计成本</div><div class="v">${money(d.cost)}</div><div class="s">${st?.runs.length || 0} 次会话</div></div>
            <div class="tile"><div class="k">修复轮</div><div class="v">${st ? st.reviewFixRounds + st.acceptanceFixRounds : '–'}</div><div class="s">${st ? `评审打回 ${st.reviewFixRounds} 次 · 验收打回 ${st.acceptanceFixRounds} 次` : ''}</div></div>
          </div>
          <div class="tile"><div class="k">分支</div><div class="mono" style="margin-top:.2rem;overflow-wrap:anywhere">${esc(st?.branch || '—')}</div><div class="s">${st?.isWorktree ? 'worktree' : ''}</div></div>
          <section class="sec"><h2>文档（${d.docs.length}）</h2>
            <div class="card"><p class="doclinks">${d.docs.length ? d.docs.map(docLink).join('') : '<span class="muted">无工件目录</span>'}</p>
            ${d.docsFromBranch ? `<p class="muted small" style="margin:.6rem 0 0">部分文档只在分支 <code>${esc(d.docsFromBranch)}</code> 上，已从分支读取。</p>` : ''}</div>
          </section>
        </aside>
      </div>`;
    if (closed) return;
    $('#pause').onclick = async () => { try { const r = await post(`/api/tickets/${encodeURIComponent(id)}/pause`); toast(r.note); ticket(id); } catch (e) { toast(e.message, true); } };
    $('#resume').onclick = async () => {
      if (st?.haltedReason && !confirm(`${id} 挂起原因：${st.haltedReason}\n\n确定已处理，让 daemon 继续？`)) return;
      try { const r = await post(`/api/tickets/${encodeURIComponent(id)}/resume`); toast(r.note); } catch (e) { toast(e.message, true); }
    };
  }

  // ---------- 需求 ----------
  async function reqs() {
    const list = await api('/api/reqs');
    main.innerHTML = `<div class="head"><h1>需求池</h1><span class="aside">共 ${list.length} 条</span></div>` + (list.length ? `<div class="wrap"><table><thead><tr><th>需求</th><th>项目</th><th>标题</th><th>状态</th><th>拆分</th><th>工单</th><th>更新</th></tr></thead><tbody>
      ${list.slice().reverse().map((r) => `<tr><td><a href="#/reqs/${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(r.project)}</td><td>${esc(r.title)}</td><td>${pill(r.status, reqClass[r.status])}</td>
        <td>${r.splits?.length || ''}</td><td>${(r.tickets || []).map((t) => `<a href="#/tickets/${esc(t)}">${esc(t)}</a>`).join(' ')}</td><td class="muted">${fmtAgo(Date.now() - Date.parse(r.updatedAt))}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card" style="max-width:60rem">
        <h3>还没有需求</h3>
        <p>在群里说「我想提个需求…」或发 <code>/req 一句话</code>，机器人会在话题里和你梳理清楚，产出《需求说明》。</p>
        <p class="muted small">流转：梳理中 → 待确认（提出人确认说明）→ 待排期（负责人排期）→ 已排期 → 已转工单 → 已交付；也可能被标为重复、搁置或不做。</p>
      </div>`);
  }

  async function req(id) {
    const r = await api(`/api/reqs/${encodeURIComponent(id)}`);
    main.innerHTML = `
      <div class="head"><h1>${esc(r.id)} ${pill(r.status, reqClass[r.status])}</h1><a class="aside" href="#/reqs">← 需求池</a></div>
      <p class="lead">${esc(r.title)}</p>
      <div class="split">
        <div class="stack">
          <section class="sec"><h2>需求说明</h2>
            <div class="card doc">${r.brief ? md(r.brief) : '<span class="muted">访谈尚未产出《需求说明》</span>'}</div>
          </section>
          <section class="sec"><h2>提出人原话</h2>
            <div class="card"><pre>${esc(r.raw)}</pre></div>
          </section>
        </div>
        <aside class="stack">
          ${r.note || r.dupOf ? `<div class="notices">${r.note ? `<div class="notice">${esc(r.note)}</div>` : ''}${r.dupOf ? `<div class="notice">并入 <a href="#/reqs/${esc(r.dupOf)}">${esc(r.dupOf)}</a></div>` : ''}</div>` : ''}
          <div class="tiles two">
            <div class="tile"><div class="k">项目</div><div class="v">${esc(r.project)}</div></div>
            <div class="tile"><div class="k">访谈轮次</div><div class="v">${r.rounds}</div></div>
            <div class="tile"><div class="k">关联工单</div><div class="v">${r.tickets.length}</div><div class="s">${r.tickets.map((t) => `<a href="#/tickets/${esc(t)}">${esc(t)}</a>`).join(' ')}${r.delivered?.length ? ` · 已交付 ${r.delivered.length}` : ''}</div></div>
            <div class="tile"><div class="k">创建</div><div class="v" style="font-size:1rem">${fmtTs(r.createdAt)}</div><div class="s">更新 ${fmtTs(r.updatedAt)}${r.scheduledAt ? ` · 排期 ${fmtTs(r.scheduledAt)}` : ''}</div></div>
          </div>
          ${r.splits?.length ? `<section class="sec"><h2>建议拆分（${r.splits.length}）</h2><div class="card"><ol style="margin:0;padding-left:1.2rem">${r.splits.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div></section>` : ''}
          <p class="muted small mono" style="overflow-wrap:anywhere">提出人 ${esc(r.requester)}<br>群 ${esc(r.chatId)}<br>话题 ${esc(r.rootId)}</p>
        </aside>
      </div>`;
  }

  // ---------- 文档 ----------
  async function docs(alias, ticket, file) {
    const projects = await api('/api/docs');
    if (!alias && projects.length) alias = projects[0].alias;
    const pr = projects.find((p) => p.alias === alias);
    const ticketFiles = pr && ticket ? (await api(`/api/docs/${encodeURIComponent(alias)}/tickets/${encodeURIComponent(ticket)}`)).files : [];
    const items = pr ? [
      { h: '项目' }, ...pr.files.map((f) => ({ rel: f, label: f })),
      { h: '工单' }, ...pr.tickets.slice().reverse().map((t) => ({ t, label: t })),
    ] : [];
    main.innerHTML = `<div class="head"><h1>文档</h1>
        <div class="row"><select id="proj" style="width:auto">${projects.map((p) => `<option value="${esc(p.alias)}" ${p.alias === alias ? 'selected' : ''}>${esc(p.alias)}（${esc(p.prefix)}-）</option>`).join('')}</select>
        <span class="muted mono small">${esc(pr?.repo || '')}/docs/pipeline</span></div></div>
      <div class="docs with-toc"><ul class="list" id="tree">${items.map((i) => i.h ? `<li class="h">${i.h}</li>` : i.t
        ? `<li data-t="${esc(i.t)}" class="${i.t === ticket ? 'on' : ''}">${esc(i.label)}</li>` + (i.t === ticket ? ticketFiles.map((f) => `<li data-f="${esc(f)}" class="${f === file ? 'on' : ''}" style="padding-left:1.8rem" title="${esc(f)}">${esc(docName(f))}</li>`).join('') : '')
        : `<li data-f="${esc(i.rel)}" class="${!ticket && i.rel === file ? 'on' : ''}">${esc(i.label)}</li>`).join('')}</ul>
      <div id="docBody" class="card doc"><span class="muted">从左边选一个文件：项目级文档，或展开某个工单看它的 PRD、计划、评审……</span></div>
      <nav class="toc" id="toc"></nav></div>`;
    $('#proj').onchange = (e) => (location.hash = `#/docs/${e.target.value}`);
    $('#tree').onclick = (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      if (li.dataset.t) location.hash = `#/docs/${alias}/${li.dataset.t}`;
      else if (li.dataset.f === 'prototype/index.html' && ticket) {
        // 原型是可交互的 html：不在控制台源下渲染，交给 webhook 服务的预览路由
        window.open(`/preview/${encodeURIComponent(ticket)}/`, '_blank', 'noopener');
      } else if (li.dataset.f) location.hash = ticket ? `#/docs/${alias}/${ticket}/${li.dataset.f}` : `#/docs/${alias}/-/${li.dataset.f}`;
    };
    if (file && pr) {
      const rel = ticket ? `${ticket}/${file}` : file;
      const body = $('#docBody');
      body.innerHTML = '<span class="muted">加载中…</span>';
      try {
        const r = await fetch(`/api/docs/${encodeURIComponent(alias)}/file?path=${encodeURIComponent(rel)}`);
        if (!r.ok) throw new Error((await r.json()).error);
        const txt = await r.text();
        body.innerHTML = `<p class="muted mono">${esc(rel)}</p>` + (/\.md$/i.test(rel) ? md(txt) : `<pre>${esc(txt)}</pre>`);
        // 本文目录：长文档（PRD、计划动辄几百行）靠它跳转；hash 已被路由占用，用 scrollIntoView
        const heads = [...body.querySelectorAll('h1, h2, h3')];
        $('#toc').innerHTML = heads.length > 2 ? `<h2>本文目录</h2>${heads.map((h, i) => `<a href="javascript:void 0" data-i="${i}" class="${h.tagName === 'H3' ? 'l3' : ''}">${esc(h.textContent)}</a>`).join('')}` : '';
        $('#toc').onclick = (e) => { const i = e.target.dataset?.i; if (i !== undefined) heads[i].scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      } catch (err) { body.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    }
  }

  // ---------- 日志 ----------
  async function logs(file = 'daemon') {
    main.innerHTML = `<div class="head"><h1>日志</h1><span class="aside" id="lt"></span></div>
      <div class="row">
        <select id="lf" style="width:auto">${[['daemon', 'daemon（机器人与流水线）'], ['web', 'web（评审 / 预览 / 控制台）'], ['watchdog', '看门狗']].map(([f, l]) => `<option value="${f}" ${f === file ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="lq" placeholder="过滤（正则，不分大小写），回车生效" style="flex:1;min-width:16rem;max-width:40rem">
        <select id="ln" style="width:auto"><option value="200">最近 200 行</option><option value="500">最近 500 行</option><option value="1000">最近 1000 行</option></select>
        <button id="lr">刷新</button><label class="row small" style="gap:.3rem"><input type="checkbox" id="la" style="width:auto">每 10 秒自动刷新</label>
      </div>
      <div class="log" id="lo"></div>`;
    let timer;
    const load = async () => {
      const q = $('#lq').value.trim();
      const r = await api(`/api/logs?file=${$('#lf').value}&lines=${$('#ln').value}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      $('#lo').textContent = localizeIso(r.lines.join('\n')) || '（空）';
      $('#lt').textContent = `共 ${r.total} 行，显示 ${r.lines.length} 行`;
      $('#lo').scrollTop = $('#lo').scrollHeight;
    };
    $('#lr').onclick = load;
    $('#lf').onchange = load;
    $('#lq').onkeydown = (e) => e.key === 'Enter' && load();
    $('#la').onchange = (e) => { clearInterval(timer); if (e.target.checked) timer = setInterval(load, 10000); };
    window.addEventListener('hashchange', () => clearInterval(timer), { once: true });
    load();
  }

  // ---------- 环境配置 ----------
  async function env() {
    const v = await api('/api/env');
    const restartNote = (k) => k.restart ? `<span class="flag">改后需重启 ${esc(k.restart)}</span>` : '';
    main.innerHTML = `<div class="head"><h1>环境配置</h1></div>
      <p class="lead">凭据只显示是否已配置；填了才会改，留空即不动。非凭据键改后 daemon 10 秒内热生效，标了「需重启」的要去「重启」页。</p>
      <form id="envForm" class="stack">
        <div class="cards masonry">${v.groups.map((g) => `<section class="card"><h2>${esc(g.name)}</h2><div class="form">${g.keys.map((k) => k.key === 'PIPELINE_PROJECTS'
          // 项目表只在「项目配置」页改：两个入口同时能改同一行，迟早互相覆盖
          ? `<label>${esc(k.key)}</label><input class="mono" value="${esc(k.value)}" readonly tabindex="-1" style="opacity:.7">
             <div class="desc">只读。去 <a href="#/projects">项目配置</a> 改</div>`
          : `
          <label for="k_${esc(k.key)}">${esc(k.key)}${k.secret ? '<span class="flag secret">凭据</span>' : ''}${restartNote(k)}</label>
          <input id="k_${esc(k.key)}" name="${esc(k.key)}" class="mono" ${k.secret ? `type="password" placeholder="${k.set ? `已配置（${k.length} 位），留空不改` : '未配置'}" autocomplete="new-password"` : `value="${esc(k.value)}" data-orig="${esc(k.value)}"`}>
          <div class="desc">${esc(k.desc)}</div>`).join('')}</div></section>`).join('')}</div>
        <div class="savebar"><button class="primary" id="envSave">保存并热重载</button><span class="muted small" id="envMsg">没有改动</span></div>
      </form>`;
    $('#envForm').oninput = () => {
      const n = [...$('#envForm').querySelectorAll('input[name]')].filter((i) => (i.type === 'password' ? i.value : i.value !== i.dataset.orig)).length;
      $('#envMsg').textContent = n ? `已改 ${n} 项，未保存` : '没有改动';
    };
    $('#envForm').onsubmit = async (e) => {
      e.preventDefault();
      const changes = {};
      for (const inp of e.target.querySelectorAll('input[name]')) {
        if (inp.type === 'password') { if (inp.value) changes[inp.name] = inp.value; }
        else if (inp.value !== inp.dataset.orig) changes[inp.name] = inp.value;
      }
      if (!Object.keys(changes).length) return toast('没有改动');
      try {
        const r = await put('/api/env', { mtime: v.mtime, changes });
        toast(`已保存 ${Object.keys(changes).length} 项${r.needsRestart.length ? `；需重启：${r.needsRestart.join('、')}` : '，daemon 10 秒内生效'}`);
        env();
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---------- 项目配置 ----------
  const PFIELDS = [['alias', '别名', '字母开头，字母数字-'], ['prefix', '工单号前缀', '1-6 个字母'], ['repo', '本地仓库路径', '正斜杠'], ['gitlab', 'GitLab 路径', 'group/name'], ['jenkins', 'Jenkins 任务', 'folder/job'],
    ['wikiArchive', 'Wiki 归档节点', ''], ['wikiKnowledge', 'Wiki 系统地图节点', ''], ['chatId', '绑定群 chat_id', 'oc_…'], ['owner', '负责人', 'ou_…（排期卡只认他）']];
  async function projects() {
    const [v, people] = await Promise.all([api('/api/projects'), api('/api/people').catch(() => ({ people: [], note: '候选人读取失败' }))]);
    const list = v.projects.map((p) => ({ ...p }));
    const personLabel = (p) => `${p.name || '（未知姓名）'}${p.messages ? ` · 最近 @机器人 ${p.messages} 次${p.lastAt ? `，${fmtAgo(Date.now() - Date.parse(p.lastAt))}` : ''}` : ''}`;
    const byId = new Map(people.people.map((p) => [p.openId, p]));
    const field = (p, i, [k, label, hint]) => {
      const input = `<input class="mono" data-i="${i}" data-k="${k}" value="${esc(p[k] || '')}" placeholder="${esc(hint)}"${k === 'owner' ? ' list="peopleList" autocomplete="off"' : ''}>`;
      if (k !== 'owner') return `<label>${esc(label)}</label>${input}`;
      const who = p.owner && byId.get(p.owner);
      return `<label>${esc(label)}</label>${input}<div class="desc">${who ? esc(personLabel(who)) : p.owner ? '不在候选人里（手填的 open_id）' : '未设：排期卡谁都可以点。点输入框从候选人里选。'}</div>`;
    };
    const render = () => {
      main.innerHTML = `<div class="head"><h1>项目配置</h1><span class="aside">${list.length} 个项目</span></div>
        <p class="lead">保存 = 备份 .env、改写 PIPELINE_PROJECTS 一行、daemon 10 秒内原地替换项目表（与群里 /bind、/addproject 同一条路）。</p>
        ${people.note ? `<div class="notice small">${esc(people.note)}。开通方法：飞书开放平台 → 本应用 → 权限管理 → 搜 im:chat.members:read → 开通并发布版本。</div>` : ''}
        <datalist id="peopleList">${people.people.map((p) => `<option value="${esc(p.openId)}">${esc(personLabel(p))}</option>`).join('')}</datalist>
        <form id="pf" class="stack">
          <div class="cards">${list.map((p, i) => `<section class="card">
            <div class="row between" style="margin-bottom:.9rem"><h3 class="cardtitle" style="margin:0">${esc(p.alias || '新项目')}${p.prefix ? ` <span class="muted small">${esc(p.prefix)}-</span>` : ''}</h3>
              <button type="button" class="danger small" data-del="${i}">移除</button></div>
            <div class="form">${PFIELDS.map((f) => field(p, i, f)).join('')}</div></section>`).join('')}</div>
          <div class="savebar"><button class="primary">保存并热重载</button><button type="button" id="padd">添加项目</button></div>
        </form>`;
      $('#pf').oninput = (e) => { const { i, k } = e.target.dataset; if (i !== undefined) list[i][k] = e.target.value; };
      $('#pf').onclick = (e) => { const d = e.target.dataset.del; if (d !== undefined && confirm(`移除项目 ${list[d].alias || '(未命名)'}？`)) { list.splice(d, 1); render(); } };
      $('#padd').onclick = () => { list.push({ alias: '', prefix: '', repo: '' }); render(); };
      $('#pf').onsubmit = async (e) => {
        e.preventDefault();
        try { await put('/api/projects', { mtime: v.mtime, projects: list }); toast('项目表已保存，daemon 10 秒内生效'); projects(); }
        catch (err) { toast(err.message, true); }
      };
    };
    render();
  }

  // ---------- 阶段参数 ----------
  async function stages() {
    const s = await api('/api/stages');
    main.innerHTML = `<div class="head"><h1>阶段参数</h1><span class="aside">只读</span></div>
      <p class="lead">这些数字在 src/config.ts 里，每个都附着实测校准依据，改动走代码评审。推理档位统一钉在 <b>${esc(s.effort)}</b>；同一来源打回 implement 上限 ${s.fixRoundCap} 轮；implement 自动续跑上限 ${s.autoContinueCap} 批。</p>
      <div class="wrap"><table><thead><tr><th>阶段</th><th>模型</th><th class="num">轮数上限</th><th class="num">预算</th><th>工具</th></tr></thead><tbody>
      ${s.stages.map((x) => `<tr><td>${esc(x.stage)}</td><td>${esc(x.model)}</td><td class="num">${x.maxTurns}</td><td class="num">${money(x.budgetUsd)}</td><td class="mono">${esc(x.tools)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ---------- 重启 ----------
  async function restart() {
    const o = await api('/api/overview');
    const rt = o.runtime;
    const throttled = o.lastRestart && o.lastRestart.minutesAgo < 10;
    main.innerHTML = `<div class="head"><h1>重启</h1></div>
      <div class="split even">
      <section class="sec"><h2>daemon（飞书机器人与流水线）</h2>
      <div class="card">
        <p>重启 = 写入 <code>data/daemon.stop</code>。daemon 每 10 秒看一眼：<b>没有阶段会话在执行</b>时自行退出（有卡片等人最多再等 5 分钟），看门狗 2 分钟内以最新代码拉起。</p>
        <ul>
          <li>当前在跑会话：<b>${rt ? rt.concurrency.inUse : '?'}</b>${rt?.active.length ? `（${esc(rt.active.join('、'))}）` : ''}${rt?.concurrency.inUse ? ' — 会等它们结束再退' : ''}</li>
          <li>待答卡片：<b>${rt ? Object.values(rt.pending).reduce((s, l) => s + l.length, 0) : '?'}</b>${rt && Object.keys(rt.pending).length ? ' — 重启后这些卡失效，daemon 启动时会在群里提示' : ''}</li>
          <li>上次看门狗 RESTART：${o.lastRestart ? `${esc(o.lastRestart.at.replace('T', ' '))}（${o.lastRestart.minutesAgo} 分钟前）` : '无记录'}${throttled ? ' — <b>不足 10 分钟，看门狗会跳过拉起</b>，请稍等' : ''}</li>
          <li>空窗约 2 分钟：这期间群里的消息会丢；看门狗只在有人登录本机时运行。</li>
        </ul>
        ${o.stopPending ? '<div class="notice">停止信号已在，等 daemon 退出。</div>' : ''}
        <div class="actions"><button class="danger" id="doRestart" ${o.stopPending ? 'disabled' : ''}>重启 daemon</button></div>
        <h3 class="small muted" style="margin:1rem 0 .3rem">进度</h3><div class="log short" id="rlog">（点了之后这里每 5 秒刷新：心跳消失 → 看门狗 RESTART → 心跳恢复）</div>
      </div>
      </section>
      <section class="sec"><h2>web 服务（本控制台 + GitLab 评审 + 结果预览）</h2>
      <div class="card">
        <p>改了标着「需重启 web」的配置（如 GitLab 触发词、端口、控制台口令）后用这个。web 服务 5 秒内退出（有 MR 评审在跑会等它跑完），看门狗 2 分钟内拉起。</p>
        <p class="muted">这个页面本身会断开，重新拉起后要重新输一次口令。</p>
        <div class="actions"><button class="danger" id="doRestartWeb">重启 web 服务</button></div>
      </div>
      </section>
      </div>`;
    let timer;
    const watch = async () => {
      const x = await api('/api/overview');
      const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  daemon ${x.daemon.alive ? '在线' : '不在线'}${x.runtime ? `（心跳 ${x.runtime.ageSec}s 前，pid ${x.runtime.pid}）` : ''}${x.stopPending ? '，停止信号待处理' : ''}${x.lastRestart ? `，上次 RESTART ${x.lastRestart.minutesAgo} 分钟前` : ''}`;
      $('#rlog').textContent += `\n${line}`;
    };
    $('#doRestart').onclick = async (e) => {
      if (!confirm('确定重启 daemon？空闲时才会退出，空窗约 2 分钟。')) return;
      e.target.disabled = true;
      try { await post('/api/restart'); toast('已发出重启'); $('#rlog').textContent = '已写入停止信号'; timer = setInterval(watch, 5000); } catch (err) { toast(err.message, true); }
    };
    $('#doRestartWeb').onclick = async (e) => {
      if (!confirm('确定重启 web 服务？本页面会断开约 2 分钟。')) return;
      e.target.disabled = true;
      try { await post('/api/restart-web'); toast('web 服务即将重启，约 2 分钟后刷新本页'); } catch (err) { toast(err.message, true); }
    };
    window.addEventListener('hashchange', () => clearInterval(timer), { once: true });
  }

  // ---------- 路由 ----------
  const routes = [
    [/^$/, overview], [/^tickets$/, tickets], [/^tickets\/([^/]+)$/, ticket], [/^reqs$/, reqs], [/^reqs\/([^/]+)$/, req],
    [/^docs(?:\/([^/]+)(?:\/([^/]+)(?:\/(.+))?)?)?$/, (a, t, f) => docs(a, t === '-' ? undefined : t, f)],
    [/^logs$/, logs], [/^env$/, env], [/^projects$/, projects], [/^stages$/, stages], [/^restart$/, restart],
  ];
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const top = h.split('/')[0];
    for (const a of document.querySelectorAll('.side a')) a.classList.toggle('on', a.dataset.route === top);
    for (const [re, fn] of routes) {
      const m = re.exec(h);
      if (m) {
        try { await fn(...m.slice(1).map((x) => (x ? decodeURIComponent(x) : x))); } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
        return;
      }
    }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', route);
  $('#logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.reload(); };
  route();
})();
