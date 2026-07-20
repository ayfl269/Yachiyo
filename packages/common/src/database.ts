/**
 * SQLite Database Manager
 *
 * Manages 4 SQLite databases (chat, memory, config, knowledge) with:
 * - PRAGMA optimizations (DELETE, cache, mmap, foreign keys)
 * - Schema migration system (version-tracked)
 * - Transaction helpers
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Types ──

export type DatabaseName = "chat" | "memory" | "config" | "knowledge" | "scheduler";

export interface Migration {
  version: number;
  name: string;
  up: string; // SQL statements to execute
}

/**
 * Escape special characters in SQL LIKE pattern.
 * Converts \ -> \\, % -> \% and _ -> \_
 */
export function escapeLike(pattern: string): string {
  return pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ── DatabaseManager ──

export class DatabaseManager {
  private dbs: Map<DatabaseName, Database.Database> = new Map();
  private dataDir: string;
  private initialized = false;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.DATA_DIR ?? "./data";
  }

  /**
   * Initialize all databases: create directory, open connections,
   * apply PRAGMAs, run migrations.
   */
  initialize(): void {
    if (this.initialized) return;

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Open all databases
    const dbNames: DatabaseName[] = ["chat", "memory", "config", "knowledge", "scheduler"];
    for (const name of dbNames) {
      const dbPath = join(this.dataDir, `${name}.db`);
      const db = new Database(dbPath);
      this.applyPragmas(db);
      this.ensureMigrationTable(db);
      this.dbs.set(name, db);
    }

    this.initialized = true;
  }

  /**
   * Get a database connection by name.
   */
  getDb(name: DatabaseName): Database.Database {
    const db = this.dbs.get(name);
    if (!db) {
      throw new Error(
        `[DatabaseManager] Database '${name}' not initialized. Call initialize() first.`
      );
    }
    return db;
  }

  /**
   * Run migrations for a specific database.
   * Migrations are applied in order by version number, skipping already-applied ones.
   */
  migrate(dbName: DatabaseName, migrations: Migration[]): void {
    const db = this.getDb(dbName);

    // Sort migrations by version
    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    // Get already-applied versions
    const applied = new Set(
      (db.prepare("SELECT version FROM _migrations").all() as { version: number }[])
        .map((r) => r.version)
    );

    for (const migration of sorted) {
      if (applied.has(migration.version)) continue;

      try {
        db.transaction(() => {
          // Execute migration SQL (may contain multiple statements)
          db.exec(migration.up);

          // Record migration
          db.prepare(
            "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))"
          ).run(migration.version, migration.name);
        })();

        console.info(
          `[DatabaseManager] Applied migration v${migration.version} (${migration.name}) to ${dbName}.db`
        );
      } catch (error) {
        console.error(
          `[DatabaseManager] Failed to apply migration v${migration.version} (${migration.name}) to ${dbName}.db:`,
          error
        );
        throw error;
      }
    }
  }

  /**
   * Close all database connections.
   */
  close(): void {
    for (const [name, db] of this.dbs) {
      try {
        // 在关闭连接前，尝试运行存储优化指令（包装在独立的 try-catch 中，避免其因锁或其他原因报错时阻止连接的关闭）
        try {
          // 1. 运行增量真空回收，释放多余的空闲页面占用空间（比全量 VACUUM 速度快得多，更安全）
          db.pragma("incremental_vacuum");
          // 2. 在关闭前进行统计分析优化，SQLite 官方推荐此操作以加速后续的查询
          db.pragma("optimize");
        } catch (optError) {
          console.warn(`[DatabaseManager] Warning: failed to optimize ${name}.db before closing:`, optError);
        }

        // 4. 确保关闭连接
        db.close();
        console.info(`[DatabaseManager] Successfully closed ${name}.db`);
      } catch (e) {
        console.error(`[DatabaseManager] Error closing ${name}.db:`, e);
      }
    }
    this.dbs.clear();
    this.initialized = false;
  }

  /**
   * Get the data directory path.
   */
  getDataDir(): string {
    return this.dataDir;
  }

  // ── Private ──

  /**
   * Apply PRAGMA optimizations to a database connection.
   *
   * Uses WAL journal mode for significantly better write concurrency:
   * readers do not block writers and vice versa. This is critical for
   * chat workloads where many conversations may write while the agent
   * reads context. WAL also survives crashes better than DELETE mode.
   *
   * Note: WAL requires the data directory to be on a filesystem that
   * supports shared-memory (`/dev/shm` on Linux, default on Windows/macOS).
   * If that is unavailable, fall back to DELETE explicitly here.
   */
  private applyPragmas(db: Database.Database): void {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("wal_autocheckpoint = 1000"); // checkpoint every 1000 pages
    db.pragma("journal_size_limit = 1048576"); // 限制日志文件大小为 1MB
    db.pragma("auto_vacuum = INCREMENTAL");    // 开启增量真空回收模式
    db.pragma("cache_size = 20000");
    db.pragma("temp_store = MEMORY");
    db.pragma("mmap_size = 134217728");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  }

  /**
   * Create the _migrations tracking table if it doesn't exist.
   */
  private ensureMigrationTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
