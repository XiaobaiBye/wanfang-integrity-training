// 使用现有 DOM 桩，在独立 VM 中控制时钟和网络响应。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const fixture = fs.readFileSync(path.join(__dirname, 'rate-harness.js'), 'utf8')
  .split('const src = fs.readFileSync')[0];
const source = fs.readFileSync(path.join(__dirname, '../src/wf-auto-course.user.js'), 'utf8')
  .replace('  boot();', '  window.__test = { tick, afterVideo, captureContext, pushNet };\n  boot();');

function setup(savedConfig) {
  const timers = [];
  const requests = [];
  const box = {
    require, __dirname, console: { log() {}, table() {} },
    setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    fetch: (url) => new Promise((resolve) => requests.push({ url, resolve })),
  };
  box.global = box;
  vm.createContext(box);
  vm.runInContext(fixture + '\nglobal.fixture = { video, node, store };', box);
  if (savedConfig) box.localStorage.setItem('cx_cfg_v2', JSON.stringify(savedConfig));
  vm.runInContext(source, box);
  return { box, timers, requests, cx: box.window.__CX, api: box.window.__test, ...box.fixture };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function reply(request, nodes) {
  request.resolve({ ok: true, status: 200,
    text: async () => JSON.stringify({ courseTree: { sub: nodes } }) });
}

function attachNext(t) {
  const target = { ...t.node, name: '下一节', listResourceCode: '3.4', courseWareId: 'cw-2' };
  t.store.state.courseListTree.sub.push(target);
  let clicks = 0;
  const item = { textContent: target.name, closest: () => null, getClientRects: () => [1],
    contains: () => false, click: () => { clicks++; t.store.state.courseActiveList = target; } };
  t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? [item] : [];
  return { target, clicks: () => clicks };
}

(async () => {
  {
    const t = setup();
    t.node.isLearned.learnProgress = 277;
    t.api.tick();
    t.api.tick();
    assert.equal(t.requests.length, 1, '核对期间重复 tick 不应重复发起核对');
    t.cx.pause();
    const cur = t.video.currentTime;
    reply(t.requests[0], [t.node]);
    await flush();
    assert.equal(t.video.paused, true);
    assert.equal(t.video.currentTime, cur, '暂停后的旧核对不应触发补时 seek');
    assert.equal(t.cx.state.inTopUp, false);
    assert.equal(t.cx.runtime().taskPending, false);
    console.log('PASS 核对串行执行，暂停后旧任务失效');
  }
  {
    const t = setup();
    t.node.isLearned.learnProgress = 277;
    t.api.tick();
    t.store.state.courseId = 'another-course';
    t.store.state.courseActiveList = { ...t.node, name: '新课程', isLearned: {} };
    reply(t.requests[0], [t.node]);
    await flush();
    assert.equal(t.cx.state.serverTree, null);
    assert.equal(t.cx.state.verify['3.3'], undefined);
    assert.equal(t.cx.state.inTopUp, false);
    console.log('PASS 相同章节编号跨课程切换，旧响应不写入');
  }
  {
    const t = setup();
    t.video.currentTime = t.video.duration;
    t.video.ended = true;
    t.video.paused = true;
    t.api.tick();
    assert.equal(t.video.paused, true, '结尾不能先调用 play 重播');
    assert.equal(t.cx.runtime().taskPending, true);
    t.cx.pause();
    const settle = t.timers.find((timer) => timer.ms === 4000);
    assert.ok(settle);
    settle.fn();
    await flush();
    assert.equal(t.requests.length, 0, '结算等待期间暂停，应取消后续核对');
    t.cx.resume();
    t.api.tick();
    assert.equal(t.cx.state.videoDone, true, '恢复后允许重新结算');
    console.log('PASS 视频结尾结算与暂停恢复');
  }
  {
    const t = setup();
    t.cx.topUp();
    t.cx.pause();
    t.timers.filter((timer) => timer.ms === 400).forEach((timer) => timer.fn());
    assert.equal(t.video.paused, true);
    console.log('PASS 暂停后补时延迟回调不会重新播放');
  }
  {
    const t = setup({ finishGap: 1.5, verifyMode: 'lenient', strictComplete: true });
    assert.equal(t.cx.cfg.finishGap, 0);
    assert.equal(t.cx.cfg.verifyMode, 'strict');
    t.node.durationSec = 308;
    t.video.duration = 308.64;
    t.video.currentTime = 307.133468;
    t.cx.cfg.finishGap = 1.5; // 即使外部再次写旧值，也不能提前结算。
    t.api.tick();
    await flush();
    assert.equal(t.video.paused, false);
    assert.equal(t.cx.state.videoDone, false);
    assert.equal(t.timers.some((timer) => timer.ms === 4000), false);
    t.cx.state.inTopUp = true;
    t.api.tick();
    await flush();
    assert.equal(t.cx.state.videoDone, false);
    console.log('PASS 旧配置自动迁移，正常播放和补时均不会在差 1 秒时结算');
  }
  {
    const t = setup();
    t.node.durationSec = 1085;
    t.video.duration = 1085.125259;
    t.api.tick();
    await flush();
    // 模拟播放中的心跳把本地进度更新到最后一秒。
    t.node.isLearned.learnProgress = 1084.642187;
    t.video.currentTime = 1084.954466;
    t.api.tick();
    await flush();
    assert.equal(t.requests.length, 0, '末尾心跳不能触发进入章节时的核对分支');
    assert.equal(t.cx.state.inTopUp, false);
    assert.equal(t.video.currentTime, 1084.954466, '不能提前 seek(0)');
    assert.equal(t.video.paused, false);
    t.video.ended = true;
    t.video.paused = true;
    t.video.currentTime = t.video.duration;
    t.api.tick();
    assert.ok(t.timers.find((timer) => timer.ms === 4000), '自然结束后进入结算等待');
    console.log('PASS 播放中满进度心跳不会提前补时，仍等待自然结束');
  }
  {
    const t = setup();
    let switches = 0;
    t.store.commit = () => switches++;
    t.cx.cfg.verifyMode = 'lenient'; // 旧控制台配置不能绕过服务端核对。
    t.cx.cfg.topUp = false;
    t.node.isLearned.learnDuration = 277;
    t.cx.state.treeStale = true;
    const pending = t.api.afterVideo(t.api.captureContext());
    t.timers.find((timer) => timer.ms === 4000).fn();
    await flush();
    assert.equal(t.requests.length, 1, '疑似缓存时仍应核对');
    reply(t.requests[0], [t.node]);
    await pending;
    assert.equal(t.cx.cfg.running, false);
    assert.equal(t.cx.state.phase, 'blocked');
    assert.equal(switches, 0);
    console.log('PASS 本地时长满但服务端未确认时暂停，疑似缓存不会阻止核对');
  }
  {
    const t = setup();
    let switches = 0;
    t.store.commit = () => switches++;
    const pending = t.api.afterVideo(t.api.captureContext());
    t.timers.find((timer) => timer.ms === 4000).fn();
    await flush();
    reply(t.requests[0], [{ ...t.node, isLearned: { isLearned: true, learnDuration: 277, learnProgress: 277 } }]);
    await pending;
    assert.equal(t.cx.cfg.running, true);
    assert.equal(t.cx.state.verify['3.3'].ok, true);
    assert.equal(t.cx.state.phase, 'done');
    console.log('PASS 服务端确认完成后可以结束课程流程');
  }
  {
    const t = setup();
    t.cx.cfg.netLog = false;
    t.api.pushNet({ url: '/e-training/api/usercenter/insertrecord',
      expected: { key: t.cx.runtime().context, code: '3.3', resourceId: 'cw-1', title: t.node.name },
      body: JSON.stringify({ resourceId: 'wrong-chapter', title: '旧章节' }) });
    assert.equal(t.cx.cfg.running, false);
    assert.equal(t.cx.state.phase, 'blocked');
    assert.equal(t.cx.state.reportChecks[0].match, false);
    console.log('PASS 上报资源错位立即暂停，关闭网络日志也生效');
  }
  {
    const t = setup();
    const expected = { key: t.cx.runtime().context, resourceId: 'cw-1', code: '3.3' };
    t.api.pushNet({ url: '/e-training/api/usercenter/insertrecord', expected,
      body: JSON.stringify({ resourceId: 'cw-1' }), resp: '{}' });
    assert.equal(t.cx.state.reportChecks[0].match, true);
    assert.equal(t.cx.cfg.running, true);
    t.store.state.courseId = 'new-course';
    t.api.pushNet({ url: '/e-training/api/usercenter/insertrecord', expected,
      body: JSON.stringify({ resourceId: 'late-old-resource' }), resp: '{}' });
    assert.equal(t.cx.cfg.running, true, '旧页面请求响应不能暂停新课程');
    console.log('PASS 正确资源正常运行，旧上下文响应不会误停新课程');
  }
  {
    const t = setup();
    const nextNode = { ...t.node, name: '下一节', listResourceCode: '3.4', courseWareId: 'cw-2' };
    t.store.state.courseListTree.sub.push(nextNode);
    let commits = 0;
    let clicks = 0;
    t.store.commit = () => commits++;
    const item = { textContent: '下一节', closest: () => null,
      getClientRects: () => [1], contains: () => false,
      click: () => { clicks++; t.store.state.courseActiveList = nextNode; } };
    t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? [item] : [];
    t.cx.next();
    t.cx.next();
    assert.equal(clicks, 1, '等待切换期间不重复点击');
    assert.equal(commits, 0, '不能通过直接修改 Vuex 切节');
    assert.equal(t.store.state.courseActiveList, nextNode);
    t.api.tick();
    await flush();
    assert.equal(t.cx.cfg.running, true);
    console.log('PASS 通过原目录点击切节，不直接写 Vuex');
  }
  {
    const t = setup();
    t.store.state.courseListTree.sub.push({ ...t.node, name: '找不到的下一节', listResourceCode: '3.4' });
    let commits = 0;
    t.store.commit = () => commits++;
    t.cx.next();
    assert.equal(t.cx.cfg.running, false);
    assert.equal(t.cx.state.phase, 'blocked');
    assert.equal(commits, 0);
    console.log('PASS 无法定位目录项时暂停，保留当前章节');
  }
  {
    const t = setup();
    const completedQuiz = { contentType: 'quiz', listResourceCode: '3.6', isQuizLearned: true };
    const completedVideo = { ...t.node, listResourceCode: '4.4', isLearned: { isLearned: true } };
    const target = { ...t.node, name: '什么是学术署名', listResourceCode: '4.5' };
    t.store.state.courseListTree.sub.push(completedQuiz, completedVideo, target);
    let clicks = 0;
    const item = { textContent: target.name, closest: () => null, getClientRects: () => [1],
      contains: () => false, click: () => { clicks++; t.store.state.courseActiveList = target; } };
    t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? [item] : [];
    t.cx.next();
    assert.equal(clicks, 1);
    assert.equal(t.store.state.courseActiveList, target);
    assert.equal(t.cx.cfg.running, true);
    console.log('PASS 略过已完成且没有名称的测验和已完成视频，直接选择未完成章节');
  }
  {
    const t = setup();
    t.store.state.courseListTree.sub.push({ contentType: 'quiz', listResourceCode: '3.6', isQuizLearned: false });
    t.cx.next();
    assert.equal(t.cx.state.phase, 'blocked', '未完成测验不能直接略过');
    assert.equal(t.cx.state.marks['3.6'], undefined);
    console.log('PASS 未完成的测验仍保留处理，不当作已完成跳过');
  }
  {
    const t = setup();
    const target = { contentType: 'quiz', listResourceCode: '5.6', isQuizLearned: false };
    const following = { ...t.node, name: '第六章导言', listResourceCode: '6.1' };
    t.store.state.courseListTree.sub.push(target, following);
    let selected = null;
    const make = (text, order) => ({ textContent: text, order, closest: () => null,
      getClientRects: () => [1], contains: () => false,
      compareDocumentPosition(other) { return this.order < other.order ? 4 : 2; },
      click() { selected = order; t.store.state.courseActiveList = target; } });
    const items = [make('随堂测验', 0), make(t.node.name, 1), make('随堂测验', 2),
      make(following.name, 3), make('随堂测验', 4)];
    t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? items : [];
    t.cx.next();
    assert.equal(selected, 2);
    assert.equal(t.store.state.courseActiveList, target);
    assert.equal(t.cx.cfg.running, true);
    console.log('PASS 未命名测验通过前后课件定位，多个同名测验不会串章');
  }
  {
    const t = setup();
    const target = { contentType: 'quiz', listResourceCode: '5.6', isQuizLearned: false,
      courseWareId: '11111111-2222-3333-4444-555555555555' };
    t.store.state.courseListTree.sub.push(target);
    let clicks = 0;
    const item = { textContent: '随堂测验', closest: () => null, getClientRects: () => [1],
      contains: () => false, __vue__: { $props: { item: target } },
      click: () => { clicks++; t.store.state.courseActiveList = target; } };
    const container = { ...item, textContent: '目录', __vue__: { $props: { items: [target] } },
      click: () => { throw new Error('不能点击整份课程树容器'); } };
    t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? [container, item] : [];
    t.cx.next();
    assert.equal(clicks, 1);
    console.log('PASS 通过 Vue 绑定资源 ID 进入未命名测验，不把目录容器当作课件');
  }
  {
    const t = setup();
    const target = { contentType: 'quiz', listResourceCode: '5.6', isQuizLearned: false };
    t.store.state.courseListTree.sub.push(target);
    const make = (text, order) => ({ textContent: text, order, closest: () => null,
      getClientRects: () => [1], contains: () => false,
      compareDocumentPosition(other) { return this.order < other.order ? 4 : 2; },
      click() { throw new Error('多个候选不能自动点击'); } });
    const items = [make(t.node.name, 1), make('随堂测验', 2), make('随堂测验', 3)];
    t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? items : [];
    t.cx.next();
    assert.equal(t.cx.cfg.running, false);
    assert.equal(t.cx.state.navigationDiagnostics[0].quizLabels.length, 2);
    console.log('PASS 目录区间存在多个测验时暂停，并导出定位诊断');
  }
  for (const via of ['label', 'vnode']) {
    const t = setup();
    const target = { contentType: 'quiz', listResourceCode: '5.6', isQuizLearned: false,
      courseWareId: '11111111-2222-3333-4444-555555555555' };
    t.store.state.courseListTree.sub.push(target);
    let parentClicks = 0;
    let childClicks = 0;
    const child = { textContent: via === 'label' ? '随堂测验' : '进入',
      closest: () => null, getClientRects: () => [1], contains: () => false,
      click: () => { childClicks++; t.store.state.courseActiveList = target; } };
    const root = { textContent: '第五章目录', closest: () => null, getClientRects: () => [1],
      contains: (el) => el === child,
      __vue__: { $props: { item: target }, _vnode: { children: [{ elm: child, data: { on: { click() {} } } }] } },
      click: () => { parentClicks++; } };
    t.box.document.querySelectorAll = (selector) => selector === 'a,button,span,div,li' ? [root, child] : [];
    t.cx.next();
    assert.equal(childClicks, 1);
    assert.equal(parentClicks, 0, '不能只点击无事件的绑定容器');
    assert.equal(t.store.state.courseActiveList, target);
    t.api.tick();
    assert.equal(t.cx.state.navigationDiagnostics[0].result, 'switched');
    t.cx.pause();
    console.log(`PASS ${via} 方式点击组件内部真实入口，并记录成功切换`);
  }
  for (const topUp of [false, true]) {
    const t = setup();
    const nav = attachNext(t);
    t.cx.state.inTopUp = topUp;
    t.cx.state.verify['3.3'] = { ok: false, ts: Date.now(), learnDuration: 120 };
    const pending = t.cx.check();
    reply(t.requests[0], [{ ...t.node, isLearned: { isLearned: true, learnDuration: 260, learnProgress: 260 } }]);
    await pending;
    assert.equal(nav.clicks(), 1);
    assert.equal(t.store.state.courseActiveList, nav.target);
    assert.equal(t.cx.state.inTopUp, false);
    assert.equal(t.cx.state.verify['3.3'].ok, true);
    assert.equal(t.video.paused, true);
    console.log(`PASS ${topUp ? '补时' : '正常播放'}中服务端确认即切节，旧未完成状态同步更新`);
  }
  for (const mode of ['paused', 'autoNext-off', 'unconfirmed']) {
    const t = setup();
    const nav = attachNext(t);
    if (mode === 'paused') t.cx.pause();
    if (mode === 'autoNext-off') t.cx.cfg.autoNext = false;
    const pending = t.cx.check();
    reply(t.requests[0], [{ ...t.node, isLearned: { isLearned: mode !== 'unconfirmed', learnDuration: 277, learnProgress: 277 } }]);
    await pending;
    assert.equal(nav.clicks(), 0);
    console.log(`PASS ${mode} 时对账不会触发自动切节`);
  }
  {
    const t = setup();
    const nav = attachNext(t);
    t.node.isLearned.learnProgress = 277;
    t.api.tick(); // 老的未完成核对仍在等待。
    const check = t.cx.check();
    reply(t.requests[1], [{ ...t.node, isLearned: { isLearned: true, learnDuration: 277, learnProgress: 277 } }]);
    await check;
    reply(t.requests[0], [t.node]);
    await flush();
    assert.equal(nav.clicks(), 1);
    assert.equal(t.store.state.courseActiveList, nav.target);
    assert.equal(t.cx.state.inTopUp, false);
    assert.equal(t.cx.state.verify['3.3'].ok, true);
    console.log('PASS 完成对账废弃旧核对任务，迟到响应不会触发重复切节或补时');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
