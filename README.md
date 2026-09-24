# Minigram · 部署与使用文档

> 部署在 Cloudflare Pages 上的 Telegram 私聊中转机器人：把用户私聊消息镜像到群组话题，带 Turnstile 人机验证、消息编辑同步、管理面板。

---

## 变量速查

| 变量 | 必填 | 来源 |
|---|---|---|
| `BOT_TOKEN_ENV` | ✅ | BotFather |
| `GROUP_ID_ENV` | ✅ | 后台群组 |
| `OWNER_ID` | ✅ | @userinfobot |
| `SHARED_SECRET` | ✅ | `openssl rand -hex 32` |
| `PUBLIC_ORIGIN` | ✅ | 自定义域名 |
| `CAPTCHA_SITE_KEY` | ✅ | Turnstile |
| `CAPTCHA_SECRET_KEY` | ✅ | Turnstile |
| `MAX_MESSAGES_PER_MINUTE_ENV` | ❌ | 默认 40 |
| `BOT_DESCRIPTION` | ❌ | 自定义 |
| `BOT_SHORT_DESCRIPTION` | ❌ | 自定义 |
| `D1`（绑定） | ✅ | D1 数据库 |

---

## 准备工作

1. **创建 Telegram Bot**：
   - 在 Telegram 中找到 `@BotFather`，发送 `/newbot` 创建新机器人。
   - 按照提示设置机器人名称和用户名，获取 Bot Token（例如 `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`）。
   - 记录为 `BOT_TOKEN_ENV`。

2. **创建后台群组**：
   - 创建一个 Telegram 群组。
   - 群组的“话题功能”打开。
   - 添加机器人为管理员，建议权限全给（消息管理，话题管理）。
   - 获取群组的 Chat ID（例如 `-100123456789`），可以通过 `@getidsbot` 获取（拉它进群）。
   - 记录为 `GROUP_ID_ENV`。

3. **获取自己的 User ID**：
   - 在 Telegram 中找到 `@userinfobot`，私聊发送任意消息。
   - 它会返回你的 User ID（例如 `6983385803`）。
   - 记录为 `OWNER_ID`。

4. **生成共享密钥**：
   - 本地终端执行 `openssl rand -hex 32`。
   - 输出形如 `7f3a9c2b8d1e4f6a...`（64 位 hex）。
   - 记录为 `SHARED_SECRET`。
   - ⚠️ 不要用 `openssl rand -base64 15`，base64 含 `+` `/` `=`，会让 `setWebhook` 失败。

5. **创建 D1 数据库**：
   - Cloudflare Dashboard → **Workers & Pages** → **D1** → **Create database**。
   - 名称填 `tg-private-bot`。
   - 不需要手动建表，代码会自动初始化。

---

## 部署 Pages 项目

6. **部署项目**：
   - Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
   - 选择你的仓库（本项目 fork 后的仓库）。
   - Build command：**留空**。
   - Build output directory：`public`。
   - 点 **Save and Deploy**。

7. **绑定 D1**：
   - Pages 项目 → **Settings** → **Functions** → **D1 database bindings**。
   - `Variable name`: `D1`
   - `D1 database`: `tg-private-bot`

8. **绑定自定义域名**：
   - Pages 项目 → **Custom domains** → **Set up a custom domain**。
   - 输入域名（如 `tg.example.com`），按提示完成解析。
   - 等状态变 **Active**。
   - 记录为 `PUBLIC_ORIGIN`（含 `https://`，不含尾斜杠）。
   - ⚠️ 必须使用自定义域名，不能用 `pages.dev`，否则 Turnstile 会失败。

---

## 创建 Turnstile

9. **创建 Turnstile**：
   - Cloudflare Dashboard → **Turnstile** → **Add Site**。
   - 站点名称随意，如 `Minigram Verification`。
   - Domain 填自定义域名（如 `tg.example.com`）。
   - Widget Mode 选 **Managed**。
   - 记录 `CAPTCHA_SITE_KEY` 和 `CAPTCHA_SECRET_KEY`。
   - ⚠️ 必须在自定义域名 Active 之后再创建，域名不一致验证框加载不出来。

---

## 配置环境变量

10. **配置环境变量**：
    - Pages 项目 → **Settings** → **Environment variables**。

```
BOT_TOKEN_ENV      = ...
GROUP_ID_ENV       = -100...
OWNER_ID           = ...
CAPTCHA_SECRET_KEY = ...
CAPTCHA_SITE_KEY   = ...
PUBLIC_ORIGIN      = https://tg.example.com
SHARED_SECRET      = ...
```

11. **重新部署**：
    - 改了环境变量必须重新部署才生效。
    - Pages 项目 → **Deployments** → **Retry deployment**。

---

## 初始化

12. **触发初始化**：
    - 部署完成后访问一次带鉴权的 `/checkTables`：

```bash
curl "https://tg.example.com/checkTables" \
     -H "X-Admin-Key: <SHARED_SECRET>"
```

    - 返回 `Database tables checked and repaired` 表示：
      - ✅ 建好 5 张表
      - ✅ 写入默认设置（验证码默认开启）
      - ✅ 自动注册 webhook（带 `secret_token`）
      - ✅ 配置 Bot 描述、简介、命令菜单

13. **验证 webhook**：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

    - `url` 应为 `https://tg.example.com/webhook`
    - `pending_update_count` 为 `0`
    - `last_error_message` 为空

---

## 使用说明

14. **用户视角**：
    - 私聊 Bot，发任意消息 → 收到验证按钮。
    - 点击 `✅ 点击验证` → 打开 Mini App → 完成 Turnstile。
    - 验证通过 → 话题自动创建，可以正常发消息。
    - 验证有效期 7 天，到期自动重新验证。

15. **管理员视角**：
    - 在用户话题里发 `/admin` → 打开管理面板。
    - 面板按钮：拉黑 / 解黑 / 查用户 / 查黑名单 / 开关验证 / 删用户。
    - 直接回复话题内消息 → 转发回用户私聊。
    - 回复某消息发 `/del` → 删除群组副本。

---

## 命令一览

| 命令 | 位置 | 权限 | 说明 |
|---|---|---|---|
| `/start` | 私聊 | 所有人 | 开始使用 |
| `/del` | 私聊 / 群组话题 | 私聊任何人，群组仅管理员 | 回复消息后发送，删除群组副本 |
| `/admin` | 群组话题 | 管理员 | 打开管理面板 |

---

## 常见问题

- **Bot 不回消息**：`getWebhookInfo` 看 `last_error_message`；确认 `SHARED_SECRET` 格式正确；确认 Bot 是群管理员且有 Manage Topics 权限。
- **话题创建失败**：Bot 不是管理员，或缺 Manage Topics 权限。
- **置顶失败**：Bot 缺 Pin Messages 权限。
- **验证链接显示 pages.dev**：`PUBLIC_ORIGIN` 没配或配错，改好后重新部署并访问 `/registerWebhook`。
- **Turnstile 加载不出来**：Turnstile 里配置的域名要和 `PUBLIC_ORIGIN` 完全一致。
- **管理端点 401**：`X-Admin-Key` 头和 `SHARED_SECRET` 不一致，注意前后空格。
- **`/verify` 报 Token is invalid**：`SHARED_SECRET` 不一致（改了没重新部署，或 Production/Preview 不一致）。让用户重新触发验证。
- **`/registerWebhook` 返回 429**：Telegram 限流，等 `retry_after` 秒后重试。
- **D1 报 table not found**：访问一次 `/checkTables` 触发建表。

---

## 安全建议

1. `SHARED_SECRET` 用 `openssl rand -hex 32`，不要用 base64。
2. 管理端点优先用 `X-Admin-Key` 请求头，不要 `?key=` 走 URL。
3. Bot Token 泄露立即去 BotFather `/revoke` 重置。
4. Turnstile Widget 限制域名，不要用 `*`。
5. 不要在前端页面输出 `SHARED_SECRET`。
6. 怀疑泄露：换 `SHARED_SECRET` → 重新部署 → `/registerWebhook` 重设。

---

## 致谢

| 项目 | 作者 | 仓库 |
|---|---|---|
| Minigram | oldfriendme | https://github.com/oldfriendme/Minigram |
| ctt | iawooo | https://github.com/iawooo/ctt |

---

有问题欢迎提 Issue。
