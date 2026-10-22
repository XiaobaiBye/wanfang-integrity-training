// ==UserScript==
// @name         万方诚信培训 · 自动刷课助手
// @namespace    https://cx.wanfangdata.com.cn/
// @version      1.4.5
// @description  自动播放 / 跳过已完成 / 服务端落库对账 / 随堂测验两阶段作答 / 自动考试 / 反后台暂停 / 倍速守护 / 诊断包
// @author       local
// @match        https://cx.wanfangdata.com.cn/e-training/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__CX_LOADED__) return;
  window.__CX_LOADED__ = true;

  const VERSION = '1.4.5';
  const LS_KEY = 'cx_cfg_v2';

  /* ==================== 配置 ==================== */
  const DEFAULTS = {
    configVersion: 2,
    running: true,
    rate: 1.0,
    rateGuard: true,         // 倍速守护：服务端只认真实时长时自动降速
    completeRatio: 1.0,      // 必须补满：275.99/277 这种差 1 秒服务端就不认
    mute: true,
    autoNext: true,
    autoQuiz: true,
    quizStrategy: 'probe',   // probe=两阶段探测；manual=暂停等人工
    autoExam: false,
    finishGap: 0,            // 兼容旧配置；完成判断改用自然 ended，不再提前结算
    skipFinished: true,
    verify: true,
    topUp: true,
    strictComplete: true,    // 服务端不认可的节点不静默跳过，暂停等处理
    verifyMode: 'strict',    // 核对失败暂停，不再按本地时长放行
    settleWait: 4000,        // 播完后等多久让平台结算再核对
    tickMs: 1200,
    selfHeal: true,
    netLog: true,
  };
  const savedCfg = loadCfg();
  const CFG = Object.assign({}, DEFAULTS, savedCfg);
  if (savedCfg.configVersion !== DEFAULTS.configVersion) {
    CFG.configVersion = DEFAULTS.configVersion;
    CFG.finishGap = 0;
    CFG.verifyMode = 'strict';
    CFG.strictComplete = true;
    saveCfg();
  }

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveCfg() {
    try {
      const keep = {};
      Object.keys(DEFAULTS).forEach((k) => { if (k !== 'running') keep[k] = CFG[k]; });
      localStorage.setItem(LS_KEY, JSON.stringify(keep));
    } catch (e) { /* ignore */ }
  }

  const S = {
    phase: 'idle',
    lastCode: null,
    videoDone: false,
    entryChecked: false,
    topUpRound: 0,
    inTopUp: false,
    topUpBase: null,
    topUpAccum: 0,
    topUpTick: 0,
    topUpSrvBefore: null,  // 进入补时前服务端时长，用来判断补时有没有真的落库
    topUpNeed: 0,          // 本轮要补的真实秒数
    noPersist: {},         // { code: true } 服务端不落库，补时无效
    examTried: false,
    busy: false,
    logs: [],
    errors: [],
    net: [],
    marks: {},
    verify: {},
    serverTree: null,
    serverRaw: null,
    serverAt: 0,
    stuckSince: 0,
    stallWarned: false,
    stallSeeked: false,
    stallBlocked: false,
    lastCur: -1,
    rateUnsafe: {},        // { '1.5': true } 实测不安全、被守护降速过的倍速
    rateFixes: 0,          // 实际倍速被纠正的次数（诊断用）
    rateLastFixAt: null,
    rateEvents: [],        // 倍速变更与纠正记录
    hb: { count: 0, ok: 0, reject: 0, ins: 0, insOk: 0, deltas: [], short: 0, lastDelta: null, ids: [], firstAt: null, lastAt: null, samples: [] },
    ledger: {},            // 服务端落库对账：{ code: {server, local} }
    ledgerPrev: {},        // 上次对账时服务端时长
    ledgerMiss: {},        // 服务端时长连续未增长次数
    ledgerSig: {},         // 服务端记录指纹，用于检测"接口返回一直不变"
    ledgerSame: {},        // 指纹连续相同次数
    treeStale: false,      // 课程树连续返回同一份数据 → 核对不可用
    ledgerWarned: {},
    ledgerAt: 0,
    ledgerBusy: false,
    reportChecks: [],
  };

  const isQuality = () => /\/quality\//.test(location.href);
  const courseApi = () => (isQuality() ? '/api/course/quality/' : '/api/course/lecture/');

  // 每次暂停、切节都会废弃旧任务。身份包含课程、节点和页面地址。
  let generation = 0;
  let activeTask = null;
  let pendingNavigation = null;
  function contextKey() {
    const store = getStore();
    const state = store && store.state;
    return JSON.stringify([location.href, state && state.courseId,
      state && state.courseActiveList && state.courseActiveList.listResourceCode]);
  }
  function captureContext() { return { generation, key: contextKey() }; }
  function isCurrent(ctx) {
    return CFG.running && ctx.generation === generation && ctx.key === contextKey();
  }
  function invalidateTask() {
    generation++;
    activeTask = null;
    pendingNavigation = null;
    S.busy = false;
  }
  function scheduleCurrent(fn, delay) {
    const ctx = captureContext();
    setTimeout(() => { if (isCurrent(ctx)) fn(); }, delay);
  }

  /* ==================== 日志 ==================== */
  function log(msg, type) {
    const t = new Date().toTimeString().slice(0, 8);
    S.logs.push({ t, msg: String(msg), type: type || 'info' });
    if (S.logs.length > 200) S.logs.shift();
    const c = { info: '#2c2c2a', ok: '#3b6d11', warn: '#854f0b', err: '#a32d2d' }[type] || '#2c2c2a';
    console.log(`%c[CX ${t}] ${msg}`, `color:${c}`);
    renderPanel();
  }
  function errLog(where, e) {
    const item = { t: new Date().toISOString(), where, msg: (e && e.message) || String(e), stack: e && e.stack ? String(e.stack).slice(0, 800) : '' };
    S.errors.push(item);
    if (S.errors.length > 50) S.errors.shift();
    log(`${where} 异常：${item.msg}`, 'err');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function transformToSec(str) {
    if (!str) return 0;
    const p = String(str).split(':').map((x) => parseInt(x, 10) || 0);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0] || 0;
  }
  function nodeSec(node) {
    if (!node) return 0;
    if (node.durationSec) return node.durationSec;
    if (node.duration) return transformToSec(node.duration);
    return 0;
  }

  /* ==================== 网络录制 ==================== */
  function clip(s, n) {
    s = typeof s === 'string' ? s : JSON.stringify(s);
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function pushNet(rec) {
    // 对比发送时的课程身份，不能拿响应到达时的新章节作比较。
    if (/usercenter\/insertrecord/.test(rec.url) && rec.expected) {
      let body;
      try { body = JSON.parse(rec.body); } catch (e) { /* ignore */ }
      const expected = rec.expected;
      if (body && body.resourceId && expected.resourceId) {
        const normalize = (id) => String(id || '').toLowerCase();
        const match = normalize(body.resourceId) === normalize(expected.resourceId) &&
          (!body.courseId || normalize(body.courseId) === normalize(expected.courseId));
        S.reportChecks.push({ at: rec.at, code: expected.code, expected, actual: {
          resourceId: body.resourceId, courseId: body.courseId, title: body.title,
        }, match });
        if (S.reportChecks.length > 30) S.reportChecks.shift();
        if (!match && CFG.running && expected.key === contextKey()) {
          S.phase = 'blocked';
          log(`上报对象错位：当前 ${expected.code}「${expected.title}」，上报却为「${body.title || body.resourceId}」。已暂停，请在页面目录手动重新选择当前节`, 'err');
          setRunning(false);
        }
      }
    }
    if (!CFG.netLog) return;
    S.net.push(rec);
    if (S.net.length > 300) S.net.shift();

    if (/usercenter\/(insertrecord|updatelearncount)/.test(rec.url)) {
      const isIns = /insertrecord/.test(rec.url);
      S.hb.count++;
      S.hb.lastAt = rec.at;
      if (!S.hb.firstAt) S.hb.firstAt = rec.at;
      let body = null, resp = null;
      try { body = JSON.parse(rec.body || '{}'); } catch (e) { /* ignore */ }
      try { resp = JSON.parse(rec.resp || '{}'); } catch (e) { /* ignore */ }
      const ok = !!(resp && resp.success === true);
      if (ok) S.hb.ok++; else S.hb.reject++;
      if (isIns && resp && resp.id !== undefined) {
        S.hb.ids.push(resp.id);
        if (S.hb.ids.length > 30) S.hb.ids.shift();
      }

      // 只有 insertrecord 才累计学习时长；上报窗口 = endTime - learnTime
      let delta = null;
      if (isIns && body && body.learnTime && body.endTime) {
        delta = (new Date(body.endTime) - new Date(body.learnTime)) / 1000;
        if (isFinite(delta)) {
          S.hb.ins++;
          if (ok) S.hb.insOk++;
          S.hb.lastDelta = +delta.toFixed(1);
          S.hb.deltas.push(+delta.toFixed(1));
          if (S.hb.deltas.length > 60) S.hb.deltas.shift();
          if (delta < 30) {
            S.hb.short++;
            if (S.hb.short === 1) log(`短窗口上报 ${delta.toFixed(1)}s：${ok ? '接口已接受' : '接口未确认成功' + (resp && resp.message ? '（' + resp.message + '）' : '')}，是否计入时长以服务端对账为准`, ok ? 'warn' : 'err');
          }
        }
      }
      S.hb.samples.push({
        at: rec.at,
        api: rec.url.split('/').pop(),
        expected: rec.expected,
        resourceId: body && body.resourceId,
        title: body && body.title,
        courseId: body && body.courseId,
        status: rec.status,
        learnProgress: body && body.learnProgress,
        learnTime: body && body.learnTime,
        endTime: body && body.endTime,
        delta: delta == null ? null : +delta.toFixed(1),
        resp: resp ? clip(resp, 300) : null,
      });
      if (S.hb.samples.length > 120) S.hb.samples.shift();
      if (isIns && ok) scheduleLedgerCheck();
    }
  }

  function installNetHook() {
    if (window.__CX_NET_HOOKED__) return;
    window.__CX_NET_HOOKED__ = true;
    try {
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) {
        this.__cx = { method: m, url: String(u) };
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        const meta = this.__cx;
        if (meta && /\/api\//.test(meta.url)) {
          const rec = { at: new Date().toISOString(), method: meta.method, url: meta.url, body: clip(body, 1200), status: 0, resp: '' };
          const store = getStore();
          const node = store && store.state.courseActiveList;
          if (node) rec.expected = { key: contextKey(), code: node.listResourceCode,
            title: node.name, resourceId: node.courseWareId, courseId: store.state.courseId };
          // 课程树响应体较大，放宽截断长度，便于完整核对
          const maxResp = /\/api\/course\//.test(meta.url) ? 300000 : 2000;
          this.addEventListener('load', () => {
            rec.status = this.status;
            rec.resp = clip(this.responseText, maxResp);
            pushNet(rec);
          });
          this.addEventListener('error', () => { rec.status = -1; pushNet(rec); });
        }
        return send.apply(this, arguments);
      };
      log('已接管 XHR 录制（诊断用）');
    } catch (e) { errLog('installNetHook', e); }
  }

  function installErrorHook() {
    window.addEventListener('error', (e) => {
      S.errors.push({ t: new Date().toISOString(), where: 'window.error', msg: e.message, stack: clip(e.error && e.error.stack, 600) });
      if (S.errors.length > 50) S.errors.shift();
    });
    window.addEventListener('unhandledrejection', (e) => {
      S.errors.push({ t: new Date().toISOString(), where: 'unhandledrejection', msg: String((e.reason && e.reason.message) || e.reason), stack: '' });
      if (S.errors.length > 50) S.errors.shift();
    });
  }

  /* ==================== 请求封装 ==================== */
  async function api(path, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    let url = path.startsWith('http') ? path : '/e-training' + path;
    // 关键：/api/course/quality/{id} 会被浏览器或代理缓存，核对时会一直读到页面加载时的旧快照
    if (method === 'GET') url += (url.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
    const init = {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(url, init);
    const text = await res.text();
    const maxResp = /\/api\/course\//.test(url) ? 300000 : 2000;
    pushNet({ at: new Date().toISOString(), method: init.method, url, body: clip(init.body, 1200), status: res.status, resp: clip(text, maxResp), mine: true });
    if (!res.ok) throw new Error(`${init.method} ${url} → HTTP ${res.status}`);
    try { return text ? JSON.parse(text) : {}; } catch (e) { return { raw: text }; }
  }

  /* ==================== Vue 实例访问 ==================== */
  function getRoot() {
    const el = document.getElementById('app');
    if (el && el.__vue__) return el.__vue__;
    if (document.body && document.body.__vue__) return document.body.__vue__;
    return null;
  }
  function getStore() {
    const r = getRoot();
    return r && r.$store ? r.$store : null;
  }
  function walk(vm, fn, depth) {
    depth = depth || 0;
    if (!vm || depth > 40) return null;
    try { if (fn(vm)) return vm; } catch (e) { /* ignore */ }
    const kids = vm.$children || [];
    for (let i = 0; i < kids.length; i++) {
      const hit = walk(kids[i], fn, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  function findPage() {
    const root = getRoot();
    if (!root) return null;
    return walk(root, (vm) => vm.$refs && vm.$refs.player);
  }

  /* ==================== 播放器适配层 ==================== */
  const Player = {
    raw() {
      const page = findPage();
      if (page && page.$refs && page.$refs.player) {
        const wrap = page.$refs.player;
        if (wrap.inPlayer) return wrap.inPlayer;
      }
      return document.querySelector('video');
    },
    videoEl() { return document.querySelector('video'); },
    isNative(p) { return !!p && typeof p.currentTime === 'number' && typeof p.getCurrentTime !== 'function'; },
    cur() {
      const v = this.videoEl();
      if (v && isFinite(v.currentTime)) return v.currentTime;
      const p = this.raw();
      if (!p) return 0;
      try { return this.isNative(p) ? p.currentTime : (p.getCurrentTime() || 0); } catch (e) { return 0; }
    },
    dur() {
      const v = this.videoEl();
      if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
      const p = this.raw();
      if (!p) return 0;
      try {
        const d = this.isNative(p) ? p.duration : p.getDuration();
        return isFinite(d) && d > 0 ? d : 0;
      } catch (e) { return 0; }
    },
    ended() {
      const v = this.videoEl();
      return !!(v && v.ended);
    },
    playing() {
      const v = this.videoEl();
      // 不用 readyState 判断：缓冲时它会掉到 2，导致每 tick 都调 play()，
      // 而平台 playerPlayCb 里会把 enterTime 重置，上报窗口被切碎，服务端就不累计了
      if (v) return !v.paused && !v.ended;
      return false;
    },
    play() {
      const v = this.videoEl();
      // 已经在播就绝对不要再碰：每次 play 都会触发平台的 playerPlayCb，
      // 里面把 enterTime 重置成当前时间，上报窗口就被切成 0 秒，服务端直接丢弃
      if (v && !v.paused && !v.ended) return;
      const p = this.raw();
      try { if (p && typeof p.play === 'function') p.play(); } catch (e) { /* ignore */ }
      if (v && v.paused) { try { const r = v.play(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* ignore */ } }
    },
    pause() {
      const v = this.videoEl();
      if (v && v.paused) return;
      const p = this.raw();
      try { if (p && typeof p.pause === 'function') p.pause(); } catch (e) { /* ignore */ }
      if (v && !v.paused) { try { v.pause(); } catch (e) { /* ignore */ } }
    },
    videos() {
      const out = [];
      const boxes = ['.prism-player', '#player', '.video-box', '.player-wrap'];
      for (let i = 0; i < boxes.length; i++) {
        const box = document.querySelector(boxes[i]);
        if (box) { try { box.querySelectorAll('video').forEach((v) => out.push(v)); } catch (e) { /* ignore */ } }
        if (out.length) break;
      }
      if (!out.length) { try { document.querySelectorAll('video').forEach((v) => out.push(v)); } catch (e) { /* ignore */ } }
      return out;
    },
    // 读"真实生效"的倍速：优先取正在播放的那个 video
    actualRate() {
      const vs = this.videos();
      if (!vs.length) return null;
      const live = vs.filter((v) => !v.paused && v.readyState > 0);
      const v = live[0] || vs[0];
      const r = v && v.playbackRate;
      return typeof r === 'number' && isFinite(r) ? r : null;
    },
    // 双通道写入：阿里云 inPlayer.setSpeed + 原生 video.playbackRate
    setRate(r) {
      let ok = false;
      const p = this.raw();
      try { if (p && typeof p.setSpeed === 'function') { p.setSpeed(r); ok = true; } } catch (e) { /* ignore */ }
      this.videos().forEach((v) => {
        try {
          v.defaultPlaybackRate = r;
          if (Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r;
          if (Math.abs(v.playbackRate - r) <= 0.01) ok = true;
        } catch (e) { /* ignore */ }
      });
      return ok;
    },
    speed(r) { return this.setRate(r); },
    mute() {
      const v = this.videoEl();
      if (v && !v.muted) {
        const p = this.raw();
        try { if (p && typeof p.setVolume === 'function') p.setVolume(0); } catch (e) { /* ignore */ }
        try { v.muted = true; v.volume = 0; } catch (e) { /* ignore */ }
      }
    },
    seek(t) {
      const p = this.raw();
      try { if (p && typeof p.seek === 'function') p.seek(t); } catch (e) { /* ignore */ }
      const v = this.videoEl();
      if (v) { try { v.currentTime = t; } catch (e) { /* ignore */ } }
    },
  };

  /* ==================== 倍速管理 ==================== */
  // 补时长阶段必须 1x：服务端只累加真实时钟，倍速越大缺口越大，永远补不满
  function effectiveRate() {
    if (S.inTopUp) return 1;
    return CFG.rate;
  }

  // 平台自己会实时累加 activeList.isLearned.learnDuration（真实时钟，上限 durationSec）
  // 这是唯一能实时拿到"服务端口径时长"的地方，比拉课程树快
  function liveLearned(node) {
    const l = (node && node.isLearned) || {};
    return {
      duration: Number(l.learnDuration) || 0,
      progress: Number(l.learnProgress) || 0,
      isLearned: l.isLearned === true,
    };
  }

  // 服务端认的时长：优先用刚核对过的值，其次用对账台账
  function serverDuration(node) {
    const code = node && node.listResourceCode;
    if (!code) return null;
    if (S.treeStale) return null;   // 课程树不可信，交给本地口径
    const rec = S.verify[code];
    if (rec && typeof rec.learnDuration === 'number' && rec.ts && Date.now() - rec.ts < 120000) return rec.learnDuration;
    const led = S.ledger[code];
    if (led && led.server && !led.server.none) return led.server.d;
    if (led && led.server && led.server.none) return 0;
    return null;
  }

  function topUpDeficit(node) {
    const total = nodeSec(node) || 0;
    if (!total) return 0;
    // 关键：必须用服务端口径的时长。本地 learnDuration 是平台在内存里自己加的，
    // 永远是"满"的，用它判断会导致永远不补、直接跳过。
    const srv = serverDuration(node);
    const real = srv != null ? srv : realDuration(node);
    return Math.max(0, total * CFG.completeRatio - real);
  }

  // 真实时长：平台的 learnDuration 每 60s 才刷新一次，补时阶段靠本地秒表把粒度做细
  function realDuration(node) {
    const lv = liveLearned(node);
    const total = nodeSec(node) || 0;
    let est = lv.duration;
    if (S.inTopUp && S.topUpBase != null) {
      est = Math.max(est, S.topUpBase + S.topUpAccum);
    }
    return total ? Math.min(total, est) : est;
  }

  // 补时秒表：只在真正播放时累加
  function tickTopUpClock() {
    if (!S.inTopUp) { S.topUpTick = 0; return; }
    const now = Date.now();
    if (S.topUpTick && Player.playing()) S.topUpAccum += (now - S.topUpTick) / 1000;
    S.topUpTick = now;
  }

  // 写入目标倍速并记录实际值
  function applyRate(reason, force) {
    const want = effectiveRate();
    const before = Player.actualRate();
    if (!force && before != null && Math.abs(before - want) <= 0.01) return true;
    Player.setRate(want);
    const after = Player.actualRate();
    const good = after == null || Math.abs(after - want) <= 0.01;
    if (!good) {
      S.rateEvents.push({ at: new Date().toISOString(), reason, want, before, after, ok: false });
      if (S.rateEvents.length > 80) S.rateEvents.shift();
    }
    return good;
  }

  // 守护：每轮对比实际倍速，被平台/播放器重置就纠回来
  function enforceRate() {
    const want = effectiveRate();
    const act = Player.actualRate();
    if (act == null) return;
    if (Math.abs(act - want) <= 0.01) return;
    applyRate('enforce');
    const after = Player.actualRate();
    if (after != null && Math.abs(after - want) <= 0.01) {
      S.rateFixes++;
      S.rateLastFixAt = new Date().toISOString();
      if (S.rateFixes <= 6) log(`倍速被重置，已纠正 ${act}x→${want}x`, 'warn');
    } else if (S.rateFixes < 3) {
      log(`倍速写入失败：目标 ${want}x，实际仍为 ${after}x`, 'err');
    }
  }

  // 判定某个倍速是否"安全"：进度到了但真实时长没到，说明服务端查真实时钟
  // serverRec 传入 S.verify[code]（服务端口径），比本地快照可靠
  function judgeRate(node, why, serverRec) {
    if (!CFG.rateGuard) return;
    const rate = effectiveRate();
    if (rate <= 1) return;
    const total = nodeSec(node) || 0;
    if (!total) return;
    let prog;
    let real;
    if (serverRec && typeof serverRec.learnDuration === 'number' && serverRec.learnDuration > 0) {
      prog = serverRec.learnProgress || 0;
      real = serverRec.learnDuration;
    } else {
      const lv = liveLearned(node);
      prog = lv.progress;
      real = lv.duration;
    }
    const progRatio = prog / total;
    const realRatio = real / total;
    if (progRatio >= 0.9 && realRatio < CFG.completeRatio) {
      S.rateUnsafe[String(rate)] = true;
      CFG.rate = 1;
      saveCfg();
      S.rateEvents.push({ at: new Date().toISOString(), reason: 'guard-downgrade', want: 1, from: rate, progRatio: +progRatio.toFixed(3), realRatio: +realRatio.toFixed(3), why });
      Player.setRate(1);
      log(`倍速守护：${rate}x 下进度已到 ${(progRatio * 100).toFixed(0)}%，真实时长只有 ${(realRatio * 100).toFixed(0)}%，服务端不认 → 已自动降为 1x`, 'err');
    }
  }


  /* ==================== 反后台暂停 ==================== */
  function installAntiHidden() {
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch (e) { /* ignore */ }
    ['visibilitychange', 'webkitvisibilitychange'].forEach((ev) => {
      document.addEventListener(ev, (e) => e.stopImmediatePropagation(), true);
      window.addEventListener(ev, (e) => e.stopImmediatePropagation(), true);
    });
    log('已安装反后台暂停');
  }

  /* ==================== 课程树工具（兼容数组与 {sub:[]} 两种结构） ==================== */
  function toArray(t) {
    if (Array.isArray(t)) return t;
    if (t && Array.isArray(t.sub)) return t.sub;
    return [];
  }
  function flattenTree(tree, out) {
    out = out || [];
    toArray(tree).forEach((n) => {
      if (n && n.sub && n.sub.length) flattenTree(n.sub, out);
      else if (n) out.push(n);
    });
    return out;
  }

  /* ==================== 服务端课程树（校验用） ==================== */
  async function refreshServerTree() {
    const key = contextKey();
    const store = getStore();
    const courseId = store && store.state.courseId;
    if (!courseId) return null;
    const data = await api(courseApi() + courseId);
    if (key !== contextKey()) return null;
    S.serverRaw = data;
    const tree = flattenTree(data && data.courseTree);
    if (!tree.length) {
      log('服务端课程树解析为空，请检查结构', 'err');
      return null;
    }
    S.serverTree = tree;
    S.serverAt = Date.now();
    return tree;
  }

  // true=服务端认可完成 / false=未认可 / null=拿不到
  async function verifyNode(code, force) {
    const key = contextKey();
    const rec = S.verify[code];
    if (!force && rec && Date.now() - (rec.ts || 0) < 20000) return rec.ok;
    // 数据不变也可能是尚未落库，不能因此停止核对。
    try {
      const tree = await refreshServerTree();
      if (key !== contextKey()) return null;
      if (!tree) { S.verify[code] = { ok: null, ts: Date.now(), at: new Date().toISOString(), err: 'no-tree' }; return null; }
      const n = tree.find((x) => String(x.listResourceCode) === String(code));
      if (!n) { S.verify[code] = { ok: null, ts: Date.now(), at: new Date().toISOString(), err: 'not-found' }; return null; }
      const learned = n.isLearned || {};
      const ok = learned.isLearned === true;
      S.verify[code] = {
        ok,
        ts: Date.now(),
        at: new Date().toISOString(),
        learnProgress: Math.round(learned.learnProgress || 0),
        learnDuration: Math.round(learned.learnDuration || 0),
        duration: n.duration,
        none: !n.isLearned,
      };
      const loc = liveLearned(getStore() && getStore().state.courseActiveList);
      S.ledger[code] = {
        context: key,
        at: new Date().toISOString(),
        server: {
          none: !n.isLearned,
          d: Math.round(learned.learnDuration || 0),
          p: Math.round(learned.learnProgress || 0),
          ok,
        },
        local: { d: Math.round(loc.duration), p: Math.round(loc.progress) },
        via: 'verify',
      };
      return ok;
    } catch (e) {
      if (key !== contextKey()) return null;
      S.verify[code] = { ok: null, ts: Date.now(), at: new Date().toISOString(), err: e.message };
      errLog('verifyNode', e);
      return null;
    }
  }

  /* ==================== 服务端落库对账 ==================== */
  // 本地 learnDuration 是平台在内存里自己加的，跟服务端是否落库无关。
  // 所以每次 insertrecord 成功后回拉一次课程树，比对服务端到底记了多少。
  const LEDGER_MIN_GAP = 45000;

  function scheduleLedgerCheck() {
    if (!CFG.verify) return;
    if (S.ledgerBusy) return;
    if (Date.now() - (S.ledgerAt || 0) < LEDGER_MIN_GAP) return;
    S.ledgerBusy = true;
    S.ledgerAt = Date.now();
    setTimeout(() => { checkLedger().catch((e) => errLog('checkLedger', e)); }, 3000);
  }

  async function checkLedger() {
    const ctx = captureContext();
    try {
      const tree = await refreshServerTree();
      const store = getStore();
      const node = store && store.state.courseActiveList;
      if (!tree || !node) return null;
      const code = node.listResourceCode;
      const n = tree.find((x) => String(x.listResourceCode) === String(code));
      const learned = n && n.isLearned;
      const srv = {
        none: !learned,
        d: learned ? Math.round(learned.learnDuration || 0) : 0,
        p: learned ? Math.round(learned.learnProgress || 0) : 0,
        ok: !!(learned && learned.isLearned === true),
      };
      const loc = liveLearned(node);
      const prev = S.ledgerPrev[code];
      S.ledgerPrev[code] = srv.d;
      S.ledger[code] = {
        context: ctx.key,
        at: new Date().toISOString(),
        server: srv,
        local: { d: Math.round(loc.duration), p: Math.round(loc.progress) },
      };
      // 对账与显式核对共享同一份最新状态，防止旧 false 阻挡新 true。
      if (n) S.verify[code] = {
        ok: srv.ok, ts: Date.now(), at: new Date().toISOString(),
        learnProgress: srv.p, learnDuration: srv.d, duration: n.duration, none: srv.none,
      };

      const warn = (kind, msg) => {
        const key = code + '|' + kind;
        if (S.ledgerWarned[key]) return;
        S.ledgerWarned[key] = true;
        log(msg, 'err');
      };

      // 指纹：服务端这条记录连续不变 → 说明接口/数据不刷新，核对不可用
      const sig = [srv.none, srv.d, srv.p, srv.ok].join('|');
      if (S.ledgerSig[code] === sig) S.ledgerSame[code] = (S.ledgerSame[code] || 0) + 1;
      else {
        S.ledgerSame[code] = 0;
        if (S.treeStale) { S.treeStale = false; log('课程树恢复刷新，核对重新可用', 'ok'); }
      }
      S.ledgerSig[code] = sig;
      if (S.ledgerSame[code] >= 5 && !S.treeStale && loc.duration > srv.d + 120) {
        S.treeStale = true;
        log('课程树连续 5 次返回相同记录，可能延迟或未落库；继续核对，不按本地时长放行', 'err');
      }

      if (srv.none && loc.duration > 30) {
        warn('none', `服务端未记录本节（本地已 ${Math.round(loc.duration)}s，服务端无记录）—— 刷新后会显示未完成`);
      } else if (prev != null && srv.d <= prev && loc.duration > prev + 20) {
        // 服务端可能落后一个 60s 窗口，连续两次不涨才判定异常
        S.ledgerMiss[code] = (S.ledgerMiss[code] || 0) + 1;
        if (S.ledgerMiss[code] >= 2) {
          warn('stuck', `服务端时长连续 ${S.ledgerMiss[code]} 次没有增长（本地 ${Math.round(loc.duration)}s，服务端仍 ${srv.d}s）—— 上报没有落库`);
        }
      } else {
        S.ledgerMiss[code] = 0;
      }
      if (srv.d > 0 && loc.duration - srv.d > 90) {
        warn('lag', `服务端比本地落后 ${Math.round(loc.duration - srv.d)}s，可能在丢上报`);
      }
      updateProgress();
      advanceServerComplete(node, ctx);
      return S.ledger[code];
    } finally {
      S.ledgerBusy = false;
    }
  }

  /* ==================== 课程树（本地） ==================== */
  function getList() {
    const store = getStore();
    if (!store) return [];
    return flattenTree(store.state.courseListTree);
  }
  function markNode(node, why) {
    if (!node) return;
    const learned = node.isLearned || {};
    S.marks[node.listResourceCode] = {
      name: node.name,
      type: node.contentType,
      durationSec: nodeSec(node),
      learnDuration: Math.round(learned.learnDuration || 0),
      learnProgress: Math.round(learned.learnProgress || 0),
      isLearned: !!learned.isLearned,
      serverVerified: S.verify[node.listResourceCode] ? S.verify[node.listResourceCode].ok : undefined,
      why,
      at: new Date().toISOString(),
    };
  }
  function next() {
    if (pendingNavigation) return;
    const store = getStore();
    if (!store) return;
    const list = getList();
    const cur = store.state.courseActiveList || {};
    const idx = list.findIndex((n) => n.listResourceCode === cur.listResourceCode);
    if (idx < 0) { log('找不到当前节点在课程树中的位置', 'warn'); return; }
    invalidateTask();
    markNode(cur, 'leave');
    // 已完成节点无需逐个点击，尤其测验可能没有可匹配的名称。
    let nextIndex = idx + 1;
    while (nextIndex < list.length) {
      const candidate = list[nextIndex];
      const completedVideo = CFG.skipFinished && candidate.contentType === 'video' &&
        candidate.isLearned && candidate.isLearned.isLearned === true;
      const completedQuiz = candidate.contentType === 'quiz' && candidate.isQuizLearned === true;
      if (!completedVideo && !completedQuiz) break;
      markNode(candidate, 'skip-finished-navigation');
      nextIndex++;
    }
    if (nextIndex > idx + 1) log(`略过 ${nextIndex - idx - 1} 个已完成课件`, 'info');
    const nx = list[nextIndex];
    if (!nx) { log('全部课件已处理完毕', 'ok'); S.phase = 'done'; onAllDone(); return; }
    S.videoDone = false;
    S.topUpRound = 0;
    S.phase = 'switching';
    log(`→ 下一节：${nx.name || nx.listResourceCode}`, 'ok');
    // 仅修改 Vuex 不会更新页面内部用于上报的 activeList。
    // 点击原目录，让页面自己的处理器同时更新播放源和上报身份。
    const normalize = (s) => String(s || '').replace(/\s+/g, '').trim();
    const name = normalize(nx.name);
    const candidates = name ? Array.from(document.querySelectorAll('a,button,span,div,li'))
      .filter((el) => !el.closest('#cx-panel') && el.getClientRects().length &&
        normalize(el.textContent) === name) : [];
    const leaves = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
    if (leaves.length !== 1) {
      S.phase = 'blocked';
      log(`无法唯一定位下一节目录项「${nx.name || nx.listResourceCode}」，已暂停，请在页面目录手动选择`, 'err');
      setRunning(false);
      return;
    }
    const navigation = { from: cur.listResourceCode, to: nx.listResourceCode };
    pendingNavigation = navigation;
    Player.pause();
    try { leaves[0].click(); } catch (e) {
      S.phase = 'blocked';
      setRunning(false);
      errLog('目录切节', e);
      return;
    }
    setTimeout(() => {
      if (pendingNavigation !== navigation) return;
      const current = getStore() && getStore().state.courseActiveList;
      pendingNavigation = null;
      if (current && current.listResourceCode === navigation.to) return;
      S.phase = 'blocked';
      log('目录点击后章节未切换，已暂停，请手动选择下一节', 'err');
      setRunning(false);
    }, 5000);
  }

  /* ==================== 看课 ==================== */
  function advanceServerComplete(node, ctx) {
    const rec = S.ledger[node.listResourceCode];
    if (!CFG.autoNext || !isCurrent(ctx) || pendingNavigation ||
        node.contentType !== 'video' || !rec || rec.context !== ctx.key || rec.server.ok !== true) return false;
    log(`服务端已确认完成，立即进入下一节：${node.name || node.listResourceCode}`, 'ok');
    exitTopUp();
    markNode(node, 'server-complete');
    Player.pause();
    next();
    return true;
  }

  async function handleVideo(node, ctx) {
    // 必须先于 videoDone 和补时判断，也适用于正常播放中收到的完成确认。
    if (advanceServerComplete(node, ctx)) return;
    if (!Player.raw()) { S.phase = 'waiting'; return; }
    if (S.videoDone) { S.phase = 'topup'; return; }

    const learned = node.isLearned || {};
    const total = nodeSec(node);
    const progress = learned.learnProgress || 0;
    const code = node.listResourceCode;

    // 1) 服务端明确已完成 → 跳过，不再空播
    if (CFG.skipFinished && learned.isLearned === true) {
      log(`服务端已认可完成，跳过：${node.name || code}`, 'ok');
      exitTopUp();
      markNode(node, 'skip-finished');
      next();
      return;
    }

    // 2) 只在进入/恢复章节时检查已有满进度记录。
    // 播放中的心跳也会更新 learnProgress，不能在最后两秒触发 seek(0)。
    const entryCheck = !S.entryChecked;
    S.entryChecked = true;
    const full = total > 0 && progress >= total - 2;
    if (entryCheck && !Player.ended() && CFG.skipFinished && full && CFG.verify && !S.busy && !S.inTopUp) {
      const rec = S.verify[code];
      const fresh = rec && Date.now() - (rec.ts || 0) < 20000;
      if (!fresh) {
        S.busy = true;
        S.phase = 'verifying';
        log(`进度已满但未标记完成，向服务端核对：${node.name || code}`, 'warn');
        const ok = await verifyNode(code, true).catch((e) => { errLog('verify', e); return null; });
        if (!isCurrent(ctx)) return;
        S.busy = false;
        if (ok === true) { log('服务端确认已完成，跳过', 'ok'); exitTopUp(); next(); return; }
        if (ok === null) {
          S.phase = 'blocked';
          log('无法核对服务端完成状态，已暂停，请检查网络后重试', 'err');
          setRunning(false);
          return;
        }
        else if (S.noPersist[code]) {
          log(`服务端始终没有该节记录，已暂停：${node.name || code}`, 'err');
          exitTopUp();
          S.phase = 'blocked';
          setRunning(false);
          return;
        } else {
          judgeRate(node, 'progress-full-but-unverified', S.verify[code]);
          enterTopUp(node, '进度满但未认可');
        }
      }
    }

    if (CFG.mute) Player.mute();
    applyRate('tick');

    const cur = Player.cur();
    const dur = Player.dur() || total;
    if (!dur) { S.phase = 'waiting'; return; }
    // ended 时调用 play() 会从头重播，必须先保留结尾状态用于结算。
    if (!Player.playing() && !Player.ended()) Player.play();

    S.phase = S.inTopUp ? 'topup' : 'playing';
    selfHeal(cur);
    if (S.stuckSince && Date.now() - S.stuckSince > 30000) S.phase = 'stalled';

    // 补时长阶段：从头完整播一遍，播到真正的结尾再核对
    // （实测唯一有效的办法就是完整过一遍：learnDuration 会被平台截到 durationSec，一遍就够）
    if (S.inTopUp) {
      const capSec = (total || 600) * 2.5;
      if (Player.ended()) {
        S.videoDone = true;
        S.phase = 'switching';
        log(`补时播放到结尾 ${fmt(cur)}/${fmt(dur)}（累计 ${Math.round(S.topUpAccum)}s），去核对`, 'ok');
        await afterVideo(ctx);
        return;
      }
      if (S.topUpAccum > capSec) {
        S.videoDone = true;
        S.phase = 'switching';
        log(`补时已播 ${Math.round(S.topUpAccum)}s 仍未到结尾，先核对`, 'warn');
        await afterVideo(ctx);
      }
      return;
    }

    // 等待自然 ended，不能为结算提前暂停最后一秒。
    // 加一道硬门槛：进度必须过课程时长的 90%，防止刚换源时 cur/dur 还没就绪被误判"播完"
    const nearEnd = total ? cur >= total * 0.9 : true;
    if (nearEnd && Player.ended()) {
      S.videoDone = true;
      S.phase = 'switching';
      log(`本节播完 ${fmt(cur)}/${fmt(dur)}`, 'ok');
      await afterVideo(ctx);
    }
  }

  function selfHeal(cur) {
    if (!CFG.selfHeal) return;
    const now = Date.now();
    if (Math.abs(cur - S.lastCur) > 0.3) {
      S.lastCur = cur;
      S.stuckSince = 0;
      S.stallWarned = false;
      S.stallSeeked = false;
      S.stallBlocked = false;
      return;
    }
    if (!S.stuckSince) { S.stuckSince = now; return; }
    const stuck = now - S.stuckSince;

    if (stuck > 30000 && !S.stallWarned) {
      S.stallWarned = true;
      S.phase = 'stalled';
      log(`视频 ${Math.round(stuck / 1000)}s 没有前进，尝试恢复播放`, 'warn');
      Player.play();
    }
    if (stuck > 120000 && !S.stallSeeked) {
      S.stallSeeked = true;
      log('视频 2 分钟没有前进：多半是后台标签页被浏览器节流，或网络拉流卡住。请把窗口保持在前台；已尝试原地重连', 'err');
      Player.seek(cur + 0.1);
      scheduleCurrent(() => Player.play(), 600);
    }
    if (stuck > 480000 && !S.stallBlocked) {
      S.stallBlocked = true;
      S.phase = 'blocked';
      log(`视频已卡住 ${Math.round(stuck / 60000)} 分钟，停止自动播放。请把浏览器窗口切到前台、检查网络后再点「开始」`, 'err');
      setRunning(false);
    }
  }

  // 进入补时：1x 从头播放，把真实时长补到 completeRatio * durationSec
  function enterTopUp(node, reason) {
    const def = topUpDeficit(node);
    const srvBefore = serverDuration(node);
    const total = nodeSec(node) || 0;
    // 服务端按 60 秒窗口累加：补时向上取整到整窗口，且不超过剩余时长
    const windowNeed = Math.max(60, Math.ceil(def / 60) * 60);
    const room = (srvBefore != null && total) ? Math.max(0, total - srvBefore) : windowNeed;
    // 至少播满一个 60s 窗口，否则这次补时不会产生任何上报
    const need = Math.max(60, Math.min(room || windowNeed, windowNeed));

    S.topUpRound++;
    S.inTopUp = true;
    S.topUpBase = liveLearned(node).duration;
    S.topUpAccum = 0;
    S.topUpTick = 0;
    S.topUpSrvBefore = srvBefore;
    S.topUpNeed = need;
    S.phase = 'topup';
    S.videoDone = false;
    Player.setRate(1);
    Player.seek(0);
    log(`服务端未认可（服务端 ${srvBefore == null ? '未知' : Math.round(srvBefore) + 's'}/${Math.round(total)}s）→ 1x 补 ${Math.round(need)}s（第${S.topUpRound}轮，${reason}）`, 'warn');
    scheduleCurrent(() => Player.play(), 400);
  }

  // 补时一轮后看服务端有没有真的涨；不涨说明上报没落库，补时没有意义
  function topUpPersisted(node) {
    if (S.topUpSrvBefore == null) return true;
    const now = serverDuration(node);
    if (now == null) return true;
    return now - S.topUpSrvBefore >= 20;
  }

  function exitTopUp() {
    S.inTopUp = false;
    S.topUpBase = null;
    S.topUpAccum = 0;
    S.topUpTick = 0;
    S.topUpNeed = 0;
    S.topUpSrvBefore = null;
  }

  async function afterVideo(ctx) {
    const store = getStore();
    if (!store) return;
    const node = store.state.courseActiveList || {};
    const code = node.listResourceCode;
    markNode(node, 'video-end');

    // 先暂停，让平台的 playerPauseCb 结算一次（带最终进度）
    Player.pause();
    await sleep(CFG.settleWait || 3000);
    if (!isCurrent(ctx)) return;

    let fail = false;
    if (CFG.verify) {
      S.phase = 'verifying';
      const ok = await verifyNode(code, true);
      if (!isCurrent(ctx)) return;
      if (ok === true) {
        exitTopUp();
        log('服务端已确认完成', 'ok');
      } else if (ok === false && CFG.topUp) {
        // 先判断是不是倍速导致真实时长不足（这一步会把倍速降回 1x）
        judgeRate(node, 'video-end-unverified', S.verify[code]);
        const def = topUpDeficit(node);
        const srvNow = serverDuration(node);
        const srvTxt = srvNow == null ? '未知' : `${Math.round(srvNow)}s`;

        if (S.topUpRound > 0 && !topUpPersisted(node)) {
          S.noPersist[code] = true;
          fail = true;
          log(`补了 ${Math.round(S.topUpAccum)}s，服务端仍是 ${srvTxt}（补前 ${Math.round(S.topUpSrvBefore || 0)}s）→ 上报没有落库，补时无效`, 'err');
        } else if (S.noPersist[code]) {
          fail = true;
          log(`服务端仍无有效记录（${srvTxt}）`, 'err');
        } else if (def > 0.5 && S.topUpRound < 3) {
          enterTopUp(node, '播完后未认可');
          return;
        } else {
          fail = true;
          log(`真实时长已够但服务端仍不认（服务端 ${srvTxt}/${Math.round(nodeSec(node))}s）`, 'err');
        }
      } else {
        fail = true;
        log('服务端未确认（拿不到课程树）', 'err');
      }
    }
    exitTopUp();

    // 本地时长满不代表服务端已保存，失败必须停在当前节。
    if (fail) {
      S.phase = 'blocked';
      log('本节未被服务端确认完成，已暂停；点「开始」将重试当前节', 'err');
      setRunning(false);
      return;
    }
    if (CFG.autoNext) next();
  }

  /* ==================== 随堂测验 ==================== */
  function guessAnswer() { return 'A'; }
  function buildQuizBody(node, items) {
    return items.map((it) => ({
      quizId: node.courseWareId,
      examPaperItemId: it.examPaperItemId,
      type: it.type,
      order: it.order,
      userAnswer: String(it.rightAnswer || guessAnswer()),
    }));
  }

  async function handleQuiz(node, ctx) {
    if (S.busy) return;
    const code = node.listResourceCode;
    if (node.isQuizLearned) { log(`测验已完成，跳过：${code}`, 'ok'); markNode(node, 'quiz-done'); next(); return; }

    let items = node.items || [];
    if (!items.length) { log('测验无题目，跳过', 'warn'); next(); return; }

    if (CFG.quizStrategy === 'manual') {
      setRunning(false);
      S.phase = 'blocked';
      Player.pause();
      log(`随堂测验需人工作答，已暂停（${items.length} 题）`, 'warn');
      return;
    }

    S.busy = true;
    S.phase = 'quiz';
    try {
      const hasAnswers = items.every((it) => !!it.rightAnswer);

      if (!hasAnswers) {
        log(`测验未下发答案，先提交探测答案（${items.length} 题）`, 'warn');
        const r1 = await api('/api/quiz/save', { method: 'POST', body: buildQuizBody(node, items) });
        if (!isCurrent(ctx)) return;
        log(`探测提交：${r1 && r1.success ? '已记录' : (r1 && r1.message) || '失败'}`, r1 && r1.success ? 'ok' : 'err');
        await sleep(1800);
        if (!isCurrent(ctx)) return;

        const fresh = await api('/api/quiz/' + node.courseWareId);
        if (!isCurrent(ctx)) return;
        if (fresh && fresh.items && fresh.items.length) {
          items = fresh.items;
          node.items = items;
        }
        if (!items.every((it) => !!it.rightAnswer)) {
          log('重新拉取后仍未下发答案，测验保持探测结果', 'err');
          node.isQuizLearned = true;
          markNode(node, 'quiz-probe-only');
          await sleep(800);
          if (!isCurrent(ctx)) return;
          next();
          return;
        }
        log('已拿到正确答案，提交纠正', 'ok');
      }

      const r2 = await api('/api/quiz/save', { method: 'POST', body: buildQuizBody(node, items) });
      if (!isCurrent(ctx)) return;
      if (r2 && r2.success) {
        node.isQuizLearned = true;
        markNode(node, 'quiz-done');
        log(`测验已提交正确答案（${items.length} 题）`, 'ok');
      } else {
        log(`测验提交失败：${(r2 && r2.message) || clip(r2, 200)}`, 'err');
      }
      await sleep(1200);
      if (!isCurrent(ctx)) return;
      next();
    } catch (e) {
      errLog('handleQuiz', e);
    } finally {
      if (isCurrent(ctx)) S.busy = false;
    }
  }

  /* ==================== 考试 ==================== */
  async function runExam() {
    const page = findPage();
    const examId = (page && page.currentexam && page.currentexam.examId) || null;
    if (!examId) { log('未找到课程关联考试 examId', 'warn'); return; }
    S.phase = 'exam';
    log(`开始考试 examId=${examId}`);
    const data = await api('/api/userexam/' + examId);
    const items = (data && data.examPaperItems) || [];
    if (!items.length) { log('考试题目为空', 'warn'); return; }

    const noAnswer = items.filter((it) => !it.rightAnswer);
    if (noAnswer.length) {
      S.phase = 'blocked';
      log(`考试 ${noAnswer.length}/${items.length} 题未返回 rightAnswer，需人工，已存诊断包`, 'err');
      console.log('[CX] exam payload', data);
      return;
    }

    const answers = items.map((it) => ({
      time: new Date(),
      examPaperItemId: it.examPaperItemId,
      optionDictionary: buildOptionDict(it),
      answer: String(it.rightAnswer),
    }));

    const r = await api('/api/userexam/handinpaper', {
      method: 'POST',
      body: { examId, beginTime: new Date(), endTime: new Date(), answers },
    });
    if (r && r.success) { log('考试已交卷', 'ok'); S.phase = 'done'; }
    else log(`交卷返回：${clip(r, 300)}`, 'warn');
  }

  function buildOptionDict(it) {
    const dict = {};
    const letters = 'ABCDEFGH';
    const rnd = it.randomOption ? String(it.randomOption).split(',') : null;
    for (let i = 0; i < 8; i++) {
      const L = letters[i];
      const text = it['option' + L];
      if (!text) continue;
      dict[rnd && rnd[i] ? rnd[i] : L] = text;
    }
    return dict;
  }

  function onAllDone() {
    if (!CFG.autoExam || S.examTried) { log('课程看完。如需考试请点面板「考试」按钮', 'ok'); return; }
    S.examTried = true;
    runExam().catch((e) => errLog('runExam', e));
  }

  /* ==================== 主循环 ==================== */
  let timer = null;
  let rateTimer = null;
  let observedContext = null;
  function tick() {
    if (!CFG.running) return;
    if (!/\/courselearn/.test(location.href)) return;
    const store = getStore();
    if (!store) return;
    const node = store.state.courseActiveList;
    if (!node || !node.contentType) return;
    if (pendingNavigation) {
      if (node.listResourceCode === pendingNavigation.from) { S.phase = 'switching'; return; }
      pendingNavigation = null;
    }

    const key = contextKey();
    if (key !== observedContext) {
      invalidateTask();
      observedContext = key;
      S.lastCode = node.listResourceCode;
      S.videoDone = false;
      S.entryChecked = false;
      S.topUpRound = 0;
      S.stuckSince = 0;
      S.lastCur = -1;
      exitTopUp();
      S.phase = 'switching';
      log(`▶ ${node.name || node.listResourceCode}（${node.contentType}）`);
    }

    enforceRate();
    tickTopUpClock();

    if (activeTask) return;
    const ctx = captureContext();
    const task = { ctx };
    activeTask = task;
    task.promise = (async () => {
      if (node.contentType === 'video') return handleVideo(node, ctx);
      if (node.contentType === 'quiz') {
        if (CFG.autoQuiz) return handleQuiz(node, ctx);
        return;
      }
      log(`跳过非视频课件：${node.contentType}`, 'warn');
      next();
    })().catch((e) => {
      if (isCurrent(ctx)) {
        S.videoDone = false;
        S.busy = false;
        errLog('tick', e);
      }
    }).finally(() => {
      if (activeTask === task) activeTask = null;
    });
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try { tick(); } catch (e) { errLog('tick', e); }
      updateProgress();
    }, CFG.tickMs);
    // 倍速独立守护：即使主循环在核对/答题/暂停，也保证倍速不被播放器重置
    if (rateTimer) clearInterval(rateTimer);
    rateTimer = setInterval(() => {
      try { enforceRate(); } catch (e) { /* ignore */ }
    }, 800);
    log('自动刷课已启动');
  }

  function setRunning(v) {
    invalidateTask();
    CFG.running = v;
    S.videoDone = false;
    if (v) {
      S.entryChecked = false;
      if (!Player.ended()) Player.play();
      scheduleCurrent(() => applyRate('resume'), 300);
      log('继续运行');
    } else {
      if (S.phase !== 'blocked') S.phase = 'paused';
      Player.pause();
      log('已暂停（视频已同步暂停）');
    }
    renderPanel();
  }

  /* ==================== 诊断包 ==================== */
  function buildDiagnose(light) {
    const store = getStore();
    const node = (store && store.state.courseActiveList) || {};
    const page = findPage();
    const list = getList();
    const out = {
      meta: { version: VERSION, exportedAt: new Date().toISOString(), url: location.href, ua: navigator.userAgent, screen: `${screen.width}x${screen.height}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      cfg: Object.assign({}, CFG),
      reportChecks: S.reportChecks.slice(),
      phase: S.phase,
      course: {
        id: store && store.state.courseId,
        name: store && store.state.courseName,
        nodeCount: list.length,
        currentIndex: list.findIndex((n) => n.listResourceCode === node.listResourceCode),
      },
      current: {
        code: node.listResourceCode, name: node.name, type: node.contentType,
        duration: node.duration, durationSec: nodeSec(node), videoId: node.videoId,
        isLearned: node.isLearned,
        quizItems: node.items ? node.items.map((i) => ({ id: i.examPaperItemId, type: i.type, order: i.order, rightAnswer: i.rightAnswer })) : undefined,
      },
      player: {
        cur: Player.cur(), dur: Player.dur(), ended: Player.ended(), playing: Player.playing(),
        rate: Player.actualRate(), rateWant: CFG.rate, rateEffective: effectiveRate(),
        rateActual: Player.actualRate(), videoCount: Player.videos().length,
        inTopUp: !!S.inTopUp, topUpRound: S.topUpRound,
      },
      rate: {
        guard: CFG.rateGuard, completeRatio: CFG.completeRatio,
        unsafe: S.rateUnsafe, fixes: S.rateFixes, lastFixAt: S.rateLastFixAt,
        events: S.rateEvents.slice(-40),
      },
      duration: (function () {
        const lv = liveLearned(node);
        const total = nodeSec(node) || 0;
        return {
          total,
          learnDuration: +lv.duration.toFixed(1),
          learnProgress: +lv.progress.toFixed(1),
          realRatio: total ? +(lv.duration / total).toFixed(3) : 0,
          progRatio: total ? +(lv.progress / total).toFixed(3) : 0,
          deficit: +Math.max(0, total * CFG.completeRatio - lv.duration).toFixed(1),
        };
      })(),

      exam: page && page.currentexam ? page.currentexam : null,
      heartbeat: {
        count: S.hb.count, ok: S.hb.ok, reject: S.hb.reject,
        insert: S.hb.ins, insertOk: S.hb.insOk,
        shortWindows: S.hb.short, lastDelta: S.hb.lastDelta, deltas: S.hb.deltas, ids: S.hb.ids,
        firstAt: S.hb.firstAt, lastAt: S.hb.lastAt, samples: S.hb.samples,
      },
      ledger: S.ledger,
      ledgerPrev: S.ledgerPrev,
      ledgerMiss: S.ledgerMiss,
      ledgerSame: S.ledgerSame,
      treeStale: S.treeStale,
      marks: S.marks,
      verify: S.verify,
      errors: S.errors,
      logs: S.logs.slice(-150),
      net: S.net.slice(-150),
      serverSnapshot: S.serverTree ? S.serverTree.map((n) => ({
        code: n.listResourceCode, name: n.name, duration: n.duration,
        isLearned: n.isLearned ? n.isLearned.isLearned : null,
        learnProgress: n.isLearned ? Math.round(n.isLearned.learnProgress || 0) : null,
        learnDuration: n.isLearned ? Math.round(n.isLearned.learnDuration || 0) : null,
      })) : null,
    };
    if (!light) {
      out.tree = store ? store.state.courseListTree : null;
      out.list = list.map((n) => ({
        code: n.listResourceCode, name: n.name, type: n.contentType,
        duration: n.duration, durationSec: n.durationSec, isLearned: n.isLearned, videoId: n.videoId,
        hasAnswers: n.items ? n.items.map((i) => !!i.rightAnswer) : undefined,
      }));
    }
    return out;
  }

  function download(name, text) {
    try {
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      log(`已导出 ${name}`, 'ok');
      return true;
    } catch (e) { errLog('download', e); return false; }
  }

  function exportDiag(light) {
    const data = buildDiagnose(!!light);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    download(`cx-diag-${stamp}.json`, JSON.stringify(data, null, 2));
    return data;
  }

  function exportLog() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const lines = S.logs.map((l) => `[${l.t}] [${l.type}] ${l.msg}`);
    const head = [
      `# 万方刷课日志  v${VERSION}`,
      `# 导出时间 ${new Date().toLocaleString()}`,
      `# 页面 ${location.href}`,
      `# 心跳 ${S.hb.ok}/${S.hb.count} 成功  阶段 ${S.phase}`,
      '',
    ];
    download(`cx-log-${stamp}.txt`, head.concat(lines).join('\n'));
    return lines;
  }

  async function copyDiag() {
    const text = JSON.stringify(buildDiagnose(true), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      log(`已复制诊断摘要（${(text.length / 1024).toFixed(1)}KB）`, 'ok');
    } catch (e) { console.log(text); log('剪贴板不可用，已输出到控制台', 'warn'); }
    return text;
  }

  /* ==================== 面板 ==================== */
  let panel = null;
  const PHASE_TEXT = {
    idle: '待命', waiting: '等待播放器', playing: '播放中', switching: '切换中',
    verifying: '核对中', topup: '补时长中', quiz: '答题中', exam: '考试中', stalled: '卡顿中',
    blocked: '已阻塞', done: '已完成', paused: '已暂停',
  };
  const PHASE_COLOR = {
    playing: '#3b6d11', topup: '#854f0b', verifying: '#185fa5', quiz: '#185fa5', stalled: '#a32d2d',
    exam: '#185fa5', blocked: '#a32d2d', done: '#3b6d11', paused: '#888780',
  };

  function mountPanel() {
    if (panel && document.body.contains(panel)) { renderPanel(); return; }
    panel = document.createElement('div');
    panel.id = 'cx-panel';
    panel.style.cssText = [
      'position:fixed', 'top:72px', 'right:16px', 'width:308px', 'z-index:2147483000',
      'background:#fff', 'border:1px solid #d3d1c7', 'border-radius:12px',
      'box-shadow:0 4px 16px rgba(0,0,0,.12)',
      'font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif',
      'color:#2c2c2a', 'overflow:hidden',
    ].join(';');
    document.body.appendChild(panel);
    renderPanel();
  }

  function renderPanel() {
    if (!panel) return;
    const store = getStore();
    const node = (store && store.state.courseActiveList) || {};
    const list = getList();
    const idx = list.findIndex((n) => n.listResourceCode === node.listResourceCode);
    const learned = node.isLearned || {};
    const phase = CFG.running ? S.phase : 'paused';

    const rows = S.logs.slice(-4).reverse().map((l) => {
      const c = { info: '#5f5e5a', ok: '#3b6d11', warn: '#854f0b', err: '#a32d2d' }[l.type] || '#5f5e5a';
      return `<div style="color:${c};margin-top:3px;word-break:break-all">${l.t} ${escapeHtml(l.msg)}</div>`;
    }).join('');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:#f1efe8;border-bottom:1px solid #e5e3da">
        <span style="font-weight:500">万方刷课 <span style="color:#888780;font-weight:400">v${VERSION}</span></span>
        <span id="cx-state" style="margin-left:auto;color:${CFG.running ? '#3b6d11' : '#a32d2d'}">${CFG.running ? '运行中' : '已暂停'}</span>
        <span id="cx-fold" style="cursor:pointer;color:#888780;padding:0 2px">—</span>
      </div>
      <div id="cx-body" style="padding:10px 12px">
        <div id="cx-idx" style="color:#5f5e5a">进度 ${idx >= 0 ? idx + 1 : 0}/${list.length}　已看 ${Math.round(learned.learnDuration || 0)}s</div>
        <div id="cx-name" style="margin:6px 0 2px;font-weight:500;word-break:break-all">${escapeHtml(node.name || '未开始')}</div>
        <div style="height:5px;background:#e5e3da;border-radius:3px;overflow:hidden;margin:6px 0">
          <div id="cx-bar" style="height:100%;width:0%;background:#639922"></div>
        </div>
        <div id="cx-time" style="color:#888780">0:00 / 0:00　${CFG.rate}x</div>
        <div id="cx-gap" style="color:#888780;font-size:11px">真实时长 —/—</div>
        <div id="cx-srv" style="color:#888780;font-size:11px">服务端 —</div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <span id="cx-phase" style="color:${PHASE_COLOR[phase] || '#5f5e5a'}">${PHASE_TEXT[phase] || phase}</span>
          <span id="cx-hb" style="margin-left:auto;color:#888780">上报 ${S.hb.insOk}/${S.hb.ins}</span>
        </div>
        <div style="display:flex;gap:6px;margin:9px 0 6px">
          <button id="cx-toggle" style="${btn()}">${CFG.running ? '暂停' : '开始'}</button>
          <button id="cx-next" style="${btn()}">下一节</button>
          <button id="cx-rate" style="${btn()}">${CFG.rate}x</button>
          <button id="cx-exam" style="${btn()}">考试</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <button id="cx-diag" style="${btn('#eaf3de', '#639922', '#27500a')}">诊断包</button>
          <button id="cx-logx" style="${btn()}">导出日志</button>
          <button id="cx-copy" style="${btn()}">复制摘要</button>
        </div>
        <div style="border-top:1px solid #eeede7;padding-top:6px;max-height:96px;overflow:auto">${rows}</div>
      </div>`;
    bindPanel();
    updateProgress();
  }

  function btn(bg, bd, fg) {
    return [
      'flex:1', 'padding:4px 0', `border:1px solid ${bd || '#d3d1c7'}`, `background:${bg || '#fff'}`,
      'border-radius:6px', 'cursor:pointer', 'font-size:11.5px', `color:${fg || '#2c2c2a'}`,
    ].join(';');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function updateProgress() {
    if (!panel) return;
    const $ = (id) => panel.querySelector('#' + id);
    const store = getStore();
    const node = (store && store.state.courseActiveList) || {};
    const cur = Player.cur();
    const dur = Player.dur() || nodeSec(node);
    const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
    const phase = CFG.running ? S.phase : 'paused';

    const bar = $('cx-bar'); if (bar) bar.style.width = pct + '%';

    // 倍速：显示真实生效值，与目标不符时标红
    const want = effectiveRate();
    const act = Player.actualRate();
    const mismatch = act != null && Math.abs(act - want) > 0.01;
    const time = $('cx-time');
    if (time) {
      time.textContent = `${fmt(cur)} / ${fmt(dur)}　${act != null ? act : want}x${mismatch ? `（目标 ${want}x）` : ''}`;
      time.style.color = mismatch ? '#a32d2d' : '#888780';
    }
    const rateBtn = $('cx-rate');
    if (rateBtn) {
      rateBtn.textContent = `${CFG.rate}x${S.inTopUp ? '·补时' : ''}`;
      rateBtn.style.borderColor = mismatch ? '#a32d2d' : '#d3d1c7';
      rateBtn.style.color = mismatch ? '#a32d2d' : '#2c2c2a';
    }

    // 真实时长缺口：补时判断以服务端口径为准，本地只作参考
    const total = nodeSec(node) || dur || 0;
    const real = realDuration(node);
    const srvDur = serverDuration(node);
    const basis = srvDur != null ? srvDur : real;
    const gapEl = $('cx-gap');
    if (gapEl) {
      if (!total) gapEl.textContent = '真实时长 —';
      else {
        const def = Math.max(0, total * CFG.completeRatio - basis);
        const topUpTxt = S.inTopUp ? `　补时重播 ${fmt(S.topUpAccum)}` : '';
        gapEl.textContent = `本地 ${fmt(real)}　服务端 ${srvDur == null ? '未知' : fmt(srvDur)}　差 ${fmt(def)}${topUpTxt}`;
        gapEl.style.color = def > 30 && want > 1 ? '#a32d2d' : (def <= 3 ? '#3b6d11' : '#888780');
      }
    }

    // 服务端对账：这是"刷新后变未完成"的唯一可靠指标
    const srvEl = $('cx-srv');
    if (srvEl) {
      const code = node.listResourceCode;
      const led = code && S.ledger[code];
      const vf = code && S.verify[code];
      if (led) {
        const s = led.server;
        if (s.ok) { srvEl.textContent = `服务端 已完成 ✓`; srvEl.style.color = '#3b6d11'; }
        else if (s.none) { srvEl.textContent = `服务端 无记录 ⚠ 刷新后会变未完成`; srvEl.style.color = '#a32d2d'; }
        else { srvEl.textContent = `服务端 未认可（进度 ${fmt(s.p)}）`; srvEl.style.color = '#854f0b'; }
      } else if (vf && vf.ok === true) {
        srvEl.textContent = '服务端 已完成 ✓'; srvEl.style.color = '#3b6d11';
      } else if (vf && vf.ok === false) {
        srvEl.textContent = `服务端 未认可（${fmt(vf.learnDuration || 0)}/${fmt(total)}）`;
        srvEl.style.color = '#854f0b';
      } else {
        srvEl.textContent = '服务端 未核对'; srvEl.style.color = '#888780';
      }
    }

    const hb = $('cx-hb'); if (hb) hb.textContent = `上报 ${S.hb.insOk}/${S.hb.ins}`;

    const ph = $('cx-phase');
    if (ph) { ph.textContent = PHASE_TEXT[phase] || phase; ph.style.color = PHASE_COLOR[phase] || '#5f5e5a'; }
    const st = $('cx-state');
    if (st) { st.textContent = CFG.running ? '运行中' : '已暂停'; st.style.color = CFG.running ? '#3b6d11' : '#a32d2d'; }
  }

  function bindPanel() {
    const $ = (id) => panel.querySelector('#' + id);
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

    on('cx-toggle', () => setRunning(!CFG.running));
    on('cx-next', () => { Player.pause(); next(); });
    on('cx-rate', () => {
      const seq = [1, 1.25, 1.5, 1.75, 2];
      CFG.rate = seq[(seq.indexOf(CFG.rate) + 1) % seq.length];
      saveCfg();
      const good = applyRate('click', true);
      const act = Player.actualRate();
      const bad = !good && act != null;
      log(`倍速 → ${CFG.rate}x${bad ? `（实际 ${act}x，未生效）` : ''}`, bad ? 'warn' : 'info');
      if (S.rateUnsafe[String(CFG.rate)]) log(`注意：${CFG.rate}x 实测不被服务端认可（真实时长会跟不上），脚本会自动降速`, 'warn');
      updateProgress();
    });
    on('cx-exam', () => runExam().catch((e) => errLog('runExam', e)));
    on('cx-diag', () => exportDiag(false));
    on('cx-logx', () => exportLog());
    on('cx-copy', () => copyDiag());
    on('cx-fold', () => {
      const b = $('cx-body');
      if (!b) return;
      const hidden = b.style.display === 'none';
      b.style.display = hidden ? 'block' : 'none';
      $('cx-fold').textContent = hidden ? '—' : '+';
    });
  }

  /* ==================== 调试接口 ==================== */
  window.__CX = {
    version: VERSION,
    runtime: () => ({ generation, context: contextKey(), taskPending: !!activeTask }),
    cfg: CFG,
    state: S,
    next,
    exam: runExam,
    export: exportLog,
    diag: exportDiag,
    copy: copyDiag,
    verify: (code) => verifyNode(code, true),
    refresh: refreshServerTree,
    rate(n) {
      if (n == null) return { want: CFG.rate, effective: effectiveRate(), actual: Player.actualRate(), inTopUp: S.inTopUp };
      CFG.rate = Number(n);
      saveCfg();
      applyRate('api');
      const act = Player.actualRate();
      log(`倍速 → ${CFG.rate}x（实际 ${act}x）`);
      updateProgress();
      return act;
    },
    rateInfo() {
      const node = (getStore() && getStore().state.courseActiveList) || {};
      const lv = liveLearned(node);
      const total = nodeSec(node) || 0;
      const info = {
        want: CFG.rate, effective: effectiveRate(), actual: Player.actualRate(),
        videoCount: Player.videos().length, inTopUp: S.inTopUp, fixes: S.rateFixes,
        unsafe: S.rateUnsafe, total, learnDuration: Math.round(lv.duration),
        learnProgress: Math.round(lv.progress),
        realRatio: total ? +(lv.duration / total).toFixed(3) : 0,
      };
      console.log(info);
      if (S.rateEvents.length) console.table(S.rateEvents);
      return info;
    },
    server() {
      const t = S.serverTree || [];
      const rows = t.map((n) => ({
        code: n.listResourceCode,
        name: n.name,
        duration: n.duration,
        isLearned: n.isLearned ? n.isLearned.isLearned : null,
        learnProgress: n.isLearned ? Math.round(n.isLearned.learnProgress || 0) : null,
        learnDuration: n.isLearned ? Math.round(n.isLearned.learnDuration || 0) : null,
        hasRecord: !!n.isLearned,
      }));
      console.table(rows);
      return rows;
    },
    ledger() {
      const rows = Object.keys(S.ledger).map((code) => ({
        code,
        serverDur: S.ledger[code].server.d,
        serverProg: S.ledger[code].server.p,
        serverOk: S.ledger[code].server.ok,
        noRecord: S.ledger[code].server.none,
        localDur: S.ledger[code].local.d,
        at: S.ledger[code].at,
      }));
      console.table(rows);
      return rows;
    },
    check: () => checkLedger(),
    topUp() {
      const node = getStore() && getStore().state.courseActiveList;
      if (!node) return null;
      enterTopUp(node, 'manual');
      return { need: S.topUpNeed, server: serverDuration(node), deficit: topUpDeficit(node) };
    },
    pause: () => setRunning(false),
    resume: () => setRunning(true),
    dump() { const d = buildDiagnose(false); console.log('[CX] dump', d); return d; },
    save() { saveCfg(); return CFG; },
    reset() { Object.assign(CFG, DEFAULTS); saveCfg(); log('配置已重置'); },
  };

  /* ==================== 启动 ==================== */
  function boot() {
    if (!/\/courselearn/.test(location.href)) return false;
    if (!getStore()) { setTimeout(boot, 600); return false; }
    if (!window.__CX_ANTI_HIDDEN__) {
      window.__CX_ANTI_HIDDEN__ = true;
      installAntiHidden();
      installErrorHook();
    }
    installNetHook();
    mountPanel();
    start();
    log(`脚本就绪 v${VERSION}，控制台可用 __CX.diag() / __CX.server()`);
    return true;
  }

  boot();

  window.addEventListener('hashchange', () => {
    setTimeout(() => {
      if (!/\/courselearn/.test(location.href)) {
        invalidateTask();
        if (timer) { clearInterval(timer); timer = null; }
        if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
        return;
      }
      if (panel && !document.body.contains(panel)) panel = null;
      boot();
    }, 900);
  });
})();
