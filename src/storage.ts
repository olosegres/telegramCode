import Database from 'better-sqlite3';
import type { UserConfig } from './types';
import path from 'path';
import fs from 'fs';

const dataDir = process.env.DATA_DIR || './data';

export class Storage {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(path.join(dataDir, 'users.db'));
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        work_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  getUser(userId: number): UserConfig | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE user_id = ?
    `).get(userId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      userId: row.user_id as number,
      workDir: row.work_dir as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  saveUser(config: UserConfig): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO users
      (user_id, work_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      config.userId,
      config.workDir,
      config.createdAt,
      config.updatedAt
    );
  }

  deleteUser(userId: number): void {
    this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  }

  close() {
    this.db.close();
  }
}

export const storage = new Storage();
