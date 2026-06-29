# 贡献指南

感谢您对 Yachiyo 项目的兴趣！我们欢迎各种形式的贡献，包括 Bug 报告、功能建议、代码提交和文档改进。

## 开发环境准备

### 前置要求

- **Node.js** 22+
- **pnpm** 11+（`corepack enable && corepack prepare pnpm@latest --activate`）
- **Git**

### 初始化

```bash
git clone <repo-url>
cd yachiyo
pnpm install
pnpm build
```

前端管理后台需要单独安装依赖：

```bash
pnpm frontend:install
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm build` | 编译所有子包（`tsc -b`） |
| `pnpm typecheck` | 类型检查（不产出文件） |
| `pnpm lint` | ESLint 代码规范检查 |
| `pnpm test` | 运行全部测试套件 |
| `pnpm dev` | 启动开发服务器（tsx watch） |
| `pnpm frontend:dev` | 启动前端开发服务器 |
| `pnpm frontend:build` | 构建前端生产版本 |

## 代码规范

### TypeScript

- 严格模式已启用（`tsconfig.base.json` 中 `strict: true`）
- 禁止使用 `@ts-ignore`、`@ts-nocheck`、`@ts-expect-error`
- 尽量避免 `as any`，必要时添加注释说明原因
- 所有新增代码必须通过 `pnpm typecheck` 和 `pnpm lint`

### 架构约定

- 项目使用 pnpm workspaces 单仓多包架构，核心逻辑在 `packages/` 下
- `src/` 目录是代理层，仅 re-export `packages/` 中的模块
- 新功能应在对应的子包中实现，而非 `src/`
- 跨包共享类型应放在 `@yachiyo/common` 或 `@yachiyo/message`

### 提交前检查

提交代码前请确保以下全部通过：

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

如果是前端改动，还需：

```bash
pnpm frontend:build
```

## 提交规范

### Commit Message

使用清晰的提交信息，建议格式：

```
<类型>: <简要描述>

<详细说明（可选）>
```

类型包括：`feat`（新功能）、`fix`（修复）、`refactor`（重构）、`docs`（文档）、`test`（测试）、`chore`（杂项）。

### PR 要求

1. **通过所有检查**：typecheck、lint、build、test 均须通过
2. **描述清晰**：在 PR 描述中说明改动内容和动机
3. **AI 编码声明**：我们接受 AI 辅助编码，但请在 PR 描述中注明使用的模型/工具
4. **测试覆盖**：新增功能应附带测试（使用项目现有的 `assert()` + `tsx` 模式）
5. **不引入新依赖**：如需引入新依赖，请在 PR 中说明理由

## 测试编写

项目使用 `tsx` 直接运行 TypeScript 测试文件，无测试框架。请参考现有测试风格：

```typescript
// tests/example-test.ts
let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

async function main(): Promise<void> {
  // ... 测试逻辑 ...
  console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount > 0) process.exit(1);
}

main();
```

新增测试文件后，请在 `package.json` 的 `test` 脚本中添加。

## 项目结构

详见 [README.md](README.md) 中的目录结构章节。核心代码分布在 14 个子包中，`src/` 仅作为入口代理层。

## 问题与建议

- 发现 Bug 请提交 [Issue](../../issues)，附上复现步骤和环境信息
- 功能建议请先在 Issue 中讨论，达成共识后再提交 PR
