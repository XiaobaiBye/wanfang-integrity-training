// 倍速模块回归测试：用最小 DOM/Vue 桩加载脚本，验证倍速写入与回退
const fs = require('fs');
const path = require('path');

const registry = {};
function FakeEl(id) {
  this.id = id || '';
  this.style = {};
  this.textContent = '';
  this._html = '';
  this.onclick = null;
  this.children = [];
}
Object.defineProperty(FakeEl.prototype, 'innerHTML', {
  get() { return this._html; },
  set(v) { this._html = v; },
});
FakeEl.prototype.appendChild = function (c) { this.children.push(c); return c; };
FakeEl.prototype.contains = function () { return true; };
FakeEl.prototype.addEventListener = function () {};
FakeEl.prototype.removeChild = function () {};
FakeEl.prototype.querySelector = function (sel) {
  const id = String(sel).replace('#', '');
  if (!registry[id]) registry[id] = new FakeEl(id);
  return registry[id];
};
FakeEl.prototype.querySelectorAll = function () { return []; };

const video = {
  playbackRate: 1, defaultPlaybackRate: 1, currentTime: 159.15, duration: 276.96,
  paused: false, ended: false, readyState: 4, muted: false, volume: 1,
  play() { this.paused = false; }, pause() { this.paused = true; },
};

const node = {
  listResourceCode: '3.3', name: '文献和数据的收集', contentType: 'video',
  durationSec: 277, duration: '4:37', videoId: 'vid-1', courseWareId: 'cw-1',
  isLearned: { isLearned: false, learnDuration: 90.1, learnProgress: 159.15 },
};
const store = {
  state: {
    courseId: 'ec66edb9', courseName: '测试课程',
    courseActiveList: node,
    courseListTree: { sub: [node] },
  },
  commit() {},
};
const page = { $refs: { player: { inPlayer: {
  getCurrentTime: () => video.currentTime,
  getDuration: () => video.duration,
  play: () => video.play(), pause: () => video.pause(),
  seek: (t) => { video.currentTime = t; },
  setSpeed: (r) => { video.playbackRate = r; },
  setVolume: () => {},
} } } };
const root = { $store: store, $children: [page], $refs: {} };

const app = new FakeEl('app');
app.__vue__ = root;

global.window = {
  addEventListener() {}, location: { href: '' },
  setInterval, clearInterval, setTimeout, clearTimeout,
};
global.location = { href: 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=ec66edb9' };
global.window.location = global.location;
global.document = {
  getElementById: (id) => (id === 'app' ? app : null),
  createElement: () => new FakeEl(''),
  querySelector: (sel) => (sel === 'video' ? video : null),
  querySelectorAll: (sel) => (sel === 'video' ? [video] : []),
  addEventListener() {},
  body: new FakeEl('body'),
  visibilityState: 'visible',
  hidden: false,
};
global.navigator = { userAgent: 'node-test', clipboard: null };
global.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] === undefined ? null : this._m[k]; },
  setItem(k, v) { this._m[k] = String(v); },
};
global.screen = { width: 1920, height: 1080 };
global.XMLHttpRequest = function () {
  this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {};
  this.addEventListener = () => {};
};

const src = fs.readFileSync(path.join(__dirname, '..', 'src/wf-auto-course.user.js'), 'utf8');
new Function(src)();

const CX = global.window.__CX;
const ok = (label, cond, extra) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);

setTimeout(() => {
  console.log('=== 1. 循环点击倍速按钮（1→1.25→1.5→1.75→2→1） ===');
  const seq = [];
  for (let i = 0; i < 5; i++) {
    registry['cx-rate'].onclick();
    seq.push(`cfg=${CX.cfg.rate} actual=${video.playbackRate}`);
  }
  console.log('  ' + seq.join(' | '));
  ok('点 5 次回到 1x，且视频真的回到 1x', CX.cfg.rate === 1 && Math.abs(video.playbackRate - 1) < 0.01, `cfg=${CX.cfg.rate} actual=${video.playbackRate}`);

  console.log('=== 2. 逐级设置并检查是否落到 video 上 ===');
  [1.25, 1.5, 1.75, 2, 1].forEach((r) => {
    CX.rate(r);
    ok(`__CX.rate(${r})`, Math.abs(video.playbackRate - r) < 0.01, `actual=${video.playbackRate}`);
  });

  console.log('=== 3. 播放器把倍速重置回 1，守护是否纠正 ===');
  CX.rate(1.5);
  video.playbackRate = 1; // 模拟平台/播放器重置
  setTimeout(() => {
    ok('800ms 内被纠正回 1.5x', Math.abs(video.playbackRate - 1.5) < 0.01, `actual=${video.playbackRate} fixes=${CX.state.rateFixes}`);

    console.log('=== 4. 面板显示的是真实倍速 ===');
    CX.rate(2);
    video.playbackRate = 1.25; // 目标与真实不一致
    const t = registry['cx-time'];
    setTimeout(() => {
      ok('目标 2x 被纠正', Math.abs(video.playbackRate - 2) < 0.01, `actual=${video.playbackRate}`);
      console.log('  面板文案:', registry['cx-time'].textContent, '| 缺口:', registry['cx-gap'].textContent);
      console.log('  rateInfo:', JSON.stringify(CX.rateInfo().rate || CX.rateInfo()));

      console.log('=== 5. 补时缺口必须按服务端口径算（v1.3.1 核心修复） ===');
      CX.state.verify['3.3'] = { ok: false, learnDuration: 0, learnProgress: 0, ts: Date.now() };
      CX.state.ledger['3.3'] = { at: new Date().toISOString(), server: { none: true, d: 0, p: 0, ok: false }, local: { d: 90, p: 159 } };
      setTimeout(() => {
        const gap = registry['cx-gap'].textContent;
        const srv = registry['cx-srv'].textContent;
        ok('服务端 0s 时缺口应约 4:31（不是 0）', /差 4:3[0-9]/.test(gap), gap);
        ok('服务端状态提示无记录', /无记录/.test(srv), srv);
        console.log('  面板:', gap, '|', srv);

        CX.state.verify['3.3'] = { ok: true, learnDuration: 277, learnProgress: 277, ts: Date.now() };
        CX.state.ledger['3.3'] = { at: new Date().toISOString(), server: { none: false, d: 277, p: 277, ok: true }, local: { d: 277, p: 277 } };
        setTimeout(() => {
          const g2 = registry['cx-gap'].textContent;
          ok('服务端 277s（满）时缺口应为 0', /差 0:00/.test(g2), g2);
          console.log('  面板:', g2, '|', registry['cx-srv'].textContent);
          process.exit(0);
        }, 1500);
      }, 1500);
    }, 900);
  }, 900);
}, 600);
