# Yachiyo

Yachiyo 是一个基于 TypeScript 实现的模块化 Agent 系统。采用 pnpm workspaces 单仓多包架构，支持多模型提供商接入、多平台消息适配、分层 SQLite 记忆体系、丰富的工具链与沙箱隔离执行、子代理编排，以及 React 管理后台。

这个项目的创建初衷是构建一个全能型个人助手，可以实现多模态的对话交互，并提供丰富的工具链与插件系统。项目名称来源于《超时空辉夜姬》中的角色（月见八千代）

项目中并没有硬编码任何角色设定和知识库，均由用户自由创建。

目前项目依旧处于开发阶段，很多功能可能仍存在Bug，未实现或硬编码的情况。我们欢迎您的Issues和PR，我们欢迎和接受AI编码，但提交前请必须通过测试和在PR描述中注明使用的模型/工具。

如果您有任何有趣的想法或功能建议欢迎和我们分享，让我们一起走向Happy ending!

---

## 核心特性

- **模块化架构 (PNPM Workspaces)**：14 个子包解耦核心逻辑（`@yachiyo/agent`、`@yachiyo/provider`、`@yachiyo/pipeline`、`@yachiyo/platform` 等），`src/` 仅保留引导与入口文件，所有逻辑直接引用 `@yachiyo/*` 工作区包。
- **多模型提供商接入 (Unified Providers)**：原生支持 OpenAI Chat Completions & Responses API、Google Gemini 以及 Anthropic API，提供流式输出解析、Prompt 缓存及多模态输入转换。同时支持 Embedding、Rerank、STT、TTS 等扩展能力。
- **洋葱模型管线 (Stages Pipeline)**：基于事件驱动的 8 阶段消息处理管线（WakingCheck → SessionStatusCheck → RateLimit → ContentSafetyCheck → Preprocess → Process → ResultDecorate → Respond），支持会话锁定与后续事件处理。
- **会话访问控制 (Session Access Control)**：支持基于 UMO（Unified Message Origin）的会话黑名单与白名单机制。白名单模式开启后，仅白名单内会话可获得响应，适用于限定特定群组/用户使用场景。
- **分层记忆存储 (Layered SQLite Memory)**：利用 SQLite 存储短期对话缓冲区、长期记忆、角色偏好以及用户画像。内置 LLM 整理提炼机制、Jaccard 相似度去重、降权老化机制与 FTS5 全文搜索。
- **丰富的工具系统 (Tool System)**：内置文件操作、Shell 执行、代码执行、网页搜索/抓取、Playwright 浏览器控制、记忆管理、代码搜索、Text-to-Image 渲染等工具，支持通过 MCP 协议接入外部工具。
- **子代理编排 (Sub-Agent Orchestration)**：支持创建子代理并行处理任务，通过 Handoff 机制实现代理间协作，支持沙箱隔离执行。
- **安全沙箱 (Process Sandbox)**：基于 Windows Job Object / Linux cgroup 的进程级安全沙箱，可限制 CPU 权重、最大内存使用与最大衍生进程数，保障本地命令及代码安全执行。
- **多平台适配器中心 (Adapter Registry)**：支持 QQ (OneBot11 WebSocket)、QQ Official Bot、微信 (WeChat OC) 平台适配，统一生命周期管理并共享异步事件队列。各适配器均实现 `sendProactiveMessage` 主动推送能力，可用于定时任务到期提醒等场景。
- **定时任务与提醒系统 (Scheduler System)**：内置 `scheduler_tool` 工具允许 Agent 创建/查询/更新/删除定时任务（reminder / scheduled / recurring / goal / plan 五种类型）、设置当前任务目标、维护多步骤执行计划。采用"模型优先，系统兜底"两阶段触发机制：任务到期前 60 秒进入 pre-fire 窗口，由模型生成自然提醒回复；若模型未响应则到期时直接推送原始提醒作为兜底。系统事件自动绕过唤醒检查与限流。
- **插件与技能系统 (Plugin & Skill)**：可扩展的插件注册与技能管理机制，支持事件过滤、自定义处理逻辑。
- **React 管理后台 (Admin Dashboard)**：集成 React + Vite 管理面板，可视化管理提供商、插件、技能、角色、知识库、对话、记忆、配置、消息平台与会话白名单。支持调试 Chat 端点用于集成测试（调试对话不并入记忆，避免污染长期记忆与触发记忆整理）。

---

## 支持的模型提供商

| 提供商 | 接入方式 |
|--------|---------|
| OpenAI | Chat Completions API / Responses API |
| Google Gemini | Gemini API |
| Anthropic | Messages API |

扩展能力：OpenAI / Gemini Embedding、通用 Rerank、OpenAI STT/TTS。

## 支持的消息平台

| 平台 | 协议 | 主动推送¹ |
|------|------|:--------:|
| QQ (第三方) | OneBot11 WebSocket | ✓ |
| QQ (官方) | QQ Official Bot API | ✓ |
| 微信 | WeChat OC | ✓² |

¹ 主动推送用于定时任务到期提醒等场景，详见"定时任务系统"。
² 微信 OC 需用户先前发过消息以建立 context_token。

> **注意**：测试可以使用 Dashboard 的 `/api/debug/chat` 端点（通过 `debugChatEnabled` 配置项启用）。

---

## 目录结构

```
yachiyo/
├── src/                          # 入口与引导（直接引用 @yachiyo/* 工作区包）
│   ├── server.ts                 # 主入口，读取环境变量并调用 bootstrap()
│   ├── bootstrap.ts              # 系统引导，初始化所有管理器与管线
│   └── index.ts                  # 库入口，统一 re-export 各子包公共 API
├── packages/                     # 14 个 PNPM 子软件包（真正源代码所在）
│   ├── agent/                    # @yachiyo/agent — 代理核心（构建器、运行器、工具、沙箱、上下文管理）
│   ├── common/                   # @yachiyo/common — 公共工具（数据库、错误、ID 生成、Token 计数、SSRF 防护、加密）
│   ├── config/                   # @yachiyo/config — 配置管理（含会话黑/白名单存储）
│   ├── conversation/             # @yachiyo/conversation — 对话管理
│   ├── dashboard/                # @yachiyo/dashboard — 管理后台 API 服务
│   ├── knowledge-base/           # @yachiyo/knowledge-base — 知识库（分块、向量存储、RAG）
│   ├── message/                  # @yachiyo/message — 消息模型与序列化
│   ├── persona/                  # @yachiyo/persona — 角色/人格管理
│   ├── pipeline/                 # @yachiyo/pipeline — 消息处理管线（调度器、8 个阶段）
│   ├── platform/                 # @yachiyo/platform — 平台适配器（OneBot11、QQ Official、WeChat OC）
│   ├── plugin/                   # @yachiyo/plugin — 插件系统
│   ├── provider/                 # @yachiyo/provider — 模型提供商（实现、转换器、流解析器）
│   ├── skill/                    # @yachiyo/skill — 技能管理
│   └── t2i/                      # @yachiyo/t2i — Text-to-Image 渲染
├── frontend/                     # React + Vite 管理后台
│   └── src/components/           # 15 个管理面板组件
├── tests/                        # 测试套件（tsx 直接运行）
├── doc/                          # 架构设计与 API 文档
│   ├── API_REFERENCE.md          # API 参考文档
│   ├── message_processing_design.md   # 消息处理架构设计
│   ├── provider_interface_design.md   # Provider 接口设计
│   └── webhook_adapter_design.md      # 平台适配器设计
├── data/                         # SQLite 数据库文件
│   ├── chat.db                   # 对话历史
│   ├── config.db                 # 配置、提供商、角色、适配器、会话黑白名单
│   ├── memory.db                 # 代理长期记忆
│   ├── scheduler.db              # 定时任务存储
│   └── knowledge.db              # 知识库存储
├── dist/                         # 编译输出
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── tsconfig.base.json
```

---

## 快速上手

### 1. 安装依赖

项目使用 `pnpm` 进行依赖管理：

```bash
pnpm install
```

### 2. 编译项目

```bash
pnpm build
```

### 3. 启动开发服务器

```bash
pnpm dev
```

### 4. 启动前端管理后台

```bash
pnpm frontend:install
pnpm frontend:dev
```

### 5. 首次登录管理后台

管理后台启动后访问 `http://localhost:8000`，默认账户信息：

| 项目 | 值 |
|------|-----|
| 默认用户名 | `admin`（可通过 `DASHBOARD_DEFAULT_USER` 环境变量自定义） |
| 默认密码 | 无固定默认密码 |

密码来源（二选一）：
- **环境变量**：设置 `DASHBOARD_DEFAULT_PASSWORD`（≥ 8 字符），启动时使用该值作为初始密码
- **自动生成**：未设置环境变量时，系统自动生成一次性强随机密码（出于安全考虑不会打印到日志），此时需通过下方重置脚本设置密码

> **注意**：首次登录强制修改密码。如忘记密码或使用自动生成密码，可通过重置脚本重新设置：
> ```bash
> pnpm reset-admin
> ```
> 该脚本会交互式提示输入新用户名和密码（≥ 8 字符）。

---

## 测试套件

使用 `tsx` 直接运行 TypeScript 测试文件：

```bash
pnpm test
```

包含的测试文件（全部 13 个由 `pnpm test` 运行）：

| 测试文件 | 测试内容 |
|----------|---------|
| `tests/test.ts` | 系统核心集成测试 |
| `tests/message-processing-test.ts` | 消息管线与调度 |
| `tests/platform-adapter-test.ts` | 平台与 Webhook 适配器 |
| `tests/context-system-test.ts` | 上下文管理系统 |
| `tests/memory-system-test.ts` | 记忆提取与整理 |
| `tests/provider-caching-test.ts` | 模型 Prompt 缓存 |
| `tests/provider-manager-test.ts` | 模型加载与 MCP 安全校验 |
| `tests/pipeline-stages-test.ts` | Pipeline 8 阶段核心逻辑单元测试 |
| `tests/save-platform-file-test.ts` | save_platform_file 工具（URL 校验、路径穿越防护、文件下载） |
| `tests/onebot11-api-test.ts` | OneBot11 适配器 API 响应机制（Echo 关联、超时、核心 API） |
| `tests/onebot11-events-test.ts` | OneBot11 适配器事件处理与群管理 API |
| `tests/onebot11-extended-test.ts` | OneBot11 适配器扩展 API（消息/文件/工具/群管扩展） |
| `tests/qqofficial-test.ts` | QQ Official Bot 适配器（富媒体、扩展发送、撤回、表态、频道/公告/权限） |

另可通过独立脚本运行：

| 脚本 | 测试文件 | 测试内容 |
|------|----------|---------|
| `pnpm test:windows` | `tests/windows-sandbox-test.ts` | Windows 沙箱限制验证（非 Windows 自动跳过） |
| `pnpm test:browser` | `tests/browser-automation-test.ts` | 浏览器自动化测试 |
| `pnpm test:interactive-shell` | `tests/interactive-shell-test.ts` | 交互式 Shell 工具测试 |
| `pnpm test:conversation` | `tests/conversation-test.ts` | 对话管理测试 |

以下测试文件未绑定 npm 脚本，可通过 `tsx tests/<file>` 直接运行：

| 测试文件 | 测试内容 |
|----------|---------|
| `tests/ask-user-tool-test.ts` | ask_user 工具（澄清交互、选项卡片） |
| `tests/knowledge-base-test.ts` | 知识库分块、向量检索与 RAG |
| `tests/proxy-tool-test.ts` | proxy_manage 工具（运行时代理切换） |
| `tests/scheduler-system-test.ts` | 定时任务两阶段触发与状态机 |

---

## 环境变量

`src/server.ts` 启动入口读取以下环境变量进行配置：

| 变量 | 说明 | 默认值 |
|------|------|-------|
| `PROVIDER_TYPE` | LLM Provider 类型：`openai` / `openai_responses` / `gemini` / `anthropic` | — |
| `PROVIDER_API_KEY` | Provider API Key | — |
| `PROVIDER_MODEL` | 模型名称 | `gpt-4o-mini` |
| `PROVIDER_BASE_URL` | 自定义 API Base URL（可选） | — |
| `WEBHOOK_PORT` | OneBot11 WebSocket 监听端口 | `8080` |
| `WEBHOOK_HOST` | OneBot11 WebSocket 监听地址 | `0.0.0.0` |
| `DASHBOARD_ENABLED` | 是否启用管理后台（设为 `false` 关闭） | 启用 |
| `DASHBOARD_PORT` | 管理后台端口 | `8000` |
| `DASHBOARD_HOST` | 管理后台监听地址 | `0.0.0.0` |
| `DASHBOARD_DEFAULT_USER` | 管理后台默认用户名 | `admin` |
| `DASHBOARD_DEFAULT_PASSWORD` | 管理后台默认密码（≥ 8 字符，未设置时自动生成） | — |
| `DATA_DIR` | 数据目录路径（存放 SQLite 数据库与密钥） | `./data` |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出站 HTTPS/HTTP 代理地址（同时作用于 undici 与 Playwright） | — |

> 启动时若未设置 `PROVIDER_TYPE` 与 `PROVIDER_API_KEY`，系统将以"无 LLM Provider"模式启动，仍可使用 Dashboard 进行配置。

---

## 定时任务系统

Yachiyo 内置完整的定时任务与提醒系统，允许 Agent 主动管理用户的待办事项、周期提醒与多步骤执行计划。采用"模型优先，系统兜底"两阶段触发机制，确保提醒既自然又可靠。

### 任务类型

| 类型 | 说明 | 触发方式 |
|------|------|---------|
| `reminder` | 一次性提醒 | `scheduled_at` 到期触发 |
| `scheduled` | 定时任务 | `scheduled_at` 到期触发 |
| `recurring` | 周期任务 | 按 `recurrence`（`1h`/`30m`/`daily`/`weekly`）周期触发 |
| `goal` | 当前任务目标 | 不自动触发，由 Agent 维护 |
| `plan` | 多步骤执行计划 | 不自动触发，由 Agent 推进步骤 |

### 任务状态

| 状态 | 说明 |
|------|------|
| `pending` | 待触发（默认状态） |
| `active` | 活动中（用于 goal/plan 等需手动推进的任务） |
| `notifying` | 已进入 pre-fire 窗口，已发送给模型等待响应 |
| `completed` | 已完成 |
| `cancelled` | 已取消 |
| `failed` | 失败 |

### 两阶段触发机制

任务触发采用"模型优先，系统兜底"机制，平衡提醒的自然性与可靠性：

```
T-60s  Pre-fire 窗口（模型优先）
       │ pending → notifying
       ├─ 注入 ProactiveTriggerEvent 到 pipeline（绕过唤醒检查与限流）
       ├─ 模型接收提醒 prompt，生成自然回复
       ├─ 模型回复发送时 → onResponded → markFired（阻止兜底）
       └─ 模型调用 scheduler_tool delete 删除任务（防止堆积）

T+0    到期检查（系统兜底）
       ├─ 模型已响应：任务已 markFired → 不触发兜底 ✓
       └─ 模型未响应：任务仍为 notifying → fireTask
           ├─ markFired（条件 WHERE 防止重复推进）
           └─ sendProactiveMessage 直接推送原始提醒文本
```

**关键设计：**
- **Pre-fire 窗口**：默认 60 秒，通过 `preFireWindow` 配置项调整
- **系统事件绕过**：`ProactiveTriggerEvent` 设置 `isSystem` 标志，自动绕过 `WakingCheckStage` 和 `RateLimitStage`
- **防重复推进**：`markFired` 使用条件 WHERE 子句（`status IN ('pending', 'active', 'notifying')`），即使模型响应与兜底同时触发也只会推进一次
- **Recurring 任务重置**：recurring 任务从 `notifying` 触发后重置为 `pending`，确保下次周期能再次被 pre-fire 拾取

### 工作流程

1. **Agent 创建任务**：用户对话中要求设置提醒，Agent 调用 `scheduler_tool` 创建任务并自动绑定当前会话的 UMO / sessionId / platformId
2. **Pre-fire 阶段**：`TaskScheduler` 每 30 秒扫描，任务进入 pre-fire 窗口（到期前 60 秒）时标记为 `notifying` 并发送给模型
3. **模型响应阶段**：模型生成自然提醒回复并通过 `sendProactiveMessage` 推送给用户，随后调用 `scheduler_tool` delete 删除任务
4. **兜底阶段**：若到期时模型仍未响应（任务仍为 `notifying`），直接推送原始提醒文本
5. **周期任务重算**：recurring 类型任务触发后自动重算 `next_fire_at`，从 `notifying` 重置为 `pending` 继续运行

### Agent 可用操作

`scheduler_tool` 提供 13 个 action：`create` / `get` / `list` / `search` / `update` / `delete` / `set_goal` / `get_goal` / `set_plan` / `update_step` / `next_step` / `fire_now` / `stats`。

### 调试模式

Dashboard 的 `/api/debug/chat` 端点用于集成测试。调试对话会被标记 `_debugChat`，不写入短期记忆，避免触发记忆整理导致调试响应延迟。通过 `debugChatEnabled` 配置项控制开关（默认关闭）。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装后端依赖 |
| `pnpm build` | 编译所有子包（`tsc -b`） |
| `pnpm typecheck` | 类型检查（不产出文件） |
| `pnpm lint` | ESLint 代码规范检查 |
| `pnpm dev` | 启动开发服务器（`tsx watch`） |
| `pnpm test` | 运行核心测试套件（13 个测试） |
| `pnpm frontend:install` | 安装前端依赖（独立 lockfile） |
| `pnpm frontend:dev` | 启动前端 Vite 开发服务器 |
| `pnpm frontend:build` | 构建前端生产版本 |
| `pnpm reset-admin` | 交互式重置管理后台账户密码 |


---

## 架构文档

`doc/` 目录下包含详细的设计文档：

- **[API_REFERENCE.md](doc/API_REFERENCE.md)** — 完整 API 参考
- **[message_processing_design.md](doc/message_processing_design.md)** — 消息处理管线架构设计
- **[provider_interface_design.md](doc/provider_interface_design.md)** — Provider 接口与多模型适配设计
- **[webhook_adapter_design.md](doc/webhook_adapter_design.md)** — 平台适配器系统设计（历史设计稿，部分未实现）

---

## 社区

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — 贡献指南与开发规范

我们欢迎 Issues 和 PR，也接受 AI 辅助编码，但提交前请确保通过全部测试并在 PR 描述中注明使用的模型/工具。

---

## 技术栈

**后端核心：**
TypeScript 6.0+ · Node.js · pnpm Workspaces · Better-sqlite3 · Zod · WebSocket (ws) · Playwright · Sharp · EventEmitter3 · MCP SDK

**前端管理后台：**
React 18 · TypeScript 6.0+ · Vite 8 · ApexCharts · Lucide Icons · JSZip · QRCode

**测试：**
tsx（TypeScript 直接执行）

---
