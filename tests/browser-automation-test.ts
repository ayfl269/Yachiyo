/**
 * 浏览器自动化工具测试
 * 验证 browser_navigate / browser_click / browser_type / browser_screenshot /
 * browser_snapshot / browser_get_text / browser_execute_script /
 * browser_press_key / browser_wait_for / browser_list_pages / browser_close_page
 *
 * 运行方式：
 *   pnpm test:browser
 * 或
 *   npx tsx tests/browser-automation-test.ts
 */
import { join } from "path";
import { existsSync } from "fs";

// 如果未设置 PLAYWRIGHT_BROWSERS_PATH，自动指向工作区内的 .ms-playwright 目录
const localBrowserPath = join(process.cwd(), ".ms-playwright");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowserPath)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowserPath;
}

import {
  createBrowserNavigateTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserScreenshotTool,
  createBrowserSnapshotTool,
  createBrowserGetTextTool,
  createBrowserExecuteScriptTool,
  createBrowserPressKeyTool,
  createBrowserWaitForTool,
  createBrowserListPagesTool,
  createBrowserClosePageTool,
  closeAllBrowserPages,
  closeSharedBrowser,
} from "@yachiyo/agent/web-tools.js";
import type { CallToolResult } from "@yachiyo/agent/types.js";

// 测试结果统计
let passed = 0;
let failed = 0;

function logResult(name: string, success: boolean, detail = ""): void {
  const icon = success ? "✅" : "❌";
  console.log(`  ${icon} ${name}${detail ? " — " + detail : ""}`);
  if (success) passed++;
  else failed++;
}

/** 调用工具并返回结果文本 */
async function callTool(
  tool: { handler?: (ctx: unknown, ...args: unknown[]) => Promise<unknown> },
  ...args: unknown[]
): Promise<CallToolResult> {
  const result = await tool.handler!(undefined, ...args);
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return result as CallToolResult;
}

function getText(result: CallToolResult): string {
  const textPart = result.content.find((c) => c.type === "text");
  return textPart && "text" in textPart ? textPart.text : "";
}

function hasImage(result: CallToolResult): boolean {
  return result.content.some((c) => c.type === "image");
}

async function runTests(): Promise<void> {
  console.log("\n=== 浏览器自动化工具测试 ===\n");

  // ── 1. browser_list_pages (空状态) ──
  console.log("[1] browser_list_pages (空状态)");
  {
    const result = await callTool(createBrowserListPagesTool());
    const text = getText(result);
    logResult("列出空页面列表", text.includes("No open browser pages"), text.slice(0, 60));
  }

  // ── 2. browser_navigate ──
  console.log("\n[2] browser_navigate");
  let pageId = "";
  {
    const result = await callTool(
      createBrowserNavigateTool(),
      "https://example.com",
      "domcontentloaded",
      30,
    );
    const text = getText(result);
    const match = text.match(/page_id:\s*(\S+)/);
    pageId = match ? match[1] : "";
    logResult("导航到 example.com", !result.isError && pageId !== "", `page_id=${pageId}`);
    logResult("返回标题", text.includes("Example Domain"), text.split("\n").find((l) => l.startsWith("title")));
  }

  if (!pageId) {
    console.log("\n❌ 无法获取 page_id，终止后续测试。");
    return;
  }

  // ── 3. browser_snapshot (text) ──
  console.log("\n[3] browser_snapshot (text)");
  {
    const result = await callTool(createBrowserSnapshotTool(), pageId, "text", 5000);
    const text = getText(result);
    logResult("获取页面文本快照", text.includes("Example Domain") || text.includes("example"), text.slice(0, 60));
  }

  // ── 4. browser_snapshot (html) ──
  console.log("\n[4] browser_snapshot (html)");
  {
    const result = await callTool(createBrowserSnapshotTool(), pageId, "html", 5000);
    const text = getText(result);
    logResult("获取页面 HTML 快照", text.length > 0, `长度=${text.length}`);
  }

  // ── 5. browser_snapshot (accessibility) ──
  console.log("\n[5] browser_snapshot (accessibility)");
  {
    const result = await callTool(createBrowserSnapshotTool(), pageId, "accessibility", 5000);
    const text = getText(result);
    logResult("获取页面无障碍快照", text.length > 0, `长度=${text.length}`);
  }

  // ── 6. browser_screenshot ──
  console.log("\n[6] browser_screenshot");
  {
    const result = await callTool(createBrowserScreenshotTool(), pageId, false);
    logResult("截图包含图片", hasImage(result), getText(result).slice(0, 60));
  }

  // ── 7. browser_get_text ──
  console.log("\n[7] browser_get_text");
  {
    const result = await callTool(createBrowserGetTextTool(), pageId, "h1");
    const text = getText(result);
    logResult("提取 h1 文本", text.includes("Example Domain"), text.slice(0, 60));
  }

  // ── 8. browser_get_text (属性) ──
  console.log("\n[8] browser_get_text (href 属性)");
  {
    const result = await callTool(createBrowserGetTextTool(), pageId, "a", "href");
    const text = getText(result);
    logResult("提取链接 href", /(?:example\.com|iana\.org)/.test(text), text.slice(0, 80));
  }

  // ── 9. browser_execute_script ──
  console.log("\n[9] browser_execute_script");
  {
    const result = await callTool(
      createBrowserExecuteScriptTool(),
      pageId,
      "return document.title + ' | ' + document.querySelectorAll('p').length + ' paragraphs';",
    );
    const text = getText(result);
    logResult("执行 JS 获取标题", text.includes("Example Domain"), text.slice(0, 80));
  }

  // ── 10. browser_wait_for ──
  console.log("\n[10] browser_wait_for");
  {
    const result = await callTool(createBrowserWaitForTool(), pageId, "h1", 5, "visible");
    logResult("等待 h1 元素可见", !result.isError, getText(result).slice(0, 60));
  }

  // ── 11. browser_list_pages (有页面) ──
  console.log("\n[11] browser_list_pages (有页面)");
  {
    const result = await callTool(createBrowserListPagesTool());
    const text = getText(result);
    logResult("列出打开的页面", text.includes(pageId), text.slice(0, 80));
  }

  // ── 12. browser_navigate (第二个页面用于交互测试) ──
  console.log("\n[12] browser_navigate (Bing 搜索页)");
  let bingPageId = "";
  {
    const result = await callTool(
      createBrowserNavigateTool(),
      "https://www.bing.com",
      "domcontentloaded",
      30,
    );
    const text = getText(result);
    const match = text.match(/page_id:\s*(\S+)/);
    bingPageId = match ? match[1] : "";
    logResult("导航到 Bing", !result.isError && bingPageId !== "", `page_id=${bingPageId}`);
  }

  // ── 13. browser_type ──
  console.log("\n[13] browser_type");
  if (bingPageId) {
    // Bing 的搜索框可能有多种选择器，尝试常见的几个
    const selectors = ["#sb_form_q", "textarea[name='q']", "input[name='q']", "#search"];
    let typed = false;
    for (const sel of selectors) {
      const result = await callTool(
        createBrowserTypeTool(),
        bingPageId,
        sel,
        "playwright automation",
        true,
        0,
        false,
      );
      if (!result.isError) {
        logResult("在搜索框输入文本", true, `selector=${sel}`);
        typed = true;
        break;
      }
    }
    if (!typed) {
      logResult("在搜索框输入文本", false, "所有选择器均失败");
    }
  }

  // ── 14. browser_press_key ──
  console.log("\n[14] browser_press_key");
  if (bingPageId) {
    const result = await callTool(createBrowserPressKeyTool(), bingPageId, "Enter");
    logResult("按 Enter 键", !result.isError, getText(result).slice(0, 40));
    // 等待搜索结果加载
    await callTool(createBrowserWaitForTool(), bingPageId, undefined, 3);
  }

  // ── 15. browser_close_page ──
  console.log("\n[15] browser_close_page");
  {
    const result = await callTool(createBrowserClosePageTool(), pageId);
    logResult("关闭 example.com 页面", !result.isError, getText(result).slice(0, 40));
  }

  // ── 16. browser_close_page (关闭所有) ──
  console.log("\n[16] browser_close_page (关闭所有)");
  {
    const result = await callTool(createBrowserClosePageTool());
    logResult("关闭所有页面", !result.isError, getText(result).slice(0, 40));
  }

  // ── 17. browser_list_pages (清理后) ──
  console.log("\n[17] browser_list_pages (清理后)");
  {
    const result = await callTool(createBrowserListPagesTool());
    const text = getText(result);
    logResult("所有页面已关闭", text.includes("No open browser pages"), text.slice(0, 60));
  }

  // ── 18. 错误处理: 操作不存在的 page_id ──
  console.log("\n[18] 错误处理: 操作不存在的 page_id");
  {
    const result = await callTool(createBrowserScreenshotTool(), "nonexistent_id");
    logResult("操作不存在的页面返回错误", result.isError === true, getText(result).slice(0, 60));
  }
}

// 主函数
async function main(): Promise<void> {
  try {
    await runTests();
  } finally {
    // 清理浏览器资源
    try { await closeAllBrowserPages(); } catch { /* ignore */ }
    try { await closeSharedBrowser(); } catch { /* ignore */ }
  }

  console.log(`\n=== 测试结果 ===`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("测试运行失败:", e);
  process.exit(1);
});
