'use strict';

const MAX_TRANSLATIONS = 4;

const baselineEl = document.getElementById('baseline');
const translationsEl = document.getElementById('translations');
const addBtn = document.getElementById('add-translation');
const exampleBtn = document.getElementById('load-example');
const runBtn = document.getElementById('run');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const filterEl = document.getElementById('type-filter');
const tbody = document.querySelector('#findings tbody');
const noFindingsEl = document.getElementById('no-findings');
const filteredEmptyEl = document.getElementById('filtered-empty');

let typeLabels = {}; // 由服务端返回，未知类型兜底为原始代码
let allFindings = [];

/* ---------- 译文输入块管理 ---------- */

function translationsCount() {
  return translationsEl.querySelectorAll('.translation-block').length;
}

function refreshButtons() {
  addBtn.disabled = translationsCount() >= MAX_TRANSLATIONS;
  translationsEl.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.disabled = translationsCount() <= 1;
  });
}

function addTranslation(lang = '', messages = '') {
  if (translationsCount() >= MAX_TRANSLATIONS) return;
  const block = document.createElement('div');
  block.className = 'translation-block';

  const row = document.createElement('div');
  row.className = 'row';

  const label = document.createElement('label');
  label.textContent = '语言代码：';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lang-input';
  input.placeholder = '如 zh-CN、ja、fr';
  input.value = lang;
  label.appendChild(input);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-btn';
  remove.textContent = '移除';
  remove.addEventListener('click', () => {
    block.remove();
    refreshButtons();
  });

  row.append(label, remove);

  const textarea = document.createElement('textarea');
  textarea.rows = 7;
  textarea.spellcheck = false;
  textarea.placeholder = '{"app.title":"…"}';
  textarea.value = messages;

  block.append(row, textarea);
  translationsEl.appendChild(block);
  refreshButtons();
}

addBtn.addEventListener('click', () => addTranslation());

/* ---------- 示例数据 ---------- */

const EXAMPLE = {
  baseline: {
    'app.title': '消息审计台',
    'user.greeting': '{gender, select, female{她} male{他} other{TA}} 向你问好，{name}！',
    'inbox.summary': '{name}，你有 {count, plural, =0{没有新消息} one{1 条新消息} other{# 条新消息}}。',
    'meeting.time': '会议时间：{start, date, medium} {start, time, short}',
    'rank.label': '你是第 {rank, selectordinal, one{# 名} other{# 名}}',
    'invite.text': '邀请 {count, plural, one{# 人} other{# 人}}',
    'quota.used': '已用 {used, number, percent}',
  },
  translations: [
    {
      lang: 'zh-TW',
      messages: {
        'app.title': '訊息審計台',
        'user.greeting': '{gender, select, female{她} male{他} other{TA}} 向你問好！',
        'inbox.summary': '{name}，你有 {count, plural, one{1 條新消息} other{# 條新消息}}。',
        'meeting.time': '會議時間：{start, date, medium}',
        'rank.label': '你是第 {rank, selectordinal, one{# 名} two{# 名} other{# 名}}',
        'invite.text': '邀請 {count, plural, one{# 人} other{# 人}',
        'quota.used': '已用 {used}',
        'legacy.banner': '這個鍵基準裡沒有',
      },
    },
    {
      lang: 'ja',
      messages: {
        'app.title': 'メッセージ監査',
        'user.greeting': '{gender, select, female{彼女} male{彼} other{彼ら}} から {name} さんへ！',
        'inbox.summary': '{name} さん、新着は {count, plural, =0{ありません} other{# 件あります}}。',
        'meeting.time': '会議時間：{start, date, medium} {start, time, short}',
        'rank.label': 'あなたは {rank, selectordinal, other{# 位}} です',
        'invite.text': '{count, plural, other{# 人を招待}}',
        'quota.used': '使用率 {used, number, percent}',
      },
    },
  ],
};

exampleBtn.addEventListener('click', () => {
  baselineEl.value = JSON.stringify(EXAMPLE.baseline, null, 2);
  translationsEl.innerHTML = '';
  for (const t of EXAMPLE.translations) {
    addTranslation(t.lang, JSON.stringify(t.messages, null, 2));
  }
  setStatus('已填入示例，点击「开始审计」查看结果。');
});

/* ---------- 审计请求与渲染 ---------- */

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function typeLabel(type) {
  return typeLabels[type] || type;
}

function renderSummary(summary) {
  summaryEl.innerHTML = '';
  const types = Object.keys(summary).sort();
  for (const type of types) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.innerHTML =
      `<span class="badge ${escapeHtml(type)}">${escapeHtml(typeLabel(type))}</span>` +
      `<span class="count">${summary[type]}</span>`;
    chip.title = '点击筛选该类型';
    chip.addEventListener('click', () => {
      filterEl.value = type;
      applyFilter();
    });
    summaryEl.appendChild(chip);
  }
}

function renderFilterOptions(summary) {
  const current = filterEl.value;
  filterEl.innerHTML = '<option value="">全部类型</option>';
  for (const type of Object.keys(summary).sort()) {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = `${typeLabel(type)}（${summary[type]}）`;
    filterEl.appendChild(opt);
  }
  filterEl.value = [...filterEl.options].some((o) => o.value === current) ? current : '';
}

function applyFilter() {
  const filter = filterEl.value;
  const rows = allFindings.filter((f) => !filter || f.type === filter);
  tbody.innerHTML = rows.map((f) => `
    <tr>
      <td>${escapeHtml(f.language)}</td>
      <td class="key">${escapeHtml(f.key)}</td>
      <td><span class="badge ${escapeHtml(f.type)}">${escapeHtml(typeLabel(f.type))}</span></td>
      <td class="detail">${escapeHtml(f.detail)}</td>
    </tr>`).join('');
  filteredEmptyEl.classList.toggle('hidden', !(allFindings.length && !rows.length));
}

filterEl.addEventListener('change', applyFilter);

runBtn.addEventListener('click', async () => {
  const translations = [...translationsEl.querySelectorAll('.translation-block')].map((block) => ({
    lang: block.querySelector('.lang-input').value,
    messages: block.querySelector('textarea').value,
  }));

  setStatus('审计中…');
  runBtn.disabled = true;
  try {
    const resp = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline: baselineEl.value, translations }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(data.error || '审计失败', true);
      return;
    }

    typeLabels = data.types || {};
    allFindings = data.findings || [];
    resultsEl.classList.remove('hidden');
    renderSummary(data.summary || {});
    renderFilterOptions(data.summary || {});
    applyFilter();
    noFindingsEl.classList.toggle('hidden', allFindings.length > 0);
    document.querySelector('#findings').classList.toggle('hidden', allFindings.length === 0);
    setStatus(`完成：共 ${allFindings.length} 条发现。`);
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus(`请求失败：${err.message}`, true);
  } finally {
    runBtn.disabled = false;
  }
});

/* ---------- 初始化 ---------- */

addTranslation();
