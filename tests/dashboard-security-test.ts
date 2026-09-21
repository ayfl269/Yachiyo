/**
 * Dashboard security helpers — path-containment and ZIP-entry sanitization.
 *
 * These pure, exported functions are the containment boundary for the
 * dashboard's file routes (skill files, static assets, ZIP extraction). A
 * regression here is a path-traversal vulnerability, so they are covered
 * directly rather than through a full HTTP server (which needs a live
 * BootstrapContext).
 */
import { isPathSafe, sanitizeSkillPathSegment } from "@yachiyo/dashboard/server.js";

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

function testIsPathSafe(): void {
  console.log("\n=== isPathSafe ===");

  const base = process.platform === "win32" ? "C:\\root\\skills" : "/root/skills";

  assert(isPathSafe(base, "sub/file.txt"), "allows a nested relative path");
  assert(isPathSafe(base, "file.txt"), "allows a direct child");
  assert(isPathSafe(base, "./sub/../file.txt"), "allows an in-root normalized path");

  assert(!isPathSafe(base, "../secret.txt"), "rejects ../ escape");
  assert(!isPathSafe(base, "../../etc/passwd"), "rejects multi-level escape");
  assert(!isPathSafe(base, "sub/../../secret"), "rejects nested escape");

  // Absolute target outside the base must be rejected on every platform.
  const outsideAbs = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";
  assert(!isPathSafe(base, outsideAbs), "rejects an absolute path outside the base");

  // A sibling directory sharing the base's string prefix is NOT inside it.
  const sibling = base + (process.platform === "win32" ? "evil" : "evil");
  assert(!isPathSafe(base, sibling), "rejects a prefix-sibling directory");
}

function testSanitizeSkillPathSegment(): void {
  console.log("\n=== sanitizeSkillPathSegment ===");

  assert(sanitizeSkillPathSegment("my-skill") === "my-skill", "keeps a clean slug");
  assert(sanitizeSkillPathSegment("My Skill!") === "My_Skill_", "slugifies disallowed characters");
  assert(sanitizeSkillPathSegment("../../x") === "x", "strips traversal and keeps the basename");
  assert(sanitizeSkillPathSegment("..\\..\\x") === "x", "handles backslash traversal");
  assert(sanitizeSkillPathSegment("dir/sub") === "sub", "takes the basename");
  assert(sanitizeSkillPathSegment("..") === "", "rejects bare '..'");
  assert(sanitizeSkillPathSegment(".") === "", "rejects bare '.'");
  assert(sanitizeSkillPathSegment("") === "", "rejects empty");
  assert(sanitizeSkillPathSegment("/") === "", "rejects bare separator");
}

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════");
  console.log("  Dashboard security helper tests");
  console.log("════════════════════════════════════════════════");

  testIsPathSafe();
  testSanitizeSkillPathSegment();

  console.log("\n════════════════════════════════════════════════");
  console.log(`  通过: ${passCount}  失败: ${failCount}`);
  console.log("════════════════════════════════════════════════");
  if (failCount > 0) {
    console.error(`❌ ${failCount} 个测试失败`);
    process.exit(1);
  }
  console.log("✅ 所有测试通过!");
  process.exit(0);
}

main();
