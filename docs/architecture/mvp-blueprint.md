# MVP Blueprint — 发 + 收两端打通

> 在完整的 14-module / 32-table schema 基础上，先实现**最小业务闭环**，人工验证完再迭代。
>
> 本文是规划文档，**不动代码、不写迁移**；具体落库要走 migrations `000X_mvp_minimum.sql`，等这份蓝图核对后再起草。

---

## 1. 目标 & Non-Goals

### 1.1 MVP 必须能做的事（人工可点击验证）

1. 一次性初始化：`/setup` → 创建首个管理员 → 落 `installation_state.status='complete'`。
2. 管理员登录后能：创建 managed domain、创建 / 配置 provider connection（先只接 1 个 outbound provider）。
3. 创建 mailbox → 触发一封**自发自**的测试邮件（同一域名下两个地址）。
4. 在已发送列表看到这封邮件，能打开详情（subject / text_body / html_body / 时间）。
5. 把另一封用 webhook 模拟塞进 inbox：在 inbox 列表看到、详情能开。
6. 一次手动重试失败的出站任务，能从 `pending → succeeded`。

### 1.2 明确**砍掉 / 不实现**的

| 类别 | 砍掉内容 |
|---|---|
| 鉴权 | OAuth (`oauth_accounts`)；账户恢复码 (`account_recovery_codes`)；邀请注册码 (`registration_keys`) |
| 多角色 | 只保留 `administrator` 一个角色；`member` 暂不参与登录 |
| 权限 | 仅 `message.read / message.send / mailbox.create / settings.read / settings.manage`，其它 17 个 permission 全部不导入 |
| 邮件生产功能 | domain signatures (`domain_signatures` + `signatures` 模块) |
| 附件 | `attachment_files` 去重目录、`attachment-md5-backfill` 维护作业、`file_id` 三方关联全部走 0006 之前的简化形态 |
| 调度 | `outbound_jobs.created_via_schedule`（0009）；scheduled-send 入口 |
| 同步/运维 | `configuration_checkpoints` 的 inbound/outbound smoke test、`maintenance_jobs` 表 |
| 集成 | MCP、agent、`integrations/` 下第二个 provider |
| 审计 | `audit_events.metadata_json` 详尽字段；只保留 `actor / action / resource_type / resource_id / request_id` |
| 配置 | `system_settings` 里 11 个开关，MVP 只用 `registration_enabled / outbound_enabled / unknown_recipient_policy / max_mailboxes_per_user / max_attachment_bytes` 5 个 |

### 1.3 显式**风险声明**（动手前必须看一遍）

- 后续激活 "暂停" 的能力时，**不需要**回滚任何已经入库的数据；只需写新的 `00XX_<feature>.sql` 把列加回去。
- 暂停 ≠ 删除 schema。MVP 阶段直接 DROP 表会丢失未来用于回填的 hook，只能在审完本文档同意后才做。

---

## 2. 模块层面的切除清单

来自 `apps/worker/src/modules/` 12 个目录，分三档：✅ 保留 / ⚠️ 最小化保留 / 🛑 暂不实现。

| 模块 | 档 | 备注 |
|---|---|---|
| `identity` | ✅ | 仅 `POST /api/v1/auth/login` + `POST /api/v1/auth/refresh`；`/setup` 创建首位 admin |
| `authorization` | ⚠️ | 只装载 5 个 permission；`requirePermission` 中间件 stub |
| `mailboxes` | ⚠️ | 仅个人 mailbox；`mailbox_members` 表保留 schema 但 routes 不暴露 |
| `messages` | ✅ | `outbox` / `inbox` 两视图列表 + detail + reply (outbound 入口共用) |
| `outbound-mail` | ✅ | 仅 immediate send；保留 `outbound_jobs` 但不走 `created_via_schedule` 分支 |
| `inbound-mail` | ✅ | webhook entrypoint + provider 入站 pipeline；保留 `webhook_events` 仅写最少字段 |
| `provider-sync` | ⚠️ | 仅一个 provider key（建议 `cloudflare_mail`）；`provider_message_state` 上游回调写最少字段 |
| `attachments` | ⚠️ | 直接 R2 object_key 关联到 `message_attachments`；`attachment_uploads` / `attachment_files` 表保留 schema，但不上传流程 |
| `installation` | ✅ | `/setup` 只走 `claim → admin_bootstrap → complete` 三步；`configuration_checkpoints` 暂不写 |
| `administration` | ⚠️ | 域管理 / 用户管理路由**仅 admin**；admin 列表只有自己 |
| `signatures` | 🛑 | 模块不挂载；`domain_signatures` 表保留 schema 但无路由 |
| `maintenance` | 🛑 | 表保留 schema，handler 不挂载（worker entrypoint 不引用）|
| `agent` (MCP) | 🛑 | 完全不挂载；routes 不出现 |
| `integrations` | 🛑 | `brevo / resend` provider 都先 stub |

> 入口表 (`apps/worker/src/entrypoints/`)：保留 `http` / `inbound-email` / `queue`；`scheduled` 入口可留 empty handler。

---

## 3. Schema 层面的切除清单

### 3.1 表级别

| 表 | 档 | 备注 |
|---|---|---|
| `users` | ✅ | 全保留 |
| `sessions` | ✅ | 全保留 |
| `idempotency_records` | ✅ | 全保留 |
| `account_recovery_codes` | 🟡 | 保留 schema，不写路由 |
| `oauth_accounts` | 🟡 | 保留 schema，不写路由 |
| `roles` | ✅ | 但 INSERT 仅 `administrator` |
| `permissions` | ✅ | 只 5 行 |
| `role_permissions` | ✅ | 仅 admin 全拿这 5 个 |
| `user_roles` | ✅ | 全保留 |
| `encrypted_credentials` | ✅ | 全保留 |
| `provider_connections` | ✅ | 全保留 |
| `domains` | ✅ | 全保留 |
| `domain_signatures` | 🟡 | 保留 schema，不写路由 |
| `mailboxes` | ✅ | 全保留 |
| `mailbox_members` | 🟡 | 保留 schema，不写路由 |
| `messages` | ✅ | 全保留（含 0005 `domain_id`） |
| `outbound_jobs` | ✅ | **`created_via_schedule` 列先不加** |
| `message_recipients` | ✅ | 全保留 |
| `mailbox_messages` | ✅ | 全保留 |
| `message_user_state` | ✅ | 全保留 |
| `attachment_uploads` | 🟡 | 保留 schema，路由不写 |
| `attachment_files` | 🟡 | 保留 schema，路由不写 |
| `message_attachments` | ⚠️ | 保留表 + `upload_id` / `object_key` / `size_bytes` / `content_id`/`sha256` 共 8 列，但**不创建 `attachment_files` 表 / `file_id` 列** |
| `provider_message_state` | ✅ | 全保留 |
| `webhook_deliveries` | ✅ | 全保留 |
| `webhook_events` | ✅ | 全保留 |
| `registration_keys` | 🟡 | 保留 schema，不写路由 |
| `audit_events` | ✅ | 全保留 |
| `installation_state` | ✅ | 全保留 |
| `configuration_checkpoints` | 🟡 | 保留 schema，不 INSERT |
| `maintenance_jobs` | 🟡 | 保留 schema，不 INSERT |
| `system_settings` | ✅ | 全保留（但只有 5 个开关被读） |

🟡 = "保留 schema，路由不开" → 这些表是**未来重新激活 feature 的占位**，不能 DROP。

### 3.2 触发器

| 触发器 | 档 | 备注 |
|---|---|---|
| `validate_attachment_upload` | 🛑 | 不创建 |
| `consume_attachment_upload` | 🛑 | 不创建 |

> 触发器重建时一次性随 `attachment_files` 那张表激活，写在未来的 `00XX_attachments_reactivation.sql` 里。

### 3.3 权限键

```
MVP 仅这些 permission key 被 seed 进 0002 / 权限中间件识别，其它全部保留为「未来 import」清单：
- message.read
- message.send
- mailbox.create
- settings.read
- settings.manage
```

---

## 4. 迁移层面的影响

> 我们**不会**修改 `migrations/0001..0009`（它们已经是历史、不可变）。
> MVP 在它们的基础上"选择性忽略"：入口不挂载、表结构不动，只在路由 / handler / queue consumer 层不出现。

| 迁移 | MVP 行为 |
|---|---|
| 0001 | 全部应用（含所有 31 张表 + 2 触发器不创建）|
| 0002 | 仅 seed 5 个 permission + 1 个 role（administrator）|
| 0003 | 应用（表保留，路由不开）|
| 0004 | 应用 **`configuration_checkpoints` 的 5 行 INSERT 改为不执行** |
| 0005 | 全部应用（4 列 `domain_id` + backfill + 4 索引）|
| 0006 | 不应用（`message.read_all` 是禁用的）|
| 0007 | 不应用 (`attachment_files` 整张表 + 重写的触发器都跳过；附件保留 `attachment_uploads` 单文件关联形态) |
| 0008 | 不应用（`attachment.read` 不需要）|
| 0009 | 不应用（`created_via_schedule` 不需要）|

> 备注：以上「不应用」是**逻辑层决策**，**不是**把对应的 SQL 文件删掉。后续激活时这些迁移要么 **replay 一遍**（手工 ALTER/CREATE），要么写 `000X_resume_<feature>.sql`。

---

## 5. 手工验证路径（验收清单）

每一项必须在 dev 环境手动过一遍。

### 5.1 安装 → 登录

```
[v] 启动 worker：`pnpm dev` / `wrangler dev`
[v] GET /setup 返回 installation_state.status='pending'，current_step='claim'
[v] POST /setup 完成 3 步：
    - claim       → cloudflare account/zone/credential 入库
    - admin_bootstrap → 创建首位 administrator
    - complete    → installation_state.status='complete'
[v] POST /api/v1/auth/login 用首位 admin 登录，拿到 access_token
[v] GET /api/v1/auth/me  返回当前 admin
```

### 5.2 准备发送

```
[v] POST /api/v1/credentials        加密平台凭证 → encrypted_credentials
[v] POST /api/v1/provider-connections 绑定 provider_key=cloudflare_mail → provider_connections
[v] POST /api/v1/domains  创建 managed domain (例如 demo.example.com)
[v] POST /api/v1/mailboxes 创建 self@demo.example.com 和 friend@demo.example.com
[v] GET /api/v1/mailboxes  列表中两条记录都出现
```

### 5.3 发一封测试邮件（自发自）

```
[v] POST /api/v1/messages
    { from: self@demo.example.com, to: [friend@demo.example.com],
      subject: "hello", text: "hi" }
[v] DB 检查：
    - messages 新行，status='draft'|'queued'|'sent' 之一
    - outbound_jobs 新行，对应 message_id，status 应该是 succeeded/enqueued/sent 之一
    - message_recipients 新行，type='to'
    - mailbox_messages 新行，folder='sent'
[v] GET /api/v1/mailboxes/{id}/messages?folder=sent  列表出现
[v] GET /api/v1/messages/{message_id}  返回 subject / text / html / sent_at / recipients
```

### 5.4 收一封测试邮件（模拟 webhook）

```
[v] 手工构造一个 HTTP 请求到 /api/v1/webhooks/cloudflare_mail/{connectionId}
    payload 含 provider_message_id / from / to / subject / html / text
[v] DB 检查：
    - provider_message_state 新行（provider_connection_id, provider_message_id）
    - webhook_deliveries 新行
    - webhook_events 新行
    - messages 新行（status='received'）
    - mailbox_messages 新行（folder='inbox'）
    - message_user_state 默认 is_read=0
[v] GET /api/v1/mailboxes/{id}/messages?folder=inbox  列表出现
[v] GET /api/v1/messages/{message_id}  返回 subject / text / html / received_at / recipients
```

### 5.5 失败重试

```
[v] 把刚才那封 outbound_jobs 行的 message_id 改成 sent 失败 → lock_token / attempts++
[v] 检查 queue consumer 处理时 attempts 递增，最终 status='succeeded' 后停止
```

### 5.6 审计与系统设置

```
[v] GET /api/v1/audit-events?limit=20  看到刚才 4 个动作（setup / 凭证 / domain / mailbox / send / receive）
[v] GET /api/v1/admin/system-settings  返回 5 个字段
[v] PATCH outbound_enabled=false，再 POST /api/v1/messages 应该 4xx 拒绝
```

---

## 6. 后续 Milestone（在本蓝图上的增量）

| 里程碑 | 引入的迁移 / 模块 | 触发条件 |
|---|---|---|
| M1 = MVP | 0001 + 0002(limited) | 本蓝图 5.x 通过人工验收 |
| M2 = 共享邮箱 | 激活 `mailbox_members` 路由；新增 `member` role + `user_roles` 灌入 | M1 后 |
| M3 = 邀请注册 | 激活 `registration_keys` / `account_recovery_codes` 路由 | M1 后 |
| M4 = 第二个 provider | 解禁 integrations/brevo + permission `provider.sync` | M2 后 |
| M5 = Domain signatures | 新表 `domain_signatures` 路由 + 注入 `signature.manage` permission | M1 后 |
| M6 = 附件去重 | 回放 0007（`attachment_files` + 触发器）+ backfill | M1 后 |
| M7 = Scheduled send | 回放 0009 `created_via_schedule` + worker `scheduled` entrypoint | M1 后 |
| M8 = MCP / Agent | `agent` 模块挂载 + 新增 MCP routes | M5 后 |
| M9 = Analytics | 新增 `analytics.read` permission + dashboard | M5 后 |

---

## 7. 决策回顾（写代码前再确认一次）

如果你看完之后想改以下任一项，告诉我，我会更新本蓝图：

- [ ] 是否真要砍掉 OAuth / 恢复码 / 邀请码？还是要保留 registration_keys 给「管理员后台创建用户」用？
- [ ] 出站 provider 默认要不要直接接 `cloudflare_mail`？还是保留一个 mock provider 让人工验证时不依赖真实 SMTP？
- [ ] 附件是否要在 MVP 就允许（仅文本、不能上传）？还是 M1 完全不带附件？
- [ ] 权限集合 5 个够不够？要不要把 `message.delete` / `mailbox.manage` / `mailbox.share` 也带上？
- [ ] 期望"MVP 完工"的判断标准：5.1~5.6 全过？还是只过 5.1~5.5？

---

> 蓝图状态：草稿。等 1) 上述 5 个 ✓ 在对话里勾完，并且 2) 一份 `000X_mvp_minimum.sql` 草稿写出来并经过 review，再把状态推到"已批准"。
