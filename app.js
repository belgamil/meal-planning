'use strict';

// ---------- Storage ----------

const STORAGE_KEY = 'mealPlanner.v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { recipes: parsed.recipes || [], days: parsed.days || {} };
    }
  } catch (err) {
    console.error('Could not load saved data', err);
  }
  return { recipes: [], days: {} };
}

let state = loadState();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Dates ----------

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeek(d) {
  // Weeks start on Monday.
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - offset);
  return copy;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

const fmtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

let weekStart = startOfWeek(new Date());

function getDay(key) {
  return state.days[key] || { meals: [], notes: '' };
}

function setDay(key, day) {
  if (day.meals.length === 0 && !day.notes.trim()) {
    delete state.days[key];
  } else {
    state.days[key] = day;
  }
  save();
}

// ---------- DOM helpers ----------

const $ = (sel) => document.querySelector(sel);

// Builds elements without innerHTML so user text is never interpreted as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function findRecipe(id) {
  return state.recipes.find((r) => r.id === id);
}

function parseLines(text) {
  return (text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// ---------- Tabs ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
});

function showView(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#plan-view').hidden = name !== 'plan';
  $('#recipes-view').hidden = name !== 'recipes';
  if (name === 'plan') renderWeek();
  else renderRecipes();
}

// Close buttons for all dialogs.
document.querySelectorAll('dialog [data-close]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

// ---------- Weekly plan ----------

function renderWeek() {
  const grid = $('#week-grid');
  grid.replaceChildren();
  const todayKey = dateKey(new Date());
  const end = addDays(weekStart, 6);
  $('#week-label').textContent = `${fmtShort.format(weekStart)} – ${fmtShort.format(end)}, ${end.getFullYear()}`;

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const key = dateKey(date);
    const day = getDay(key);

    const meals = el('ul', { class: 'meals' },
      day.meals.map((meal) => {
        const recipe = meal.recipeId ? findRecipe(meal.recipeId) : null;
        const label = recipe ? recipe.name : meal.text || '(deleted recipe)';
        return el('li', { class: 'meal' },
          el('span', { class: 'slot' }, meal.slot),
          el('button', {
            class: 'name' + (recipe ? ' linked' : ''),
            title: recipe ? 'View recipe' : '',
            onclick: () => recipe && openRecipeViewer(recipe.id),
          }, label),
          el('button', {
            class: 'remove',
            title: 'Remove',
            'aria-label': `Remove ${label}`,
            onclick: () => {
              const d = getDay(key);
              d.meals = d.meals.filter((m) => m.id !== meal.id);
              setDay(key, d);
              renderWeek();
            },
          }, '×'),
        );
      }),
    );

    const notes = el('textarea', {
      placeholder: 'Notes for the day (prep, shopping, who\'s home…)',
      value: day.notes,
      oninput: (e) => {
        const d = getDay(key);
        d.notes = e.target.value;
        setDay(key, d);
      },
    });

    grid.append(
      el('article', { class: 'day' + (key === todayKey ? ' today' : '') },
        el('div', { class: 'day-head' },
          el('h3', {}, fmtWeekday.format(date)),
          el('span', { class: 'date' }, fmtShort.format(date)),
        ),
        meals,
        el('button', { class: 'add-meal', onclick: () => openAddDialog(key, date) }, '+ Add meal'),
        notes,
      ),
    );
  }
}

$('#prev-week').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderWeek(); });
$('#next-week').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderWeek(); });
$('#today-btn').addEventListener('click', () => { weekStart = startOfWeek(new Date()); renderWeek(); });

// ---------- Add meal dialog ----------

let addTargetKey = null;

function openAddDialog(key, date) {
  addTargetKey = key;
  const form = $('#add-form');
  form.reset();
  form.slot.value = 'Dinner';
  $('#add-dialog-title').textContent = `Add to ${fmtLong.format(date)}`;
  $('#add-search').value = '';
  renderAddOptions();
  $('#add-dialog').showModal();
  $('#add-search').focus();
}

function renderAddOptions() {
  const q = $('#add-search').value.trim().toLowerCase();
  const list = $('#add-recipe-options');
  const matches = state.recipes
    .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.tags || []).some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (state.recipes.length === 0) {
    list.replaceChildren(el('p', { class: 'empty' }, 'No saved recipes yet — add some in the Recipes tab.'));
    return;
  }
  if (matches.length === 0) {
    list.replaceChildren(el('p', { class: 'empty' }, 'No matching recipes.'));
    return;
  }
  list.replaceChildren(...matches.map((r) =>
    el('label', {},
      el('input', { type: 'checkbox', name: 'recipe', value: r.id }),
      el('span', {}, r.name),
    ),
  ));
}

$('#add-search').addEventListener('input', renderAddOptions);

$('#add-form').addEventListener('submit', (e) => {
  const form = e.target;
  const slot = form.slot.value;
  const picked = [...form.querySelectorAll('input[name="recipe"]:checked')].map((i) => i.value);
  const freeText = form.freeText.value.trim();
  if (picked.length === 0 && !freeText) {
    e.preventDefault();
    form.freeText.focus();
    return;
  }
  const day = getDay(addTargetKey);
  for (const recipeId of picked) day.meals.push({ id: uid(), slot, recipeId });
  if (freeText) day.meals.push({ id: uid(), slot, text: freeText });
  day.meals.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  setDay(addTargetKey, day);
  renderWeek();
});

const SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
function slotOrder(slot) {
  const i = SLOTS.indexOf(slot);
  return i === -1 ? SLOTS.length : i;
}

// ---------- Recipes ----------

function renderRecipes() {
  const q = $('#recipe-search').value.trim().toLowerCase();
  const list = $('#recipe-list');
  const matches = state.recipes
    .filter((r) => {
      if (!q) return true;
      const haystack = [r.name, r.notes, (r.tags || []).join(' '), (r.ingredients || []).join(' ')].join(' ').toLowerCase();
      return haystack.includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) {
    list.replaceChildren(el('p', { class: 'empty' },
      state.recipes.length === 0 ? 'No recipes yet. Click “+ New recipe” to add your first one.' : 'No recipes match your search.'));
    return;
  }

  list.replaceChildren(...matches.map((r) => {
    const meta = [r.time, r.servings && `serves ${r.servings}`, r.ingredients?.length && `${r.ingredients.length} ingredients`]
      .filter(Boolean).join(' · ');
    return el('button', { class: 'recipe-card', onclick: () => openRecipeViewer(r.id) },
      el('h3', {}, r.name),
      meta && el('span', { class: 'muted small' }, meta),
      r.tags?.length > 0 && el('div', { class: 'tags' }, r.tags.map((t) => el('span', { class: 'tag' }, t))),
    );
  }));
}

$('#recipe-search').addEventListener('input', renderRecipes);
$('#new-recipe-btn').addEventListener('click', () => openRecipeEditor(null));

let editingId = null;

function openRecipeEditor(id) {
  editingId = id;
  const form = $('#recipe-form');
  form.reset();
  const r = id ? findRecipe(id) : null;
  $('#recipe-dialog-title').textContent = r ? 'Edit recipe' : 'New recipe';
  $('#delete-recipe-btn').hidden = !r;
  if (r) {
    form.name.value = r.name;
    form.servings.value = r.servings || '';
    form.time.value = r.time || '';
    form.url.value = r.url || '';
    form.tags.value = (r.tags || []).join(', ');
    form.ingredients.value = (r.ingredients || []).join('\n');
    form.instructions.value = r.instructions || '';
    form.notes.value = r.notes || '';
  }
  $('#recipe-dialog').showModal();
  form.name.focus();
}

$('#recipe-form').addEventListener('submit', (e) => {
  const form = e.target;
  const data = {
    name: form.name.value.trim(),
    servings: form.servings.value ? Number(form.servings.value) : null,
    time: form.time.value.trim(),
    url: form.url.value.trim(),
    tags: form.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
    ingredients: parseLines(form.ingredients.value),
    instructions: form.instructions.value.trim(),
    notes: form.notes.value.trim(),
  };
  if (!data.name) { e.preventDefault(); return; }
  if (editingId) {
    Object.assign(findRecipe(editingId), data);
  } else {
    state.recipes.push({ id: uid(), ...data });
  }
  save();
  renderRecipes();
  renderWeek();
});

$('#delete-recipe-btn').addEventListener('click', () => {
  const r = findRecipe(editingId);
  if (!r || !confirm(`Delete “${r.name}”? It will also be removed from your plan.`)) return;
  state.recipes = state.recipes.filter((x) => x.id !== editingId);
  for (const key of Object.keys(state.days)) {
    const day = state.days[key];
    day.meals = day.meals.filter((m) => m.recipeId !== editingId);
    setDay(key, day);
  }
  save();
  $('#recipe-dialog').close();
  renderRecipes();
  renderWeek();
});

let viewingId = null;

function openRecipeViewer(id) {
  const r = findRecipe(id);
  if (!r) return;
  viewingId = id;
  const meta = [r.time, r.servings && `Serves ${r.servings}`].filter(Boolean).join(' · ');
  $('#view-content').replaceChildren(
    el('h2', {}, r.name),
    meta && el('p', { class: 'muted' }, meta),
    r.tags?.length > 0 && el('div', { class: 'tags' }, r.tags.map((t) => el('span', { class: 'tag' }, t))),
    r.url && el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open original recipe ↗'),
    r.ingredients?.length > 0 && el('h3', {}, 'Ingredients'),
    r.ingredients?.length > 0 && el('ul', {}, r.ingredients.map((i) => el('li', {}, i))),
    r.instructions && el('h3', {}, 'Instructions'),
    r.instructions && el('p', { class: 'pre' }, r.instructions),
    r.notes && el('h3', {}, 'Notes'),
    r.notes && el('p', { class: 'pre' }, r.notes),
  );
  $('#view-dialog').showModal();
}

$('#view-edit-btn').addEventListener('click', () => {
  $('#view-dialog').close();
  openRecipeEditor(viewingId);
});

// ---------- Grocery list ----------

function buildGroceryList() {
  // Collect ingredients from every recipe planned this week, merging identical lines.
  const counts = new Map();
  for (let i = 0; i < 7; i++) {
    const day = getDay(dateKey(addDays(weekStart, i)));
    for (const meal of day.meals) {
      const recipe = meal.recipeId && findRecipe(meal.recipeId);
      if (!recipe) continue;
      for (const item of recipe.ingredients || []) {
        const k = item.toLowerCase();
        const entry = counts.get(k) || { label: item, n: 0 };
        entry.n++;
        counts.set(k, entry);
      }
    }
  }
  return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label));
}

let groceryItems = [];

$('#grocery-btn').addEventListener('click', () => {
  groceryItems = buildGroceryList();
  $('#grocery-range').textContent = `For ${$('#week-label').textContent}`;
  $('#grocery-content').replaceChildren(
    groceryItems.length === 0
      ? el('p', { class: 'muted' }, 'No ingredients yet — add saved recipes (with ingredients) to this week.')
      : el('ul', { class: 'grocery-list' }, groceryItems.map((item) =>
          el('li', {},
            el('label', {},
              el('input', { type: 'checkbox' }),
              el('span', {}, item.label),
              item.n > 1 && el('span', { class: 'count' }, `×${item.n}`),
            ),
          ),
        )),
  );
  $('#grocery-dialog').showModal();
});

$('#copy-grocery-btn').addEventListener('click', async () => {
  const text = groceryItems.map((i) => `- ${i.label}${i.n > 1 ? ` (×${i.n})` : ''}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('#copy-grocery-btn').textContent = 'Copied!';
    setTimeout(() => { $('#copy-grocery-btn').textContent = 'Copy'; }, 1500);
  } catch {
    alert(text);
  }
});

// ---------- Import / export ----------

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `meal-planner-${dateKey(new Date())}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.recipes) || typeof data.days !== 'object') throw new Error('Unrecognized file');
    if (!confirm('Replace all current recipes and plans with this backup?')) return;
    state = { recipes: data.recipes, days: data.days || {} };
    save();
    renderWeek();
    renderRecipes();
  } catch (err) {
    alert(`Could not import: ${err.message}`);
  }
});

// ---------- Init ----------

renderWeek();
