# Minigram · 部署与使用文档

> 一个部署在 Cloudflare Pages 上的 Telegram 私聊中转机器人：把用户私聊消息镜像到群组话题、内置 Turnstile 人机验证、支持消息编辑同步与管理面板。

---

## 目录

- [功能特性](#功能特性)
- [准备工作](#准备工作)
- [环境变量](#环境变量)
- [获取密钥与 ID](#获取密钥与-id)
- [部署步骤](#部署步骤)
- [初始化](#初始化)
- [使用说明](#使用说明)
- [命令一览](#命令一览)
- [数据库表结构](#数据库表结构)
- [常见问题](#常见问题)
- [安全建议](#安全建议)
- [致谢](#致谢)

---

## 功能特性

| 功能 | 说明 |
|---|---|
| 私聊中转 | 用户私聊 Bot → 自动镜像到群组对应话题 |
| 话题隔离 | 每个用户自动拥有一个独立话题，管理员回复会转发回用户 |
| 人机验证 | Cloudflare Turnstile 验证，有效期 7 天，到期自动重新验证 |
| 多端一致 | 桌面 / Android / iOS / 浏览器均可完成验证（不依赖 WebApp.sendData） |
| 编辑同步 | 用户编辑私聊消息 → 群组副本自动更新 |
| 删除同步 | 回复消息发 `/del` → 两端同时删除（群组仅管理员可用） |
| 管理面板 | 拉黑 / 解黑 / 查询用户 / 查询黑名单 / 开关验证 / 删除用户 |
| 频率限制 | 消息 1 分钟上限 + `/start` 5 分钟一次 |
| Owner 免验 | 机器人所有者私聊被静默忽略 |
| 菜单精简 | 私聊显示 `/start`，群组和 Owner 隐藏命令菜单 |
| 自动化配置 | 部署后自动注册 webhook + 设置 Bot 描述 + 建表 |

---

## 准备工作

### 开始之前，把下面变量准备好

```bash
# ===== Telegram =====
BOT_TOKEN_ENV                  # Bot Token（从 @BotFather 获取）
GROUP_ID_ENV                   # 群组 ID（-100 开头）
OWNER_ID                       # 你自己的 Telegram User ID

# ===== Cloudflare =====
CAPTCHA_SECRET_KEY             # Turnstile Secret Key
CAPTCHA_SITE_KEY               # Turnstile Site Key

# ===== 密钥、URL =====
PUBLIC_ORIGIN                  # 你的自定义域名，如 https://tg.example.com
VERIFY_SECRET                  # HMAC 签名密钥（自定义随机串）

# ===== 可选 =====
MAX_MESSAGES_PER_MINUTE_ENV    # 每分钟消息上限，默认 40
BOT_DESCRIPTION                # Bot 描述文案（可选，默认有值）
BOT_SHORT_DESCRIPTION          # Bot 简介文案（可选，默认有值）
```

---

## 环境变量

在 Cloudflare Pages → Settings → Environment variables 中配置，**Production 和 Preview 两个环境都要加**：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `BOT_TOKEN_ENV` | ✅ | Telegram Bot Token |
| `GROUP_ID_ENV` | ✅ | 群组 ID，`-100` 开头的负数 |
| `OWNER_ID` | ✅ | 机器人所有者 User ID |
| `CAPTCHA_SECRET_KEY` | ✅ | Turnstile 密钥 |
| `CAPTCHA_SITE_KEY` | ✅ | Turnstile 站点密钥 |
| `PUBLIC_ORIGIN` | ✅ | 对外访问域名，如 `https://tg.example.com` |
| `VERIFY_SECRET` | ✅ | HMAC 签名密钥，随机字符串 |
| `MAX_MESSAGES_PER_MINUTE_ENV` | ❌ | 消息频率上限，默认 40 |
| `BOT_DESCRIPTION` | ❌ | 自定义 Bot 描述，用 `\|` 代表换行 |
| `BOT_SHORT_DESCRIPTION` | ❌ | 自定义 Bot 简介 |

**D1 绑定**（不是环境变量，在 Pages → Settings → Functions → D1 database bindings 里配置）：

| 绑定名 | 值 |
|---|---|
| `D1` | 你创建的 D1 数据库 |

---

## 获取密钥与 ID

### Telegram Bot Token

与 [@BotFather](https://t.me/BotFather) 对话创建 Bot：

```
/newbot
→ 输入 Bot 显示名
→ 输入 Bot 用户名（必须以 bot 结尾）
→ 获得 Token，格式：123456789:ABCDEFGHIKabcnopqrstuvwxyzA
```

### 群组 ID

1. 在 Telegram 里**新建超级群组**
2. 群组设置 → **开启 Topics（话题）功能**
3. 把 Bot 拉进群组 → 设为**管理员**，至少给以下权限：
   - ✅ **Manage Topics**（创建 / 删除话题）
   - ✅ **Pin Messages**（置顶用户信息）
   - ✅ **Delete Messages**（删除测试消息）
4. 获取群组 ID：
   - 用 [@getidsbot](https://t.me/getidsbot) 转发任意群消息给它
   - 或邀请 [@userinfobot](https://t.me/userinfobot) 进群
   - 或直接调用 Bot API `getUpdates`
   - 格式：`-100xxxxxxxxxx`

### 自定义域名（必须）

**本项目必须使用自定义域名，不使用 Pages 默认的 `<项目名>.pages.dev`。**

#### 情况 A：域名已在 Cloudflare 托管（推荐）

1. Pages 项目 → **Custom domains** → **Set up a custom domain**
2. 输入域名，例如 `tg.example.com`
3. 域名在 Cloudflare 托管时会**自动添加 CNAME 记录**，无需手动操作
4. 等 SSL 证书签发（约 1 分钟，最长 24 小时）
5. 访问 `https://tg.example.com` 确认能打开

#### 情况 B：域名在其它服务商

1. 在 Pages 项目 → **Custom domains** → 输入域名，例如 `tg.example.com`
2. 按提示去域名服务商处添加 **CNAME 记录**，指向 `<项目名>.pages.dev`
   - 主机记录：填子域名前缀（如 `tg`），或 `@` 表示根域名
   - 记录类型：`CNAME`
   - 记录值：`<项目名>.pages.dev`
3. 等待 DNS 生效（1-30 分钟，最长 24 小时）
4. 回到 Pages 页面，状态变为 **Active** 后即可访问

> 如果域名服务商不支持 CNAME 泛解析或根域名 CNAME，建议把域名 NS 改到 Cloudflare 托管，用情况 A 的方式。

#### 完成后

```
访问 https://tg.example.com/                    → 跳转到项目 GitHub
访问 https://tg.example.com/verify?token=...    → 打开验证页
访问 https://tg.example.com/robot.gif           → 验证页头像
```

### Turnstile 密钥

**必须在自定义域名绑定成功后再创建 Turnstile**，否则域名不一致会导致验证框加载失败。

1. 登录 Cloudflare Dashboard
2. 左侧菜单 → **Turnstile** → **Add Site**
3. 站点名称随意（如 `Minigram Verification`）
4. **Domain** 填你的**自定义域名**，如 `tg.example.com`
   - 想支持多个子域 → 分别 Add
5. Widget Mode 选 **Managed**
6. 创建 → 记录：
   - **Site Key** → `CAPTCHA_SITE_KEY`
   - **Secret Key** → `CAPTCHA_SECRET_KEY`

> ⚠️ **域名必须和 `PUBLIC_ORIGIN` 完全一致**（不含协议、不含尾斜杠）。不一致时 Turnstile 会加载失败，用户看不到验证框。

### HMAC 签名密钥

在终端生成随机密钥：

```bash
openssl rand -base64 15
```

或自定义任意字符串（≥ 16 字符）。复制结果作为 `VERIFY_SECRET`。

> ⚠️ **一旦确定后不要更换**，换了所有已签发的验证码立即失效，所有用户需要重新验证。

### 你的 User ID

找 [@userinfobot](https://t.me/userinfobot) 私聊，它会告诉你 User ID，填到 `OWNER_ID`。

---

## 部署步骤

### 部署顺序（推荐按此顺序）

```
1. 创建 D1 数据库
2. 部署 Pages 项目
3. 绑定 D1
4. 绑定自定义域名            ← 关键，先做这步
5. 域名状态变 Active
6. 创建 Turnstile（域名填自定义域名）
7. 配置环境变量（PUBLIC_ORIGIN 用自定义域名）
8. 重新部署
9. 访问 https://<自定义域名>/checkTables
```

### 1. 创建 D1 数据库

Cloudflare Dashboard → **Workers & Pages** → **D1** → **Create database**

- 名称：如 `tg-private-bot`
- 创建完成后不需要手动建表，代码会自动初始化

### 2. 部署 Pages 项目

**方式 A：连接 Git 仓库（推荐）**

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择你的仓库（本项目 fork 后的仓库）
3. 构建设置：
   - Build command：**留空**
   - Build output directory：`public`
4. 部署

**方式 B：Wrangler CLI**

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy public --project-name=your-pages
```

**方式 C：直接上传**

Dashboard → Pages → Create → Upload assets → 上传 `functions/` 和 `public/` 目录

### 3. 绑定 D1

Pages 项目 → **Settings** → **Functions** → **D1 database bindings**

```
Variable name: D1
D1 database:   tg-private-bot
```

### 4. 绑定自定义域名

见上文「[自定义域名（必须）](#自定义域名必须)」章节。

### 5. 创建 Turnstile

见上文「[Turnstile 密钥](#turnstile-密钥)」章节。

### 6. 配置环境变量

Pages 项目 → **Settings** → **Environment variables**

把上面「环境变量」表里的所有变量填进去，**Production 和 Preview 都加**。

**关键项**：

```
PUBLIC_ORIGIN = https://tg.example.com      # 必须和绑定的自定义域名完全一致
```

### 7. 重新部署

修改环境变量后，去 **Deployments** 页面，重新部署一次（或者推一次代码触发构建），让新环境变量生效。

---

## 初始化

部署完成后访问一次：

```
https://<你的自定义域名>/checkTables
```

返回 `Database tables checked and repaired` 表示：

- ✅ 建好 5 张表
- ✅ 写入默认设置（验证码默认开启）
- ✅ 自动注册 webhook 到 `https://<你的自定义域名>/webhook`
- ✅ 检查 Bot 是否有群组权限
- ✅ 自动配置 Bot 描述、简介、命令菜单

**验证 webhook 是否成功：**

```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

`url` 应为 `https://<你的自定义域名>/webhook`，`pending_update_count` 为 0。

**手动刷新 Bot 资料（可选）：**

```
https://<你的自定义域名>/setupBotProfile
```

**手动重设 webhook（可选）：**

```
https://<你的自定义域名>/registerWebhook
```

---

## 使用说明

### 用户视角

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | 私聊 Bot，发任意消息 | 收到 `😮‍💨 先验一下。点下面，5 分钟。` + 验证按钮 |
| 2 | 点击 `✅ 点击验证` | 打开 Mini App，完成 Turnstile |
| 3 | 验证通过 | 收到 `😮‍💨 行了，进来了。`，话题自动创建 |
| 4 | 直接发消息 | 消息以 `昵称:\n内容` 的形式转发到话题 |
| 5 | 验证 7 天后过期 | 自动弹新按钮，重新验证 |

**兜底机制**：如果按钮点不开，**再发一条消息** → Bot 会推纯文本链接：

```
🔗 链接在这，5 分钟：
https://<你的自定义域名>/verify?token=...
```

### 管理员视角

管理员在**用户话题内**操作：

1. **打开面板**：在话题里发 `/admin`
2. **面板按钮**：

   ```
   [ 拉黑用户 ]     [ 解除拉黑 ]
   [ 查询用户信息 ] [ 查询黑名单 ]
   [ 关闭验证码 ]   [ 🗑 删除用户 ]
   [    ⭐️ 项目地址 ⭐️    ]
   ```

3. **回复用户**：直接在自己话题里回复，消息会通过 `copyMessage` 转发回用户私聊
4. **删除消息**：回复某条消息发 `/del`，群组和私聊两端同时删除

### 特殊场景

| 场景 | 行为 |
|---|---|
| Owner 私聊 Bot | 静默忽略，不验证不转发 |
| 群组普通成员发 `/del` | 静默忽略 |
| 群组普通成员发 `/admin` | 提示"只有管理员可以使用此功能" |
| 用户在私聊里发 `/del` | 可用（回复要删的消息即可） |
| 用户编辑私聊消息 | 群组副本自动更新（保留昵称前缀） |
| 管理员编辑群组消息 | 尝试同步到私聊（仅文本，因 Bot 无法编辑用户消息，可能失败） |

---

## 命令一览

| 命令 | 使用位置 | 权限 | 说明 |
|---|---|---|---|
| `/start` | 私聊 | 所有人 | 开始使用 |
| `/del` | 私聊 / 群组话题 | 私聊任何人，群组仅管理员 | 回复要删除的消息后发送，两端同步删除 |
| `/admin` | 群组话题 | 管理员 | 打开管理面板 |

**命令菜单显示**：

| 场景 | 菜单显示 |
|---|---|
| 私聊普通用户 | `/start` |
| 私聊 Owner | 无 |
| 群组（成员/管理员） | 无 |

---

## 数据库表结构

代码会在首次访问 `/checkTables` 时自动创建以下表：

### `user_states` — 用户状态

| 字段 | 类型 | 说明 |
|---|---|---|
| `chat_id` | TEXT PK | 用户 ID |
| `is_blocked` | BOOLEAN | 是否被拉黑 |
| `is_verified` | BOOLEAN | 是否已验证 |
| `verified_expiry` | INTEGER | 验证过期时间（Unix 秒）|
| `code_expiry` | INTEGER | 验证码过期时间 |
| `is_first_verification` | BOOLEAN | 是否首次验证（首验跳过频率检查）|
| `is_verifying` | BOOLEAN | 是否正在验证流程中 |

### `message_rates` — 频率计数

| 字段 | 类型 | 说明 |
|---|---|---|
| `chat_id` | TEXT PK | 用户 ID |
| `message_count` | INTEGER | 当前窗口消息数 |
| `window_start` | INTEGER | 窗口起始时间 |
| `start_count` | INTEGER | `/start` 次数 |
| `start_window_start` | INTEGER | `/start` 窗口起始 |

### `chat_topic_mappings` — 用户↔话题映射

| 字段 | 类型 | 说明 |
|---|---|---|
| `chat_id` | TEXT PK | 用户 ID |
| `topic_id` | TEXT | 话题 ID |

### `message_mappings` — 消息映射（编辑/删除同步用）

| 字段 | 类型 | 说明 |
|---|---|---|
| `chat_id` + `private_message_id` | PK | 私聊消息标识 |
| `topic_id` | INTEGER | 话题 ID |
| `group_message_id` | INTEGER | 群组消息 ID |
| `created_at` | INTEGER | 创建时间（30 天后自动清理）|

### `settings` — 全局设置

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | TEXT PK | 设置键 |
| `value` | TEXT | 设置值 |

目前使用 `verification_enabled`（`true` / `false`）。

---

## 常见问题

### Q1：APP 端验证按钮点不开，走了网页逻辑？

旧版存在此问题，新版通过**服务端直接验证**解决：Mini App 完成 Turnstile 后由服务端更新 DB 并推送通知，**不依赖 `Telegram.WebApp.sendData`**。

如果仍然遇到，尝试：
- 清 Telegram APP 缓存
- 换一个没用过 Bot 的账号测试
- 检查 `PUBLIC_ORIGIN` 是否与访问域名完全一致

### Q2：无限弹验证？

已修复。根因是跨 Worker 实例的用户状态缓存陈旧，新版已改为**每次私聊消息都从 D1 读用户状态**。

### Q3：验证卡住了，刷新后验证码还是新的吗？

**不是全新 token，但会重新计时。** 每次访问 `/verify`（含刷新）都会把 `code_expiry` 重置为 `now + 300`，所以刷新后你又有 5 分钟。

想拿全新 token，在私聊里再发条消息即可。

### Q4：Bot 不回消息？

按顺序排查：

1. `getWebhookInfo` 检查 webhook 是否正常，`last_error_message` 是否有报错
2. Pages → Functions → Real-time Logs 看请求日志
3. 确认 `BOT_TOKEN_ENV`、`GROUP_ID_ENV` 配置正确
4. 确认 Bot 是群管理员，且有 Manage Topics 权限

### Q5：话题创建失败？

Bot 不是管理员，或缺少 `Manage Topics` 权限。

### Q6：置顶消息失败？

Bot 缺少 `Pin Messages` 权限。

### Q7：删除用户时话题没删掉？

`deleteForumTopic` 需要 Bot 有 `Manage Topics` 权限，且群组必须是超级群组。

### Q8：D1 报 "table not found"？

访问一次 `/checkTables` 触发建表。

### Q9：验证链接里显示的是 pages.dev 域名？

说明 `PUBLIC_ORIGIN` 没配置或配置错了。修复：

1. 确认自定义域名已绑定且 Active
2. 检查 `PUBLIC_ORIGIN` 是否等于自定义域名（含 `https://`，不含尾斜杠）
3. 重新部署
4. 访问 `https://<自定义域名>/registerWebhook` 重设 webhook
5. 访问 `https://<自定义域名>/setupBotProfile` 刷新描述

### Q10：Turnstile 显示"域名校验失败"或验证框加载不出来？

Turnstile 里配置的域名和实际访问的域名不一致。检查：

1. Turnstile Dashboard → 你的站点 → 查看 Domain 列表
2. 确保里面包含 `PUBLIC_ORIGIN` 里的域名
3. 缺了就 Add 上去
4. 不要通过 pages.dev 域名访问——只能走自定义域名

### Q11：访问 pages.dev 域名能用吗？

能访问，但**不建议**——Turnstile 校验会失败（因为没在 Turnstile 里注册）。始终通过自定义域名访问。

### Q12：`/del` 没反应？

- 群组里：只有**管理员**能用，普通成员发会被静默忽略
- 私聊里：任何人都能用，但**必须先回复**要删的消息
- 检查 `message_mappings` 表里是否有该消息的映射（旧消息可能没有）

### Q13：验证完成后还提示"先验一下"？

1. 检查 `user_states.is_verified` 和 `verified_expiry` 字段
2. 如果 `is_verified = 1` 但 `verified_expiry < now`，说明已过期（7 天有效期）
3. 如果都不对，可能是缓存问题，等待 Worker 实例重启

### Q14：第一次访问很慢？

Worker 冷启动 + `initialize()` 里的初始化任务（建表、注册 webhook、设置 Bot 资料）。之后的请求会快很多。

---

## 安全建议

1. **`VERIFY_SECRET`** 用 `openssl rand -base64 15` 或更强的随机串生成，不要用短字符串
2. **Bot Token 泄漏**立即去 BotFather `/revoke` 重置
3. **D1 数据库**只绑定到这个 Pages 项目，不要外借
4. **Turnstile Widget** 限制域名，不要用 `*`
5. **预览环境**也要配齐环境变量，否则 PR 部署会失败
6. **不要**在前端页面输出 `VERIFY_SECRET`
7. **所有者 ID**（`OWNER_ID`）填对，避免自己账户走完整验证流程

---

## 致谢

本项目在设计和实现过程中参考了以下开源项目的代码与思路：

| 项目 | 作者 | 仓库地址 |
|---|---|---|
| Minigram（原作者） | oldfriendme | https://github.com/oldfriendme/Minigram |
| ctt | iawooo | https://github.com/iawooo/ctt |

感谢以上项目的开源贡献。

---

## 相关链接

- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram WebApp](https://core.telegram.org/bots/webapps)

---

有问题欢迎提 Issue。
