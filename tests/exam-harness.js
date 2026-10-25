const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const fixture = fs.readFileSync(path.join(__dirname, 'rate-harness.js'), 'utf8').split('const src = fs.readFileSync')[0];
const source = fs.readFileSync(path.join(__dirname, '../src/wf-auto-course.user.js'), 'utf8');
function setup(started = true, additions = {}) {
  const timeouts = [];
  const intervals = [];
  const cleared = [];
  const requests = [];
  const box = { require, __dirname, console: { log() {}, table() {} },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; }, clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => cleared.push(id),
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  };
  Object.assign(box, additions);
  box.global = box;
  vm.createContext(box);
  vm.runInContext(fixture + '\nglobal.fixture = { root, registry, video };', box);
  const active = { examId: 'exam-1', title: '测试试卷', beginTime: new Date().toISOString(), examDuration: 30,
    questionData: [
      { examPaperItemId: 1, title: '单选', type: 0, randomOption: 'C,A,B', rightAnswer: 'A', randomOptionText: ['丙', '甲', '乙'] },
      { examPaperItemId: 2, title: '多选', type: 1, randomOption: 'B,C,A', rightAnswer: 'A,C', randomOptionText: ['乙', '丙', '甲'] },
      { examPaperItemId: 3, title: '判断', type: 2, randomOption: 'B,A', rightAnswer: 'B', randomOptionText: ['错', '对'] },
    ], answerList: [], current: 1, $children: [], $set: (array, index, value) => { array[index] = value; } };
  const clock = { timer: 99, $children: [], submitExamPaper() {}, countDown() { this.restarted = true; } };
  active.$children.push(clock);
  const board = { exams: [{ examId: 'exam-1', title: '测试试卷', remainTimes: 2 }],
    step: started ? 3 : 1, $refs: started ? { inexam: active } : {}, $children: started ? [active] : [],
    examInfo({ eId }) { this.step = 2; this.$refs.requirement = { exam: { examId: eId, examDuration: 30 } }; },
    bgExam(claim) { assert.equal(claim.examId, 'exam-1'); this.step = 3; this.$refs.inexam = active; this.$children = [active]; },
  };
  box.fixture.root.$children = [board];
  box.location.href = 'https://cx.wanfangdata.com.cn/e-training/exam/examboard';
  let playCalls = 0;
  box.fixture.video.play = () => { playCalls++; };
  if (typeof additions.preparePage === 'function') additions.preparePage(box);
  vm.runInContext(source, box);
  const exposedWindow = box.unsafeWindow || box.window;
  return { box, active, board, clock, requests, timeouts, intervals, cleared,
    cx: exposedWindow.__CX, api: exposedWindow.__CX.examBoard, playCalls: () => playCalls };
}
function reply(request, data, ok = true) {
  request.resolve({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(data) });
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

(async () => {
  {
    const t = setup(false);
    assert.ok(t.box.fixture.registry['cx-exam-start']);
    assert.equal(t.requests.length, 0, '考试页启动不应生成试卷或提交');
    assert.equal(t.playCalls(), 0);
    await t.api.start('exam-1');
    assert.equal(t.board.step, 3);
    assert.equal(t.api.inspect().active.count, 3);
    assert.equal(t.requests.length, 0, '通过页面原流程开始，不重复请求随机试卷');
    await assert.rejects(t.api.start('exam-1'), /已有考试/);
    console.log('PASS 考试页独立启动，通过页面流程开始，不自动播放或提交');
  }
  {
    const t = setup();
    t.api.fill();
    assert.deepEqual(t.active.answerList.map((record) => record.answer), ['B', 'B,C', 'A']);
    assert.equal(JSON.stringify(t.active.answerList[0].optionDictionary), JSON.stringify({ A: 'C', B: 'A', C: 'B' }));
    assert.equal(t.active.current, 3);
    assert.equal(t.requests.length, 0);
    console.log('PASS 单选、多选、判断题按随机顺序映射，填写不交卷');
    const pending = t.api.submit();
    assert.equal(t.requests.length, 1);
    assert.ok(t.cleared.includes(99), '提交期间停止页面重复交卷定时器');
    await assert.rejects(t.api.submit(), /请勿重复/);
    const body = JSON.parse(t.requests[0].init.body);
    assert.equal(body.beginTime, t.active.beginTime);
    assert.equal(body.answers[1].answer, 'B,C');
    reply(t.requests[0], { success: true });
    await pending;
    assert.equal(t.cx.state.examBoard.phase, 'submitted');
    await assert.rejects(t.api.submit(), /已经提交/);
    console.log('PASS 使用真实开始时间交卷，阻止并发和重复提交');
  }
  {
    const t = setup();
    delete t.active.questionData[1].rightAnswer;
    t.api.fill();
    assert.equal(t.active.answerList[1], undefined);
    await assert.rejects(t.api.submit(), /第 2 题尚未作答/);
    assert.equal(t.requests.length, 0);
    t.api.fill({ 2: 'A,C' });
    assert.equal(t.active.answerList[1].answer, 'B,C');
    console.log('PASS 缺答案保持未答并阻止交卷，支持导入原始答案');
  }
  {
    const t = setup();
    assert.throws(() => t.api.fill({ 1: 'A,B' }), /只能选择一个/);
    assert.equal(t.active.answerList.length, 0, '校验全部通过之前不能部分填写');
    t.active.questionData[1].randomOption = 'A,A,B';
    assert.throws(() => t.api.fill(), /映射无效/);
    console.log('PASS 拒绝无效单选和重复随机映射，写入前统一校验');
  }
  {
    const t = setup();
    const child = { examPaperItemId: 1, selectedOptions: [], $children: [],
      change(selected) { this.called = selected; t.active.answerList[0] = {
        examPaperItemId: 1, answer: selected, optionDictionary: { A: 'C', B: 'A', C: 'B' } }; } };
    t.active.$children.push(child);
    t.api.fill();
    assert.equal(child.selectedOptions, 'B');
    assert.equal(child.called, 'B');
    console.log('PASS 调用页面题目组件事件，同步选中状态和答题记录');
  }
  {
    const t = setup();
    t.api.fill();
    const pending = t.api.submit();
    reply(t.requests[0], { success: false, message: '稍后重试' });
    await assert.rejects(pending, /稍后重试/);
    assert.equal(t.clock.restarted, true);
    assert.equal(t.cx.state.examBoard.phase, 'error');
    console.log('PASS 交卷拒绝保留答案，并恢复页面倒计时');
  }
  {
    const t = setup();
    t.api.fill();
    const pending = t.api.submit();
    t.active.examId = 'another-exam';
    t.clock.timer = 100;
    reply(t.requests[0], { success: true });
    await pending;
    assert.notEqual(t.cx.state.examBoard.phase, 'submitted');
    assert.equal(t.cleared.includes(100), false, '旧提交不能停掉新试卷倒计时');
    assert.doesNotThrow(() => t.api.fill(), '复用同一 Vue 实例的新试卷不应被视为已提交');
    console.log('PASS 切换试卷后旧响应不会将新试卷标为已提交');
  }
  {
    const t = setup(false);
    t.board.examInfo = () => {};
    const pending = t.api.start('exam-1');
    t.box.location.href = 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn';
    t.timeouts.find((timer) => timer.ms === 200).fn();
    await assert.rejects(pending, /页面或试卷已切换/);
    console.log('PASS 加载试卷期间离开页面会取消后续开始操作');
  }
  {
    const t = setup(false);
    t.board.exams[0].remainTimes = 0;
    await assert.rejects(t.api.start('exam-1'), /剩余次数/);
    assert.equal(t.board.step, 1);
    console.log('PASS 无剩余次数时不启动考试');
  }
  {
    const t = setup();
    t.api.fill();
    t.active.questionData[0].randomOption = 'A,B,C';
    await assert.rejects(t.api.submit(), /选项映射已变化/);
    assert.equal(t.requests.length, 0);
    console.log('PASS 随机选项改变后旧答卷不能提交');
  }
  {
    const t = setup();
    t.api.fill();
    t.active.beginTime = new Date(Date.now() - 31 * 60000).toISOString();
    await assert.rejects(t.api.submit(), /考试时间已到/);
    assert.equal(t.requests.length, 0);
    console.log('PASS 到期后不额外发起助手交卷');
  }
  {
    const t = setup();
    const routeWatcher = t.intervals.find((timer) => timer.ms === 800);
    t.box.location.href = 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=test';
    routeWatcher.fn();
    assert.ok(t.box.fixture.registry['cx-rate'], '切回课程页恢复课程面板');
    t.box.location.href = 'https://cx.wanfangdata.com.cn/e-training/exam/examboard';
    routeWatcher.fn();
    assert.match(t.box.fixture.registry['cx-exam-status'].textContent, /测试试卷/);
    assert.equal(t.requests.length, 0);
    console.log('PASS history 路由在课程和考试间切换时自动切换面板');
  }
  await flush();
})().catch((error) => { console.error(error); process.exitCode = 1; });
