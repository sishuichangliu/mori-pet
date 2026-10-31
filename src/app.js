'use strict';

/* morichan 桌面宠物 — 渲染进程
 * PIXI 6 + pixi-live2d-display(cubism4) + Live2DCubismCore
 */

const overlay = document.getElementById('overlay');
function fail(html) {
  overlay.innerHTML = html;
  overlay.classList.add('show');
}
function log(...a) { (window.pet && window.pet.log) ? window.pet.log(...a) : console.log(...a); }

window.addEventListener('error', (e) => log('window error:', e.message));

(async function main() {
  if (typeof Live2DCubismCore === 'undefined') {
    return fail('<div><b>缺少 Cubism Core</b><br>找不到 live2dcubismcore.min.js</div>');
  }
  if (typeof PIXI === 'undefined' || !PIXI.live2d) {
    return fail('<div><b>PIXI / pixi-live2d-display 加载失败</b></div>');
  }

  const cfg = await window.pet.getConfig();
  log('config', JSON.stringify(cfg));

  const CANVAS_W = 380, CANVAS_BASE_H = 520;
  let sizeFactor = 1;

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    autoStart: true,
    antialias: true,
    preserveDrawingBuffer: true,
    resolution: 1,
    autoDensity: true,
    width: CANVAS_W,
    height: CANVAS_BASE_H
  });
  document.getElementById('stage').appendChild(app.view);

  let model;
  try {
    const { Live2DModel } = PIXI.live2d;
    model = await Live2DModel.from(cfg.modelUrl, { autoInteract: false });
  } catch (e) {
    log('load fail', String(e));
    return fail('<div><b>模型加载失败</b><br>' + String(e).replace(/</g, '&lt;') + '</div>');
  }

  app.stage.addChild(model);
  model.anchor.set(0.5, 1);

  // ---------------------------------------------------------------- 缩放 / 尺寸
  let fitScale = null, baseScale = 1, baseY = 0;
  const applyScale = () => {
    baseScale = fitScale;
    model.scale.set(baseScale);
    model.x = app.screen.width / 2;
    model.y = app.screen.height;
    baseY = app.screen.height;
  };
  const fit = () => {
    if (fitScale === null) {
      model.scale.set(1);
      fitScale = (app.screen.height * 1.0) / model.height;
    }
    applyScale();
  };

  fit();

  function setSize(v) {
    const f = Math.min(2, Math.max(0.5, Number(v) || 1));
    sizeFactor = f;
    // 宽度必须跟着缩放：只加高不加宽时，>100% 她会被画布右边缘裁掉（尾巴先没）
    const w = Math.round(CANVAS_W * f);
    const h = Math.round(CANVAS_BASE_H * f);
    app.renderer.resize(w, h);
    app.view.style.width = w + 'px';
    app.view.style.height = h + 'px';
    const stEl = document.getElementById('stage');
    if (stEl) {
      stEl.style.width = w + 'px';
      stEl.style.height = h + 'px';
    }
    if (window.Dialog && window.Dialog.setCanvasHeight) window.Dialog.setCanvasHeight(h);
    fitScale = null;
    fit();
    if (typeof grabMask === 'function') grabMask();
    log('size ->', f, 'canvasH', h);
  }
  if (window.pet.onSetSize) window.pet.onSetSize(setSize);
  // 透明度：主进程下发，作用在 #stage 的 CSS opacity 上。
  // 不能用主进程 win.setOpacity()——透明窗口上会把整窗渲染打成黑块（100% 也一样）
  const applyOpacity = (v) => {
    const el = document.getElementById('stage');
    const o = Math.min(1, Math.max(0.05, Number(v) || 1));
    if (el) el.style.opacity = String(o);
    log('opacity ->', o);
  };
  if (window.pet.onOpacity) window.pet.onOpacity(applyOpacity);
  // 启动时主动拉一次：did-finish-load 的推送可能早于本监听注册，会丢
  if (window.pet.getOpacity) window.pet.getOpacity().then(applyOpacity).catch(() => { });

  // ---------------------------------------------------------------- 帧率策略
  // 平时：静止 30fps，交互 60fps（持续 6 秒）；节能：静止 8fps，交互 25fps（持续 2.5 秒）
  // 窗口隐藏时主进程发 perf=pause，直接停渲染
  let powerSave = false;
  let activeUntil = 0;
  const baseFPS = () => (powerSave ? 8 : 30);
  const activeFPS = () => (powerSave ? 25 : 60);
  const activeMs = () => (powerSave ? 2500 : 6000);
  const setFPS = (n) => { try { app.ticker.maxFPS = n; } catch (e) { } };
  const bumpFPS = () => { setFPS(activeFPS()); activeUntil = performance.now() + activeMs(); };
  setFPS(baseFPS());
  setInterval(() => {
    if (activeUntil && performance.now() > activeUntil) { activeUntil = 0; setFPS(baseFPS()); }
  }, 800);
  if (window.pet.onPerf) {
    window.pet.onPerf((m) => {
      if (m === 'pause') { try { app.ticker.stop(); } catch (e) { } log('perf pause'); }
      else { try { app.ticker.start(); } catch (e) { } setFPS(baseFPS()); log('perf resume'); }
    });
  }
  const applyPowerSave = (on) => {
    powerSave = !!on;
    const settled = !activeUntil || performance.now() > activeUntil;
    if (settled) setFPS(baseFPS());
    log('power save', powerSave ? 'on' : 'off', 'fps', baseFPS());
  };
  if (window.pet.onPowerSave) window.pet.onPowerSave(applyPowerSave);
  // 启动时主动拉一次：did-finish-load 的推送可能早于本监听注册
  if (window.pet.getPowerSave) window.pet.getPowerSave().then(applyPowerSave).catch(() => { });
  if (window.pet.getSize) {
    window.pet.getSize().then((f) => {
      const v = Number(f) || 1;
      if (Math.abs(v - 1) > 0.01) setSize(v);
    }).catch(() => { });
  }

  // ---------------------------------------------------------------- 参数
  const im = model.internalModel;
  const core = im.coreModel;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let summonT = -1;
  const setP = (id, v) => { try { core.setParameterValueById(id, v); } catch (e) { } };

  const LOOK = { xSign: 1, ySign: 1, xGain: 28, yGain: 22, ballGain: 1.0, bodyGain: 7 };

  const RESET_PARAMS = {
    'PARAM_ARM_L_01': 0, 'PARAM_ARM_L_02': 0, 'PARAM_ARM_R_01': 0, 'PARAM_ARM_R_02': 0,
    'PARAM_HAND_L': 0, 'PARAM_HAND_R': 0, 'PARAM_LEG_L': 0, 'PARAM_LEG_R': 0,
    'PARAM_CHEEK': 0, 'PARAM_EYE_L_SMILE': 0, 'PARAM_EYE_R_SMILE': 0,
    'PARAM_EYE_FORM': 0, 'PARAM_EYE_BALL_FORM': 0,
    'PARAM_BROW_L_Y': 0, 'PARAM_BROW_R_Y': 0, 'PARAM_BROW_L_X': 0, 'PARAM_BROW_R_X': 0,
    'PARAM_BROW_L_ANGLE': 0, 'PARAM_BROW_R_ANGLE': 0,
    'PARAM_BROW_L_FORM': 0, 'PARAM_BROW_R_FORM': 0,
    'PARAM_MOUTH_FORM': 1, 'PARAM_MOUTH_OPEN_Y': 0,
    'PARAM_ANGLE_Z': 0, 'PARAM_BODY_ANGLE_Y': 0, 'PARAM_BODY_ANGLE_Z': 0,
    'PARAM_BASE_X': 0, 'PARAM_BASE_Y': 0,
    'PARAM_HAIR_FRONT': 0, 'PARAM_HAIR_BACK': 0, 'PARAM_HAIR_FLUFFY': 0,
    'ParamEyeA': 0, 'ParamMouthA': 0, 'ParamTail': 0,
    'ParamTear': 0, 'ParamStar': 0, 'ParamStartRuning': 0,
    'ParamFoxearL': 0, 'ParamFoxearR': 0
  };

  function stopMotions() {
    try {
      const mm = model.internalModel.motionManager;
      if (mm && typeof mm.stopAllMotions === 'function') mm.stopAllMotions();
    } catch (e) { log('stopMotions fail', e.message); }
  }
  function resetPose() {
    stopMotions();
    for (const k in RESET_PARAMS) setP(k, RESET_PARAMS[k]);
    log('pose reset');
  }

  const rc = { dizzyUntil: 0, dizzyFade: 0, hold: 0, tail: 0, earDroop: 0, blush: 0, nextIdle: performance.now() + 15000 + Math.random() * 10000 };
  const st = {
    t: 0, star: 0, starSpin: 0, tear: 0, ear: 0,
    lastTouch: performance.now(),
    blinkAt: performance.now() + 2200 + Math.random() * 3000, blinkT: -1,
    lookX: 0, lookY: 0, lookTX: 0, lookTY: 0
  };

  const PIN_ARMS = ['PARAM_ARM_L_01', 'PARAM_ARM_L_02', 'PARAM_ARM_R_01', 'PARAM_ARM_R_02',
    'PARAM_HAND_L', 'PARAM_HAND_R', 'PARAM_LEG_L', 'PARAM_LEG_R'];

  const DIZZY_DUR = 4.57;   // 眩晕时长：与 TapFace[1] 动作时长一致

  const IDLE_MOTIONS = [{ idx: 0, dur: 3.5 }, { idx: 1, dur: 5.67 }];
  // 剧情动作：name 会直接作为右键菜单「剧情动作」子菜单的条目名
  const STORY_MOTIONS = [
    { idx: 0, dur: 2.03, name: '赞同' },
    { idx: 1, dur: 1.87, name: '否认' },
    { idx: 2, dur: 2.20, name: '挥手' },
    { idx: 3, dur: 2.57, name: '打气' },
    { idx: 4, dur: 1.87, name: '兴高采烈' },
    { idx: 5, dur: 1.80, name: '高兴' },
    { idx: 6, dur: 1.80, name: '失落' },
    { idx: 7, dur: 1.80, name: '叹气' },
    { idx: 8, dur: 2.03, name: '歪头微笑' },
    { idx: 9, dur: 1.90, name: '叉腰不满' },
    { idx: 10, dur: 2.03, name: '叉腰赞同' },
    { idx: 11, dur: 2.23, name: '尴尬' },
    { idx: 12, dur: 1.80, name: '助威' }
  ];

  // ---------------------------------------------------------------- 动作调度器
  // 依据《动作互斥矩阵》：motion 是单通道独占，所以按优先级 抢占 / 排队 / 丢弃
  // 眩晕(4) > 触摸/点播(3) > 剧情(2) > 待机(1) > 程序(0)
  const PRIO = { dizzy: 4, touch: 3, story: 2, idle: 1, program: 0 };
  function prioOf(group, idx) {
    if (group === 'TapFace' && idx === 1) return PRIO.dizzy;
    if (group === 'Story') return PRIO.story;
    if (group === 'Idle') return PRIO.idle;
    return PRIO.touch;
  }
  let curMotion = null;     // { group, idx, priority, endAt }
  const motionQueue = [];   // 只排 1 条（序列动作，如「竖起 → 兴奋甩动」）

  function startMotion(group, idx, prio, holdSec) {
    try { model.motion(group, idx); } catch (e) { log('motion fail', e.message); return false; }
    rc.hold = Math.max(rc.hold, holdSec);
    curMotion = { group, idx, priority: prio, endAt: performance.now() + holdSec * 1000 };
    log('motion play', group, idx, 'p' + prio, 'hold', holdSec);
    return true;
  }

  function playMotion(group, idx, holdSec, opts) {
    const now = performance.now();
    const hold = holdSec || 2;
    const prio = (opts && opts.priority) || prioOf(group, idx);
    if (curMotion && now < curMotion.endAt) {
      if (prio > curMotion.priority) {
        log('motion preempt', group, idx, 'p' + prio, '>', curMotion.priority);
        motionQueue.length = 0;
        return startMotion(group, idx, prio, hold);
      }
      if (prio === curMotion.priority) {
        if (motionQueue.length === 0) {
          motionQueue.push({ group, idx, hold, prio });
          log('motion queue', group, idx);
        } else {
          log('motion drop', group, idx, 'queue full');
        }
        return false;
      }
      log('motion drop', group, idx, 'p' + prio, '<', curMotion.priority);
      return false;
    }
    return startMotion(group, idx, prio, hold);
  }

  // 每帧检查：当前动作结束 → 播队列里的，否则复位
  function scheduleTick() {
    if (!curMotion || performance.now() < curMotion.endAt) return;
    const done = curMotion;
    curMotion = null;
    log('motion end', done.group, done.idx);
    if (motionQueue.length) {
      const q = motionQueue.shift();
      log('motion dequeue', q.group, q.idx);
      startMotion(q.group, q.idx, q.prio, q.hold);
    }
  }
  app.ticker.add(scheduleTick);

  // ---------------------------------------------------------------- 台词
  const saidRecent = [];
  let lastDeepAt = 0;
  function pickLine(kind) {
    const pool = (window.LINES || {})[kind];
    if (!pool || !pool.length) return null;
    const avail = pool.filter(t => saidRecent.indexOf(t) === -1);
    const list = avail.length ? avail : pool;
    return list[Math.floor(Math.random() * list.length)];
  }
  function sayLine(kind, priority) {
    try {
      if (!window.Dialog) return;
      const t = pickLine(kind);
      if (!t) return;
      saidRecent.push(t);
      if (saidRecent.length > 10) saidRecent.shift();
      window.Dialog.say(t, { priority: priority || 1 });
    } catch (e) { log('dialog fail', e.message); }
  }

  // ---------------------------------------------------------------- 每帧参数
  function applyParams(dt) {
    st.t += dt;

    // 眩晕 = 星环 + 泪 + 脸红 + 闭眼（动作 TapFace[1]）
    // 时间由 dizzyUntil 控制：拖动中不断续期，松手后保留 1 秒
    if (rc.dizzyUntil > 0) {
      const tNow = performance.now();
      let k;
      if (tNow < rc.dizzyUntil) {
        k = Math.min(1, (tNow - (rc.dizzyStart || tNow)) / 150);   // 淡入 0.15s
        rc.dizzyFade = 0;
      } else {
        if (!rc.dizzyFade) rc.dizzyFade = tNow;
        k = Math.max(0, 1 - (tNow - rc.dizzyFade) / 400);          // 淡出 0.4s
        if (k <= 0) {
          rc.dizzyUntil = 0;
          rc.dizzyFade = 0;
          rc.dizzyStart = 0;
          resetPose();
          return;
        }
      }
      for (const kk of PIN_ARMS) setP(kk, 0);
      st.starSpin = (st.starSpin + dt * 1.6) % 1.6;
      setP('ParamStar', k);
      setP('ParamStartRuning', st.starSpin);
      setP('ParamTear', k);
      setP('PARAM_CHEEK', 0.9 * k);
      setP('PARAM_EYE_L_OPEN', 0);
      setP('PARAM_EYE_R_OPEN', 0);
      return;
    }

    if (rc.hold > 0) {
      rc.hold -= dt;
      if (rc.hold <= 0) resetPose();
      return;
    }

    const nowMs = performance.now();
    const idleFor = nowMs - st.lastTouch;
    if (idleFor > 15000 && nowMs >= rc.nextIdle) {
      const hourNow = new Date().getHours();
      if ((hourNow >= 22 || idleFor > 20 * 60000) && (nowMs - lastDeepAt) > 30 * 60000 && Math.random() < 0.3) {
        lastDeepAt = nowMs;
        sayLine('deep', 2);
      }
      if (idleFor > 45000 && Math.random() < 0.35) {
        const sp = STORY_MOTIONS[Math.floor(Math.random() * STORY_MOTIONS.length)];
        playMotion('Story', sp.idx, sp.dur + 0.3);
      } else {
        const pick = IDLE_MOTIONS[Math.floor(Math.random() * IDLE_MOTIONS.length)];
        playMotion('Idle', pick.idx, pick.dur + 0.25);
        if (Math.random() < 0.35) sayLine('idle', 1);
      }
      rc.nextIdle = nowMs + 25000 + Math.random() * 25000;
      return;
    }

    let tail;
    if (rc.tail > 0) {
      rc.tail = Math.max(0, rc.tail - dt / 1.4);
      tail = Math.sin(st.t * 17) * 0.9 * rc.tail;
    } else {
      tail = 0.25 * Math.sin(st.t * 1.15) + 0.08 * Math.sin(st.t * 2.7);
    }
    setP('ParamTail', clamp(tail, -1, 1));

    const earIdle = 0.07 * Math.sin(st.t * 1.7);
    let droop = 0;
    if (rc.earDroop > 0) {
      rc.earDroop = Math.max(0, rc.earDroop - dt / 1.8);
      droop = -0.9 * rc.earDroop;
    }
    setP('ParamFoxearL', clamp(earIdle + st.ear + droop, -1, 1));
    setP('ParamFoxearR', clamp(earIdle * 0.9 + st.ear * 0.95 + droop, -1, 1));
    st.ear *= Math.max(0, 1 - dt * 2.4);

    if (rc.blush > 0) rc.blush = Math.max(0, rc.blush - dt / 2.6);
    setP('PARAM_CHEEK', Math.min(1, rc.blush * 0.88));

    setP('PARAM_BREATH', 0.5 + 0.5 * Math.sin(st.t * (2 * Math.PI / 4.2)));

    st.lookX += (st.lookTX - st.lookX) * Math.min(1, dt * 6);
    st.lookY += (st.lookTY - st.lookY) * Math.min(1, dt * 6);
    const gx = clamp(st.lookX + Math.sin(st.t * 0.45) * 0.12, -1, 1) * LOOK.xSign;
    const gy = clamp(st.lookY, -1, 1) * LOOK.ySign;
    setP('PARAM_ANGLE_X', gx * LOOK.xGain);
    setP('PARAM_ANGLE_Y', gy * LOOK.yGain);
    setP('PARAM_EYE_BALL_X', gx * LOOK.ballGain);
    setP('PARAM_EYE_BALL_Y', gy * LOOK.ballGain * 0.9);
    setP('PARAM_BODY_ANGLE_X', gx * LOOK.bodyGain);

    if (st.star > 0.001) {
      st.star = Math.max(0, st.star - dt * 0.35);
      setP('ParamStar', st.star);
      st.starSpin = (st.starSpin + dt * 1.6) % 1.6;
      setP('ParamStartRuning', st.starSpin);
    } else {
      setP('ParamStar', 0);
      setP('ParamStartRuning', 0);
    }

    st.tear = 0;
    setP('ParamTear', 0);

    if (summonT >= 0 && summonT < 1.05) {
      setP('PARAM_EYE_L_OPEN', 0);
      setP('PARAM_EYE_R_OPEN', 0);
      return;
    }
    if (window.__noBlink) {
      setP('PARAM_EYE_L_OPEN', 1);
      setP('PARAM_EYE_R_OPEN', 1);
      return;
    }
    if (st.blinkT < 0 && nowMs >= st.blinkAt) st.blinkT = 0;
    let open = 1;
    if (st.blinkT >= 0) {
      st.blinkT += dt;
      const T1 = 0.06, T2 = 0.10, T3 = 0.19;
      if (st.blinkT < T1) open = 1 - st.blinkT / T1;
      else if (st.blinkT < T2) open = 0;
      else if (st.blinkT < T3) open = (st.blinkT - T2) / (T3 - T2);
      else { open = 1; st.blinkT = -1; st.blinkAt = performance.now() + 2200 + Math.random() * 3800; }
    }
    setP('PARAM_EYE_L_OPEN', open);
    setP('PARAM_EYE_R_OPEN', open);
  }

  const mmu = im.motionManager;
  const origMMUpdate = mmu.update.bind(mmu);
  mmu.update = (coreModel, now, dt) => {
    origMMUpdate(coreModel, now, dt);
    try { applyParams(dt || 0.016); } catch (e) { log('applyParams err', e.message); }
  };

  // ---------------------------------------------------------------- 召唤特效
  const fx = new PIXI.Container();
  app.stage.addChildAt(fx, 0);

  function ellipseRing(rx, ry, thick, color, alpha) {
    const g = new PIXI.Graphics();
    g.lineStyle(thick, color, alpha);
    g.drawEllipse(0, 0, rx, ry);
    return g;
  }
  const ground = new PIXI.Container();
  ground.x = CANVAS_W / 2;
  ground.y = CANVAS_BASE_H - 44;
  ground.visible = false;
  fx.addChild(ground);
  const glow = new PIXI.Graphics();
  glow.beginFill(0xffb9d6, 0.16);
  glow.drawEllipse(0, 0, 150, 46);
  glow.endFill();
  const ringA = ellipseRing(150, 46, 6, 0xff8fc0, 1);
  const ringB = ellipseRing(112, 34, 3, 0xffffff, 0.98);
  const ringC = ellipseRing(184, 57, 2, 0xffd9ea, 0.85);
  ground.addChild(glow, ringC, ringA, ringB);

  const sparks = [];
  for (let i = 0; i < 14; i++) {
    const sp = new PIXI.Graphics();
    sp.beginFill(0xfff0f6, 1);
    sp.drawCircle(0, 0, 2 + Math.random() * 2.5);
    sp.endFill();
    sp.alpha = 0;
    sp.__a = Math.random() * Math.PI * 2;
    sp.__rad = 40 + Math.random() * 110;
    sp.__spd = 0.6 + Math.random() * 0.9;
    sp.__lift = 60 + Math.random() * 90;
    sp.__t = 0;
    fx.addChild(sp);
    sparks.push(sp);
  }

  const SUMMON_DUR = 1.9;
  const FX = { t: -1, starFired: false };

  function playSummon() {
    summonT = 0;
    FX.t = 0;
    FX.starFired = false;
    ground.x = app.screen.width / 2;   // 画布宽度随大小变化，每次都重新居中
    ground.visible = true;
    ground.scale.set(0.2);
    for (const sp of sparks) { sp.alpha = 0; sp.__t = 0; }
    model.alpha = 0;
    model.y = baseY + 26;
    model.scale.set(baseScale * 0.96);
    setTimeout(() => sayLine('summon', 2), 1100);
  }

  function updateFX(dtFrames) {
    const dt = dtFrames / 60;
    if (FX.t < 0) return;
    FX.t += dt;
    summonT = FX.t;
    const T = FX.t;
    if (T > SUMMON_DUR) {
      summonT = -1; FX.t = -1;
      ground.visible = false;
      model.alpha = 1;
      model.y = baseY;
      model.scale.set(baseScale);
      for (const sp of sparks) sp.alpha = 0;
      return;
    }
    const pop = Math.min(1, T / 0.55);
    const ease = 1 - Math.pow(1 - pop, 3);
    const out = T < 1.05 ? 1 : Math.max(0, 1 - (T - 1.05) / (SUMMON_DUR - 1.05));
    ground.scale.set(0.2 + ease * 0.95 + Math.max(0, T - 1.05) * 0.35);
    ground.alpha = out;
    ringA.rotation = T * 1.6;
    ringC.rotation = -T * 1.1;
    const pulse = 0.72 + 0.28 * Math.sin(T * 22);
    ringA.alpha = out * pulse;
    ringB.alpha = out * (1.1 - pulse * 0.5);

    for (const sp of sparks) {
      sp.__t += dt * sp.__spd;
      const life = Math.min(1, sp.__t);
      if (life >= 1) { sp.alpha = 0; continue; }
      const rad = sp.__rad * (0.6 + life * 0.5);
      sp.x = ground.x + Math.cos(sp.__a + life * 1.2) * rad;
      sp.y = ground.y - life * sp.__lift + Math.sin(sp.__a) * 10;
      sp.alpha = Math.sin(life * Math.PI) * 0.95;
    }

    const mp = Math.min(1, Math.max(0, (T - 0.35) / 0.85));
    const me = 1 - Math.pow(1 - mp, 3);
    model.alpha = me;
    model.y = baseY + (1 - me) * 26;
    model.scale.set(baseScale * (0.96 + 0.04 * me));

    if (!FX.starFired && T > 1.0) { FX.starFired = true; st.star = 1; st.starSpin = 0; }
  }
  app.ticker.add(updateFX);
  playSummon();
  if (window.pet.onShown) window.pet.onShown(() => playSummon());

  // ---------------------------------------------------------------- 命中掩码
  let SW = 96, SH = Math.round(96 * (CANVAS_BASE_H / CANVAS_W));
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = SW; maskCanvas.height = SH;
  let mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  let mask = null;

  function grabMask() {
    try {
      const w = app.screen.width, h = app.screen.height;
      SH = Math.round(96 * (h / w));
      if (maskCanvas.height !== SH) {
        maskCanvas.height = SH;
        mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
      }
      mctx.clearRect(0, 0, SW, SH);
      mctx.drawImage(app.view, 0, 0, app.view.width, app.view.height, 0, 0, SW, SH);
      mask = mctx.getImageData(0, 0, SW, SH).data;
      const raw = new Uint8Array(SW * SH);
      for (let i = 0; i < SW * SH; i++) raw[i] = mask[i * 4 + 3] > 8 ? 1 : 0;

      // 可见包围盒上报（窗口内坐标）：用于主进程夹边和贴边吸附。
      // 窗口两侧有透明留白，按窗口矩形夹的话她永远贴不到屏幕左右边缘
      let bx0 = SW, bx1 = -1, by0 = SH, by1 = -1;
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          if (!raw[y * SW + x]) continue;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
      if (bx1 >= 0 && window.pet.sendPetBox) {
        const kx = app.screen.width / SW, ky = app.screen.height / SH;
        const r = app.view.getBoundingClientRect();
        window.pet.sendPetBox({
          x: Math.round(r.left + bx0 * kx),
          y: Math.round(r.top + by0 * ky),
          w: Math.round((bx1 - bx0 + 1) * kx),
          h: Math.round((by1 - by0 + 1) * ky)
        });
      }
      const bits = new Uint8Array(SW * SH);
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          let v = 0;
          for (let dy = -1; dy <= 1 && !v; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= SH) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= SW) continue;
              if (raw[yy * SW + xx]) { v = 1; break; }
            }
          }
          bits[y * SW + x] = v;
        }
      }
      if (window.pet.sendMask) window.pet.sendMask(SW, SH, bits);
    } catch (e) { mask = null; }
  }
  setInterval(grabMask, 250);
  setTimeout(grabMask, 300);

  function toCanvas(x, y) {
    const r = app.view.getBoundingClientRect();
    const sx = app.screen.width / (r.width || 1);
    const sy = app.screen.height / (r.height || 1);
    return { x: (x - r.left) * sx, y: (y - r.top) * sy };
  }

  function hitAt(clientX, clientY) {
    const c = toCanvas(clientX, clientY);
    const b = model.getBounds();
    if (c.x < b.x || c.y < b.y || c.x > b.x + b.width || c.y > b.y + b.height) return false;
    if (!mask) return true;
    const mx = Math.min(SW - 1, Math.floor(c.x / app.screen.width * SW));
    const my = Math.min(SH - 1, Math.floor(c.y / app.screen.height * SH));
    return mask[(my * SW + mx) * 4 + 3] > 8;
  }

  function zoneAt(clientX, clientY) {
    const c = toCanvas(clientX, clientY);
    const b = model.getBounds();
    const rx = (c.x - b.x) / b.width;
    const ry = (c.y - b.y) / b.height;
    if (rx > 0.66 && ry > 0.42 && ry < 0.92) return 'tail';
    if (ry > 0.90 && rx > 0.20 && rx < 0.80) return 'foot';   // 脚：模型包围盒最底部中间
    if (ry > 0.70 && rx > 0.22 && rx < 0.78) return 'leg';    // 腿：脚上方一段（与脚共用台词池）
    if (ry < 0.24 && (rx < 0.42 || rx > 0.58)) return 'ears';
    if (ry < 0.42) return 'head';
    return 'body';
  }

  // ---------------------------------------------------------------- 反应
  // 同一部位：1 秒内重复点无效；连续点满 4 次 → 播一个剧情动作代替部位反应
  const TOUCH_CD_MS = 1000;
  const TOUCH_STREAK_N = 4;
  const TOUCH_STREAK_RESET_MS = 8000;
  const touchState = new Map();   // zone -> { n, lastAt }

  function playStoryOnce(kind) {
    const sp = STORY_MOTIONS[Math.floor(Math.random() * STORY_MOTIONS.length)];
    bumpFPS();
    // 同级排队：正在播触摸动作时排到它后面，而不是被优先级丢掉
    playMotion('Story', sp.idx, sp.dur + 0.3, { priority: PRIO.touch });
    log('story motion', 'Story', sp.idx, 'by', kind);
    sayLine('double', 2);
  }

  function react(kind) {
    const now = performance.now();
    const rec = touchState.get(kind) || { n: 0, lastAt: 0 };
    if (rec.lastAt && now - rec.lastAt < TOUCH_CD_MS) {
      log('touch cd', kind, Math.round(now - rec.lastAt) + 'ms');
      return;
    }
    if (rec.lastAt && now - rec.lastAt > TOUCH_STREAK_RESET_MS) {
      rec.n = 0;
      log('touch streak reset', kind);
    }
    rec.n += 1;
    rec.lastAt = now;
    touchState.set(kind, rec);

    st.lastTouch = now;
    st.tear = 0;
    rc.nextIdle = now + 15000 + Math.random() * 10000;

    if (rec.n >= TOUCH_STREAK_N) {
      rec.n = 0;
      log('touch streak story', kind, '(4/' + TOUCH_STREAK_N + ')');
      if (window.pet.onboard) window.pet.onboard('tap');
      playStoryOnce(kind);
      return;   // 第 4 次不再执行原部位反应
    }

    if (kind === 'ears') {
      st.ear = 1.2; rc.blush = 1;
      // 摸耳朵的动画：用「表情/特殊」里的「耳朵兴奋」(TapFace[2], 1.6s)
      playMotion('TapFace', 2, 1.6 + 0.25);
    }
    else if (kind === 'head') { st.ear = 1.0; rc.blush = Math.max(rc.blush, 0.45); }
    else if (kind === 'body') { rc.earDroop = 1; }
    else if (kind === 'tail') { rc.tail = 1; rc.blush = 0.95; st.ear = 0.6; }
    else if (kind === 'foot' || kind === 'leg') { st.ear = 0.9; rc.blush = Math.max(rc.blush, 0.75); rc.hold = Math.max(rc.hold, 0.2); }
    else if (kind === 'dizzy') {
      enterDizzy(DIZZY_DUR * 1000);
    }
    log('react:', kind, '(' + rec.n + '/' + TOUCH_STREAK_N + ')');
    if (window.pet.onboard) window.pet.onboard('tap');   // 首启引导：摸过她一次
    sayLine(kind, 2);
  }
  function enterDizzy(holdMs) {
    const first = rc.dizzyUntil <= 0;
    rc.dizzyUntil = performance.now() + Math.max(400, holdMs);
    rc.dizzyFade = 0;
    if (first) {
      rc.dizzyStart = performance.now();
      // 眩晕优先级最高，走调度器抢占当前动作
      playMotion('TapFace', 1, Math.max(1, holdMs / 1000), { priority: PRIO.dizzy });
      sayLine('dizzy', 2);
      log('dizzy on');
    }
  }
  window.__dizzy = enterDizzy;

  // 甩飞：拖动中主进程不断发 fling-hold（每 ~120ms），每次续期 1 秒
  if (window.pet.onFlingHold) {
    window.pet.onFlingHold((d) => {
      enterDizzy(1000);
      log('fling hold avg', (d && d.avg) || '-');
    });
  }

  window.__react = (k) => react(k);

  if (window.pet.onShakeDizzy) {
    window.pet.onShakeDizzy((d) => {
      const ms = (d && d.ms) || 800;
      enterDizzy(DIZZY_DUR * 1000);
      st.lastTouch = performance.now();
      log('shake dizzy trigger');
    });
  }

  // ---------------------------------------------------------------- 拖拽
  let dragging = false;
  let downAt = null;
  let lastScreen = null;   // 上一次 mousemove 的绝对屏幕坐标（CSS px，与 setPosition 的 DIP 同单位）
  let dragUnit = { move: 0, screen: 0 };
  let lastHit = null;

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) {
      log('mousedown miss at', Math.round(e.clientX), Math.round(e.clientY), 'mask?', !!mask);
      return;
    }
    dragging = true;
    bumpFPS();
    downAt = { x: e.screenX, y: e.screenY, t: performance.now() };
    lastScreen = { x: e.screenX, y: e.screenY };
    dragUnit = { move: 0, screen: 0 };
    try { window.pet.dragStart({ sx: e.screenX, sy: e.screenY }); } catch (err) { }
    e.preventDefault();
  });

  // 收尾统一走这里：顺便记录「movementX 累计 vs 屏幕坐标累计」，缩放比例有异常时一眼能看出来
  const finishDrag = () => {
    dragging = false;
    try { window.pet.dragEnd(); } catch (err) { }
    if (dragUnit.screen > 20) {
      log('[drag-unit] screen', Math.round(dragUnit.screen),
        'movement', Math.round(dragUnit.move),
        'ratio', (dragUnit.move / dragUnit.screen).toFixed(2),
        'dpr', window.devicePixelRatio);
    }
    lastScreen = null;
  };

  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      // 左键已经松开却没收到 mouseup（穿透/失焦时常见）→ 就地收尾，
      // 否则会一直往主进程发位移，拖拽状态永远不复位
      if (e.buttons === 0) {
        downAt = null;
        finishDrag();
        return;
      }
      // 位移用 e.screenX/Y 的差：绝对屏幕坐标是 CSS px，与主进程 setPosition(DIP) 同一坐标系。
      // 而 movementX/Y 在 125% 缩放下给的是设备像素，会放大 1.25 倍 —— 每拖 1px 窗口走 1.25px，
      // 越拖越超前，手感就是"逐渐脱离鼠标"。用绝对坐标求差还能顺带吃掉丢事件造成的缺口。
      let dx = 0, dy = 0;
      if (lastScreen && Number.isFinite(e.screenX) && Number.isFinite(e.screenY)) {
        dx = e.screenX - lastScreen.x;
        dy = e.screenY - lastScreen.y;
        lastScreen = { x: e.screenX, y: e.screenY };
      } else {
        dx = e.movementX || 0;
        dy = e.movementY || 0;
      }
      dragUnit.move += Math.hypot(e.movementX || 0, e.movementY || 0);
      dragUnit.screen += Math.hypot(dx, dy);
      if (dx || dy) {
        // 同时把绝对屏幕坐标送过去：主进程按「起点 + 总位移」定位，避免逐帧累加漂移
        try { window.pet.dragBy({ dx, dy, sx: e.screenX, sy: e.screenY }); } catch (err) { }
      }
      return;
    }
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) bumpFPS();
    if (hit !== lastHit) {
      lastHit = hit;
      log('hover hit =', hit, 'at', Math.round(e.clientX), Math.round(e.clientY));
    }
    if (hit) st.ear = Math.max(st.ear, 0.3);
    if (window.pet.setIgnoreMouse) window.pet.setIgnoreMouse(!hit);
  });

  window.addEventListener('mouseup', (e) => {
    // 只处理左键：右键松手不该结束拖拽、也不该算一次触摸
    if (e.button !== 0) return;
    if (!dragging) return;
    const moved = downAt ? Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) : 99;
    downAt = null;
    finishDrag();
    if (moved < 6) {
      // 双击手势已取消：统一走「每点 4 次触发剧情」，1 秒内的重复点由 react 的 CD 拦掉
      react(zoneAt(e.clientX, e.clientY));
    }
  });

  window.addEventListener('mouseleave', () => {
    st.lookTX = 0; st.lookTY = 0;
    // 拖拽中光标短暂跑出窗口矩形不能切成穿透，否则会直接丢掉后续 mousemove/mouseup
    if (window.pet.setIgnoreMouse) window.pet.setIgnoreMouse(!dragging);
  });

  if (window.pet.onCursor) {
    window.pet.onCursor((d) => {
      const nx = (d.x - d.w / 2) / (d.w * 0.75);
      const ny = (d.y - d.h * 0.42) / (d.h * 0.55);
      st.lookTX = clamp(nx, -1, 1);
      st.lookTY = clamp(-ny, -1, 1);
    });
  }

  // ---------------------------------------------------------------- 右键菜单
  const MOTION_CATALOG = [
    { group: 'Idle', idx: 0, label: '待机·轻晃', dur: 3.5 },
    { group: 'Idle', idx: 1, label: '待机·长循环', dur: 5.67 },
    { group: 'Idle', idx: 2, label: '耳朵·自然摆', dur: 1.2 },
    { group: 'Idle', idx: 3, label: '耳朵·自然摆（变体）', dur: 1.2 },
    { group: 'Idle', idx: 4, label: '尾巴·自然垂', dur: 1.0 },
    { group: 'TapHead', idx: 0, label: '耳朵竖起', dur: 1.0 },
    { group: 'TapHead', idx: 1, label: '耳朵竖起（保持）', dur: 0.6 },
    { group: 'TapHead', idx: 2, label: '耳朵恢复', dur: 0.8 },
    { group: 'TapHead', idx: 3, label: '耳朵闪动', dur: 1.0 },
    { group: 'TapBody', idx: 0, label: '耳朵耷拉', dur: 0.8 },
    { group: 'TapBody', idx: 1, label: '耷拉恢复', dur: 0.8 },
    { group: 'TapBody', idx: 2, label: '耳朵垂下', dur: 0.8 },
    { group: 'TapBody', idx: 3, label: '垂下恢复', dur: 0.8 },
    { group: 'TapBody', idx: 4, label: '耳朵抖动', dur: 1.8 },
    { group: 'TapTail', idx: 0, label: '尾巴竖起', dur: 0.8 },
    { group: 'TapTail', idx: 1, label: '尾巴兴奋甩动', dur: 1.3 },
    { group: 'TapTail', idx: 2, label: '尾巴抖动', dur: 1.0 },
    { group: 'TapTail', idx: 3, label: '尾巴放下', dur: 0.8 },
    { group: 'TapFace', idx: 0, label: '生气（眼+嘴+尾）', dur: 1.5 },
    { group: 'TapFace', idx: 1, label: '眩晕（星环+泪+脸红+闭眼）', dur: 4.57 },
    { group: 'TapFace', idx: 2, label: '耳朵兴奋', dur: 1.6 }
  ];
  for (const sp of STORY_MOTIONS) {
    MOTION_CATALOG.push({ group: 'Story', idx: sp.idx, label: sp.name, dur: 2.6 });
  }

  // 首启引导：主进程按里程碑下发一两句提示（优先级 3，压过普通台词）
  if (window.pet.onOnboarding) {
    window.pet.onOnboarding((d) => {
      if (!d || !d.text) return;
      log('onboarding:', d.text);
      try { window.Dialog && window.Dialog.say(d.text, { priority: 3 }); } catch (e) { }
    });
  }

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    try { window.pet.openMenu(); } catch (err) { log('menu fail', err.message); }
  });

  if (window.pet.onPlayMotion) {
    window.pet.onPlayMotion((m) => {
      if (!m) return;
      log('menu play', m.group, m.idx, m.label);
      bumpFPS();
      rc.dizzyUntil = 0; rc.dizzyFade = 0;
      st.ear = 0.7;
      rc.blush = Math.max(rc.blush, 0.3);
      st.lastTouch = performance.now();
      if (m.group === 'TapFace' && m.idx === 1) {
        enterDizzy((m.dur || DIZZY_DUR) * 1000);
        return;
      }
      playMotion(m.group, m.idx, (m.dur || 2) + 0.25);
      rc.nextIdle = performance.now() + 25000 + Math.random() * 15000;
      sayLine('menu', 1);
    });
  }

  if (window.pet.onPlayLine) {
    window.pet.onPlayLine((kind) => {
      if (kind === 'eat') {
        rc.blush = Math.max(rc.blush, 0.5);
        st.ear = 0.8;
        st.lastTouch = performance.now();
        sayLine('eat', 3);
      } else if (kind === 'story') {
        st.lastTouch = performance.now();
        sayLine('story', 3);
      }
      log('play-line', kind);
    });
  }

  try { window.pet.sendMotions(MOTION_CATALOG); } catch (e) { }
  log('renderer ready');
})();
