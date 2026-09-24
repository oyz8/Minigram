// ============================================================================
// 一个部署在 Cloudflare Pages 上的 Telegram 私聊机器人
// 把用户私聊消息转发到群组话题、并配有 Turnstile 人机验证, 支持 APP 和网页双端。
// ============================================================================

/* ========================== 1. 全局状态 ========================== */
let BOT_TOKEN, GROUP_ID, MAX_MESSAGES_PER_MINUTE, VERIFY_SECRET, PUBLIC_ORIGIN, OWNER_ID;

let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
let isInitialized = false;
const processedMessages   = new Set();
const processedCallbacks  = new Set();
const topicCreationLocks  = new Map();
const settingsCache = new Map([['verification_enabled', null]]);

/* ========================== 2. LRU 缓存 ========================== */
class LRUCache {
  constructor(maxSize) { this.maxSize = maxSize; this.cache = new Map(); }
  get(k) {
    const v = this.cache.get(k);
    if (v !== undefined) { this.cache.delete(k); this.cache.set(k, v); }
    return v;
  }
  set(k, v) {
    if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(k, v);
  }
  clear() { this.cache.clear(); }
}
const userInfoCache     = new LRUCache(1000);
const topicIdCache      = new LRUCache(1000);
const messageRateCache  = new LRUCache(1000);

/* ========================== 3. 工具函数 ========================== */
function randomHex(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function getOrigin(request, env) {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

/* ========================== 4. 验证页面 HTML ========================== */
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
  return htmlHead + `
<div class="content">
  <div class="logo-wrap">
    <img src="/robot.gif" alt="Bot Avatar" class="avatar"/>
    <div class="card-title">身份验证</div>
  </div>
  <input type="hidden" id="token" value="${eToken}">
  <div class="cf-wrap">
    <div class="cf-turnstile"
         data-sitekey="${env.CAPTCHA_SITE_KEY}"
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

/* ========================== 5. 主入口 ========================== */
export async function onRequest(context) {
  const { request, env } = context;

  BOT_TOKEN = env.BOT_TOKEN_ENV || null;
  GROUP_ID  = env.GROUP_ID_ENV  || null;
  MAX_MESSAGES_PER_MINUTE = env.MAX_MESSAGES_PER_MINUTE_ENV
    ? parseInt(env.MAX_MESSAGES_PER_MINUTE_ENV) : 40;
  VERIFY_SECRET = env.VERIFY_SECRET || '';
  PUBLIC_ORIGIN = env.PUBLIC_ORIGIN || null;
  OWNER_ID      = env.OWNER_ID ? env.OWNER_ID.toString() : null;

  const url = new URL(request.url);

  if (url.pathname === '/' && request.method === 'GET') {
    return Response.redirect('https://github.com/oyz8/Minigram', 302);
  }

  if (!env.D1) return new Response('Server configuration error: D1 not bound', { status: 500 });
  if (!isInitialized) { await initialize(env.D1, request, env); isInitialized = true; }

  if (url.pathname === '/verify') {
    if (request.method === 'POST') return await handleVerifyPost(request, env, context);
    return handleVerifyGet(request, env);
  }
  if (url.pathname === '/webhook' && request.method === 'POST') {
    try {
      const update = await request.json();
      await handleUpdate(update);
      return new Response('OK');
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }
  }
  if (url.pathname === '/registerWebhook')   return await registerWebhook(request, env);
  if (url.pathname === '/unRegisterWebhook') return await unRegisterWebhook();
  if (url.pathname === '/checkTables') {
    await checkAndRepairTables(env.D1);
    return new Response('Database tables checked and repaired', { status: 200 });
  }
  if (url.pathname === '/setupBotProfile') {
    await setupBotProfile(env);
    return new Response('Bot profile updated', { status: 200 });
  }
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not Found', { status: 404 });

  // ============================================================
  //  /verify
  // ============================================================
  function handleVerifyGet(request, env) {
    const u = new URL(request.url);
    const token = u.searchParams.get('token');
    if (!token) return new Response("Token is null");
    if (token.length < 12 || token.length > 256) return new Response("Token is err");

    const parts = token.split('_');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      const chatId = parts[1];
      const nowSec = Math.floor(Date.now() / 1000);
      const newExpiry = nowSec + 300;
      env.D1.prepare(
        'UPDATE user_states SET code_expiry = ? WHERE chat_id = ? AND is_verifying = TRUE'
      ).bind(newExpiry, chatId).run().catch(() => {});
    }

    return new Response(renderVerifyPage(token, env), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  async function handleVerifyPost(request, env, ctx) {
    const body = await request.formData();
    const captcha = body.get('cf-turnstile-response');
    const token = body.get('token');
    const ip = request.headers.get('CF-Connecting-IP');

    const fd = new FormData();
    fd.append('secret', env.CAPTCHA_SECRET_KEY);
    fd.append('response', captcha);
    fd.append('remoteip', ip);
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { body: fd, method: 'POST' });
    const res = await verifyRes.json();
    if (!res.success) return jsonErr('Captcha fail');

    if (!token || token.length < 16 || token.length > 256) return jsonErr('Token is err');
    const parts = token.split('_');
    if (parts.length !== 2) return jsonErr('Token is err');
    const [rand, chatId] = parts;
    if (rand.length !== 12 || !/^\d+$/.test(chatId)) return jsonErr('Token is err');

    const st = await env.D1.prepare('SELECT is_verifying, code_expiry FROM user_states WHERE chat_id = ?').bind(chatId).first();
    if (!st) return jsonErr('User not found');
    const nowSec = Math.floor(Date.now() / 1000);
    if (!st.is_verifying) {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (st.code_expiry && nowSec > st.code_expiry) return jsonErr('Verification expired');

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
    }).catch(() => {});

    const topicPromise = (async () => {
      try { const ui = await getUserInfo(chatId); await ensureUserTopic(chatId, ui); } catch (e) {}
    })();

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(notifyPromise);
      ctx.waitUntil(topicPromise);
    } else {
      await Promise.all([notifyPromise, topicPromise]);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  function jsonErr(msg) {
    return new Response(JSON.stringify({ ok: false, error: msg }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ============================================================
  //  初始化 / 权限 / Bot 资料
  // ============================================================
  async function initialize(d1, req, env) {
    const tasks = [checkAndRepairTables(d1), checkBotPermissions(), cleanExpiredVerificationCodes(d1)];
    const branch = env.CF_PAGES_BRANCH;
    const isProduction = !branch || branch === 'main' || branch === 'production';
    if (isProduction) {
      tasks.push(autoRegisterWebhook(req, env));
      tasks.push(setupBotProfile(env));
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
    const origin = getOrigin(req, env);
    const webhookUrl = `${origin}/webhook`;
    await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
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
        if (name === 'message_mappings') {
          await d1.exec('CREATE INDEX IF NOT EXISTS idx_group_msg ON message_mappings (group_message_id)');
        }
        continue;
      }
      const colRes = await d1.prepare(`PRAGMA table_info(${name})`).all();
      const curCols = new Map(colRes.results.map(c => [c.name, true]));
      for (const [c, def] of Object.entries(structure.columns)) {
        if (c === 'PRIMARY KEY') continue;
        if (!curCols.has(c)) {
          const parts = def.split(' ');
          await d1.exec(`ALTER TABLE ${name} ADD COLUMN ${c} ${parts.slice(1).join(' ')}`);
        }
      }
    }

    await d1.exec('CREATE INDEX IF NOT EXISTS idx_group_msg ON message_mappings (group_message_id)');

    await d1.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .bind('verification_enabled', 'true').run();
    settingsCache.set('verification_enabled',
      (await getSetting('verification_enabled', d1)) === 'true');
  }

  async function cleanExpiredVerificationCodes(d1) {
    const now = Date.now();
    if (now - lastCleanupTime < CLEANUP_INTERVAL) return;
    const nowSec = Math.floor(now / 1000);
    const expired = await d1.prepare(
      'SELECT chat_id FROM user_states WHERE code_expiry IS NOT NULL AND code_expiry < ?'
    ).bind(nowSec).all();
    if (expired.results.length > 0) {
      await d1.batch(expired.results.map(({ chat_id }) =>
        d1.prepare('UPDATE user_states SET code_expiry = NULL, is_verifying = FALSE WHERE chat_id = ?').bind(chat_id)
      ));
    }
    try {
      await d1.prepare('DELETE FROM message_mappings WHERE created_at < ?')
        .bind(nowSec - 30 * 24 * 3600).run();
    } catch (e) {}
    lastCleanupTime = now;
  }

  // ============================================================
  //  Telegram 更新
  // ============================================================
  async function handleUpdate(update) {
    if (update.message) {
      const key = `${update.message.chat.id}:${update.message.message_id}`;
      if (processedMessages.has(key)) return;
      processedMessages.add(key);
      if (processedMessages.size > 10000) processedMessages.clear();
      await onMessage(update.message);
    } else if (update.edited_message) {
      await onEditedMessage(update.edited_message);
    } else if (update.callback_query) {
      await onCallbackQuery(update.callback_query);
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

        let newText = text;
        if (text) {
          const idx = text.indexOf('\n');
          if (idx > 0 && idx < 100) newText = text.slice(idx + 1);
        }

        if (text) {
          await editMessage(mapping.chat_id, mapping.private_message_id, { text: newText });
        } else if (caption) {
          await editMessage(mapping.chat_id, mapping.private_message_id, { caption });
        }
      } else {
        const mapping = await env.D1.prepare(
          'SELECT topic_id, group_message_id FROM message_mappings WHERE chat_id = ? AND private_message_id = ?'
        ).bind(chatId, messageId).first();
        if (!mapping) return;

        if (text) {
          const ui = await getUserInfo(chatId);
          const nickname = ui.nickname || ui.username || `User_${chatId}`;
          await editMessage(GROUP_ID, mapping.group_message_id, { text: `${nickname}:\n${text}` });
        } else if (caption) {
          await editMessage(GROUP_ID, mapping.group_message_id, { caption });
        }
      }
    } catch (e) {}
  }

  async function editMessage(chatId, messageId, { text, caption }) {
    let method = 'editMessageText';
    let payload = { chat_id: chatId, message_id: messageId };
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
    } catch (e) { return false; }
  }

  async function handleDelCommand(message, isGroup) {
    const chatId = message.chat.id.toString();
    const replyTo = message.reply_to_message;

    if (isGroup) {
      const senderId = message.from?.id?.toString();
      if (!senderId || !(await checkIfAdmin(senderId))) {
        return;
      }
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

      await tryDeleteMessage(chatId, replyTo.message_id);
      if (mapping) {
        await tryDeleteMessage(GROUP_ID, mapping.group_message_id);
        await env.D1.prepare(
          'DELETE FROM message_mappings WHERE chat_id = ? AND private_message_id = ?'
        ).bind(chatId, replyTo.message_id).run();
      }
      await tryDeleteMessage(chatId, message.message_id);
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
        const privateChatId = await getPrivateChatId(topicId);
        if (privateChatId && (text === '/admin' || text.startsWith('/admin@'))) {
          await sendAdminPanel(chatId, topicId, privateChatId, messageId);
          return;
        }
        if (privateChatId) await forwardMessageToPrivateChat(privateChatId, message);
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
        'INSERT INTO user_states (chat_id, is_blocked, is_first_verification, is_verified, is_verifying) VALUES (?, ?, ?, ?, ?)'
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

    if (!(await validateTopic(topicId))) {
      await env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).run();
      topicIdCache.set(chatId, undefined);
      topicId = await ensureUserTopic(chatId, userInfo);
      if (!topicId) {
        await sendMessageToUser(chatId, "无法重新创建话题，请稍后再试。");
        return;
      }
    }

    const nickname = userInfo.nickname || userInfo.username || `User_${chatId}`;
    if (text) {
      await sendMessageToTopic(topicId, `${nickname}:\n${text}`, chatId, messageId);
    } else {
      await copyMessageToTopic(topicId, message, chatId);
    }
  }

  async function handleVerification(chatId, env) {
    if (!VERIFY_SECRET) {
      await sendMessageToUser(chatId, '验证服务未配置，请联系管理员。');
      return;
    }
    try {
      const token = `${randomHex(12)}_${chatId}`;
      const origin = getOrigin(request, env);
      const verifyLink = `${origin}/verify?token=${encodeURIComponent(token)}`;
      const nowSec = Math.floor(Date.now() / 1000);
      const codeExpiry = nowSec + 300;

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
      await env.D1.prepare('UPDATE user_states SET is_verifying = FALSE WHERE chat_id = ?').bind(chatId).run();
      await sendMessageToUser(chatId, '发送验证失败，请发送任意消息重试。');
    }
  }

  async function sendVerifyLink(chatId, env) {
    if (!VERIFY_SECRET) return;
    const token = `${randomHex(12)}_${chatId}`;
    const origin = getOrigin(request, env);
    const verifyLink = `${origin}/verify?token=${encodeURIComponent(token)}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const codeExpiry = nowSec + 300;
    await env.D1.prepare('UPDATE user_states SET is_verifying = TRUE, code_expiry = ? WHERE chat_id = ?')
      .bind(codeExpiry, chatId).run();
    await sendMessageToUser(chatId, `🔗 链接在这，5 分钟：\n${verifyLink}`);
  }

  // ============================================================
  //  话题 / 消息发送
  // ============================================================
  async function validateTopic(topicId) {
    try {
      const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, message_thread_id: topicId, text: "检测中", disable_notification: true })
      });
      const d = await r.json();
      if (d.ok) {
        await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: GROUP_ID, message_id: d.result.message_id })
        });
        return true;
      }
      return false;
    } catch { return false; }
  }

  async function ensureUserTopic(chatId, userInfo) {
    let lock = topicCreationLocks.get(chatId) || Promise.resolve();
    topicCreationLocks.set(chatId, lock);
    try {
      await lock;
      let topicId = await getExistingTopicId(chatId);
      if (topicId) return topicId;
      const newLock = (async () => {
        const nickname = userInfo.nickname || userInfo.username || `User_${chatId}`;
        const userName = userInfo.username || `User_${chatId}`;
        topicId = await createForumTopic(nickname, userName, chatId);
        await saveTopicId(chatId, topicId);
        return topicId;
      })();
      topicCreationLocks.set(chatId, newLock);
      return await newLock;
    } finally {
      if (topicCreationLocks.get(chatId) === lock) topicCreationLocks.delete(chatId);
    }
  }

  async function deleteUserTopic(chatId) {
    const r = await env.D1.prepare('SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).first();
    if (!r?.topic_id) return false;
    try {
      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: GROUP_ID, message_thread_id: parseInt(r.topic_id) })
      });
      return true;
    } catch (e) { return false; }
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
    await Promise.all([
      fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, message_thread_id: topicId,
          text: '管理员面板：请选择操作',
          reply_markup: { inline_keyboard: buttons }
        })
      }),
      fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      })
    ]);
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
    } catch (e) {}
    const nowSec = Math.floor(Date.now() / 1000);
    let verifiedLine = '否';
    if (info?.is_verified && info.verified_expiry) {
      if (info.verified_expiry > nowSec) {
        const left = info.verified_expiry - nowSec;
        const h = Math.floor(left / 3600);
        const m = Math.floor((left % 3600) / 60);
        verifiedLine = `是（剩余 ${h} 小时 ${m} 分）`;
      } else { verifiedLine = '已过期'; }
    }
    let codeLine = '无';
    if (info?.code_expiry) {
      if (info.code_expiry > nowSec) codeLine = `有效（剩余 ${info.code_expiry - nowSec} 秒）`;
      else codeLine = '已过期';
    }
    const lines = [
      '👤 用户信息',
      '─────────────',
      `UserID：${targetChatId}`,
      `昵称：${tgLine}`,
      `拉黑：${info?.is_blocked ? '✅ 是' : '否'}`,
      `已验证：${verifiedLine}`,
      `首次验证：${info?.is_first_verification ? '是' : '否'}`,
      `验证流程中：${info?.is_verifying ? '是' : '否'}`,
      `验证码：${codeLine}`,
      `话题：${topic?.topic_id ? `#${topic.topic_id}` : '无'}`
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
        await env.D1.prepare('INSERT INTO message_rates (chat_id, start_count, start_window_start) VALUES (?, ?, ?)').bind(chatId, 0, now).run();
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
        await env.D1.prepare('INSERT INTO message_rates (chat_id, message_count, window_start) VALUES (?, ?, ?)').bind(chatId, 0, now).run();
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
    return r?.value || null;
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
    const chatId = cb.message.chat.id.toString();
    const topicId = cb.message.message_thread_id;
    const data = cb.data;
    const messageId = cb.message.message_id;
    const key = `${chatId}:${cb.id}`;
    if (processedCallbacks.has(key)) return;
    processedCallbacks.add(key);

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
      await sendAdminPanel(chatId, topicId, privateChatId, messageId);
      return;
    }

    if (action === 'block') {
      await env.D1.prepare('INSERT OR REPLACE INTO user_states (chat_id, is_blocked) VALUES (?, ?)').bind(privateChatId, true).run();
      await sendMessageToTopic(topicId, `用户 ${privateChatId} 已被拉黑。`);
    } else if (action === 'unblock') {
      await env.D1.prepare('UPDATE user_states SET is_blocked=FALSE, is_first_verification=TRUE WHERE chat_id=?').bind(privateChatId).run();
      await sendMessageToTopic(topicId, `用户 ${privateChatId} 已解除拉黑。`);
    } else if (action === 'toggle_verification') {
      const cur = (await getSetting('verification_enabled', env.D1)) === 'true';
      const next = !cur;
      await setSetting('verification_enabled', next.toString());
      await sendMessageToTopic(topicId, `验证码功能已${next ? '开启' : '关闭'}。`);
    } else if (action === 'check_blocklist') {
      const rows = await env.D1.prepare('SELECT chat_id FROM user_states WHERE is_blocked = TRUE').all();
      const list = rows.results.length > 0
        ? rows.results.map(r => r.chat_id).join('\n') : '当前没有被拉黑的用户。';
      await sendMessageToTopic(topicId, `黑名单列表：\n${list}`);
    } else if (action === 'user_info') {
      await sendUserInfo(topicId, privateChatId);
    } else if (action === 'delete_user') {
      const topicDeleted = await deleteUserTopic(privateChatId);
      await env.D1.batch([
        env.D1.prepare('DELETE FROM user_states WHERE chat_id = ?').bind(privateChatId),
        env.D1.prepare('DELETE FROM message_rates WHERE chat_id = ?').bind(privateChatId),
        env.D1.prepare('DELETE FROM chat_topic_mappings WHERE chat_id = ?').bind(privateChatId),
        env.D1.prepare('DELETE FROM message_mappings WHERE chat_id = ?').bind(privateChatId)
      ]);
      topicIdCache.set(privateChatId, undefined);
      await sendMessageToTopic(topicId,
        topicDeleted ? `用户 ${privateChatId} 及其话题已删除。` : `用户 ${privateChatId} 的数据已删除（话题不存在或已删除）。`);
    }

    if (action === 'user_info') {
      await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id })
      });
      return;
    }

    await sendAdminPanel(chatId, topicId, privateChatId, messageId);
    await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id })
    });
  }

  async function checkIfAdmin(userId) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, user_id: userId })
    });
    const d = await r.json();
    return d.ok && (d.result.status === 'administrator' || d.result.status === 'creator');
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
    let tid = topicIdCache.get(chatId);
    if (tid !== undefined) return tid;
    const r = await env.D1.prepare('SELECT topic_id FROM chat_topic_mappings WHERE chat_id = ?').bind(chatId).first();
    tid = r?.topic_id || null;
    if (tid) topicIdCache.set(chatId, tid);
    return tid;
  }

  async function createForumTopic(nickname, userName, userId) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, name: nickname })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to create forum topic: ${d.description}`);
    const topicId = d.result.message_thread_id;

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
    await pinMessage(topicId, mr.result.message_id);
    return topicId;
  }

  async function saveTopicId(chatId, topicId) {
    await env.D1.prepare('INSERT OR REPLACE INTO chat_topic_mappings (chat_id, topic_id) VALUES (?, ?)').bind(chatId, topicId).run();
    topicIdCache.set(chatId, topicId);
  }

  async function getPrivateChatId(topicId) {
    for (const [cid, tid] of topicIdCache.cache) {
      if (tid === topicId) return cid;
    }
    const r = await env.D1.prepare('SELECT chat_id FROM chat_topic_mappings WHERE topic_id = ?').bind(topicId).first();
    return r?.chat_id || null;
  }

  async function sendMessageToTopic(topicId, text, recordChatId, recordPrivateMsgId) {
    if (!text.trim()) throw new Error('Message text is empty');
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_ID, text, message_thread_id: topicId })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to send to topic: ${d.description}`);
    if (recordChatId && recordPrivateMsgId && d.result?.message_id) {
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
    if (chatId && d.result?.message_id) {
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
    if (d.result?.message_id && message.message_thread_id) {
      await saveMessageMapping(privateChatId, d.result.message_id, message.message_thread_id, message.message_id);
    }
  }

  async function saveMessageMapping(chatId, privateMessageId, topicId, groupMessageId) {
    try {
      await env.D1.prepare(
        'INSERT OR REPLACE INTO message_mappings (chat_id, private_message_id, topic_id, group_message_id, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(chatId, privateMessageId, topicId, groupMessageId, Math.floor(Date.now() / 1000)).run();
    } catch (e) {}
  }

  async function sendMessageToUser(chatId, text) {
    const r = await fetchWithRetry(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(`Failed to send to user: ${d.description}`);
  }

  async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) return response;
        if (response.status === 429) {
          const ra = response.headers.get('Retry-After') || 5;
          await new Promise(r => setTimeout(r, parseInt(ra) * 1000));
          continue;
        }
        throw new Error(`Request failed with status ${response.status}`);
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, backoff * Math.pow(2, i)));
      }
    }
    throw new Error(`Failed to fetch after ${retries} retries`);
  }

  async function registerWebhook(req, env) {
    const origin = getOrigin(req, env);
    const webhookUrl = `${origin}/webhook`;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
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
