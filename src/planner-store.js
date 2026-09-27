import { DurableObject } from 'cloudflare:workers';

// All planner data lives in one SQLite-backed Durable Object: one row per recipe, one row per
// planned day, and one row per week's grocery checklist. Bodies are stored as JSON text.
export class PlannerStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS days (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS groceries (week TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }

  getState() {
    const recipes = this.sql.exec('SELECT id, data FROM recipes').toArray()
      .map((row) => ({ ...JSON.parse(row.data), id: row.id }));
    const days = {};
    for (const row of this.sql.exec('SELECT key, data FROM days')) days[row.key] = JSON.parse(row.data);
    const groceries = {};
    for (const row of this.sql.exec('SELECT week, data FROM groceries')) groceries[row.week] = JSON.parse(row.data);
    return { recipes, days, groceries };
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

  putGroceries(week, data) {
    this.sql.exec('INSERT OR REPLACE INTO groceries (week, data) VALUES (?, ?)', week, JSON.stringify(data));
  }

  deleteGroceries(week) {
    this.sql.exec('DELETE FROM groceries WHERE week = ?', week);
  }

  // Restore from a backup file: replaces everything.
  replaceAll(state) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM recipes');
      this.sql.exec('DELETE FROM days');
      this.sql.exec('DELETE FROM groceries');
      for (const r of state.recipes) {
        const { id, ...data } = r;
        this.putRecipe(id, data);
      }
      for (const [key, day] of Object.entries(state.days)) this.putDay(key, day);
      for (const [week, list] of Object.entries(state.groceries)) this.putGroceries(week, list);
    });
  }
}
