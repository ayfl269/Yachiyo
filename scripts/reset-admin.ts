/**
 * CLI tool to reset the Dashboard admin account.
 *
 * Usage:  pnpm reset-admin
 *
 * Interactively prompts for a new username and password, then writes
 * directly to the SQLite config database. Useful when you forget the
 * password and cannot log in to the Dashboard.
 *
 * The server does NOT need to be running. If it is, the change takes
 * effect on next login attempt (existing sessions are unaffected until
 * they expire).
 */

import Database from "better-sqlite3";
import { randomBytes, scryptSync } from "crypto";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { join } from "path";
import { existsSync } from "fs";

// ── Helpers (mirror server.ts logic) ──

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function question(rl: any, prompt: string): Promise<string> {
  return rl.question(prompt);
}

async function questionHidden(rl: any, prompt: string): Promise<string> {
  // Node's readline doesn't natively hide input. We print the prompt
  // and read from stdin directly. This is best-effort — terminals
  // that don't support raw mode will show the password.
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let result = "";
    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === "\r" || c === "\n" || c === "\u0004") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        resolve(result.trim());
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        // Backspace
        if (result.length > 0) {
          result = result.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c >= " ") {
        result += c;
        process.stdout.write("*");
      }
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ── Main ──

async function main(): Promise<void> {
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     Yachiyo Dashboard 管理员密码重置工具     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");

  // Resolve database path
  const dataDir = process.env.DATA_DIR ?? "./data";
  const dbPath = join(dataDir, "config.db");

  if (!existsSync(dbPath)) {
    console.error(`✗ 数据库文件不存在: ${dbPath}`);
    console.error("  请确认 DATA_DIR 环境变量正确，或在此目录下运行。");
    process.exit(1);
  }

  console.log(`数据库路径: ${dbPath}`);
  console.log("");

  const db = new Database(dbPath);

  // Ensure table exists (in case dashboard hasn't been started yet)
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      is_first_login INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Show existing users
  const users = db.prepare("SELECT username, is_first_login FROM dashboard_users").all() as Array<{ username: string; is_first_login: number }>;
  if (users.length > 0) {
    console.log("现有账户:");
    for (const u of users) {
      console.log(`  • ${u.username}${u.is_first_login ? " (首次登录未修改)" : ""}`);
    }
    console.log("");
  }

  const rl = createInterface({ input, output });

  try {
    const username = (await question(rl, "新用户名 (≥3字符): ")).trim();
    if (username.length < 3) {
      console.error("✗ 用户名长度至少为3位");
      process.exit(1);
    }

    const password = await questionHidden(rl, "新密码 (≥8字符): ");
    if (password.length < 8) {
      console.error("✗ 密码长度至少为8位");
      process.exit(1);
    }

    const confirmPassword = await questionHidden(rl, "确认新密码: ");
    if (password !== confirmPassword) {
      console.error("✗ 两次输入的密码不一致");
      process.exit(1);
    }

    console.log("");

    // Write to database (replace existing or insert new)
    const hashedPassword = hashPassword(password);
    db.transaction(() => {
      // Delete any existing users (we only support a single admin account)
      db.prepare("DELETE FROM dashboard_users").run();
      db.prepare(`
        INSERT INTO dashboard_users (username, password_hash, is_first_login)
        VALUES (?, ?, 0)
      `).run(username, hashedPassword);
    })();

    console.log(`✓ 账户已重置: 用户名 "${username}"，无需首次修改。`);
    console.log("  现在可以使用新凭证登录 Dashboard。");
  } finally {
    rl.close();
    db.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
