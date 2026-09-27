// Meal planner Worker. Static files in /public are served by Cloudflare's asset handling;
// this code only runs for /api/* requests.
//
//   GET    /api/state            everything: { recipes: [...], days: { "YYYY-MM-DD": {...} } }
//   PUT    /api/recipes/:id      save a recipe
//   DELETE /api/recipes/:id
//   PUT    /api/days/:date       save a day's meals and notes
//   DELETE /api/days/:date
//   POST   /api/restore          replace everything from a backup file
//   POST   /api/import           { url } -> recipe fields read from that web page
//
// Every request must carry "Authorization: Bearer <APP_PASSCODE>".

import { extractRecipeFromHtml } from './recipe-import.js';

export { PlannerStore } from './planner-store.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 512 * 1024;
const MAX_PAGE = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!env.APP_PASSCODE) {
      return json({ error: 'The APP_PASSCODE secret isn’t set on this Worker yet. In Cloudflare, open the meal-planner Worker → Settings → “Variables and Secrets” (not the one under Build), add a Secret named APP_PASSCODE, then reload this page.' }, 500);
    }
    if (!(await passcodeMatches(request, env.APP_PASSCODE))) {
      return json({ error: 'Wrong passcode.' }, 401);
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

async function route(request, env, url) {
  const store = env.PLANNER.get(env.PLANNER.idFromName('main'));
  const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]
  const method = request.method;

  if (parts[1] === 'state' && parts.length === 2 && method === 'GET') {
    return json(await store.getState());
  }

  if (parts[1] === 'recipes' && parts.length === 3) {
    const id = parts[2];
    if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid recipe id.');
    if (method === 'PUT') {
      const body = await readJson(request);
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'A recipe needs a name.');
      delete body.id;
      await store.putRecipe(id, body);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await store.deleteRecipe(id);
      return json({ ok: true });
    }
  }

  if (parts[1] === 'days' && parts.length === 3) {
    const key = parts[2];
    if (!DATE_RE.test(key)) throw new HttpError(400, 'Invalid date.');
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!Array.isArray(body.meals)) throw new HttpError(400, 'A day needs a meals list.');
      await store.putDay(key, { meals: body.meals, notes: String(body.notes || '') });
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await store.deleteDay(key);
      return json({ ok: true });
    }
  }

  if (parts[1] === 'restore' && parts.length === 2 && method === 'POST') {
    const body = await readJson(request);
    if (!Array.isArray(body.recipes) || !body.days || typeof body.days !== 'object') {
      throw new HttpError(400, 'That file is not a meal planner backup.');
    }
    const recipes = body.recipes.filter((r) => r && ID_RE.test(r.id) && typeof r.name === 'string');
    const days = Object.fromEntries(Object.entries(body.days)
      .filter(([k, d]) => DATE_RE.test(k) && d && Array.isArray(d.meals))
      .map(([k, d]) => [k, { meals: d.meals, notes: String(d.notes || '') }]));
    await store.replaceAll({ recipes, days });
    return json({ ok: true, recipes: recipes.length, days: Object.keys(days).length });
  }

  if (parts[1] === 'import' && parts.length === 2 && method === 'POST') {
    const body = await readJson(request);
    return json(await importRecipe(String(body.url || '')));
  }

  throw new HttpError(404, 'Not found.');
}

async function importRecipe(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl.trim());
  } catch {
    throw new HttpError(400, 'That doesn’t look like a web link.');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new HttpError(400, 'Only web links (https://…) can be imported.');
  target.hash = '';

  let res;
  try {
    res = await fetch(target.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch {
    throw new HttpError(502, 'Couldn’t reach that website. Check the link and try again.');
  }
  if (!res.ok) {
    throw new HttpError(502, res.status === 403 || res.status === 401
      ? 'That website refused the request (it may need a login or block apps). Paste the recipe text instead.'
      : `That website answered with an error (${res.status}). Paste the recipe text instead.`);
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('html')) throw new HttpError(422, 'That link isn’t a web page.');
  const html = (await res.text()).slice(0, MAX_PAGE);

  const recipe = extractRecipeFromHtml(html, target.toString());
  if (!recipe || (!recipe.ingredients.length && !recipe.instructions)) {
    throw new HttpError(422, 'No recipe found on that page. If it’s behind a login (like NYT Cooking), paste the recipe text instead.');
  }
  return { ...recipe, url: target.toString() };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'That’s too much data.');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

// Compare SHA-256 digests so the check takes the same time whatever the input.
async function passcodeMatches(request, expected) {
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
