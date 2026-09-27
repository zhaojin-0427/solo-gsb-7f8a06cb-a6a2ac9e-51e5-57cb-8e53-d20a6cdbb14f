'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { audit } = require('../lib/audit');

/** 便捷构造：单语言审计，返回指定类型的发现 */
function run(baseline, messages, lang = 'zh-CN') {
  return audit(baseline, [{ lang, messages }]);
}
function ofType(findings, type) {
  return findings.filter((f) => f.type === type);
}

test('缺失与额外消息', () => {
  const findings = run(
    { a: 'A', b: 'B' },
    { b: 'B', c: 'C' },
  );
  const missing = ofType(findings, 'missing');
  const extra = ofType(findings, 'extra');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].key, 'a');
  assert.equal(missing[0].language, 'zh-CN');
  assert.equal(extra.length, 1);
  assert.equal(extra[0].key, 'c');
});

test('语法错误：译文与基准均报告', () => {
  const findings = run(
    { good: 'ok {name}', badBase: '未闭合 {x' },
    { good: '坏掉的 {name', badBase: 'whatever' },
  );
  const syntax = ofType(findings, 'syntax');
  assert.equal(syntax.length, 2);
  assert.ok(syntax.some((f) => f.language === '基准' && f.key === 'badBase'));
  assert.ok(syntax.some((f) => f.language === 'zh-CN' && f.key === 'good'));
});

test('非字符串消息值视为语法错误', () => {
  const findings = run({ a: 'A' }, { a: 42 });
  assert.equal(ofType(findings, 'syntax').length, 1);
});

test('参数名差异：缺少与多出', () => {
  const findings = run(
    { k: '{a} {b}' },
    { k: '{a} {c}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 2);
  assert.ok(arg.some((f) => f.detail.includes('缺少参数「b」')));
  assert.ok(arg.some((f) => f.detail.includes('多出参数「c」')));
});

test('参数用法类型差异：普通 vs number、plural vs selectordinal', () => {
  const findings = run(
    { k1: '{n, number}', k2: '{n, plural, other{#}}' },
    { k1: '{n}', k2: '{n, selectordinal, other{#}}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 2);
  assert.ok(arg.some((f) => f.key === 'k1' && f.detail.includes('number') && f.detail.includes('普通')));
  assert.ok(arg.some((f) => f.key === 'k2' && f.detail.includes('plural') && f.detail.includes('selectordinal')));
});

test('同名混用：同一消息内参数以多种类型出现', () => {
  const findings = run(
    { k: '{d, date} {d, time}' },
    { k: '{d, date} {d, time}' },
  );
  const mixed = ofType(findings, 'mixed');
  // 基准与译文各报一条
  assert.equal(mixed.length, 2);
  assert.ok(mixed.every((f) => f.detail.includes('「d」')));
  assert.ok(mixed.some((f) => f.language === '基准'));
  assert.ok(mixed.some((f) => f.language === 'zh-CN'));
  // 签名一致，不应再报 arg 差异
  assert.equal(ofType(findings, 'arg').length, 0);
});

test('递归解析：select / plural 分支内的嵌套参数也参与比对', () => {
  const findings = run(
    { k: '{g, select, male{{n, number} 封} other{{n} 封}}' },
    { k: '{g, select, male{{n} 封} other{{n} 封}}' },
  );
  // n 在基准中为 number+普通（混用），译文中只有普通 → 签名不一致
  assert.ok(ofType(findings, 'arg').some((f) => f.detail.includes('「n」')));
});

test('select 选项名必须与基准一致', () => {
  const findings = run(
    { k: '{g, select, male{他} female{她} other{TA}}' },
    { k: '{g, select, male{他} other{TA}}' },
  );
  const sel = ofType(findings, 'select');
  assert.equal(sel.length, 1);
  assert.ok(sel[0].detail.includes('female'));
});

test('复数显式 =n 选项必须与基准一致', () => {
  const findings = run(
    { k: '{n, plural, =0{无} one{一} other{#}}' },
    { k: '{n, plural, one{一} other{#}}' },
  );
  const exact = ofType(findings, 'exact');
  assert.equal(exact.length, 1);
  assert.ok(exact[0].detail.includes('=0'));
});

test('复数语言类别可不同，不报错', () => {
  const findings = run(
    { k: '{n, plural, one{one} other{other}}' },
    { k: '{n, plural, zero{零} few{几} many{多} other{其他}}' },
  );
  assert.deepEqual(findings, []);
});

test('复数缺少 other 分支须报告（译文与基准）', () => {
  const findings = run(
    { k: '{n, plural, one{x} other{o}}', b: '{m, plural, one{x}}' },
    { k: '{n, plural, one{x}}', b: '{m, plural, one{x}}' },
  );
  const other = ofType(findings, 'other');
  assert.equal(other.length, 3); // 译文 k + 基准 b + 译文 b
  assert.ok(other.some((f) => f.language === 'zh-CN' && f.key === 'k'));
  assert.ok(other.some((f) => f.language === '基准' && f.key === 'b'));
});

test('selectordinal 的 =n 与 other 同样校验', () => {
  const findings = run(
    { k: '{r, selectordinal, =1{第一} other{第 #}}' },
    { k: '{r, selectordinal, other{第 #}}' },
  );
  assert.equal(ofType(findings, 'exact').length, 1);
});

test('同名 plural 多处出现：逐处检查 other，不被另一处掩盖', () => {
  const findings = run(
    { k: '{n, plural, one{x} other{o}} / {n, plural, one{y} other{o}}' },
    { k: '{n, plural, one{x} other{o}} / {n, plural, one{y}}' },
  );
  const other = ofType(findings, 'other');
  assert.equal(other.length, 1);
  assert.equal(other[0].language, 'zh-CN');
  assert.equal(other[0].key, 'k');
  assert.ok(other[0].detail.includes('「n」'));
  assert.ok(other[0].detail.includes('第 2 处'), `应标明差异位置：${other[0].detail}`);
});

test('同名 select 多处出现：按位置比较选项，不错配', () => {
  const findings = run(
    { k: '{g, select, a{A} other{O}} / {g, select, b{B} other{O}}' },
    { k: '{g, select, b{B} other{O}} / {g, select, a{A} other{O}}' },
  );
  const sel = ofType(findings, 'select');
  assert.equal(sel.length, 2);
  assert.ok(sel[0].detail.includes('位置：g(select)'));
  assert.ok(sel[0].detail.includes('缺少选项：a') && sel[0].detail.includes('多出选项：b'));
  assert.ok(sel[1].detail.includes('第 2 处'));
  assert.ok(sel[1].detail.includes('缺少选项：b') && sel[1].detail.includes('多出选项：a'));
});

test('嵌套分支内的同名 plural：按结构路径定位 =n 差异', () => {
  const findings = run(
    { k: '{g, select, male{{n, plural, =0{零} other{#}}} other{{n, plural, one{x} other{o}}}}' },
    { k: '{g, select, male{{n, plural, one{x} other{o}}} other{{n, plural, =0{零} other{#}}}}' },
  );
  const exact = ofType(findings, 'exact');
  assert.equal(exact.length, 2);
  // 两个 n(plural) 分别位于 male / other 选项内，各自是本层第 1 处，
  // 不再有全消息的「第 2 处」后缀；仅靠祖先选项名即可区分路径
  assert.ok(exact[0].detail.includes('g(select)=male › n(plural)'));
  assert.ok(exact[0].detail.includes('缺少显式选项：=0'));
  assert.ok(exact[1].detail.includes('g(select)=other › n(plural)'));
  assert.ok(!exact[1].detail.includes('第 2 处'));
  assert.ok(exact[1].detail.includes('多出显式选项：=0'));
  // 各路径数量相等（每侧 1 处），不报数量差异
  assert.equal(ofType(findings, 'arg').length, 0);
});

test('整处分支节点删除（其余选项均完整）须报告数量差异', () => {
  const findings = run(
    { k: '{g, select, male{{n, plural, one{一} other{#}}} female{{n, plural, one{一} other{#}}} other{}}' },
    { k: '{g, select, male{{n, plural, one{一} other{#}}} female{} other{}}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 1);
  assert.ok(arg[0].detail.includes('g(select)=female › n(plural)'), arg[0].detail);
  assert.ok(arg[0].detail.includes('基准 1 处、译文 0 处'), arg[0].detail);
  // 选项层面无差异，不应有 select / exact 发现
  assert.equal(ofType(findings, 'select').length, 0);
  assert.equal(ofType(findings, 'exact').length, 0);
});

test('整处分支节点新增须报告数量差异', () => {
  const findings = run(
    { k: '{g, select, male{{n, plural, one{一} other{#}}} other{}}' },
    { k: '{g, select, male{{n, plural, one{一} other{#}}} other{{n, plural, one{一} other{#}}}}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 1);
  assert.ok(arg[0].detail.includes('g(select)=other › n(plural)'), arg[0].detail);
  assert.ok(arg[0].detail.includes('基准 0 处、译文 1 处'), arg[0].detail);
});

test('不同路径的一增一减不能相互抵消', () => {
  const findings = run(
    { k: '{g, select, male{{n, plural, one{一} other{#}}} female{{n, plural, one{一} other{#}}} other{}}' },
    { k: '{g, select, male{} female{{n, plural, one{一} other{#}}} other{{n, plural, one{一} other{#}}}}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 2);
  assert.ok(arg.some((f) => f.detail.includes('g(select)=male › n(plural)') && f.detail.includes('基准 1 处、译文 0 处')));
  assert.ok(arg.some((f) => f.detail.includes('g(select)=other › n(plural)') && f.detail.includes('基准 0 处、译文 1 处')));
});

test('顶层分支节点整处增删：路径标注顶层并给出双侧数量', () => {
  const findings = run(
    { k: '{n, plural, one{a} other{o}} {n, plural, one{b} other{o}} {x}' },
    { k: '{n, plural, one{a} other{o}} {x}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 1);
  assert.ok(arg[0].detail.includes('顶层 n(plural)'), arg[0].detail);
  assert.ok(arg[0].detail.includes('基准 2 处、译文 1 处'), arg[0].detail);
});

test('select 节点整处增删同样按路径核对数量', () => {
  const findings = run(
    { k: '{g, select, male{M} other{O}}' },
    { k: '{g, select, male{M} female{F} other{O}} {g, select, male{M} female{F} other{O}}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 1);
  assert.ok(arg[0].detail.includes('顶层 g(select)'), arg[0].detail);
  assert.ok(arg[0].detail.includes('基准 1 处、译文 2 处'), arg[0].detail);
});

test('同层同名兄弟节点共享结构路径：删除其中一处按数量报告，不会错配', () => {
  const findings = run(
    { k: '{h, select, x{{g, select, a{A} other{O}} {g, select, b{B} other{O}}} other{}}' },
    { k: '{h, select, x{{g, select, a{A} other{O}}} other{}}' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 1);
  assert.ok(arg[0].detail.includes('h(select)=x › g(select)'), arg[0].detail);
  assert.ok(arg[0].detail.includes('基准 2 处、译文 1 处'), arg[0].detail);
});

test('选项书写顺序不改变结构路径', () => {
  const findings = run(
    { k: '{g, select, male{{n, plural, one{一} other{#}}} other{{n, plural, other{#}}}}' },
    // 译文只是把 other 选项写在前面，结构与基准完全一致
    { k: '{g, select, other{{n, plural, other{#}}} male{{n, plural, one{一} other{#}}}}' },
  );
  assert.deepEqual(findings, []);
});

test('数量一致的已配对节点仍检查 select 选项、=n 与 other，复数类别可随语言变化', () => {
  const findings = run(
    {
      k1: '{g, select, male{{n, plural, =0{零} one{一} other{#}}} other{}}',
      k2: '{g, select, male{他} female{她} other{TA}}',
    },
    {
      // 每处节点数量与基准一致：=0 缺失应继续报 exact；类别 one→two 随语言不报
      k1: '{g, select, male{{n, plural, two{二} few{几} other{#}}} other{}}',
      // female 选项缺失应继续报 select
      k2: '{g, select, male{他} other{TA}}',
    },
    'ar',
  );
  const exact = ofType(findings, 'exact');
  const select = ofType(findings, 'select');
  assert.equal(exact.length, 1);
  assert.ok(exact[0].detail.includes('g(select)=male › n(plural)'));
  assert.ok(exact[0].detail.includes('=0'));
  assert.equal(select.length, 1);
  assert.ok(select[0].detail.includes('female'));
  assert.equal(ofType(findings, 'arg').length, 0);
});

test('数量差异与参数名缺失不重复报告', () => {
  const findings = run(
    { k: '{n, plural, one{a} other{o}}' },
    { k: '没有参数了' },
  );
  const arg = ofType(findings, 'arg');
  assert.equal(arg.length, 1);
  assert.ok(arg[0].detail.includes('缺少参数「n」'));
});

test('plural 分支之下（祖先含 plural）的节点仍保留 other 自检', () => {
  const findings = run(
    { k: '{m, plural, other{{n, plural, one{x} other{o}}}}' },
    { k: '{m, plural, other{{n, plural, one{x}}}}' },
  );
  const other = ofType(findings, 'other');
  assert.equal(other.length, 1);
  assert.ok(other[0].detail.includes('m(plural)=other › n(plural)'), other[0].detail);
});

test('同名 selectordinal 多处出现：=n 按位置比较', () => {
  const findings = run(
    { k: '{r, selectordinal, =1{一} other{#}} / {r, selectordinal, =2{二} other{#}}' },
    { k: '{r, selectordinal, =2{二} other{#}} / {r, selectordinal, =1{一} other{#}}' },
  );
  const exact = ofType(findings, 'exact');
  assert.equal(exact.length, 2);
  assert.ok(exact.every((f) => f.detail.includes('r(selectordinal)')));
});

test('同名 plural 多处一致且类别随语言不同：不误报', () => {
  const findings = run(
    { k: '{n, plural, =0{零} one{x} other{o}} / {n, plural, =0{零} other{#}}' },
    { k: '{n, plural, =0{صفر} two{x} few{y} other{o}} / {n, plural, =0{صفر} many{m} other{#}}' },
    'ar',
  );
  assert.deepEqual(findings, []);
});

test('结果按语言、键排序', () => {
  const findings = audit(
    { b: '{x}', a: '{y}' },
    [
      { lang: 'zh-CN', messages: {} },
      { lang: 'ja', messages: {} },
    ],
  );
  const order = findings.map((f) => `${f.language}:${f.key}`);
  assert.deepEqual(order, ['ja:a', 'ja:b', 'zh-CN:a', 'zh-CN:b']);
});

test('完全一致时无发现', () => {
  const findings = run(
    {
      a: '你好 {name}',
      b: '{n, plural, =0{无} other{# 条}}',
      c: '{g, select, male{他} other{TA}}',
      d: '{t, date} {t, time, short}', // 触发 mixed，单独断言
    },
    {
      a: 'こんにちは {name}',
      b: '{n, plural, =0{なし} other{# 件}}',
      c: '{g, select, male{彼} other{彼ら}}',
      d: '{t, date} {t, time, short}',
    },
    'ja',
  );
  assert.deepEqual(ofType(findings, 'arg'), []);
  assert.deepEqual(ofType(findings, 'select'), []);
  assert.deepEqual(ofType(findings, 'exact'), []);
  // d 键基准与译文均为 date+time 混用 → 各一条 mixed
  assert.equal(ofType(findings, 'mixed').length, 2);
});
