const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const setupCode = fs.readFileSync(path.join(__dirname, 'exam-harness.js'), 'utf8').split('(async () => {')[0];
const setupExam = new Function('require', '__dirname', setupCode + ';return setup;')(require, __dirname);
const flush = async () => { for (let i = 0; i < 14; i++) await Promise.resolve(); };

function setup(store = new Map()) {
  const calls = [];
  const t = setupExam(true, { URL,
    GM_getValue: (key, fallback) => store.has(key) ? store.get(key) : fallback,
    GM_setValue: (key, value) => store.set(key, value),
    GM_deleteValue: (key) => store.delete(key),
    GM_xmlhttpRequest: (details) => {
      const call = { details, aborted: false };
      calls.push(call);
      return { abort: () => { call.aborted = true; details.onabort(); } };
    },
  });
  t.active.questionData.forEach((item) => { delete item.rightAnswer; });
  const configure = (extra = {}) => t.cx.ai.configure(Object.assign({
    endpoint: 'https://ai.example.test/v1', model: 'my-model', apiKey: 'secret-test-key',
  }, extra));
  return { ...t, calls, store, configure };
}
function reply(call, answers, extra = {}) {
  call.details.onload({ status: 200, responseText: JSON.stringify({ choices: [{
    finish_reason: 'stop', message: { content: JSON.stringify({ answers }) }, ...extra,
  }] }) });
}
const answerSet = [
  { id: '1', answer: ['A'], reason: '单选理由' },
  { id: '2', answer: ['A', 'C'], reason: '多选理由' },
  { id: '3', answer: ['B'], reason: '判断理由' },
];

(async () => {
  {
    const t = setup();
    assert.equal(t.calls.length, 0);
    t.configure();
    assert.equal(t.cx.ai.config().endpoint, 'https://ai.example.test/v1/chat/completions');
    assert.equal(t.cx.ai.config().hasKey, true);
    assert.equal(t.store.has('cx_ai_secret_v1'), false, '默认不能持久保存密钥');
    assert.equal(JSON.stringify(t.box.localStorage._m).includes('secret-test-key'), false);
    assert.equal(JSON.stringify(t.cx.ai.config()).includes('secret-test-key'), false);
    assert.equal(t.calls.length, 0, '保存配置不应调用付费接口');
    t.configure({ endpoint: 'https://ai.example.test/' });
    assert.equal(t.cx.ai.config().endpoint, 'https://ai.example.test/v1/chat/completions');
    console.log('PASS 密钥默认只在会话内，配置和站点 localStorage 不包含密钥');
  }
  {
    const t = setup();
    t.configure({ rememberKey: true });
    assert.equal(t.store.get('cx_ai_secret_v1'), 'secret-test-key');
    const reloaded = setup(t.store);
    assert.equal(reloaded.cx.ai.config().hasKey, true);
    assert.throws(() => reloaded.cx.ai.configure({ endpoint: 'https://another.example.test/v1', model: 'other' }), /API Key/);
    reloaded.cx.ai.clearKey();
    assert.equal(t.store.has('cx_ai_secret_v1'), false);
    assert.equal(reloaded.cx.ai.config().hasKey, false);
    assert.throws(() => reloaded.configure({ endpoint: 'http://remote.example.test/v1' }), /HTTPS/);
    console.log('PASS 可选择记住和清除密钥，换服务商不会沿用旧密钥');
  }
  {
    const t = setup();
    t.configure({ jsonMode: true });
    const pending = t.cx.ai.solve();
    assert.equal(t.calls.length, 1);
    const request = t.calls[0].details;
    const payload = JSON.parse(request.data);
    assert.equal(request.anonymous, true);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer secret-test-key');
    assert.equal(payload.model, 'my-model');
    assert.equal(payload.response_format.type, 'json_object');
    const sent = JSON.parse(payload.messages[1].content).questions;
    assert.deepEqual(sent[0].options, { C: '丙', A: '甲', B: '乙' });
    assert.equal(request.data.includes('secret-test-key'), false);
    assert.equal(request.data.includes('beginTime'), false);
    await assert.rejects(t.cx.ai.solve(), /正在执行/);
    reply(t.calls[0], answerSet);
    await pending;
    assert.equal(t.active.answerList.length, 0, 'AI 完成后只预览，不直接填写');
    assert.equal(t.requests.length, 0, 'AI 请求不能调用考试交卷 API');
    t.cx.ai.apply();
    assert.deepEqual(t.active.answerList.map((answer) => answer.answer), ['B', 'B,C', 'A']);
    assert.equal(t.requests.length, 0, '填入 AI 建议也不能交卷');
    assert.equal(JSON.stringify(t.cx.dump()).includes('secret-test-key'), false);
    console.log('PASS 只发送题目选项，预览和填写分离，随机映射正确且无自动交卷');
  }
  {
    const t = setup();
    t.configure();
    t.active.questionData[0].rightAnswer = 'A';
    t.active.answerList[2] = { examPaperItemId: 3, answer: 'B' };
    const pending = t.cx.ai.solve();
    const sent = JSON.parse(JSON.parse(t.calls[0].details.data).messages[1].content).questions;
    assert.deepEqual(sent.map((item) => item.id), ['2']);
    reply(t.calls[0], [{ id: '2', answer: ['A', 'C'], reason: '建议' }]);
    await pending;
    t.active.answerList[1] = { examPaperItemId: 2, answer: 'A', optionDictionary: { A: 'B', B: 'C', C: 'A' } };
    t.cx.ai.apply();
    assert.equal(t.active.answerList[0], undefined, 'AI 填写不能改写有平台答案的题目');
    assert.equal(t.active.answerList[1].answer, 'A', '不能覆盖 AI 等待期间的人工选择');
    assert.equal(t.active.answerList[2].answer, 'B');
    console.log('PASS 跳过已有答案和已作答题目，保留请求期间的人工修改');
  }
  {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    t.cx.ai.cancel();
    await pending;
    assert.equal(t.calls[0].aborted, true);
    reply(t.calls[0], answerSet);
    await flush();
    assert.equal(t.cx.state.ai.suggestions.length, 0);
    assert.equal(t.cx.state.ai.phase, 'cancelled');
    console.log('PASS 停止请求会取消网络，迟到结果不会写入建议');
  }
  for (const change of ['exam', 'options']) {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    if (change === 'exam') t.active.examId = 'other-exam';
    else t.active.questionData[0].randomOption = 'A,B,C';
    reply(t.calls[0], answerSet);
    await assert.rejects(pending, /试卷已切换/);
    assert.equal(t.cx.state.ai.suggestions.length, 0);
    assert.throws(() => t.cx.ai.apply(), /不属于当前试卷/);
    console.log(`PASS ${change} 变化后丢弃 AI 结果`);
  }
  for (const answers of [
    [{ id: 'unknown', answer: ['A'] }],
    [{ id: '1', answer: ['A'] }, { id: '1', answer: ['B'] }],
    [{ id: '1', answer: ['A', 'B'] }],
  ]) {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    reply(t.calls[0], answers);
    await assert.rejects(pending);
    assert.equal(t.cx.state.ai.suggestions.length, 0);
    assert.equal(t.active.answerList.length, 0);
  }
  console.log('PASS 拒绝未知题号、重复题号及不合法的单选答案');
  {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    reply(t.calls[0], [{ id: '1', answer: [], reason: '不确定' }]);
    await pending;
    assert.equal(t.cx.state.ai.suggestions[0].uncertain, true);
    assert.throws(() => t.cx.ai.apply(), /没有可填入/);
    console.log('PASS AI 不确定时保留未答，不猜填');
  }
  {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    t.calls[0].details.onload({ status: 401, responseText: 'secret-test-key' });
    await assert.rejects(pending, /HTTP 401/);
    assert.equal(JSON.stringify(t.cx.dump()).includes('secret-test-key'), false);
    assert.equal(t.calls.length, 1, '付费请求失败不应自动重试');
    console.log('PASS 接口错误不泄露密钥，也不自动重试计费请求');
  }
  {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    t.timeouts.find((timer) => timer.ms === 90000).fn();
    await assert.rejects(pending, /90 秒/);
    assert.equal(t.calls[0].aborted, true);
    console.log('PASS 独立超时会中止挂起请求');
  }
  {
    const t = setup();
    t.configure();
    t.active.questionData = Array.from({ length: 6 }, (_, i) => ({ ...t.active.questionData[0], examPaperItemId: i + 10 }));
    const pending = t.cx.ai.solve();
    reply(t.calls[0], Array.from({ length: 5 }, (_, i) => ({ id: String(i + 10), answer: ['A'] })));
    await flush();
    assert.equal(t.calls.length, 2);
    reply(t.calls[1], [{ id: '15', answer: ['A'] }]);
    await pending;
    assert.equal(t.cx.state.ai.processed, 6);
    assert.equal(t.cx.state.ai.suggestions.length, 6);
    console.log('PASS 每批最多五题，顺序处理并汇总建议');
  }
  {
    const t = setup();
    t.configure();
    const pending = t.cx.ai.solve();
    t.calls[0].details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '<script>bad()</script>' } }] }) });
    await assert.rejects(pending, /有效 JSON/);
    assert.equal(t.active.answerList.length, 0);
    console.log('PASS 不执行模型返回的代码或非 JSON 文本');
  }
  {
    const t = setup();
    t.configure();
    t.active.questionData = Array.from({ length: 6 }, (_, i) => ({ ...t.active.questionData[0], examPaperItemId: i + 10 }));
    const pending = t.cx.ai.solve();
    reply(t.calls[0], [{ id: '10', answer: ['A'], reason: '包含 secret-test-key 的异常回显' }]);
    await flush();
    t.calls[1].details.onload({ status: 429, responseText: 'secret-test-key' });
    await assert.rejects(pending, /HTTP 429/);
    assert.equal(t.cx.state.ai.suggestions.length, 1, '后续批次失败不应清除已校验的建议');
    t.cx.ai.apply();
    assert.equal(t.active.answerList[0].answer, 'B');
    assert.equal(JSON.stringify(t.cx.dump()).includes('secret-test-key'), false);
    console.log('PASS 批次失败保留已验证建议，预览及诊断隐藏密钥回显');
  }
  {
    const t = setupExam(true, { preparePage(box) {
      box.unsafeWindow = { document: box.document, XMLHttpRequest: box.XMLHttpRequest,
        location: box.location, addEventListener() {} };
      box.document = { getElementById() { throw new Error('不能从隔离世界读取页面 Vue'); } };
    } });
    assert.equal(t.api.inspect().active.count, 3);
    t.api.fill();
    assert.equal(t.active.current, 3);
    assert.ok(t.box.unsafeWindow.__CX);
    console.log('PASS GM 权限隔离环境仍通过 unsafeWindow 访问原页面 Vue 和面板');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
