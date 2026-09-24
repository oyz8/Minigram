/* ========================== 1. 全局状态 ========================== */
let BOT_TOKEN, GROUP_ID, MAX_MESSAGES_PER_MINUTE, SHARED_SECRET, PUBLIC_ORIGIN, OWNER_ID;
let initPromise = null;
let backgroundInitStarted = false;

let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
const processedMessages  = new Set();
const processedCallbacks = new Set();
const topicCreationLocks = new Map();
const settingsCache = new Map([['verification_enabled', null]]);

const MAX_PROCESSED_SET_SIZE = 10000;
const MAX_TEXT_LENGTH = 4000;         // 留出昵称前缀空间
const MAX_BLOCKLIST_LINES = 50;
const CLEANUP_BATCH_SIZE = 100;

/* ========================== 2. 常量 ========================== */
// 注意: 不再设置 X-Frame-Options, 改用 CSP frame-ancestors,
//       否则 Telegram Web 版的 Mini App iframe 会被拦截.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

const VERIFY_PAGE_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://telegram.org https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "frame-src https://challenges.cloudflare.com; " +
  "connect-src 'self' https://challenges.cloudflare.com; " +
  "base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'self' https://web.telegram.org https://telegram.org;";

const VERIFY_TOKEN_TTL = 60 * 60;  // token 自身有效期 1 小时
const VERIFY_CODE_TTL  = 5 * 60;   // 单次验证窗口 5 分钟

const SHARED_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

const REQUIRED_ENV = [
  'BOT_TOKEN_ENV',
  'GROUP_ID_ENV',
  'OWNER_ID',
  'SHARED_SECRET',
  'PUBLIC_ORIGIN',
  'CAPTCHA_SITE_KEY',
  'CAPTCHA_SECRET_KEY'
];

/* ========================== 3. LRU 缓存 ========================== */
class LRUCache {
  constructor(maxSize) { this.maxSize = maxSize; this.cache = new Map(); }
  get(k) {
    const v = this.cache.get(k);
    if (v !== undefined) { this.cache.delete(k); this.cache.set(k, v); }
    return v;
  }
  set(k, v) {
    if (this.cache.has(k)) this.cache.delete(k);
    while (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(k, v);
  }
  delete(k) { this.cache.delete(k); }
  clear() { this.cache.clear(); }
}
const userInfoCache    = new LRUCache(1000);
const topicIdCache     = new LRUCache(1000);
const messageRateCache = new LRUCache(1000);
const adminCache       = new LRUCache(500);

/* ========================== 4. 工具函数 ========================== */
function randomHex(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function getOrigin(request, env) {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

// 恒定时间字符串比较, 防止密钥被逐字符试探
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

// token 格式: v1.<chatId>.<exp>.<nonce32hex>.<sig64hex>
async function createVerifyToken(chatId, env) {
  const exp = Math.floor(Date.now() / 1000) + VERIFY_TOKEN_TTL;
  const nonce = randomHex(32);
  const payload = `v1.${chatId}.${exp}.${nonce}`;
  const sig = await hmacHex(env.SHARED_SECRET, payload);
  return `${payload}.${sig}`;
}

async function parseVerifyToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  if (token.length < 32 || token.length > 256) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [ver, chatId, expStr, nonce, sig] = parts;
  if (ver !== 'v1') return null;
  if (!/^\d+$/.test(chatId)) return null;
  if (!/^\d+$/.test(expStr)) return null;
  if (nonce.length !== 32 || !/^[0-9a-f]+$/.test(nonce)) return null;
  if (sig.length !== 64 || !/^[0-9a-f]+$/.test(sig)) return null;

  const payload = `v1.${chatId}.${expStr}.${nonce}`;
  const expected = await hmacHex(env.SHARED_SECRET, payload);
  if (!timingSafeEqual(sig, expected)) return null;

  return { chatId, exp: parseInt(expStr, 10), nonce };
}

// 管理端点鉴权: 仅接受 X-Admin-Key 头
//   X-Admin-Key: <SHARED_SECRET>
// 不再接受 ?key=, 避免密钥进入日志/Referer/浏览器历史.
function requireAdmin(request, env) {
  const expected = env.SHARED_SECRET;
  if (!expected) {
    return new Response('SHARED_SECRET not configured', { status: 500 });
  }
  const provided = request.headers.get('X-Admin-Key') || '';
  if (!timingSafeEqual(provided, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS }
  });
}
function jsonErr(msg, status = 200) {
  return jsonResp({ ok: false, error: msg }, status);
}
function htmlErr(msg, status = 400) {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }
  });
}

function clampText(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.slice(0, MAX_TEXT_LENGTH) + '…（消息过长已截断）';
}

/* ========================== 5. 验证页面 HTML ========================== */
const htmlHead = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>身份验证</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
html, body{height:590px;overflow:hidden;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
     background:#fff;display:flex;flex-direction:column;align-items:center;
     padding:16px 0 60px 0;}
.content{width:100%;max-width:100%;padding:0 12px;display:flex;flex-direction:column;
         align-items:center;flex:1;justify-content:center;gap:10px;}
.avatar{width:300px;max-width:100%;max-height:250px;height:auto;border-radius:12px;
        object-fit:contain;display:block;margin:0 auto;}
.logo-wrap{display:flex;flex-direction:column;align-items:center;gap:4px;}
.card-title{font-size:1.1rem;font-weight:700;color:#1a1a2e;text-align:center;margin:0;}
.cf-wrap{display:flex;justify-content:center;margin-bottom:2px;}
.cf-turnstile{border-radius:12px!important;}
#status{text-align:center;font-size:.8rem;color:#6b7280;background:#f9fafb;
  border:1px solid #e5e7eb;border-radius:12px;padding:6px 14px;margin:0 auto;
  min-height:32px;display:flex;align-items:center;justify-content:center;gap:6px;
  transition:all .2s;width:fit-content;max-width:100%;}
#status.success{color:#059669;background:#ecfdf5;border-color:#a7f3d0;}
#status.error{color:#dc2626;background:#fef2f2;border-color:#fecaca;}
#status[data-clickable="1"]{cursor:pointer;user-select:none;}
#status[data-clickable="1"]:hover{background:#fee2e2;border-color:#fca5a5;}
#status[data-clickable="1"]:active{transform:scale(.98);}
.footer-tip{text-align:center;font-size:.65rem;color:#9ca3af;display:flex;
  align-items:center;justify-content:center;gap:6px;width:100%;padding:0 12px;}
.footer-tip::before,.footer-tip::after{content:'';width:30px;height:1px;
  background:#e5e7eb;flex:none;}
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #d1d5db;
  border-top-color:#4f6ef7;border-radius:50%;animation:spin .7s linear infinite;
  vertical-align:middle;}
@keyframes pop{0%{transform:scale(0)}70%{transform:scale(1.15)}100%{transform:scale(1)}}
.icon-success{display:inline-block;animation:pop .4s ease;}
</style></head><body>`;

function renderVerifyPage(token, env) {
  const eToken = encodeURIComponent(token);
  const siteKey = (env.CAPTCHA_SITE_KEY || '').replace(/"/g, '');
  return htmlHead + `
<div class="content">
  <div class="logo-wrap">
    <img src="/robot.gif" alt="Bot Avatar" class="avatar"/>
    <div class="card-title">身份验证</div>
  </div>
  <input type="hidden" id="token" value="${eToken}">
  <div class="cf-wrap">
    <div class="cf-turnstile"
         data-sitekey="${siteKey}"
         data-action="verify"
         data-theme="light"
         data-callback="onTurnstileSuccess"
         data-error-callback="onTurnstileError"
         data-expired-callback="onTurnstileExpired"
         data-timeout-callback="onTurnstileError"></div>
  </div>
  <div id="status" onclick="onStatusClick()">
    <span class="spinner"></span>
    <span id="statusText">请完成上方人机验证...</span>
  </div>
</div>
<div class="footer-tip">Powered by Cloudflare Turnstile</div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
<script>
let isDone = false;
if (window.Telegram && window.Telegram.WebApp) {
  try { window.Telegram.WebApp.ready(); window.Telegram.WebApp.expand(); } catch(e){}
}
function setStatus(msg, type, clickable) {
  const el = document.getElementById('status');
  const txt = document.getElementById('statusText');
  el.className = type ? 'status ' + type : '';
  const sp = el.querySelector('.spinner'); if (sp) sp.remove();
  txt.innerHTML = msg;
  el.dataset.clickable = clickable ? '1' : '0';
}
function onStatusClick() {
  const el = document.getElementById('status');
  if (el.dataset.clickable === '1') location.reload();
}
setTimeout(function () {
  if (!isDone) {
    const el = document.getElementById('status');
    if (el.dataset.clickable !== '1') setStatus('⏱ 卡住了？点这里刷新重试', 'error', true);
  }
}, 25000);
function onTurnstileError() {
  if (!isDone) setStatus('❌ 验证加载失败，点这里刷新重试', 'error', true);
}
function onTurnstileExpired() {
  if (!isDone) setStatus('⏱ 验证过期了，点这里刷新重试', 'error', true);
}
function tryClose() {
  try {
    const wa = window.Telegram && window.Telegram.WebApp;
    if (wa && typeof wa.close === 'function') { wa.close(); return true; }
  } catch(e) {}
  return false;
}
function onTurnstileSuccess(turnstileToken) {
  const el = document.getElementById('status');
  if (!el.querySelector('.spinner')) el.insertAdjacentHTML('afterbegin', '<span class="spinner"></span>');
  setStatus('验证中，请稍候...', '', false);
  const fd = new FormData();
  fd.append('cf-turnstile-response', turnstileToken);
  fd.append('token', decodeURIComponent(document.getElementById('token').value));
  fetch(window.location.href, { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) {
        setStatus('❌ ' + (data.error || '验证失败') + '，点这里刷新重试', 'error', true);
        return;
      }
      isDone = true;
      setStatus('<span class="icon-success">✅</span> 验证成功！', 'success', false);
      setTimeout(() => {
        if (!tryClose()) setStatus('<span class="icon-success">✅</span> 验证成功！请返回 Telegram 查看', 'success', false);
      }, 120);
    })
    .catch(() => setStatus('❌ 网络错误，点这里刷新重试', 'error', true));
}
</script></body></html>`;
}

/* ========================== 6. 主入口 ========================== */
export async function onRequest(context) {
  const { request, env } = context;

  const url = new URL(request.url);

  // 根路径: 交给静态资源 public/index.html, 不依赖 D1 / 环境变量
  // 即使服务未配置完整, 也能作为"服务是否在线"的落地页
  if (url.pathname === '/' && request.method === 'GET') {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response(
      'Minigram · 静态首页缺失（public/index.html 未找到）',
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  // 必需环境变量校验, 避免后续出现难以定位的 Telegram API 错误
  const missing = REQUIRED_ENV.filter(k => !env[k]);
  if (missing.length) {
    return new Response('Missing required env vars: ' + missing.join(', '), { status: 500 });
  }

  BOT_TOKEN = env.BOT_TOKEN_ENV || null;
  GROUP_ID  = env.GROUP_ID_ENV  || null;
  const parsedRate = parseInt(env.MAX_MESSAGES_PER_MINUTE_ENV, 10);
  MAX_MESSAGES_PER_MINUTE = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 40;
  SHARED_SECRET = env.SHARED_SECRET || '';
  PUBLIC_ORIGIN = env.PUBLIC_ORIGIN || null;
  OWNER_ID      = env.OWNER_ID ? env.OWNER_ID.toString() : null;

  if (!env.D1) return new Response('Server configuration error: D1 not bound', { status: 500 });

  // ---- 首次初始化: Promise 锁, 并发请求共享同一次建表 ----
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await checkAndRepairTables(env.D1);
      } catch (e) {
        initPromise = null;  // 允许下次请求重试
        throw e;
      }
    })();
  }

  try {
    await initPromise;
  } catch (e) {
    return new Response('Database init failed: ' + (e && e.message ? e.message : 'unknown'), { status: 500 });
  }

  if (!backgroundInitStarted) {
    backgroundInitStarted = true;
    context.waitUntil(runBackgroundInit(request, env));
  }

  // ============================================================
  //  路由
  // ============================================================
  if (url.pathname === '/verify') {
    if (request.method === 'POST') return await handleVerifyPost(request, env, context);
    return await handleVerifyGet(request, env);
  }

  if (url.pathname === '/webhook' && request.method === 'POST') {
    // 用 SHARED_SECRET 作为 Telegram secret_token 校验
    if (!SHARED_SECRET) {
      return new Response('SHARED_SECRET not configured', { status: 500 });
    }
    if (!SHARED_SECRET_PATTERN.test(SHARED_SECRET)) {
      return new Response('SHARED_SECRET has invalid format', { status: 500 });
    }
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!timingSafeEqual(provided, SHARED_SECRET)) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }

    context.waitUntil(
      handleUpdate(update).catch(e => console.error('handleUpdate error:', e))
    );
    return new Response('OK');
  }

  if (url.pathname === '/registerWebhook') {
    const deny = requireAdmin(request, env);
    if (deny) return deny;
    return await registerWebhook(request, env);
  }

  if (url.pathname === '/unRegisterWebhook') {
    const deny = requireAdmin(request, env);
    if (deny) return deny;
    return await unRegisterWebhook();
  }

  if (url.pathname === '/checkTables') {
    const deny = requireAdmin(request, env);
    if (deny) return deny;
    await checkAndRepairTables(env.D1);
    return new Response('Database tables checked and repaired', { status: 200 });
  }

  if (url.pathname === '/setupBotProfile') {
    const deny = requireAdmin(request, env);
    if (deny) return deny;
    await setupBotProfile(env);
    return new Response('Bot profile updated', { status: 200 });
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not Found', { status: 404 });

  // ============================================================
  //  /verify 处理器
  // ============================================================
  async function handleVerifyGet(request, env) {
    const u = new URL(request.url);
    const token = u.searchParams.get('token');
    if (!token) return htmlErr('Token is null');

    if (!SHARED_SECRET) return htmlErr('Verification service not configured', 500);

    const parsed = await parseVerifyToken(token, env);
    if (!parsed) return htmlErr('Token is invalid');

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > parsed.exp) return htmlErr('Token expired, please send a new message in Telegram');

    const newExpiry = nowSec + VERIFY_CODE_TTL;
    try {
      await env.D1.prepare(
        'UPDATE user_states SET code_expiry = ? WHERE chat_id = ? AND is_verifying = TRUE'
      ).bind(newExpiry, parsed.chatId).run();
    } catch (e) {
      console.error('update code_expiry failed:', e);
    }

    return new Response(renderVerifyPage(token, env), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
        'Content-Security-Policy': VERIFY_PAGE_CSP
      }
    });
  }

  async function handleVerifyPost(request, env, ctx) {
    let body;
    try { body = await request.formData(); } catch (e) { return jsonErr('Invalid form body'); }

    const captcha = body.get('cf-turnstile-response');
    const token = body.get('token');
    const ip = request.headers.get('CF-Connecting-IP');

    if (!captcha) return jsonErr('Captcha missing');
    if (!SHARED_SECRET) return jsonErr('Verification service not configured');

    // 1) Turnstile 校验
    const fd = new FormData();
    fd.append('secret', env.CAPTCHA_SECRET_KEY);
    fd.append('response', captcha);
    if (ip) fd.append('remoteip', ip);
    let res;
    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        body: fd, method: 'POST'
      });
      res = await verifyRes.json();
    } catch (e) {
      return jsonErr('Captcha verify failed');
    }
    if (!res.success) return jsonErr('Captcha fail');

    // 校验 hostname 与 action, 防止 token 被跨站复用
    if (env.PUBLIC_ORIGIN) {
      try {
        const expectedHost = new URL(env.PUBLIC_ORIGIN).hostname;
        if (res.hostname && res.hostname !== expectedHost) {
          return jsonErr('Captcha hostname mismatch');
        }
      } catch (e) { /* PUBLIC_ORIGIN 非法已在入口校验过, 这里忽略 */ }
    }
    if (res.action && res.action !== 'verify') {
      return jsonErr('Captcha action mismatch');
    }

    // 2) HMAC 签名校验
    const parsed = await parseVerifyToken(token, env);
    if (!parsed) return jsonErr('Token is invalid');
    const { chatId, exp } = parsed;

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > exp) return jsonErr('Verification token expired');

    // 3) DB 状态校验
    const st = await env.D1.prepare(
      'SELECT is_verifying, code_expiry FROM user_states WHERE chat_id = ?'
    ).bind(chatId).first();
    if (!st) return jsonErr('User not found');

    if (!st.is_verifying) {
      return jsonResp({ ok: true });
    }
    if (st.code_expiry && nowSec > st.code_expiry) return jsonErr('Verification expired');

    // 4) 标记为已验证
    const verifiedExpiry = nowSec + 3600 * 24 * 7;
    await env.D1.prepare(
      'UPDATE user_states SET is_verified = TRUE, verified_expiry = ?, is_first_verification = FALSE, is_verifying = FALSE, code_expiry = NULL WHERE chat_id = ?'
    ).bind(verifiedExpiry, chatId).run();

    const notifyPromise = fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '😮‍💨 行了，进来了。\n　　　　　　　　　　　　　　　　　　　　　　　　随便发点什么吧～',
        reply_markup: { remove_keyboard: true }
      })
    }).catch(e => console.error('verify notify failed:', e));

    const topicPromise = (async () => {
      try {
        const ui = await getUserInfo(chatId);
        await ensureUserTopic(chatId, ui);
      } catch (e) {
        console.error('verify ensureUserTopic failed:', e);
      }
    })();

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(notifyPromise);
      ctx.waitUntil(topicPromise);
    } else {
      await Promise.all([notifyPromise, topicPromise]);
    }

    return jsonResp({ ok: true });
  }

  // ============================================================
  //  初始化 / 权限 / Bot 资料
  // ============================================================
  async function runBackgroundInit(req, env) {
    const branch = env.CF_PAGES_BRANCH;
    const isProduction = !branch || branch === 'main' || branch === 'production';

    const tasks = [
      checkBotPermissions().catch(e => console.error('checkBotPermissions failed:', e)),
      cleanExpiredVerificationCodes(env.D1).catch(e => console.error('cleanExpired failed:', e))
    ];
    if (isProduction) {
      tasks.push(autoRegisterWebhook(req, env).catch(e => console.error('autoRegisterWebhook failed:', e)));
      tasks.push(setupBotProfile(env).catch(e => console.error('setupBotProfile failed:', e)));
    }
    await Promise.all(tasks);
  }

  async function setupBotProfile(env) {
    const rawDescription = env.BOT_DESCRIPTION ||
      '😮‍💨 又来了一个|' + '|' +
      '📩 你发，我转|' +
      '🔐 但先证明你是人（AI 别来）|' +
      '🕐 一次算 7 天，别天天找我|' + '|' +
      '流程就这样，点下面 👇';
    const description = rawDescription.replace(/\|/g, '\n');
    const shortDescription = env.BOT_SHORT_DESCRIPTION || '搬砖中，别催。7 天验一次。';

    const apiBase = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const groupIdNum = parseInt(GROUP_ID);

    if (description.length > 512) throw new Error('BOT_DESCRIPTION too long (>512)');
    if (shortDescription.length > 120) throw new Error('BOT_SHORT_DESCRIPTION too long (>120)');

    const tasks = [
      fetchWithRetry(`${apiBase}/setMyDescription`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description })
      }),
      fetchWithRetry(`${apiBase}/setMyShortDescription`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ short_description: shortDescription })
      }),
      fetchWithRetry(`${apiBase}/setMyCommands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: [{ command: 'start', description: '开始使用' }] })
      }),
      fetchWithRetry(`${apiBase}/setMyCommands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: [], scope: { type: 'chat', chat_id: groupIdNum } })
      }),
      fetchWithRetry(`${apiBase}/deleteMyCommands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: { type: 'chat_administrators', chat_id: groupIdNum } })
      })
    ];

    if (OWNER_ID) {
      const ownerIdNum = parseInt(OWNER_ID);
      if (!isNaN(ownerIdNum)) {
        tasks.push(
          fetchWithRetry(`${apiBase}/setMyCommands`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: [], scope: { type: 'chat', chat_id: ownerIdNum } })
          })
        );
      }
    }

    await Promise.all(tasks);
  }

  async function autoRegisterWebhook(req, env) {
    if (!SHARED_SECRET) return;
    if (!SHARED_SECRET_PATTERN.test(SHARED_SECRET)) {
      throw new Error('SHARED_SECRET must match [A-Za-z0-9_-]{1,256}');
    }
    const origin = getOrigin(req, env);
    const webhookUrl = `${origin}/webhook`;
    await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: SHARED_SECRET })
    });
  }

  async function checkBotPermissions() {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to access group: ${d.description}`);
    const botId = await getBotId();
    const mr = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, user_id: botId })
    });
    const md = await mr.json();
    if (!md.ok) throw new Error(`Failed to get bot member status: ${md.description}`);
  }

  async function getBotId() {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to get bot ID: ${d.description}`);
    return d.result.id;
  }

  async function checkAndRepairTables(d1) {
    const expectedTables = {
      user_states: {
        columns: {
          chat_id: 'TEXT PRIMARY KEY',
          is_blocked: 'BOOLEAN DEFAULT FALSE',
          is_verified: 'BOOLEAN DEFAULT FALSE',
          verified_expiry: 'INTEGER',
          code_expiry: 'INTEGER',
          is_first_verification: 'BOOLEAN DEFAULT TRUE',
          is_verifying: 'BOOLEAN DEFAULT FALSE'
        }
      },
      message_rates: {
        columns: {
          chat_id: 'TEXT PRIMARY KEY',
          message_count: 'INTEGER DEFAULT 0',
          window_start: 'INTEGER',
          start_count: 'INTEGER DEFAULT 0',
          start_window_start: 'INTEGER'
        }
      },
      chat_topic_mappings: {
        columns: { chat_id: 'TEXT PRIMARY KEY', topic_id: 'TEXT NOT NULL' }
      },
      message_mappings: {
        columns: {
          chat_id: 'TEXT NOT NULL',
          private_message_id: 'INTEGER NOT NULL',
          topic_id: 'INTEGER NOT NULL',
          group_message_id: 'INTEGER NOT NULL',
          created_at: 'INTEGER NOT NULL',
          'PRIMARY KEY': '(chat_id, private_message_id)'
        }
      },
      settings: {
        columns: { key: 'TEXT PRIMARY KEY', value: 'TEXT' }
      }
    };

    for (const [name, structure] of Object.entries(expectedTables)) {
      const info = await d1.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).bind(name).first();
      if (!info) {
        const cols = Object.entries(structure.columns)
          .map(([c, def]) => c === 'PRIMARY KEY' ? `PRIMARY KEY ${def}` : `${c} ${def}`)
          .join(', ');
        await d1.exec(`CREATE TABLE ${name} (${cols})`);
        continue;
      }
      const colRes = await d1.prepare(`PRAGMA table_info(${name})`).all();
      const curCols = new Map(colRes.results.map(c => [c.name, true]));
      for (const [c, def] of Object.entries(structure.columns)) {
        if (c === 'PRIMARY KEY') continue;
        if (!curCols.has(c)) {
          const rest = def.split(' ').slice(1).join(' ');
          const safeRest = /NOT NULL/i.test(rest)
            ? rest.replace(/NOT NULL/i, '').trim()
            : rest;
          await d1.exec(`ALTER TABLE ${name} ADD COLUMN ${c} ${safeRest}`);
        }
      }
    }

    await d1.exec('CREATE INDEX IF NOT EXISTS idx_group_msg ON message_mappings (group_message_id)');

    await d1.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .bind('verification_enabled', 'true').run();

    const v = await d1.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('verification_enabled').first();
    settingsCache.set('verification_enabled', (v && v.value) === 'true');
  }

  async function cleanExpiredVerificationCodes(d1) {
    const now = Date.now();
    if (now - lastCleanupTime < CLEANUP_INTERVAL) return;
    lastCleanupTime = now;
    const nowSec = Math.floor(now / 1000);
    try {
      const expired = await d1.prepare(
        'SELECT chat_id FROM user_states WHERE code_expiry IS NOT NULL AND code_expiry < ?'
      ).bind(nowSec).all();
      const rows = expired.results || [];
      // 分批执行, 避免 D1 batch 超限
      for (let i = 0; i < rows.length; i += CLEANUP_BATCH_SIZE) {
        const chunk = rows.slice(i, i + CLEANUP_BATCH_SIZE);
        await d1.batch(chunk.map(({ chat_id }) =>
          d1.prepare('UPDATE user_states SET code_expiry = NULL, is_verifying = FALSE WHERE chat_id = ?').bind(chat_id)
        ));
      }
      await d1.prepare('DELETE FROM message_mappings WHERE created_at < ?')
        .bind(nowSec - 30 * 24 * 3600).run();
    } catch (e) {
      console.error('cleanExpiredVerificationCodes failed:', e);
    }
  }

  // ============================================================
  //  Telegram 更新
  // ============================================================
  async function handleUpdate(update) {
    if (update.message) {
      const key = `${update.message.chat.id}:${update.message.message_id}`;
      if (processedMessages.has(key)) return;
      if (processedMessages.size > MAX_PROCESSED_SET_SIZE) processedMessages.clear();
      processedMessages.add(key);
      await onMessage(update.message);
    } else if (update.edited_message) {
      await onEditedMessage(update.edited_message);
    } else if (update.callback_query) {
      const cb = update.callback_query;
      const chatIdPart = cb.message && cb.message.chat ? cb.message.chat.id : 'unknown';
      const key = `${chatIdPart}:${cb.id}`;
      if (processedCallbacks.has(key)) return;
      if (processedCallbacks.size > MAX_PROCESSED_SET_SIZE) processedCallbacks.clear();
      processedCallbacks.add(key);
      await onCallbackQuery(cb);
    }
  }

  async function onEditedMessage(message) {
    const chatId = message.chat.id.toString();
    const messageId = message.message_id;
    const text = message.text || '';
    const caption = message.caption || '';

    try {
      if (chatId === GROUP_ID) {
        const mapping = await env.D1.prepare(
          'SELECT chat_id, private_message_id FROM message_mappings WHERE group_message_id = ?'
        ).bind(messageId).first();
        if (!mapping) return;

        if (text) {
          await editMessage(mapping.chat_id, mapping.private_message_id, { text: clampText(text) });
        } else if (caption) {
          await editMessage(mapping.chat_id, mapping.private_message_id, { caption: clampText(caption) });
        }
      } else {
        const mapping = await env.D1.prepare(
          'SELECT topic_id, group_message_id FROM message_mappings WHERE chat_id = ? AND private_message_id = ?'
        ).bind(chatId, messageId).first();
        if (!mapping) return;

        if (text) {
          const ui = await getUserInfo(chatId);
          const nickname = ui.nickname || ui.username || `User_${chatId}`;
          const composed = `${nickname}:\n${text}`;
          await editMessage(GROUP_ID, mapping.group_message_id, { text: clampText(composed) });
        } else if (caption) {
          await editMessage(GROUP_ID, mapping.group_message_id, { caption: clampText(caption) });
        }
      }
    } catch (e) {
      console.error('onEditedMessage failed:', e);
    }
  }

  async function editMessage(chatId, messageId, { text, caption }) {
    let method = 'editMessageText';
    const payload = { chat_id: chatId, message_id: messageId };
    if (text !== undefined) {
      payload.text = text;
    } else if (caption !== undefined) {
      method = 'editMessageCaption';
      payload.caption = caption;
    } else {
      return;
    }
    await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function tryDeleteMessage(chatId, messageId) {
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      });
      return true;
    } catch (e) {
      console.error('tryDeleteMessage failed:', e);
      return false;
    }
  }

  async function handleDelCommand(message, isGroup) {
    const chatId = message.chat.id.toString();
    const replyTo = message.reply_to_message;

    if (isGroup) {
      const senderId = message.from && message.from.id ? message.from.id.toString() : null;
      if (!senderId || !(await checkIfAdmin(senderId))) return;
    }

    if (!replyTo) {
      if (isGroup) {
        await sendMessageToTopic(message.message_thread_id, '回复要删除的消息，再发 /del');
      } else {
        await sendMessageToUser(chatId, '回复要删除的消息，再发 /del');
      }
      return;
    }

    if (isGroup) {
      const mapping = await env.D1.prepare(
        'SELECT chat_id, private_message_id FROM message_mappings WHERE group_message_id = ?'
      ).bind(replyTo.message_id).first();

      await tryDeleteMessage(GROUP_ID, replyTo.message_id);
      if (mapping) {
        await tryDeleteMessage(mapping.chat_id, mapping.private_message_id);
        await env.D1.prepare(
          'DELETE FROM message_mappings WHERE chat_id = ? AND private_message_id = ?'
        ).bind(mapping.chat_id, mapping.private_message_id).run();
      }
      await tryDeleteMessage(GROUP_ID, message.message_id);
    } else {
      const mapping = await env.D1.prepare(
        'SELECT topic_id, group_message_id FROM message_mappings WHERE chat_id = ? AND private_message_id = ?'
      ).bind(chatId, replyTo.message_id).first();

      if (mapping) {
        await tryDeleteMessage(GROUP_ID, mapping.group_message_id);
        await env.D1.prepare(
          'DELETE FROM message_mappings WHERE chat_id = ? AND private_message_id = ?'
        ).bind(chatId, replyTo.message_id).run();
      }
    }
  }

  async function onMessage(message) {
    const chatId = message.chat.id.toString();
    const text = message.text || '';
    const messageId = message.message_id;

    if (chatId === GROUP_ID) {
      const topicId = message.message_thread_id;
      if (topicId) {
        if (text === '/del' || text.startsWith('/del@') || text.startsWith('/del ')) {
          await handleDelCommand(message, true);
          return;
        }

        // /admin 命令: 独立处理, 命中失败时给出明确提示, 便于排查
        if (text === '/admin' || text.startsWith('/admin@') || text.startsWith('/admin ')) {
          const privateChatId = await getPrivateChatId(topicId);
          if (!privateChatId) {
            console.error('admin panel: no privateChatId for topic', topicId);
            await sendMessageToTopic(
              topicId,
              '⚠️ 未找到该话题对应的用户映射，管理面板无法打开。\n' +
              '可能是该话题是旧版本创建的，或数据库映射被清除。'
            );
            return;
          }
          await sendAdminPanel(chatId, topicId, privateChatId, messageId);
          return;
        }

        // 其它群组消息: 转发回用户私聊
        const privateChatId = await getPrivateChatId(topicId);
        if (privateChatId) {
          await forwardMessageToPrivateChat(privateChatId, message);
        } else {
          console.warn('forward: no privateChatId for topic', topicId);
        }
      }
      return;
    }

    if (OWNER_ID && chatId === OWNER_ID) return;

    if (text === '/del' || text.startsWith('/del@') || text.startsWith('/del ')) {
      await handleDelCommand(message, false);
      return;
    }

    let userState = await env.D1.prepare(
      'SELECT is_blocked, is_first_verification, is_verified, verified_expiry, is_verifying FROM user_states WHERE chat_id = ?'
    ).bind(chatId).first();
    if (!userState) {
      userState = {
        is_blocked: false, is_first_verification: true,
        is_verified: false, verified_expiry: null, is_verifying: false
      };
      await env.D1.prepare(
        'INSERT OR IGNORE INTO user_states (chat_id, is_blocked, is_first_verification, is_verified, is_verifying) VALUES (?, ?, ?, ?, ?)'
      ).bind(chatId, false, true, false, false).run();
    }

    if (userState.is_blocked) {
      await sendMessageToUser(chatId, "您已被拉黑，无法发送消息。");
      return;
    }

    const verificationEnabled = (await getSetting('verification_enabled', env.D1)) === 'true';
    if (verificationEnabled) {
      const nowSec = Math.floor(Date.now() / 1000);
      const isVerified = userState.is_verified && userState.verified_expiry && nowSec < userState.verified_expiry;
      if (!isVerified) {
        if (userState.is_verifying) {
          await sendVerifyLink(chatId, env);
          return;
        }
        await handleVerification(chatId, env);
        return;
      }
      if (!userState.is_first_verification) {
        const limited = await checkMessageRate(chatId);
        if (limited) {
          await env.D1.prepare('UPDATE user_states SET is_verified = FALSE, is_verifying = FALSE WHERE chat_id = ?').bind(chatId).run();
          await sendMessageToUser(chatId, '消息发送过于频繁，请重新完成验证。');
          await handleVerification(chatId, env);
          return;
        }
      }
    }

    if (text === '/start') {
      if (await checkStartCommandRate(chatId)) {
        await sendMessageToUser(chatId, "您发送 /start 过于频繁，请稍后再试。");
        return;
      }
      await sendMessageToUser(chatId, '🙃 行了，发吧。');
      const ui = await getUserInfo(chatId);
      await ensureUserTopic(chatId, ui);
      return;
    }

    const userInfo = await getUserInfo(chatId);
    if (!userInfo) {
      await sendMessageToUser(chatId, "无法获取用户信息，请稍后再试。");
      return;
    }

    let topicId = await ensureUserTopic(chatId, userInfo);
    if (!topicId) {
      await sendMessageToUser(chatId, "无法创建话题，请稍后再试。");
      return;
    }

    const nickname = userInfo.nickname || userInfo.username || `User_${chatId}`;
    try {
      if (text) {
        await sendMessageToTopic(topicId, `${nickname}:\n${text}`, chatId, messageId);
      } else {
        await copyMessageToTopic(topicId, message, chatId);
      }
    } catch (e) {
      console.error('send to topic failed, will recreate topic:', e);
      await env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).run();
      topicIdCache.delete(chatId);
      topicId = await ensureUserTopic(chatId, userInfo);
      if (!topicId) {
        await sendMessageToUser(chatId, "无法创建话题，请稍后再试。");
        return;
      }
      if (text) {
        await sendMessageToTopic(topicId, `${nickname}:\n${text}`, chatId, messageId);
      } else {
        await copyMessageToTopic(topicId, message, chatId);
      }
    }
  }

  async function handleVerification(chatId, env) {
    if (!SHARED_SECRET) {
      await sendMessageToUser(chatId, '验证服务未配置，请联系管理员。');
      return;
    }
    try {
      const token = await createVerifyToken(chatId, env);
      const origin = getOrigin(request, env);
      const verifyLink = `${origin}/verify?token=${encodeURIComponent(token)}`;
      const nowSec = Math.floor(Date.now() / 1000);
      const codeExpiry = nowSec + VERIFY_CODE_TTL;

      await env.D1.prepare('UPDATE user_states SET is_verifying=?, code_expiry=? WHERE chat_id=?')
        .bind(true, codeExpiry, chatId).run();

      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '😮‍💨 先验一下。点下面，5 分钟。',
          reply_markup: {
            keyboard: [[{ text: '✅ 点击验证', web_app: { url: verifyLink } }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        })
      });
    } catch (e) {
      console.error('handleVerification failed:', e);
      await env.D1.prepare('UPDATE user_states SET is_verifying = FALSE WHERE chat_id = ?').bind(chatId).run();
      await sendMessageToUser(chatId, '发送验证失败，请发送任意消息重试。');
    }
  }

  async function sendVerifyLink(chatId, env) {
    if (!SHARED_SECRET) return;
    const token = await createVerifyToken(chatId, env);
    const origin = getOrigin(request, env);
    const verifyLink = `${origin}/verify?token=${encodeURIComponent(token)}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const codeExpiry = nowSec + VERIFY_CODE_TTL;
    await env.D1.prepare('UPDATE user_states SET is_verifying = TRUE, code_expiry = ? WHERE chat_id = ?')
      .bind(codeExpiry, chatId).run();
    await sendMessageToUser(chatId, `🔗 链接在这，5 分钟：\n${verifyLink}`);
  }

  // ============================================================
  //  话题 / 消息发送
  // ============================================================
  async function ensureUserTopic(chatId, userInfo) {
    const prev = topicCreationLocks.get(chatId) || Promise.resolve();

    const task = prev.catch(() => {}).then(async () => {
      const existing = await getExistingTopicId(chatId);
      if (existing) return existing;

      const nickname = userInfo.nickname || userInfo.username || `User_${chatId}`;
      const userName = userInfo.username || `User_${chatId}`;
      const newTopicId = await createForumTopic(nickname, userName, chatId);
      await saveTopicId(chatId, newTopicId);
      return newTopicId;
    });

    topicCreationLocks.set(chatId, task);
    try {
      return await task;
    } finally {
      if (topicCreationLocks.get(chatId) === task) topicCreationLocks.delete(chatId);
    }
  }

  async function deleteUserTopic(chatId) {
    const r = await env.D1.prepare('SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).first();
    if (!r || !r.topic_id) return false;
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, message_thread_id: parseInt(r.topic_id, 10) })
      });
      return true;
    } catch (e) {
      console.error('deleteUserTopic failed:', e);
      return false;
    }
  }

  async function sendAdminPanel(chatId, topicId, privateChatId, messageId) {
    const vEnabled = (await getSetting('verification_enabled', env.D1)) === 'true';
    const buttons = [
      [
        { text: '拉黑用户', callback_data: `block_${privateChatId}` },
        { text: '解除拉黑', callback_data: `unblock_${privateChatId}` }
      ],
      [
        { text: '查询用户信息', callback_data: `user_info_${privateChatId}` },
        { text: '查询黑名单', callback_data: `check_blocklist_${privateChatId}` }
      ],
      [
        { text: vEnabled ? '关闭验证码' : '开启验证码', callback_data: `toggle_verification_${privateChatId}` },
        { text: '🗑 删除用户', callback_data: `delete_user_${privateChatId}` }
      ],
      [
        { text: '⭐️ 项目地址 ⭐️', url: 'https://github.com/oyz8/Minigram' }
      ]
    ];

    const sendPromise = fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_thread_id: topicId,
        text: '管理员面板：请选择操作',
        reply_markup: { inline_keyboard: buttons }
      })
    });

    const delPromise = fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    }).catch(e => console.error('sendAdminPanel deleteMessage failed:', e));

    await Promise.all([sendPromise, delPromise]);
  }

  async function sendUserInfo(topicId, targetChatId) {
    const info = await env.D1.prepare(
      'SELECT is_blocked, is_verified, verified_expiry, code_expiry, is_first_verification, is_verifying FROM user_states WHERE chat_id = ?'
    ).bind(targetChatId).first();
    const topic = await env.D1.prepare(
      'SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?'
    ).bind(targetChatId).first();
    let tgLine = '（获取失败）';
    try {
      const ui = await getUserInfo(targetChatId);
      tgLine = `${ui.nickname}  @${ui.username}`;
    } catch (e) {
      console.error('sendUserInfo getUserInfo failed:', e);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    let verifiedLine = '否';
    if (info && info.is_verified && info.verified_expiry) {
      if (info.verified_expiry > nowSec) {
        const left = info.verified_expiry - nowSec;
        const h = Math.floor(left / 3600);
        const m = Math.floor((left % 3600) / 60);
        verifiedLine = `是（剩余 ${h} 小时 ${m} 分）`;
      } else { verifiedLine = '已过期'; }
    }
    let codeLine = '无';
    if (info && info.code_expiry) {
      if (info.code_expiry > nowSec) codeLine = `有效（剩余 ${info.code_expiry - nowSec} 秒）`;
      else codeLine = '已过期';
    }
    const lines = [
      '👤 用户信息',
      '─────────────',
      `UserID：${targetChatId}`,
      `昵称：${tgLine}`,
      `拉黑：${info && info.is_blocked ? '✅ 是' : '否'}`,
      `已验证：${verifiedLine}`,
      `首次验证：${info && info.is_first_verification ? '是' : '否'}`,
      `验证流程中：${info && info.is_verifying ? '是' : '否'}`,
      `验证码：${codeLine}`,
      `话题：${topic && topic.topic_id ? `#${topic.topic_id}` : '无'}`
    ];
    await sendMessageToTopic(topicId, lines.join('\n'));
  }

  async function checkStartCommandRate(chatId) {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    let data = messageRateCache.get(chatId);
    if (data === undefined) {
      data = await env.D1.prepare('SELECT start_count, start_window_start FROM message_rates WHERE chat_id = ?').bind(chatId).first();
      if (!data) {
        data = { start_count: 0, start_window_start: now };
        await env.D1.prepare('INSERT OR IGNORE INTO message_rates (chat_id, start_count, start_window_start) VALUES (?, ?, ?)').bind(chatId, 0, now).run();
      }
      messageRateCache.set(chatId, data);
    }
    if (now - data.start_window_start > windowMs) {
      data.start_count = 1; data.start_window_start = now;
    } else { data.start_count += 1; }
    await env.D1.prepare('UPDATE message_rates SET start_count=?, start_window_start=? WHERE chat_id=?')
      .bind(data.start_count, data.start_window_start, chatId).run();
    messageRateCache.set(chatId, data);
    return data.start_count > 1;
  }

  async function checkMessageRate(chatId) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    let data = messageRateCache.get(chatId);
    if (data === undefined) {
      data = await env.D1.prepare('SELECT message_count, window_start FROM message_rates WHERE chat_id = ?').bind(chatId).first();
      if (!data) {
        data = { message_count: 0, window_start: now };
        await env.D1.prepare('INSERT OR IGNORE INTO message_rates (chat_id, message_count, window_start) VALUES (?, ?, ?)').bind(chatId, 0, now).run();
      }
      messageRateCache.set(chatId, data);
    }
    if (now - data.window_start > windowMs) {
      data.message_count = 1; data.window_start = now;
    } else { data.message_count += 1; }
    await env.D1.prepare('UPDATE message_rates SET message_count=?, window_start=? WHERE chat_id=?')
      .bind(data.message_count, data.window_start, chatId).run();
    messageRateCache.set(chatId, data);
    return data.message_count > MAX_MESSAGES_PER_MINUTE;
  }

  async function getSetting(key, d1) {
    const r = await d1.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return r ? r.value : null;
  }

  async function setSetting(key, value) {
    await env.D1.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
    if (key === 'verification_enabled') {
      settingsCache.set('verification_enabled', value === 'true');
      if (value === 'false') {
        const nowSec = Math.floor(Date.now() / 1000);
        const expiry = nowSec + 3600 * 24 * 7;
        await env.D1.prepare('UPDATE user_states SET is_verified=?, verified_expiry=?, is_verifying=FALSE WHERE is_blocked=FALSE').bind(true, expiry).run();
      }
    }
  }

  async function onCallbackQuery(cb) {
    if (!cb.message) return;
    const chatId = cb.message.chat.id.toString();
    const topicId = cb.message.message_thread_id;
    const data = cb.data || '';
    const messageId = cb.message.message_id;

    let action, privateChatId;
    if (data.startsWith('toggle_verification_')) {
      action = 'toggle_verification'; privateChatId = data.slice('toggle_verification_'.length);
    } else if (data.startsWith('check_blocklist_')) {
      action = 'check_blocklist'; privateChatId = data.slice('check_blocklist_'.length);
    } else if (data.startsWith('delete_user_')) {
      action = 'delete_user'; privateChatId = data.slice('delete_user_'.length);
    } else if (data.startsWith('user_info_')) {
      action = 'user_info'; privateChatId = data.slice('user_info_'.length);
    } else if (data.startsWith('block_')) {
      action = 'block'; privateChatId = data.slice('block_'.length);
    } else if (data.startsWith('unblock_')) {
      action = 'unblock'; privateChatId = data.slice('unblock_'.length);
    } else { action = data; privateChatId = ''; }

    const senderId = cb.from.id.toString();
    const isAdmin = await checkIfAdmin(senderId);
    if (!isAdmin) {
      await sendMessageToTopic(topicId, '只有管理员可以使用此功能。');
      return;
    }

    // 如果这次操作把当前话题删除了, 就不再往已删除的话题发消息 / 刷新面板
    let skipPanelRefresh = false;

    try {
      if (action === 'block') {
        await env.D1.prepare(
          'INSERT INTO user_states (chat_id, is_blocked) VALUES (?, TRUE) ' +
          'ON CONFLICT(chat_id) DO UPDATE SET is_blocked = TRUE'
        ).bind(privateChatId).run();
        await sendMessageToTopic(topicId, `用户 ${privateChatId} 已被拉黑。`);
      } else if (action === 'unblock') {
        await env.D1.prepare(
          'INSERT INTO user_states (chat_id, is_blocked, is_first_verification) VALUES (?, FALSE, TRUE) ' +
          'ON CONFLICT(chat_id) DO UPDATE SET is_blocked = FALSE, is_first_verification = TRUE'
        ).bind(privateChatId).run();
        await sendMessageToTopic(topicId, `用户 ${privateChatId} 已解除拉黑。`);
      } else if (action === 'toggle_verification') {
        const cur = (await getSetting('verification_enabled', env.D1)) === 'true';
        const next = !cur;
        await setSetting('verification_enabled', next.toString());
        await sendMessageToTopic(topicId, `验证码功能已${next ? '开启' : '关闭'}。`);
      } else if (action === 'check_blocklist') {
        const rows = await env.D1.prepare('SELECT chat_id FROM user_states WHERE is_blocked = TRUE').all();
        const all = rows.results || [];
        const list = all.length > 0
          ? all.slice(0, MAX_BLOCKLIST_LINES).map(r => r.chat_id).join('\n') +
            (all.length > MAX_BLOCKLIST_LINES ? `\n…共 ${all.length} 人` : '')
          : '当前没有被拉黑的用户。';
        await sendMessageToTopic(topicId, `黑名单列表：\n${list}`);
      } else if (action === 'user_info') {
        await sendUserInfo(topicId, privateChatId);
      } else if (action === 'delete_user') {
        // 判断即将删除的用户话题, 是否正是当前管理员所在话题
        const userTopic = await env.D1.prepare(
          'SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?'
        ).bind(privateChatId).first();
        const isCurrentTopic = userTopic && String(userTopic.topic_id) === String(topicId);
        if (isCurrentTopic) skipPanelRefresh = true;

        const topicDeleted = await deleteUserTopic(privateChatId);
        await env.D1.batch([
          env.D1.prepare('DELETE FROM user_states WHERE chat_id = ?').bind(privateChatId),
          env.D1.prepare('DELETE FROM message_rates WHERE chat_id = ?').bind(privateChatId),
          env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(privateChatId),
          env.D1.prepare('DELETE FROM message_mappings WHERE chat_id = ?').bind(privateChatId)
        ]);
        topicIdCache.delete(privateChatId);
        userInfoCache.delete(privateChatId);

        if (!isCurrentTopic) {
          await sendMessageToTopic(topicId,
            topicDeleted ? `用户 ${privateChatId} 及其话题已删除。` : `用户 ${privateChatId} 的数据已删除（话题不存在或已删除）。`);
        }
      }
    } catch (e) {
      console.error('onCallbackQuery action error:', e);
    }

    await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id })
    }).catch(e => console.error('answerCallbackQuery failed:', e));

    if (action === 'user_info' || skipPanelRefresh) return;

    try {
      await sendAdminPanel(chatId, topicId, privateChatId, messageId);
    } catch (e) {
      console.error('sendAdminPanel refresh failed:', e);
    }
  }

  async function checkIfAdmin(userId) {
    const cacheKey = String(userId);
    const cached = adminCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.isAdmin;

    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, user_id: userId })
    });
    const d = await r.json();
    const isAdmin = d.ok && (d.result.status === 'administrator' || d.result.status === 'creator');
    adminCache.set(cacheKey, { isAdmin, expiresAt: Date.now() + 5 * 60 * 1000 });
    return isAdmin;
  }

  async function getUserInfo(chatId) {
    let info = userInfoCache.get(chatId);
    if (info !== undefined) return info;
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId })
    });
    const d = await r.json();
    if (!d.ok) {
      info = { id: chatId, username: `User_${chatId}`, nickname: `User_${chatId}` };
    } else {
      const res = d.result;
      const nickname = res.first_name
        ? `${res.first_name}${res.last_name ? ` ${res.last_name}` : ''}`.trim()
        : res.username || `User_${chatId}`;
      info = { id: res.id || chatId, username: res.username || `User_${chatId}`, nickname };
    }
    userInfoCache.set(chatId, info);
    return info;
  }

  async function getExistingTopicId(chatId) {
    const tid = topicIdCache.get(chatId);
    if (tid !== undefined) return tid;
    const r = await env.D1.prepare('SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).first();
    const value = (r && r.topic_id) ? String(r.topic_id) : null;
    if (value) topicIdCache.set(chatId, value);
    return value;
  }

  async function createForumTopic(nickname, userName, userId) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, name: nickname })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to create forum topic: ${d.description}`);
    const topicId = String(d.result.message_thread_id);

    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').substring(0, 19);

    const pinned =
      `昵称: ${nickname}\n` +
      `用户名: @${userName}\n` +
      `UserID: ${userId}\n` +
      `发起时间: ${ts}\n\n` +
      `─────────────\n` +
      `管理员命令\n` +
      `• /admin      打开管理面板\n` +
      `• /del          回复某条消息后发送，删除该消息`;

    const mr = await sendMessageToTopic(topicId, pinned);
    // 置顶失败不应阻塞话题创建 (可能缺 Pin Messages 权限)
    try {
      await pinMessage(topicId, mr.result.message_id);
    } catch (e) {
      console.error('pinMessage failed (non-fatal):', e);
    }
    return topicId;
  }

  async function saveTopicId(chatId, topicId) {
    await env.D1.prepare('INSERT OR REPLACE INTO chat_topic_mappings (chat_id, topic_id) VALUES (?, ?)')
      .bind(chatId, String(topicId)).run();
    topicIdCache.set(chatId, String(topicId));
  }

  async function getPrivateChatId(topicId) {
    const tidStr = String(topicId);

    for (const [cid, tid] of topicIdCache.cache) {
      if (String(tid) === tidStr) return cid;
    }

    const r = await env.D1.prepare(
      'SELECT chat_id FROM chat_topic_mappings WHERE topic_id = ?'
    ).bind(tidStr).first();

    if (r && r.chat_id) {
      // 回填缓存, 下次同话题操作直接命中
      topicIdCache.set(r.chat_id, tidStr);
      return r.chat_id;
    }
    return null;
  }

  async function sendMessageToTopic(topicId, text, recordChatId, recordPrivateMsgId) {
    if (!text || !text.trim()) throw new Error('Message text is empty');
    const safeText = clampText(text);
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, text: safeText, message_thread_id: topicId })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to send to topic: ${d.description}`);
    if (recordChatId && recordPrivateMsgId && d.result && d.result.message_id) {
      await saveMessageMapping(recordChatId, recordPrivateMsgId, topicId, d.result.message_id);
    }
    return d;
  }

  async function copyMessageToTopic(topicId, message, chatId) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_ID,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        message_thread_id: topicId,
        disable_notification: true
      })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to copy: ${d.description}`);
    if (chatId && d.result && d.result.message_id) {
      await saveMessageMapping(chatId, message.message_id, topicId, d.result.message_id);
    }
  }

  async function pinMessage(topicId, messageId) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, message_id: messageId, message_thread_id: topicId })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to pin: ${d.description}`);
  }

  async function forwardMessageToPrivateChat(privateChatId, message) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: privateChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        disable_notification: true
      })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to forward: ${d.description}`);
    if (d.result && d.result.message_id && message.message_thread_id) {
      await saveMessageMapping(privateChatId, d.result.message_id, message.message_thread_id, message.message_id);
    }
  }

  async function saveMessageMapping(chatId, privateMessageId, topicId, groupMessageId) {
    try {
      await env.D1.prepare(
        'INSERT OR REPLACE INTO message_mappings (chat_id, private_message_id, topic_id, group_message_id, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(chatId, privateMessageId, topicId, groupMessageId, Math.floor(Date.now() / 1000)).run();
    } catch (e) {
      console.error('saveMessageMapping failed:', e);
    }
  }

  async function sendMessageToUser(chatId, text) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to send to user: ${d.description}`);
  }

  async function fetchWithRetry(url, options, retries = 2, backoff = 800) {
    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.status === 429) {
          const ra = response.headers.get('Retry-After') || 3;
          await new Promise(r => setTimeout(r, Math.min(parseInt(ra) * 1000, 5000)));
          continue;
        }
        if (response.ok) return response;
        // 非 2xx 时把响应体一起抛出, 便于排查 Telegram 返回的 description
        let detail = '';
        try {
          const clone = response.clone();
          detail = (await clone.text()).slice(0, 500);
        } catch (_) { /* ignore */ }
        throw new Error(`HTTP ${response.status}${detail ? ': ' + detail : ''}`);
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, backoff * Math.pow(2, i)));
      }
    }
    throw new Error(`Failed to fetch after ${retries} retries`);
  }

  async function registerWebhook(req, env) {
    if (!SHARED_SECRET) {
      return new Response('SHARED_SECRET not configured', { status: 500 });
    }
    if (!SHARED_SECRET_PATTERN.test(SHARED_SECRET)) {
      return new Response('SHARED_SECRET must match [A-Za-z0-9_-]{1,256}', { status: 400 });
    }
    const origin = getOrigin(req, env);
    const webhookUrl = `${origin}/webhook`;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: SHARED_SECRET })
    }).then(x => x.json());
    return new Response(r.ok ? 'Webhook set successfully' : JSON.stringify(r, null, 2));
  }

  async function unRegisterWebhook() {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '' })
    }).then(x => x.json());
    return new Response(r.ok ? 'Webhook removed' : JSON.stringify(r, null, 2));
  }
}
