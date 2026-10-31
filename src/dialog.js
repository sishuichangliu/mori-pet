'use strict';

/* 对话框：气泡显示 / 打字机 / 冷却 / 优先级 */

(function () {
  const el = document.getElementById('dialog');
  let timerHide = null;
  let timerType = null;
  let currentPriority = 0;
  let lastSayAt = 0;
  let hovered = false;
  let visible = false;

  const MIN_GAP = 3000;      // 两句之间至少 3 秒
  const TYPE_MS = 40;        // 打字机速度

  function reportRects() {
    try {
      const canvas = document.querySelector('#stage canvas');
      const cr = canvas ? canvas.getBoundingClientRect() : null;
      const dr = visible ? el.getBoundingClientRect() : null;
      const pack = (r) => r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      window.pet.sendRects({ canvas: pack(cr), dialog: pack(dr) });
    } catch (e) { }
  }

  function hide() {
    if (!visible) return;
    visible = false;
    el.classList.remove('show');
    el.textContent = '';
    if (timerHide) { clearTimeout(timerHide); timerHide = null; }
    if (timerType) { clearInterval(timerType); timerType = null; }
    reportRects();
  }

  function scheduleHide(ms) {
    if (timerHide) clearTimeout(timerHide);
    timerHide = setTimeout(() => {
      if (hovered) { scheduleHide(1200); return; }
      hide();
    }, ms);
  }

  function show(text, priority) {
    if (timerType) { clearInterval(timerType); timerType = null; }
    if (timerHide) { clearTimeout(timerHide); timerHide = null; }

    // 长句自动降字号：14 / 13 / 12px，配合 344px 宽和 128px 高上限，保证整句都能显示
    el.style.fontSize = (text.length > 110 ? 12 : text.length > 80 ? 13 : 14) + 'px';

    el.textContent = '';
    visible = true;
    currentPriority = priority || 1;
    requestAnimationFrame(() => el.classList.add('show'));
    lastSayAt = performance.now();

    // 打字机
    let i = 0;
    timerType = setInterval(() => {
      el.textContent = text.slice(0, ++i);
      if (i >= text.length) {
        clearInterval(timerType);
        timerType = null;
        scheduleHide(Math.max(2200, text.length * 90));
        reportRects();
      }
    }, TYPE_MS);
    reportRects();
  }

  function setCanvasHeight(h) {
    el.style.bottom = Math.max(8, h - 12) + 'px';
    reportRects();
  }

  window.Dialog = {
    setCanvasHeight,
    say(text, opts) {
      if (!text) return;
      const priority = (opts && opts.priority) || 1;
      const now = performance.now();

      // 冷却：同优先级以下且在冷却期内则忽略
      if (visible && priority < currentPriority) return;
      if (!visible && now - lastSayAt < MIN_GAP) return;

      show(text, priority);
    },
    hide,
    isVisible: () => visible,
    reportRects
  };

  el.addEventListener('mouseenter', () => { hovered = true; });
  el.addEventListener('mouseleave', () => { hovered = false; });
  el.addEventListener('click', () => hide());
  window.addEventListener('resize', reportRects);
})();
