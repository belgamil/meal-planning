import { DurableObject } from 'cloudflare:workers';

// All planner data lives in one SQLite-backed Durable Object: one row per recipe and one row
// per planned day. Bodies are stored as JSON text.
export class PlannerStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS days (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }

  getState() {
    const recipes = this.sql.exec('SELECT id, data FROM recipes').toArray()
      .map((row) => ({ ...JSON.parse(row.data), id: row.id }));
    const days = {};
    for (const row of this.sql.exec('SELECT key, data FROM days')) days[row.key] = JSON.parse(row.data);
    return { recipes, days };
  }

  putRecipe(id, data) {
    this.sql.exec('INSERT OR REPLACE INTO recipes (id, data) VALUES (?, ?)', id, JSON.stringify(data));
  }

  deleteRecipe(id) {
    this.sql.exec('DELETE FROM recipes WHERE id = ?', id);
  }

  putDay(key, data) {
    this.sql.exec('INSERT OR REPLACE INTO days (key, data) VALUES (?, ?)', key, JSON.stringify(data));
  }

  deleteDay(key) {
    this.sql.exec('DELETE FROM days WHERE key = ?', key);
  }

  // Restore from a backup file: replaces everything.
  replaceAll(state) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM recipes');
      this.sql.exec('DELETE FROM days');
      for (const r of state.recipes) {
        const { id, ...data } = r;
        this.putRecipe(id, data);
      }
      for (const [key, day] of Object.entries(state.days)) this.putDay(key, day);
    });
  }
}
