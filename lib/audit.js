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
 * 分支节点（select / plural / selectordinal）的身份由「结构路径」决定，
 * 路径上每一级祖先记录四个要素：
 *   参数名、节点类型、同层同名同类型出现序号、进入下一层所用的选项名，
 * 例如 g(select)=male › n(plural)（第 2 处）。
 * - 出现序号只在同一父路径、同一选项内计数，因此选项的书写顺序不影响路径；
 * - 按路径核对数量的范围：顶层节点，以及祖先全部为 select 的节点
 *   （select 选项名跨语言稳定；复数类别随语言变化，其下的节点不参与路径计数，
 *   仍按同名出现顺序配对做选项级检查）；
 * - 比对时按路径（并核对参数名与类型）统计两侧节点数量，
 *   不同路径上的增减不能相互抵消；
 * - 数量一致的路径再逐一配对，检查 select 选项与复数显式 =n 选项。
 */
function extractSignature(ast) {
  const args = new Map(); // name -> Set<用法>
  const branches = []; // 全部 select / plural / selectordinal 节点（按遍历顺序）

  const addUsage = (name, usage) => {
    if (!args.has(name)) args.set(name, new Set());
    args.get(name).add(usage);
  };

  // 同层（相同祖先路径）同名同类型节点的出现计数，计数键含所经选项名
  const occurrenceCounters = new Map();

  /** 节点自描述：name(类型)，同层多处时追加「（第 N 处）」 */
  const describeNode = (name, kind, occurrence) =>
    `${name}(${USAGE_LABELS[kind] || kind})${occurrence > 1 ? `（第 ${occurrence} 处）` : ''}`;

  const walk = (elements, trail, allSelectAncestors) => {
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
        case TYPE.select:
        case TYPE.plural: {
          const kind = el.type === TYPE.select
            ? 'select'
            : (el.pluralType === 'ordinal' ? 'selectordinal' : 'plural');
          addUsage(el.value, kind);

          // 同层（相同祖先路径）同名同类型节点的出现序号；与选项书写顺序无关
          const counterKey = JSON.stringify([
            ...trail.map((s) => [s.name, s.kind, s.occurrence, s.option]),
            [kind, el.value],
          ]);
          const occurrence = (occurrenceCounters.get(counterKey) || 0) + 1;
          occurrenceCounters.set(counterKey, occurrence);

          const ancestorPath = trail.map((s) =>
            `${describeNode(s.name, s.kind, s.occurrence)}=${s.option}`);
          const self = describeNode(el.value, kind, occurrence);
          const node = {
            name: el.value,
            kind,
            occurrence,
            path: [...ancestorPath, self].join(' › '),
            // 是否参与按路径计数：顶层或祖先全部为 select
            countable: allSelectAncestors,
            // 结构位置键：各祖先的（名、类型、序号、选项名），与节点自身名/类型无关
            trailKey: JSON.stringify(trail.map((s) => [s.name, s.kind, s.occurrence, s.option])),
            // 身份键：各祖先的（名、类型、序号、选项名）+ 自身（名、类型、同层序号）
            key: JSON.stringify([
              ...trail.map((s) => [s.name, s.kind, s.occurrence, s.option]),
              [el.value, kind, occurrence],
            ]),
            options: new Set(), // select 选项名
            exact: new Set(), // 复数显式 =n 选项
            categories: new Set(), // 复数语言类别（zero/one/two/few/many）
            hasOther: false,
          };
          branches.push(node);

          for (const [optName, opt] of Object.entries(el.options)) {
            if (kind === 'select') {
              node.options.add(optName);
            } else if (optName.startsWith('=')) {
              node.exact.add(optName);
            } else {
              node.categories.add(optName);
              if (optName === 'other') node.hasOther = true;
            }
            const step = { name: el.value, kind, occurrence, option: optName };
            // select 选项名跨语言稳定，其下节点继续参与路径计数；
            // 复数类别随语言变化，其下节点不再参与
            walk(opt.value, [...trail, step], kind === 'select');
          }
          break;
        }
        case TYPE.tag:
          walk(el.children, trail, allSelectAncestors);
          break;
        default:
          break; // literal / pound 无需处理
      }
    }
  };

  walk(ast, [], true);
  return { args, branches };
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
 * 分支节点按「结构路径（含同层同名同类型出现序号）+ 当前参数名 + 类型」分组，
 * 即每条身份路径一组，组内为该路径下基准/译文的节点。
 */
function indexBranches(nodes) {
  const groups = new Map(); // identityKey -> [node, ...]（按遍历顺序）
  for (const node of nodes) {
    if (!groups.has(node.key)) groups.set(node.key, []);
    groups.get(node.key).push(node);
  }
  return groups;
}

/**
 * 作用域外节点（祖先中含有 plural / selectordinal）的配对：
 * 复数语言类别随语言变化，结构路径无法跨语言对齐，故沿用按参数名与
 * 消息内出现顺序配对的旧规则，只做选项级检查，不做数量核对。
 * select 节点与复数类节点分别配对（同名不同类不互相占序号）。
 */
function pairByName(lang, key, baseNodes, transNodes, findings) {
  const pair = (baseList, transList, compare) => {
    const transByName = new Map(); // name -> 译文节点数组（按出现顺序）
    for (const node of transList) {
      if (!transByName.has(node.name)) transByName.set(node.name, []);
      transByName.get(node.name).push(node);
    }
    const baseIndexByName = new Map(); // name -> 已配对的基准节点数
    for (const baseNode of baseList) {
      const index = baseIndexByName.get(baseNode.name) || 0;
      baseIndexByName.set(baseNode.name, index + 1);
      const candidates = transByName.get(baseNode.name) || [];
      const transNode = candidates[index] || null;
      if (transNode) compare(lang, key, baseNode, transNode, findings);
    }
  };
  const isSelect = (n) => n.kind === 'select';
  pair(baseNodes.filter(isSelect), transNodes.filter(isSelect), compareSelectOptions);
  pair(baseNodes.filter((n) => !isSelect(n)), transNodes.filter((n) => !isSelect(n)), comparePluralOptions);
}

/**
 * 按结构路径核对分支节点数量（仅顶层及祖先全部为 select 的节点）：
 * 身份路径由各祖先的（参数名、类型、同层序号、选项名）加当前节点的
 * （参数名、类型、同层序号）组成；同一身份路径下基准与译文的节点数必须相等，
 * 不同路径的增减不能相互抵消。数量差属于参数签名不一致；
 * 数量一致时再按出现顺序逐一配对检查选项。
 */
function compareBranches(lang, key, baseNodes, transNodes, findings) {
  // 作用域内：顶层或祖先全部为 select，路径稳定可按路径计数
  const baseCountable = baseNodes.filter((n) => n.countable);
  const transCountable = transNodes.filter((n) => n.countable);

  const baseGroups = indexBranches(baseCountable);
  const transGroups = indexBranches(transCountable);
  const allKeys = new Set([...baseGroups.keys(), ...transGroups.keys()]);

  for (const nodeKey of [...allKeys].sort()) {
    const baseList = baseGroups.get(nodeKey) || [];
    const transList = transGroups.get(nodeKey) || [];

    if (baseList.length !== transList.length) {
      const sample = baseList[0] || transList[0];
      // 仅一侧有该身份键时：若对侧在同一结构位置有同名但不同类型的节点，
      // 属于类型切换（如 plural 与 selectordinal 互改），已由参数用法检查报告；
      // 否则是真正的整处增删，必须报告数量差
      const otherSide = baseList.length ? transCountable : baseCountable;
      const kindSwitched = otherSide.some(
        (n) => n.trailKey === sample.trailKey && n.name === sample.name && n.kind !== sample.kind,
      );
      if (kindSwitched) continue;
      findings.push({
        language: lang, key, type: 'arg',
        detail: `分支节点「${sample.name}」（${USAGE_LABELS[sample.kind] || sample.kind}，` +
          `路径：${sample.path}）数量不一致：基准 ${baseList.length} 处，译文 ${transList.length} 处`,
      });
      continue; // 数量不等时该路径不再做选项级比对
    }

    // 数量一致：同一身份路径下按出现顺序逐一配对
    baseList.forEach((baseNode, i) => {
      const transNode = transList[i];
      if (baseNode.kind === 'select') {
        compareSelectOptions(lang, key, baseNode, transNode, findings);
      } else {
        comparePluralOptions(lang, key, baseNode, transNode, findings);
      }
    });
  }

  // 作用域外节点（祖先含复数类分支）：按参数名与出现顺序配对做选项级检查
  pairByName(
    lang,
    key,
    baseNodes.filter((n) => !n.countable),
    transNodes.filter((n) => !n.countable),
    findings,
  );

  // 每处复数类分支都必须有 other（复数语言类别可随语言变化，不参与比对）
  for (const node of transNodes) {
    if (node.kind !== 'select' && !node.hasOther) {
      findings.push({
        language: lang, key, type: 'other',
        detail: `复数参数「${node.name}」（位置：${node.path}）缺少必需的 other 分支`,
      });
    }
  }
}

/** 配对成功的 select 节点：选项名集合必须与基准一致 */
function compareSelectOptions(lang, key, baseNode, transNode, findings) {
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

/** 配对成功的 plural / selectordinal 节点：仅显式 =n 选项必须与基准一致 */
function comparePluralOptions(lang, key, baseNode, transNode, findings) {
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

  // 3. 按结构路径核对分支节点数量，数量一致的路径再逐一配对检查选项
  compareBranches(lang, key, base.branches, trans.branches, findings);
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
  for (const node of sig.branches) {
    if (node.kind !== 'select' && !node.hasOther) {
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
