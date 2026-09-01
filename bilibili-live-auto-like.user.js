// ==UserScript==
// @name         B站直播间自动点赞
// @namespace    https://github.com/coni233/bili-live-auto-like
// @homepageURL  https://github.com/coni233/bili-live-auto-like
// @supportURL   https://github.com/coni233/bili-live-auto-like/issues
// @version      1.4.0
// @description  在 B 站直播间自动点赞：每点赞 30 次 +1 亲密度，每日点赞亲密度上限 10（即最多 300 赞/房间/天）。自动检测开播状态，本地记录每日进度，到上限自动停止。
// @author       coni
// @match        https://live.bilibili.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @noframes
// @license      MIT
// ==/UserScript==

/*!
 * B站直播间自动点赞
 *
 * 规则说明（2026-05 后新版亲密度规则）：
 *   - 直播开播期间，每点赞 30 次 +1 亲密度；
 *   - 每日通过点赞获得的亲密度上限为 10，即每天最多 300 次有效点赞；
 *   - 未开播时点赞无效，脚本会等待开播后再点。
 *
 * 实现方式：
 *   - 直接点击直播间页面原生点赞按钮，由 B 站页面自身上报，无需跨域请求；
 *   - 点赞进度按「房间」分别记录在 Tampermonkey 本地存储，次日自动清零；
 *   - 提供悬浮控制面板，可随时开始 / 停止，也可通过油猴菜单操作。
 *
 * 安全承诺：不注入页面、不发送任何跨域请求、不收集个人信息。
 */

(function () {
  'use strict';

  /* ===================== 可调配置 ===================== */
  const CONFIG = Object.freeze({
    // 每 N 次点赞 = +1 亲密度
    LIKES_PER_INTIMACY: 30,

    // 每日通过点赞获得的亲密度上限（超过后自动停止）
    DAILY_INTIMACY_CAP: 10,

    // 冗余点赞次数：实际会多点赞这么多，防止个别点赞漏记导致亲密度差一点
    REDUNDANT_LIKES: 10,

    // 连续点赞 N 次后暂停一小段时间，模拟人工节奏
    BATCH_SIZE: 30,

    // 页面加载后是否自动开始（未开播时会等待）
    AUTO_START: true,

    // 未开播时，每隔多久重新检测一次开播状态
    LIVE_CHECK_MS: 60000,

    // 找不到点赞按钮时，每隔多久重试
    BUTTON_RETRY_MS: 3000,

    // 请求失败/异常后的冷却时间（毫秒）
    ERROR_COOLDOWN_MS: 15000,
  });

  /* 点赞速度档位：B 站网页端单次点赞间隔最低约 500ms，过快会被拒绝/风控 */
  const SPEED_PRESETS = Object.freeze({
    // min/max 为单次点赞间隔（毫秒），batchPause 为每批点赞后的暂停（毫秒）
    slow: { label: '慢速', min: 1500, max: 2500, batchPause: [5000, 9000] },
    normal: { label: '标准', min: 1000, max: 1600, batchPause: [4000, 7000] },
    fast: { label: '快速', min: 600, max: 1000, batchPause: [3000, 5000] },
  });

  /* ===================== 常量与工具 ===================== */
  const STORAGE_KEY = 'biliAutoLike.daily.v1';
  const UI_KEY = 'biliAutoLike.ui.v1';
  const SETTINGS_KEY = 'biliAutoLike.settings.v1';
  const SCRIPT_NAME = 'B站自动点赞';
  const DAILY_MAX_LIKES = CONFIG.LIKES_PER_INTIMACY * CONFIG.DAILY_INTIMACY_CAP;
  const DAILY_TARGET_LIKES = DAILY_MAX_LIKES + CONFIG.REDUNDANT_LIKES;

  // 点赞按钮候选选择器（覆盖不同版本页面）
  const LIKE_SELECTORS = [
    '.like-btn',
    '.web-like-icon',
    '.web-like-btn',
    '.like-button',
    '#like-btn',
    '[class*="like-btn"]',
    '[class*="web-like"]',
    '[title="点赞"]',
    '[aria-label*="点赞"]',
  ];

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clampVal = (v, min, max) => Math.max(min, Math.min(max, v));

  function today() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function safeParse(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }

  function notify(title, text) {
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title, text, timeout: 5000 });
      }
    } catch (e) {
      /* 忽略通知失败 */
    }
  }

  /* ===================== 设置存储（速度档位等） ===================== */
  const Settings = {
    speed: 'fast',

    load() {
      const saved = safeParse(GM_getValue(SETTINGS_KEY, null), {});
      if (saved.speed && SPEED_PRESETS[saved.speed]) this.speed = saved.speed;
      else this.speed = 'fast';
      return this;
    },

    save() {
      GM_setValue(SETTINGS_KEY, { speed: this.speed });
    },

    preset() {
      return SPEED_PRESETS[this.speed] || SPEED_PRESETS.fast;
    },
  };

  /* ===================== 每日计数存储 ===================== */
  const Store = {
    data: null,

    load() {
      const raw = safeParse(GM_getValue(STORAGE_KEY, null), null);
      if (raw && raw.date === today() && raw.rooms && typeof raw.rooms === 'object') {
        this.data = raw;
      } else {
        this.data = { date: today(), rooms: {} };
        this.save();
      }
      return this.data;
    },

    save() {
      GM_setValue(STORAGE_KEY, this.data);
    },

    getCount(roomId) {
      const key = String(roomId);
      return Number(this.data.rooms[key]) || 0;
    },

    add(roomId) {
      const key = String(roomId);
      this.data.rooms[key] = this.getCount(roomId) + 1;
      this.save();
      return this.data.rooms[key];
    },

    resetToday() {
      this.data = { date: today(), rooms: {} };
      this.save();
    },
  };

  /* ===================== 房间信息读取 ===================== */
  function getRoomInfo() {
    let roomId = '';
    let liveStatus = null;
    try {
      const neptune = window.__NEPTUNE_IS_MY_WAIFU__ || {};
      const init = (neptune.roomInitRes && neptune.roomInitRes.data) ||
        (window.__SSR_INITIAL_STATE__ && window.__SSR_INITIAL_STATE__.roomInfo) ||
        {};
      roomId = String(init.room_id || init.roomId || '');
      liveStatus = init.live_status != null ? Number(init.live_status) : null;
    } catch (e) {
      /* 忽略读取失败 */
    }
    if (!roomId) {
      const m = /^\/(\d+)/.exec(location.pathname);
      if (m) roomId = m[1];
    }
    return { roomId, liveStatus };
  }

  /* ===================== 点赞按钮 ===================== */
  function findLikeButton() {
    for (const selector of LIKE_SELECTORS) {
      let els = [];
      try {
        els = Array.from(document.querySelectorAll(selector));
      } catch (e) {
        continue;
      }
      if (!els.length) continue;
      return els.find((el) => isVisible(el)) || els[0];
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      el.getClientRects().length > 0
    );
  }

  /* ===================== 悬浮面板 ===================== */
  const Panel = {
    root: null,
    fab: null,
    fabBadge: null,
    status: null,
    progress: null,
    detail: null,
    toggleBtn: null,
    ui: { collapsed: false, left: null, top: null },

    build() {
      this.loadUi();
      Settings.load();

      const root = document.createElement('div');
      root.id = 'bili-auto-like-panel';
      root.innerHTML = `
        <div class="balp-header">
          <span class="balp-title">👍 自动点赞</span>
          <button type="button" class="balp-collapse" title="折叠/展开">—</button>
        </div>
        <div class="balp-body">
          <div class="balp-status-row"><span class="balp-dot"></span><span class="balp-status">初始化…</span></div>
          <div class="balp-progress"><div class="balp-progress-fill"></div></div>
          <div class="balp-detail">今日 0 / ${DAILY_TARGET_LIKES} 赞（+0 亲密度）</div>
          <div class="balp-speed-row">
            <span>速度</span>
            <select class="balp-speed">
              <option value="slow">慢速</option>
              <option value="normal">标准</option>
              <option value="fast">快速</option>
            </select>
          </div>
          <button type="button" class="balp-toggle">开始</button>
        </div>`;

      const fab = document.createElement('div');
      fab.id = 'bili-auto-like-fab';
      fab.title = '展开 / 折叠自动点赞面板';
      fab.innerHTML = '👍<span class="balp-fab-badge">0</span>';

      document.body.appendChild(root);
      document.body.appendChild(fab);

      this.root = root;
      this.fab = fab;
      this.fabBadge = fab.querySelector('.balp-fab-badge');
      this.status = root.querySelector('.balp-status');
      this.progress = root.querySelector('.balp-progress-fill');
      this.detail = root.querySelector('.balp-detail');
      this.toggleBtn = root.querySelector('.balp-toggle');
      this.body = root.querySelector('.balp-body');
      this.speedSelect = root.querySelector('.balp-speed');
      this.speedSelect.value = Settings.speed;

      root.querySelector('.balp-collapse').addEventListener('click', () => {
        this.toggleCollapsed();
      });
      this.toggleBtn.addEventListener('click', () => {
        if (Engine.running) Engine.stop();
        else Engine.start();
      });
      this.speedSelect.addEventListener('change', () => {
        Settings.speed = this.speedSelect.value;
        Settings.save();
      });

      this._makeDraggable(root.querySelector('.balp-header'));
      this._makeDraggable(fab, { threshold: 5 });

      fab.addEventListener('click', () => {
        if (fab.dataset.moved === '1') {
          delete fab.dataset.moved;
          return;
        }
        this.toggleCollapsed();
      });

      this.apply();
    },

    loadUi() {
      const saved = safeParse(GM_getValue(UI_KEY, null), {});
      this.ui.collapsed = !!saved.collapsed;
      this.ui.left = saved.left != null ? Number(saved.left) : null;
      this.ui.top = saved.top != null ? Number(saved.top) : null;
    },

    saveUi() {
      GM_setValue(UI_KEY, this.ui);
    },

    /* 只使用 left/top 定位并限制在视口内，避免与 bottom/right 冲突导致粘连 */
    applyPos(el, left, top) {
      const w = el.offsetWidth || (el === this.fab ? 44 : 220);
      const h = el.offsetHeight || (el === this.fab ? 44 : 130);
      if (left == null || top == null) {
        left = window.innerWidth - w - 16;
        top = window.innerHeight - h - 16;
      }
      const maxLeft = Math.max(8, window.innerWidth - w - 8);
      const maxTop = Math.max(8, window.innerHeight - h - 8);
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = `${clampVal(left, 8, maxLeft)}px`;
      el.style.top = `${clampVal(top, 8, maxTop)}px`;
      this.ui.left = parseInt(el.style.left, 10);
      this.ui.top = parseInt(el.style.top, 10);
    },

    apply() {
      if (this.ui.collapsed) {
        this.root.style.display = 'none';
        this.fab.hidden = false;
        this.applyPos(this.fab, this.ui.left, this.ui.top);
      } else {
        this.root.style.display = '';
        this.fab.hidden = true;
        this.applyPos(this.root, this.ui.left, this.ui.top);
      }
    },

    toggleCollapsed() {
      this.ui.collapsed = !this.ui.collapsed;
      this.apply();
      this.saveUi();
    },

    _makeDraggable(el, options) {
      const threshold = (options && options.threshold) || 0;
      let drag = null;
      const point = (e) => (e.touches && e.touches[0]) || e;
      const onMove = (e) => {
        if (!drag) return;
        const p = point(e);
        if (!drag.moved && Math.hypot(p.clientX - drag.startX, p.clientY - drag.startY) > threshold) {
          drag.moved = true;
        }
        if (drag.moved) {
          this.applyPos(el, p.clientX - drag.offsetX, p.clientY - drag.offsetY);
          if (el.dataset) el.dataset.moved = '1';
        }
      };
      const onUp = () => {
        if (drag && drag.moved) {
          this.ui.left = parseInt(el.style.left, 10);
          this.ui.top = parseInt(el.style.top, 10);
          this.saveUi();
        }
        drag = null;
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
      };
      el.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('button')) return;
        const p = point(e);
        drag = {
          startX: p.clientX,
          startY: p.clientY,
          offsetX: p.clientX - el.getBoundingClientRect().left,
          offsetY: p.clientY - el.getBoundingClientRect().top,
          moved: threshold === 0,
        };
        e.preventDefault();
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
      });
    },

    setRunning(running) {
      this.root.classList.toggle('running', running);
      this.toggleBtn.textContent = running ? '停止' : '开始';
      this.toggleBtn.disabled = false;
    },

    setStatus(text, type) {
      this.status.textContent = text;
      this.root.querySelector('.balp-dot').className = 'balp-dot' + (type ? ' ' + type : '');
    },

    setProgress(likes) {
      const intimacy = Math.floor(likes / CONFIG.LIKES_PER_INTIMACY);
      const capIntimacy = CONFIG.DAILY_INTIMACY_CAP;
      const pct = Math.min(100, Math.round((likes / DAILY_TARGET_LIKES) * 100));
      this.progress.style.width = `${pct}%`;
      this.detail.textContent =
        `今日 ${likes} / ${DAILY_TARGET_LIKES} 赞（+${intimacy}/${capIntimacy} 亲密度）`;
      if (this.fabBadge) this.fabBadge.textContent = String(likes);
    },
  };

  /* ===================== 核心引擎 ===================== */
  const Engine = {
    running: false,
    runId: 0,
    likesThisSession: 0, // 本次运行已点击次数（供进度显示）

    start() {
      if (this.running) return;
      const info = getRoomInfo();
      if (!info.roomId) {
        Panel.setStatus('未识别到直播间', 'warn');
        return;
      }
      if (Store.getCount(info.roomId) >= DAILY_TARGET_LIKES) {
        Panel.setStatus('今日已达上限', 'done');
        Panel.setRunning(false);
        notify(SCRIPT_NAME, `今日点赞目标已完成（${DAILY_TARGET_LIKES} 赞，含 ${CONFIG.REDUNDANT_LIKES} 冗余），无需继续。`);
        return;
      }
      this.running = true;
      this.runId++;
      this.likesThisSession = 0;
      Panel.setRunning(true);
      const runId = this.runId;
      this.loop(info, runId);
    },

    stop(reason) {
      this.running = false;
      Panel.setRunning(false);
      if (reason) Panel.setStatus(reason, 'done');
    },

    async loop(info, runId) {
      while (this.running && runId === this.runId) {
        // 每次循环都重新读取房间信息（支持直播间内切换房间）
        const cur = getRoomInfo();
        const roomId = cur.roomId || info.roomId;

        // 达到每日上限则停止
        if (Store.getCount(roomId) >= DAILY_TARGET_LIKES) {
          this.stop('今日已达上限');
          Panel.setProgress(DAILY_TARGET_LIKES);
          notify(SCRIPT_NAME, `今日点赞目标已完成（${DAILY_TARGET_LIKES} 赞，含 ${CONFIG.REDUNDANT_LIKES} 冗余），已自动停止。`);
          return;
        }

        // 未开播时不点赞，等待开播
        if (cur.liveStatus != null && cur.liveStatus !== 1) {
          Panel.setStatus('未开播，等待开播…', 'warn');
          await sleep(CONFIG.LIVE_CHECK_MS);
          continue;
        }

        const btn = findLikeButton();
        if (!btn) {
          Panel.setStatus('未找到点赞按钮，重试中…', 'warn');
          await sleep(CONFIG.BUTTON_RETRY_MS);
          continue;
        }
        if (!isVisible(btn)) {
          Panel.setStatus('点赞按钮不可用，重试中…', 'warn');
          await sleep(CONFIG.BUTTON_RETRY_MS);
          continue;
        }

        Panel.setStatus('运行中…', 'run');
        try {
          btn.click();
          Store.add(roomId);
          this.likesThisSession++;
          const total = Store.getCount(roomId);
          Panel.setProgress(total);

          if (total >= DAILY_TARGET_LIKES) {
            this.stop('今日已达上限');
            Panel.setProgress(total);
            notify(SCRIPT_NAME, `今日点赞目标已完成（${DAILY_TARGET_LIKES} 赞，含 ${CONFIG.REDUNDANT_LIKES} 冗余），已自动停止。`);
            return;
          }
        } catch (e) {
          console.warn(`[${SCRIPT_NAME}] 点赞失败：`, e);
          Panel.setStatus('点赞异常，冷却中…', 'warn');
          await sleep(CONFIG.ERROR_COOLDOWN_MS);
          continue;
        }

        // 每批点赞后暂停，模拟人工节奏
        const preset = Settings.preset();
        if (this.likesThisSession % CONFIG.BATCH_SIZE === 0) {
          await sleep(rand(preset.batchPause[0], preset.batchPause[1]));
        } else {
          await sleep(rand(preset.min, preset.max));
        }
      }
    },
  };

  /* ===================== 样式 ===================== */
  GM_addStyle(`
    #bili-auto-like-panel {
      position: fixed;
      z-index: 999999;
      width: 220px;
      background: rgba(24, 27, 36, 0.96);
      color: #eef0f5;
      border-radius: 10px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
      font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
      font-size: 12px;
      user-select: none;
      overflow: hidden;
    }
    #bili-auto-like-panel .balp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      cursor: grab;
      background: rgba(255, 255, 255, 0.06);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    #bili-auto-like-fab {
      position: fixed;
      z-index: 999999;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(24, 27, 36, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #fff;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      user-select: none;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      opacity: 0.75;
      transition: opacity 0.2s ease;
    }
    #bili-auto-like-fab[hidden] {
      display: none;
    }
    #bili-auto-like-fab:hover {
      opacity: 1;
    }
    #bili-auto-like-fab .balp-fab-badge {
      position: absolute;
      top: -4px;
      right: -6px;
      min-width: 16px;
      height: 16px;
      line-height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: #3b82f6;
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      text-align: center;
      box-sizing: border-box;
    }
    #bili-auto-like-panel .balp-title {
      font-weight: 600;
    }
    #bili-auto-like-panel .balp-collapse {
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 4px;
    }
    #bili-auto-like-panel .balp-body {
      padding: 10px;
    }
    #bili-auto-like-panel .balp-status-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    #bili-auto-like-panel .balp-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9aa0ad;
      flex: none;
    }
    #bili-auto-like-panel .balp-dot.run { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
    #bili-auto-like-panel .balp-dot.warn { background: #f59e0b; }
    #bili-auto-like-panel .balp-dot.done { background: #3b82f6; }
    #bili-auto-like-panel .balp-status {
      color: #cfd3dc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #bili-auto-like-panel .balp-progress {
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.12);
      overflow: hidden;
      margin-bottom: 6px;
    }
    #bili-auto-like-panel .balp-progress-fill {
      height: 100%;
      width: 0;
      border-radius: 3px;
      background: linear-gradient(90deg, #22c55e, #3b82f6);
      transition: width 0.3s ease;
    }
    #bili-auto-like-panel .balp-detail {
      color: #9aa0ad;
      margin-bottom: 8px;
    }
    #bili-auto-like-panel .balp-speed-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      color: #cfd3dc;
    }
    #bili-auto-like-panel .balp-speed {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #eef0f5;
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }
    #bili-auto-like-panel .balp-speed option {
      background: #181b24;
      color: #eef0f5;
    }
    #bili-auto-like-panel .balp-toggle {
      width: 100%;
      border: 0;
      border-radius: 6px;
      padding: 6px 0;
      cursor: pointer;
      background: #3b82f6;
      color: #fff;
      font-size: 13px;
    }
    #bili-auto-like-panel .balp-toggle:hover {
      background: #2563eb;
    }
    #bili-auto-like-panel.running .balp-toggle {
      background: #ef4444;
    }
    #bili-auto-like-panel.running .balp-toggle:hover {
      background: #dc2626;
    }
  `);

  /* ===================== 菜单与启动 ===================== */
  function registerMenu() {
    try {
      if (typeof GM_registerMenuCommand !== 'function') return;
      GM_registerMenuCommand('▶ 开始 / 停止 自动点赞', () => {
        if (Engine.running) Engine.stop('已手动停止');
        else Engine.start();
      });
      GM_registerMenuCommand('🗑 清空今日点赞计数', () => {
        Store.resetToday();
        Panel.setProgress(0);
        Panel.setStatus('已清空今日计数', 'done');
      });
      GM_registerMenuCommand('🪟 折叠 / 展开面板', () => {
        Panel.toggleCollapsed();
      });
    } catch (e) {
      /* 菜单注册失败不影响主功能 */
    }
  }

  function init() {
    if (window.__BILI_AUTO_LIKE_ACTIVE__) return;
    window.__BILI_AUTO_LIKE_ACTIVE__ = true;

    Store.load();
    Panel.build();
    registerMenu();

    const info = getRoomInfo();
    const total = Store.getCount(info.roomId || 0);
    Panel.setProgress(total);
    Panel.setStatus(info.roomId ? '就绪' : '未识别到直播间', info.roomId ? 'run' : 'warn');

    if (CONFIG.AUTO_START) {
      setTimeout(() => Engine.start(), 1500);
    }
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
