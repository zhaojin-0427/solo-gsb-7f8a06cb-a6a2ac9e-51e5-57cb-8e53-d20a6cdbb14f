'use strict';

const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');

/** 基准语言在结果中的显示名 */
const BASELINE_LANG = '基准';

/** 所有错误类型（前端筛选器也以此为准） */
const FINDING_TYPES = {
  missing: '缺失消息',
  extra: '额外消息',
  syntax: '语法错误',
  json: 'JSON 解析失败',
  arg: '参数签名不一致',
  mixed: '同名参数混用',
  select: 'select 选项不一致',
  exact: '复数 =n 选项不一致',
  other: '缺少 other 分支',
};

/** 参数用法类型 */
const USAGE_LABELS = {
  plain: '普通',
  number: 'number',
  date: 'date',
  time: 'time',
  select: 'select',
  plural: 'plural',
  selectordinal: 'selectordinal',
};

/**
 * 消息签名：递归提取一条 ICU 消息中全部参数的名称与用法，
 * 以及 select / plural 类参数的分支结构。
 *
 * 同一参数名可能在不同位置或嵌套层重复出现，因此分支信息不按参数名合并，
 * 而是为每个分支节点保留一条记录：
 *   { name, ordinal, path, ... }
 * - ordinal：同名同种节点在本消息内的出现序号（第 1 处、第 2 处……），
 *   基准与译文各自计数，用于按位置一一配对；
 * - path：可读的位置描述，如「g(select)=male › n(plural)（第 2 处）」。
 */
function extractSignature(ast) {
  const args = new Map(); // name -> Set<用法>
  const selects = []; // [{ name, ordinal, path, options:Set<选项名> }]
  const plurals = []; // [{ name, ordinal, path, exact:Set<'=n'>, categories:Set<string>, hasOther:boolean }]

  const addUsage = (name, usage) => {
    if (!args.has(name)) args.set(name, new Set());
    args.get(name).add(usage);
  };

  // 同名同种分支节点的出现计数（select 与 plural/selectordinal 分别计数）
  const selectOrdinals = new Map();
  const pluralOrdinals = new Map();
  const nextOrdinal = (counter, name) => {
    const n = (counter.get(name) || 0) + 1;
    counter.set(name, n);
    return n;
  };

  /** 节点自描述：name(类型)，同名多处时追加「（第 N 处）」 */
  const describeNode = (name, usage, ordinal) =>
    `${name}(${USAGE_LABELS[usage] || usage})${ordinal > 1 ? `（第 ${ordinal} 处）` : ''}`;

  const walk = (elements, trail) => {
    for (const el of elements) {
      switch (el.type) {
        case TYPE.argument:
          addUsage(el.value, 'plain');
          break;
        case TYPE.number:
          addUsage(el.value, 'number');
          break;
        case TYPE.date:
          addUsage(el.value, 'date');
          break;
        case TYPE.time:
          addUsage(el.value, 'time');
          break;
        case TYPE.select: {
          addUsage(el.value, 'select');
          const ordinal = nextOrdinal(selectOrdinals, el.value);
          const self = describeNode(el.value, 'select', ordinal);
          selects.push({
            name: el.value,
            ordinal,
            path: [...trail, self].join(' › '),
            options: new Set(Object.keys(el.options)),
          });
          for (const [optName, opt] of Object.entries(el.options)) {
            walk(opt.value, [...trail, `${self}=${optName}`]); // 递归解析分支内容
          }
          break;
        }
        case TYPE.plural: {
          const usage = el.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
          addUsage(el.value, usage);
          const ordinal = nextOrdinal(pluralOrdinals, el.value);
          const self = describeNode(el.value, usage, ordinal);
          const node = {
            name: el.value,
            ordinal,
            path: [...trail, self].join(' › '),
            exact: new Set(),
            categories: new Set(),
            hasOther: false,
          };
          plurals.push(node);
          for (const [optName, opt] of Object.entries(el.options)) {
            if (optName.startsWith('=')) node.exact.add(optName);
            else {
              node.categories.add(optName);
              if (optName === 'other') node.hasOther = true;
            }
            walk(opt.value, [...trail, `${self}=${optName}`]); // 递归解析分支内容
          }
          break;
        }
        case TYPE.tag:
          walk(el.children, trail);
          break;
        default:
          break; // literal / pound 无需处理
      }
    }
  };

  walk(ast, []);
  return { args, selects, plurals };
}

/** 解析单条消息；失败时返回 { error }，成功时返回 { sig } */
function parseMessage(value) {
  if (typeof value !== 'string') {
    return { error: `消息值不是字符串（实际为 ${Array.isArray(value) ? '数组' : typeof value}）` };
  }
  try {
    // requiresOtherClause:false —— 缺少 other 不作为语法错误，而由审计单独报告
    const ast = parse(value, { requiresOtherClause: false, shouldParseSkeletons: false });
    return { sig: extractSignature(ast) };
  } catch (err) {
    return { error: err.message };
  }
}

const fmtUsages = (set) => [...set].map((u) => USAGE_LABELS[u] || u).join('、');
const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const sorted = (iterable) => [...iterable].sort();

/**
 * 同名分支节点按出现位置配对：基准第 N 处 ↔ 译文第 N 处。
 * 译文缺少对应位置时配到 null（参数层面的缺失/类型不符已在 arg 检查报告）。
 */
function pairBranchNodes(baseNodes, transNodes) {
  const transByName = new Map(); // name -> 译文节点数组（按出现顺序）
  for (const node of transNodes) {
    if (!transByName.has(node.name)) transByName.set(node.name, []);
    transByName.get(node.name).push(node);
  }
  return baseNodes.map((baseNode) => {
    const candidates = transByName.get(baseNode.name) || [];
    return [baseNode, candidates[baseNode.ordinal - 1] || null];
  });
}

/** 比较同一消息键下基准与译文的签名，追加差异到 findings */
function compareSignatures(lang, key, base, trans, findings) {
  // 1. 参数名与用法类型
  for (const [name, baseTypes] of base.args) {
    if (!trans.args.has(name)) {
      findings.push({
        language: lang, key, type: 'arg',
        detail: `缺少参数「${name}」（基准用法：${fmtUsages(baseTypes)}）`,
      });
    } else {
      const transTypes = trans.args.get(name);
      if (!setsEqual(baseTypes, transTypes)) {
        findings.push({
          language: lang, key, type: 'arg',
          detail: `参数「${name}」用法不一致：基准为 ${fmtUsages(baseTypes)}，译文为 ${fmtUsages(transTypes)}`,
        });
      }
    }
  }
  for (const [name, transTypes] of trans.args) {
    if (!base.args.has(name)) {
      findings.push({
        language: lang, key, type: 'arg',
        detail: `多出参数「${name}」（基准中不存在，译文用法：${fmtUsages(transTypes)}）`,
      });
    }
  }

  // 2. 译文内部的同名混用
  for (const [name, transTypes] of trans.args) {
    if (transTypes.size > 1) {
      findings.push({
        language: lang, key, type: 'mixed',
        detail: `参数「${name}」同名混用：${fmtUsages(transTypes)}`,
      });
    }
  }

  // 3. select 选项：同名节点按位置逐一配对，每个位置的选项名都必须与基准一致
  for (const [baseNode, transNode] of pairBranchNodes(base.selects, trans.selects)) {
    if (!transNode) continue; // 参数缺失/类型不符已在上面报告
    const missing = sorted([...baseNode.options].filter((o) => !transNode.options.has(o)));
    const extra = sorted([...transNode.options].filter((o) => !baseNode.options.has(o)));
    if (missing.length || extra.length) {
      const parts = [];
      if (missing.length) parts.push(`缺少选项：${missing.join('、')}`);
      if (extra.length) parts.push(`多出选项：${extra.join('、')}`);
      findings.push({
        language: lang, key, type: 'select',
        detail: `select 参数「${baseNode.name}」（位置：${baseNode.path}）${parts.join('；')}`,
      });
    }
  }

  // 4. 复数显式 =n 选项按位置逐一配对比较；语言类别可不同，但每处都必须有 other
  for (const [baseNode, transNode] of pairBranchNodes(base.plurals, trans.plurals)) {
    if (!transNode) continue;
    const missing = sorted([...baseNode.exact].filter((o) => !transNode.exact.has(o)));
    const extra = sorted([...transNode.exact].filter((o) => !baseNode.exact.has(o)));
    if (missing.length || extra.length) {
      const parts = [];
      if (missing.length) parts.push(`缺少显式选项：${missing.join('、')}`);
      if (extra.length) parts.push(`多出显式选项：${extra.join('、')}`);
      findings.push({
        language: lang, key, type: 'exact',
        detail: `复数参数「${baseNode.name}」（位置：${baseNode.path}）${parts.join('；')}`,
      });
    }
  }
  for (const node of trans.plurals) {
    if (!node.hasOther) {
      findings.push({
        language: lang, key, type: 'other',
        detail: `复数参数「${node.name}」（位置：${node.path}）缺少必需的 other 分支`,
      });
    }
  }
}

/** 单条消息内部问题（语法错误之外的自检：同名混用、缺 other） */
function selfCheck(lang, key, sig, findings) {
  for (const [name, types] of sig.args) {
    if (types.size > 1) {
      findings.push({
        language: lang, key, type: 'mixed',
        detail: `参数「${name}」同名混用：${fmtUsages(types)}`,
      });
    }
  }
  for (const node of sig.plurals) {
    if (!node.hasOther) {
      findings.push({
        language: lang, key, type: 'other',
        detail: `复数参数「${node.name}」（位置：${node.path}）缺少必需的 other 分支`,
      });
    }
  }
}

/** 结果排序：先语言，再消息键，最后错误类型（码元序，保证确定性） */
function compareFindings(a, b) {
  if (a.language !== b.language) return a.language < b.language ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return 0;
}

/**
 * 审计入口。
 * @param {Object<string,string>} baselineMessages 基准消息（已解析的 JSON 对象）
 * @param {Array<{lang:string, messages:Object<string,string>}>} translations 译文列表
 * @returns {Array<{language:string, key:string, type:string, detail:string}>}
 */
function audit(baselineMessages, translations) {
  const findings = [];

  // 解析基准
  const baselineParsed = new Map();
  for (const [key, value] of Object.entries(baselineMessages)) {
    baselineParsed.set(key, parseMessage(value));
  }
  for (const [key, res] of baselineParsed) {
    if (res.error) {
      findings.push({ language: BASELINE_LANG, key, type: 'syntax', detail: `基准消息解析失败：${res.error}` });
    } else {
      selfCheck(BASELINE_LANG, key, res.sig, findings);
    }
  }

  // 逐语言比对
  for (const { lang, messages } of translations) {
    const parsed = new Map();
    for (const [key, value] of Object.entries(messages)) {
      parsed.set(key, parseMessage(value));
    }

    for (const key of Object.keys(baselineMessages)) {
      if (!(key in messages)) {
        findings.push({ language: lang, key, type: 'missing', detail: '译文中缺失该消息' });
      }
    }
    for (const key of Object.keys(messages)) {
      if (!(key in baselineMessages)) {
        findings.push({ language: lang, key, type: 'extra', detail: '基准中不存在该消息' });
        const res = parsed.get(key);
        if (res && res.error) {
          findings.push({ language: lang, key, type: 'syntax', detail: `ICU 语法错误：${res.error}` });
        }
      }
    }

    for (const key of Object.keys(baselineMessages)) {
      if (!(key in messages)) continue;
      const trans = parsed.get(key);
      const base = baselineParsed.get(key);
      if (trans.error) {
        findings.push({ language: lang, key, type: 'syntax', detail: `ICU 语法错误：${trans.error}` });
        continue;
      }
      if (base.error) continue; // 基准本身无法解析时不做签名比对
      compareSignatures(lang, key, base.sig, trans.sig, findings);
    }
  }

  findings.sort(compareFindings);
  return findings;
}

module.exports = { audit, compareFindings, extractSignature, parseMessage, FINDING_TYPES, USAGE_LABELS, BASELINE_LANG };
