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
 * 本轮结构审计覆盖的分支节点：消息顶层、或祖先全部为 select 的
 * select / plural / selectordinal 节点（位于 plural 分支之下的节点暂不按结构路径核对）。
 *
 * 对覆盖范围内的每个分支节点保留一条记录：
 *   { kind, name, ordinal, path, options? / exact?, categories?, hasOther, eligible, key }
 * - kind：select / plural / selectordinal；
 * - ordinal：同名同类型节点在「同一层分支内容」中的出现序号
 *     （顶层为整则消息、嵌套时为所在 select 选项的内容；兄弟之间按此序号配对）；
 * - path：可读结构路径，由各祖先的参数名、类型、同层同名同类型出现序号和选项名组成，
 *   如「g(select)=male › n(plural)（第 2 处）」；选项书写顺序不改变路径；
 * - key：结构核对键，由祖先链（参数名(类型)#同层序号=选项名…）+ 当前参数名(类型) 构成；
 *   当前节点自身的出现序号不进 key（同路径多个兄弟归入同一组按总数核对）。
 *
 * 覆盖范围之外（祖先含 plural）的节点另以 legacy 数组保留，
 * 沿用旧的「全消息同名序号」尽力配对，避免丢失既有的 other 自检。
 */
function extractSignature(ast) {
  const args = new Map(); // name -> Set<用法>
  const branches = []; // 覆盖范围内的分支节点（结构路径核对）
  const legacy = []; // 覆盖范围之外（祖先含 plural）的分支节点

  const addUsage = (name, usage) => {
    if (!args.has(name)) args.set(name, new Set());
    args.get(name).add(usage);
  };

  /** 节点可读自描述：name(类型)，同层同名多处时追加「（第 N 处）」 */
  const describeNode = (name, kind, ordinal) =>
    `${name}(${USAGE_LABELS[kind] || kind})${ordinal > 1 ? `（第 ${ordinal} 处）` : ''}`;

  /** 节点结构自描述（不含序号后缀）：结构路径只由参数名、类型和祖先选项名组成 */
  const nodeKeyOf = (name, kind) => `${name}(${USAGE_LABELS[kind] || kind})`;

  /**
   * 遍历一层分支内容（整则消息或某个 select 选项的内容）。
   * @param eligible 本层是否处于覆盖范围（祖先全为 select）
   * @param trailLabels 已入路径的祖先可读描述（…=选项名）
   * @param trailKeys 已入路径的祖先结构键（含同层序号，消歧兄弟节点）
   * @param counters 本层的同名同类型出现计数（作用域限定在本层）
   * @param globals 覆盖范围之外节点使用的全消息计数
   */
  const walkScope = (elements, eligible, trailLabels, trailKeys, counters, globals) => {
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
          // 选项书写顺序不影响路径：以选项名作为键，路径只由选项名决定
          const optionNames = Object.keys(el.options).sort();

          if (eligible) {
            const ordinal = (counters.get(`select:${el.value}`) || 0) + 1;
            counters.set(`select:${el.value}`, ordinal);
            const self = describeNode(el.value, 'select', ordinal);
            const selfKey = nodeKeyOf(el.value, 'select');
            const node = {
              kind: 'select',
              name: el.value,
              ordinal,
              path: [...trailLabels, self].join(' › '),
              options: new Set(optionNames),
              eligible: true,
              key: [...trailKeys, selfKey].join(' › '),
            };
            branches.push(node);
            for (const optName of optionNames) {
              // select 的每个选项各自开启新的一层作用域
              walkScope(
                el.options[optName].value,
                true,
                [...trailLabels, `${self}=${optName}`],
                [...trailKeys, `${selfKey}#${ordinal}=${optName}`],
                new Map(),
                globals,
              );
            }
          } else {
            const ordinal = (globals.get(`select:${el.value}`) || 0) + 1;
            globals.set(`select:${el.value}`, ordinal);
            const self = describeNode(el.value, 'select', ordinal);
            const selfKey = nodeKeyOf(el.value, 'select');
            legacy.push({
              kind: 'select',
              name: el.value,
              ordinal,
              path: [...trailLabels, self].join(' › '),
              options: new Set(optionNames),
              eligible: false,
            });
            for (const optName of optionNames) {
              walkScope(
                el.options[optName].value,
                false,
                [...trailLabels, `${self}=${optName}`],
                [...trailKeys, `${selfKey}#${ordinal}=${optName}`],
                new Map(),
                globals,
              );
            }
          }
          break;
        }
        case TYPE.plural: {
          const kind = el.pluralType === 'ordinal' ? 'selectordinal' : 'plural';
          addUsage(el.value, kind);
          const optionNames = Object.keys(el.options).sort();

          if (eligible) {
            const ordinal = (counters.get(`${kind}:${el.value}`) || 0) + 1;
            counters.set(`${kind}:${el.value}`, ordinal);
            const self = describeNode(el.value, kind, ordinal);
            const selfKey = nodeKeyOf(el.value, kind);
            const node = {
              kind,
              name: el.value,
              ordinal,
              path: [...trailLabels, self].join(' › '),
              exact: new Set(),
              categories: new Set(),
              hasOther: false,
              eligible: true,
              key: [...trailKeys, selfKey].join(' › '),
            };
            for (const optName of optionNames) {
              if (optName.startsWith('=')) node.exact.add(optName);
              else {
                node.categories.add(optName);
                if (optName === 'other') node.hasOther = true;
              }
            }
            branches.push(node);
            // plural 分支之下暂不按结构路径核对：子层标记为覆盖范围之外
            for (const optName of optionNames) {
              walkScope(
                el.options[optName].value,
                false,
                [...trailLabels, `${self}=${optName}`],
                [...trailKeys, `${selfKey}#${ordinal}=${optName}`],
                new Map(),
                globals,
              );
            }
          } else {
            const ordinal = (globals.get(`${kind}:${el.value}`) || 0) + 1;
            globals.set(`${kind}:${el.value}`, ordinal);
            const self = describeNode(el.value, kind, ordinal);
            const selfKey = nodeKeyOf(el.value, kind);
            const node = {
              kind,
              name: el.value,
              ordinal,
              path: [...trailLabels, self].join(' › '),
              exact: new Set(),
              categories: new Set(),
              hasOther: false,
              eligible: false,
            };
            for (const optName of optionNames) {
              if (optName.startsWith('=')) node.exact.add(optName);
              else {
                node.categories.add(optName);
                if (optName === 'other') node.hasOther = true;
              }
            }
            legacy.push(node);
            for (const optName of optionNames) {
              walkScope(
                el.options[optName].value,
                false,
                [...trailLabels, `${self}=${optName}`],
                [...trailKeys, `${selfKey}#${ordinal}=${optName}`],
                new Map(),
                globals,
              );
            }
          }
          break;
        }
        case TYPE.tag:
          // 标签内容与所在层同作用域：共用本层计数
          walkScope(el.children, eligible, trailLabels, trailKeys, counters, globals);
          break;
        default:
          break; // literal / pound 无需处理
      }
    }
  };

  walkScope(ast, true, [], [], new Map(), new Map());
  return { args, branches, legacy };
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
 * 覆盖范围之外（祖先含 plural）的节点沿用旧配对方式：
 * 同名分支节点按全消息出现位置配对，基准第 N 处 ↔ 译文第 N 处。
 */
function pairLegacyNodes(baseNodes, transNodes) {
  const transByName = new Map(); // name+kind -> 译文节点数组（按出现顺序）
  for (const node of transNodes) {
    const nk = `${node.kind}:${node.name}`;
    if (!transByName.has(nk)) transByName.set(nk, []);
    transByName.get(nk).push(node);
  }
  return baseNodes.map((baseNode) => {
    const candidates = transByName.get(`${baseNode.kind}:${baseNode.name}`) || [];
    return [baseNode, candidates[baseNode.ordinal - 1] || null];
  });
}

/**
 * 覆盖范围内的分支节点：按「结构路径 + 当前参数名 + 类型」归组。
 * 每个路径桶内存放该路径下同类型同名节点（按同层出现序号排列），
 * 桶内总数用于核对整处增删；数量一致时再按序号逐处配对检查选项。
 */
function indexBranches(nodes) {
  const byKey = new Map(); // 结构键 -> 节点数组（按同层出现序号）
  for (const node of nodes) {
    if (!byKey.has(node.key)) byKey.set(node.key, []);
    byKey.get(node.key).push(node);
  }
  return byKey;
}

/** 数量差异的详情路径：结构路径去掉「（第 N 处）」后缀（数量本身已体现序号差异） */
const countPath = (node) => {
  const bare = node.path.replace(/（第 \d+ 处）/g, '');
  return bare.includes(' › ') || bare.includes('=') ? bare : `顶层 ${bare}`;
};

/** 结构路径中当前节点自描述（不含祖先链），用于数量差异文案 */
const selfDesc = (node) =>
  `${node.name}（${USAGE_LABELS[node.kind] || node.kind}）`;

/**
 * 数量差异若与参数名缺失/类型不符重复，则跳过数量发现：
 * 一侧一个节点都没有、且该侧参数用法集合中也没有该类型时，arg 检查已说明问题。
 */
function countDiffRedundant(args, name, kind, countOnThisSide) {
  if (countOnThisSide !== 0) return false;
  const usages = args.get(name);
  return !usages || !usages.has(kind);
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

  // 3. 覆盖范围内分支节点：按结构路径 + 参数名 + 类型核对双侧数量
  //    不同路径的增减不能相互抵消；数量差归入参数签名不一致（arg）
  const baseByKey = indexBranches(base.branches);
  const transByKey = indexBranches(trans.branches);
  const allKeys = new Set([...baseByKey.keys(), ...transByKey.keys()]);
  for (const nodeKey of allKeys) {
    const baseGroup = baseByKey.get(nodeKey) || [];
    const transGroup = transByKey.get(nodeKey) || [];
    if (baseGroup.length === transGroup.length) continue;
    const sample = baseGroup[0] || transGroup[0];
    // 一侧数量为 0 且该侧参数用法中已无此类型时，arg 名称/类型发现已覆盖，不再重复
    if (countDiffRedundant(base.args, sample.name, sample.kind, baseGroup.length)) continue;
    if (countDiffRedundant(trans.args, sample.name, sample.kind, transGroup.length)) continue;
    findings.push({
      language: lang, key, type: 'arg',
      detail: `分支节点数量不一致：路径 ${countPath(sample)}，${selfDesc(sample)}基准 ${baseGroup.length} 处、译文 ${transGroup.length} 处`,
    });
  }

  // 4. 已配对节点（同路径、同参数名类型、同数量）继续逐处检查：
  //    select 选项须一致；显式 =n 须一致；复数语言类别可随语言变化
  const checkSelectOptions = (baseNode, transNode) => {
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
  };

  const checkPluralExact = (baseNode, transNode) => {
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
  };

  for (const nodeKey of allKeys) {
    const baseGroup = baseByKey.get(nodeKey) || [];
    const transGroup = transByKey.get(nodeKey) || [];
    if (baseGroup.length !== transGroup.length) continue; // 数量差异已在上面报告
    // 同路径同类型节点按同层出现序号一一配对（数组天然按出现顺序排列）
    baseGroup.forEach((baseNode, i) => {
      const transNode = transGroup[i];
      if (baseNode.kind === 'select') checkSelectOptions(baseNode, transNode);
      else checkPluralExact(baseNode, transNode);
    });
  }

  // 5. 覆盖范围之外（祖先含 plural）的节点：沿用旧的同名序号配对尽力比对
  for (const [baseNode, transNode] of pairLegacyNodes(base.legacy, trans.legacy)) {
    if (!transNode) continue; // 参数缺失/类型不符已在 arg 检查报告
    if (baseNode.kind === 'select') checkSelectOptions(baseNode, transNode);
    else checkPluralExact(baseNode, transNode);
  }

  // 6. other 分支：译文内每一处复数节点（含覆盖范围之外）都必须有 other
  for (const node of [...trans.branches, ...trans.legacy]) {
    if (node.kind !== 'select' && !node.hasOther) {
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
  for (const node of [...sig.branches, ...sig.legacy]) {
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
