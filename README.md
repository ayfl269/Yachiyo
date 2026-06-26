# Yachiyo

Yachiyo 是一个基于 TypeScript 实现的模块化 Agent 系统。采用 pnpm workspaces 单仓多包架构，支持多模型提供商接入、多平台消息适配、分层 SQLite 记忆体系、丰富的工具链与沙箱隔离执行、子代理编排，以及 React 管理后台。

这个项目的创建初衷是构建一个全能型个人助手，可以实现多模态的对话交互，并提供丰富的工具链与插件系统。项目名称来源于《超时空辉夜姬》中的角色（月见八千代）

项目中并没有硬编码任何角色设定和知识库，均由用户自由创建。

目前项目依旧处于开发阶段，很多功能可能仍存在Bug，未实现或硬编码的情况。我们欢迎您的Issues和PR，我们欢迎和接受AI编码，但提交前请必须通过测试和在PR描述中注明使用的模型/工具。

如果您有任何有趣的想法或功能建议欢迎和我们分享，让我们一起走向Happy ending!

---

## 核心特性

- **模块化架构 (PNPM Workspaces)**：14 个子包解耦核心逻辑（`@yachiyo/agent`、`@yachiyo/provider`、`@yachiyo/pipeline`、`@yachiyo/platform` 等），通过 `src/` 代理层统一导出。
- **多模型提供商接入 (Unified Providers)**：原生支持 OpenAI Chat Completions & Responses API、Google Gemini 以及 Anthropic API，提供流式输出解析、Prompt 缓存及多模态输入转换。同时支持 Embedding、Rerank、STT、TTS 等扩展能力。
- **洋葱模型管线 (Stages Pipeline)**：基于事件驱动的 8 阶段消息处理管线（WakingCheck → SessionStatusCheck → RateLimit → ContentSafetyCheck → Preprocess → Process → ResultDecorate → Respond），支持会话锁定与后续事件处理。
- **分层记忆存储 (Layered SQLite Memory)**：利用 SQLite 存储短期对话缓冲区、长期记忆、角色偏好以及用户画像。内置 LLM 整理提炼机制、Jaccard 相似度去重、降权老化机制与 FTS5 全文搜索。
- **丰富的工具系统 (Tool System)**：内置文件操作、Shell 执行、代码执行、网页搜索/抓取、Playwright 浏览器控制、记忆管理、代码搜索、Text-to-Image 渲染等工具，支持通过 MCP 协议接入外部工具。
- **子代理编排 (Sub-Agent Orchestration)**：支持创建子代理并行处理任务，通过 Handoff 机制实现代理间协作，支持沙箱隔离执行。
- **安全沙箱 (Process Sandbox)**：基于 Windows Job Object / Linux cgroup 的进程级安全沙箱，可限制 CPU 权重、最大内存使用与最大衍生进程数，保障本地命令及代码安全执行。
- **多平台适配器中心 (Adapter Registry)**：支持 QQ (OneBot11 WebSocket)、QQ Official Bot、微信 (WeChat OC) 平台适配，统一生命周期管理并共享异步事件队列。
- **插件与技能系统 (Plugin & Skill)**：可扩展的插件注册与技能管理机制，支持事件过滤、自定义处理逻辑。
- **React 管理后台 (Admin Dashboard)**：集成 React + Vite 管理面板，可视化管理提供商、插件、技能、角色、知识库、对话、记忆、配置与消息平台。

---

## 支持的模型提供商

| 提供商 | 接入方式 |
|--------|---------|
| OpenAI | Chat Completions API / Responses API |
| Google Gemini | Gemini API |
| Anthropic | Messages API |

扩展能力：OpenAI / Gemini Embedding、通用 Rerank、OpenAI STT/TTS。

## 支持的消息平台

| 平台 | 协议 |
|------|------|
| QQ (第三方) | OneBot11 WebSocket |
| QQ (官方) | QQ Official Bot API |
| 微信 | WeChat OC |
| WebHook (用于测试) | HTTP |

---

## 目录结构

```
yachiyo/
├── src/                          # 核心源代码（代理层，re-export 自 packages/）
│   ├── server.ts                 # 主入口，读取环境变量并调用 bootstrap()
│   ├── bootstrap.ts              # 系统引导，初始化所有管理器与管线
│   ├── index.ts                  # 库入口，统一 re-export
│   ├── agent/                    # 代理核心（构建器、运行器、工具、沙箱、上下文管理）
│   ├── provider/                 # 模型提供商（实现、转换器、流解析器）
│   ├── pipeline/                 # 消息处理管线（调度器、8 个阶段）
│   ├── platform/                 # 平台适配器（OneBot11、QQ Official、WebChat、WeChat）
│   ├── common/                   # 公共工具（数据库、错误、ID 生成、Token 计数）
│   ├── config/                   # 配置管理
│   ├── conversation/             # 对话管理
│   ├── knowledge-base/           # 知识库（分块、向量存储、RAG）
│   ├── persona/                  # 角色/人格管理
│   ├── plugin/                   # 插件系统
│   ├── skill/                    # 技能管理
│   ├── message/                  # 消息模型与序列化
│   ├── t2i/                      # Text-to-Image 渲染
│   └── dashboard/                # 管理后台 API 服务
├── packages/                     # 14 个 PNPM 子软件包
│   ├── agent/                    # @yachiyo/agent
│   ├── common/                   # @yachiyo/common
│   ├── config/                   # @yachiyo/config
│   ├── conversation/             # @yachiyo/conversation
│   ├── dashboard/                # @yachiyo/dashboard
│   ├── knowledge-base/           # @yachiyo/knowledge-base
│   ├── message/                  # @yachiyo/message
│   ├── persona/                  # @yachiyo/persona
│   ├── pipeline/                 # @yachiyo/pipeline
│   ├── platform/                 # @yachiyo/platform
│   ├── plugin/                   # @yachiyo/plugin
│   ├── provider/                 # @yachiyo/provider
│   ├── skill/                    # @yachiyo/skill
│   └── t2i/                      # @yachiyo/t2i
├── frontend/                     # React + Vite 管理后台
│   └── src/components/           # 13 个管理面板组件
├── tests/                        # 测试套件（tsx 直接运行）
├── doc/                          # 架构设计与 API 文档
│   ├── API_REFERENCE.md          # API 参考文档
│   ├── message_processing_design.md   # 消息处理架构设计
│   ├── provider_interface_design.md   # Provider 接口设计
│   └── webhook_adapter_design.md      # 平台适配器设计
├── data/                         # SQLite 数据库文件
│   ├── chat.db                   # 对话历史
│   ├── config.db                 # 配置、提供商、角色、适配器
│   ├── memory.db                 # 代理长期记忆
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

---

## 测试套件

使用 `tsx` 直接运行 TypeScript 测试文件：

```bash
pnpm test
```

包含的测试文件：

| 测试文件 | 测试内容 |
|----------|---------|
| `tests/test.ts` | 系统核心集成测试 |
| `tests/message-processing-test.ts` | 消息管线与调度 |
| `tests/platform-adapter-test.ts` | 平台与 Webhook 适配器 |
| `tests/context-system-test.ts` | 上下文管理系统 |
| `tests/memory-system-test.ts` | 记忆提取与整理 |
| `tests/provider-caching-test.ts` | 模型 Prompt 缓存 |
| `tests/provider-manager-test.ts` | 模型加载与 MCP 安全校验 |
| `tests/windows-sandbox-test.ts` | Windows 沙箱限制验证 |

---

## 架构文档

`doc/` 目录下包含详细的设计文档：

- **[API_REFERENCE.md](doc/API_REFERENCE.md)** — 完整 API 参考
- **[message_processing_design.md](doc/message_processing_design.md)** — 消息处理管线架构设计
- **[provider_interface_design.md](doc/provider_interface_design.md)** — Provider 接口与多模型适配设计
- **[webhook_adapter_design.md](doc/webhook_adapter_design.md)** — 平台适配器系统设计

---

## 技术栈

**后端核心：**
TypeScript 5.7+ · Node.js · pnpm Workspaces · Better-sqlite3 · Zod · WebSocket (ws) · Playwright · Sharp · EventEmitter3 · MCP SDK

**前端管理后台：**
React 18 · TypeScript 5.7 · Vite 8 · ApexCharts · Lucide Icons · JSZip · QRCode

**测试：**
tsx（TypeScript 直接执行）

---
