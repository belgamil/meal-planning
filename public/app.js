// ---------- State & saving ----------
// Recipes and planned days are saved to this app's server (see src/worker.js), one request per
// recipe or day, so the plan follows you across devices. The passcode is remembered per device.

import { parseRecipeText } from './recipe-text.js';

const PASSCODE_KEY = 'mealPlanner.passcode';
const state = { recipes: [], days: {}, groceries: {} };
let passcode = readPasscode();
let lastStateJson = '';

function readPasscode() {
  try { return localStorage.getItem(PASSCODE_KEY) || ''; } catch { return ''; }
}
function storePasscode(value) {
  passcode = value;
  try {
    if (value) localStorage.setItem(PASSCODE_KEY, value);
    else localStorage.removeItem(PASSCODE_KEY);
  } catch { /* private browsing: remembered for this visit only */ }
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + passcode, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Couldn’t reach your planner. Check your connection.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) {
    storePasscode('');
    showLock('That passcode didn’t work. Try again.');
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `The server answered with an error (${res.status}).`);
  return data;
}

// One write at a time per recipe or day, in order. A failed write is retried once.
const writeChains = new Map();
let pendingWrites = 0;
function queueWrite(path, fn) {
  pendingWrites++;
  setSync(true, 'Saving…');
  const attempt = () => fn().catch((err) => {
    if (err.status === 0) return new Promise((r) => setTimeout(r, 2000)).then(fn);
    throw err;
  });
  const prev = writeChains.get(path) || Promise.resolve();
  const next = prev.then(attempt).then(
    () => { if (pendingWrites === 1) setSync(true, 'All changes saved'); },
    (err) => {
      console.error('Save failed', path, err);
      if (err.status !== 401) setSync(false, 'Couldn’t save your last change. Reload to see what was saved.');
    },
  ).finally(() => { pendingWrites--; });
  writeChains.set(path, next);
  return next;
}

function persistRecipe(recipe) {
  const { id, ...data } = recipe;
  queueWrite('recipes/' + id, () => api('PUT', 'recipes/' + id, data));
}
function removeRecipeDoc(id) {
  queueWrite('recipes/' + id, () => api('DELETE', 'recipes/' + id));
}

const pendingNotes = new Map(); // dateKey -> latest typed notes not yet confirmed
const noteTimers = new Map();

function persistDay(key) {
  const day = state.days[key];
  queueWrite('days/' + key, () => (day
    ? api('PUT', 'days/' + key, { meals: day.meals, notes: day.notes })
    : api('DELETE', 'days/' + key)))
    .then(() => { if (pendingNotes.get(key) === (day ? day.notes : '')) pendingNotes.delete(key); });
}

// A week's grocery checklist, keyed by the week's Monday: which items are checked off, plus
// items added by hand.
function persistGroceries(week) {
  const list = state.groceries[week];
  queueWrite('groceries/' + week, () => (list
    ? api('PUT', 'groceries/' + week, list)
    : api('DELETE', 'groceries/' + week)));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---------- Dates ----------

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfWeek(d) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7)); // weeks start Monday
  return copy;
}
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }

const fmtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
let weekStart = startOfWeek(new Date());

function getDay(key) {
  const d = state.days[key];
  return d ? { meals: [...d.meals], notes: d.notes || '' } : { meals: [], notes: '' };
}
function setDay(key, day) {
  if (day.meals.length === 0 && !day.notes.trim()) delete state.days[key];
  else state.days[key] = day;
  persistDay(key);
}

// ---------- DOM helpers ----------

const $ = (sel) => document.querySelector(sel);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const findRecipe = (id) => state.recipes.find((r) => r.id === id);
const byName = (a, b) => a.name.localeCompare(b.name);

function setSync(ok, text) {
  const s = $('#sync');
  s.className = 'sync' + (ok ? ' ok' : '');
  s.textContent = text;
}

// ---------- Tabs & dialogs ----------

let currentView = 'plan';
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
function showView(name) {
  currentView = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#plan-view').hidden = name !== 'plan';
  $('#recipes-view').hidden = name !== 'recipes';
  $('#groceries-view').hidden = name !== 'groceries';
  renderAll();
}
function renderAll() { renderWeek(); renderRecipes(); renderGroceries(); }
document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- Weekly plan ----------

function renderWeek() {
  // Data arriving mid-drag would pull the card out from under the pointer; render once the drop finishes.
  if (drag && drag.active) { drag.renderAfter = true; return; }
  // Keep focus and cursor in a notes box that is being typed in when data arrives from another device.
  const active = document.activeElement;
  const focusKey = active && active.dataset && active.dataset.notesKey;
  const sel = focusKey ? [active.selectionStart, active.selectionEnd] : null;

  const grid = $('#week-grid');
  const todayKey = dateKey(new Date());
  const end = addDays(weekStart, 6);
  const label = `${fmtShort.format(weekStart)} – ${fmtShort.format(end)}, ${end.getFullYear()}`;
  document.querySelectorAll('.week-label').forEach((h) => { h.textContent = label; });

  const cards = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const key = dateKey(date);
    const day = getDay(key);
    const isToday = key === todayKey;

    const meals = el('ul', { class: 'meals' }, day.meals.map((meal) => {
      const recipe = meal.recipeId ? findRecipe(meal.recipeId) : null;
      const label = recipe ? recipe.name : meal.text || '(deleted recipe)';
      const li = el('li', { class: 'meal', title: 'Drag to another day' },
        el('span', { class: 'grip', 'aria-hidden': 'true' }, icon(GRIP_SVG)),
        el('span', { class: 'slot' }, meal.slot),
        el('button', { class: 'name' + (recipe ? ' linked' : ''), title: recipe ? 'View recipe' : 'Edit meal',
          onclick: () => (recipe ? openRecipeViewer(recipe.id) : openMealEditor(key, meal.id)) }, label),
        el('button', { class: 'icon-btn edit', title: 'Edit meal', 'aria-label': `Edit ${label}`,
          onclick: () => openMealEditor(key, meal.id) }, icon(PENCIL_SVG)),
        el('button', { class: 'icon-btn remove', title: 'Remove', 'aria-label': `Remove ${label}`,
          onclick: () => {
            const d = getDay(key);
            d.meals = d.meals.filter((m) => m.id !== meal.id);
            setDay(key, d);
            renderWeek();
          } }, '×'));
      li.addEventListener('pointerdown', (e) => beginDrag(e, li, key, meal.id));
      return li;
    }));

    const notes = el('textarea', {
      id: 'notes-' + key,
      placeholder: 'Notes for the day: prep, shopping, who’s home…',
      value: day.notes,
      oninput: (e) => {
        const d = getDay(key);
        d.notes = e.target.value;
        pendingNotes.set(key, d.notes);
        if (d.meals.length === 0 && !d.notes.trim()) delete state.days[key]; else state.days[key] = d;
        clearTimeout(noteTimers.get(key));
        noteTimers.set(key, setTimeout(() => persistDay(key), 600));
      },
    });
    notes.dataset.notesKey = key;

    cards.push(el('article', { class: 'day' + (isToday ? ' today' : ''), 'data-day': key },
      el('div', { class: 'day-head' },
        el('h3', {}, fmtWeekday.format(date), isToday && el('span', { class: 'today-pill' }, 'Today')),
        el('span', { class: 'date' }, fmtShort.format(date))),
      meals,
      el('button', { class: 'add-meal', onclick: () => openAddDialog(key, date) }, '+ Add meal'),
      notes));
  }
  grid.replaceChildren(...cards);

  if (focusKey) {
    const t = document.getElementById('notes-' + focusKey);
    if (t) { t.focus(); try { t.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
  }
}

// Week navigation (shared by the Plan and Groceries tabs): -1 previous, 0 this week, 1 next.
document.querySelectorAll('[data-week]').forEach((btn) => btn.addEventListener('click', () => {
  const step = Number(btn.dataset.week);
  weekStart = step === 0 ? startOfWeek(new Date()) : addDays(weekStart, step * 7);
  renderWeek();
  renderGroceries();
}));

// ---------- Icons ----------

const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 12 18" fill="currentColor"><circle cx="3.5" cy="3.5" r="1.5"/><circle cx="8.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="9" r="1.5"/><circle cx="8.5" cy="9" r="1.5"/><circle cx="3.5" cy="14.5" r="1.5"/><circle cx="8.5" cy="14.5" r="1.5"/></svg>';
function icon(svg) {
  const t = document.createElement('template');
  t.innerHTML = svg; // constant markup above, never user text
  return t.content.firstChild;
}

// ---------- Moving & editing a planned meal ----------

function sortMeals(meals) { meals.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot)); }

// Replace a meal (optionally with changed fields) and move it to another day if toKey differs.
function relocateMeal(fromKey, mealId, toKey, replacement) {
  const from = getDay(fromKey);
  const meal = from.meals.find((m) => m.id === mealId);
  if (!meal) return;
  const updated = replacement || meal;
  if (fromKey === toKey) {
    from.meals = from.meals.map((m) => (m.id === mealId ? updated : m));
    sortMeals(from.meals);
    setDay(fromKey, from);
    return;
  }
  from.meals = from.meals.filter((m) => m.id !== mealId);
  setDay(fromKey, from);
  const to = getDay(toKey);
  to.meals.push(updated);
  sortMeals(to.meals);
  setDay(toKey, to);
}

let editMeal = null;
function openMealEditor(key, mealId) {
  const meal = getDay(key).meals.find((m) => m.id === mealId);
  if (!meal) return;
  editMeal = { key, mealId };
  $('#em-slot').value = SLOTS.includes(meal.slot) ? meal.slot : 'Dinner';
  $('#em-date').value = key;
  const sel = $('#em-recipe');
  sel.replaceChildren(
    el('option', { value: '' }, 'No saved recipe (type it below)'),
    ...[...state.recipes].sort(byName).map((r) => el('option', { value: r.id }, r.name)));
  sel.value = meal.recipeId && findRecipe(meal.recipeId) ? meal.recipeId : '';
  $('#em-text').value = meal.text || '';
  syncMealEditorText();
  $('#edit-meal-dialog').showModal();
}
function syncMealEditorText() { $('#em-text-label').hidden = Boolean($('#em-recipe').value); }
$('#em-recipe').addEventListener('change', syncMealEditorText);

$('#edit-meal-form').addEventListener('submit', (e) => {
  const recipeId = $('#em-recipe').value;
  const text = $('#em-text').value.trim();
  const toKey = $('#em-date').value;
  if (!recipeId && !text) { e.preventDefault(); $('#em-text').focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toKey)) { e.preventDefault(); $('#em-date').focus(); return; }
  const updated = { id: editMeal.mealId, slot: $('#em-slot').value };
  if (recipeId) updated.recipeId = recipeId; else updated.text = text;
  relocateMeal(editMeal.key, editMeal.mealId, toKey, updated);
  renderWeek();
});

$('#em-remove').addEventListener('click', () => {
  const d = getDay(editMeal.key);
  d.meals = d.meals.filter((m) => m.id !== editMeal.mealId);
  setDay(editMeal.key, d);
  $('#edit-meal-dialog').close();
  renderWeek();
});

// ---------- Drag a meal to another day ----------
// Pointer events rather than HTML5 drag-and-drop so it also works on phones. With a mouse the whole
// chip drags; on touch only the grip does, so the page can still scroll.

let drag = null;
let suppressClick = false;

function beginDrag(e, li, fromKey, mealId) {
  if (e.button !== 0 || drag) return;
  const onGrip = Boolean(e.target.closest('.grip'));
  if (!onGrip && (e.pointerType !== 'mouse' || e.target.closest('.icon-btn'))) return;
  if (onGrip) e.preventDefault();
  drag = { li, fromKey, mealId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, target: null };
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('keydown', onDragKey);
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
    const rect = drag.li.getBoundingClientRect();
    drag.active = true;
    drag.offX = drag.startX - rect.left;
    drag.offY = drag.startY - rect.top;
    drag.ghost = drag.li.cloneNode(true);
    drag.ghost.classList.add('drag-ghost');
    drag.ghost.style.width = rect.width + 'px';
    document.body.append(drag.ghost);
    drag.li.classList.add('dragging-source');
    document.body.classList.add('is-dragging');
  }
  e.preventDefault();
  drag.ghost.style.left = (e.clientX - drag.offX) + 'px';
  drag.ghost.style.top = (e.clientY - drag.offY) + 'px';
  if (e.clientY < 70) window.scrollBy(0, -14);
  else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const dayEl = under ? under.closest('[data-day]') : null;
  if (dayEl !== drag.target) {
    if (drag.target) drag.target.classList.remove('drop-target');
    if (dayEl) dayEl.classList.add('drop-target');
    drag.target = dayEl;
  }
}

function endDrag() {
  const d = drag;
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', cancelDrag);
  window.removeEventListener('keydown', onDragKey);
  if (d && d.active) {
    d.ghost.remove();
    d.li.classList.remove('dragging-source');
    if (d.target) d.target.classList.remove('drop-target');
    document.body.classList.remove('is-dragging');
    // The click that ends a drag fires in the same task as pointerup; clear the flag right after.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  return d;
}

function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = endDrag();
  if (!d.active) return;
  if (d.target && d.target.dataset.day !== d.fromKey) relocateMeal(d.fromKey, d.mealId, d.target.dataset.day);
  renderWeek();
}
function cancelDrag() {
  const d = endDrag();
  if (d && d.active) renderWeek();
}
function onDragKey(e) { if (e.key === 'Escape') cancelDrag(); }

// A drag ends with a click on whatever is under the pointer; don't treat it as a click.
document.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
}, true);

// ---------- Add meal ----------

const SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const slotOrder = (s) => (SLOTS.indexOf(s) + 1 || SLOTS.length + 1);
let addTargetKey = null;

function openAddDialog(key, date) {
  addTargetKey = key;
  $('#add-form').reset();
  $('#add-slot').value = 'Dinner';
  $('#add-dialog-title').textContent = `Add to ${fmtLong.format(date)}`;
  renderAddOptions();
  $('#add-dialog').showModal();
  $('#add-search').focus();
}
function renderAddOptions() {
  const q = $('#add-search').value.trim().toLowerCase();
  const list = $('#add-recipe-options');
  if (state.recipes.length === 0) {
    list.replaceChildren(el('p', { class: 'empty' }, 'No saved recipes yet. Add some in the Recipes tab.'));
    return;
  }
  const matches = state.recipes
    .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.tags || []).some((t) => t.toLowerCase().includes(q)))
    .sort(byName);
  list.replaceChildren(...(matches.length ? matches.map((r) =>
    el('label', {}, el('input', { type: 'checkbox', name: 'recipe', value: r.id }), el('span', {}, r.name)))
    : [el('p', { class: 'empty' }, 'No matching recipes.')]));
}
$('#add-search').addEventListener('input', renderAddOptions);

$('#add-form').addEventListener('submit', (e) => {
  const slot = $('#add-slot').value;
  const picked = [...document.querySelectorAll('#add-recipe-options input:checked')].map((i) => i.value);
  const freeText = $('#add-free').value.trim();
  if (!picked.length && !freeText) { e.preventDefault(); $('#add-free').focus(); return; }
  const day = getDay(addTargetKey);
  for (const recipeId of picked) day.meals.push({ id: uid(), slot, recipeId });
  if (freeText) day.meals.push({ id: uid(), slot, text: freeText });
  day.meals.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
  setDay(addTargetKey, day);
  renderWeek();
});

// ---------- Recipes ----------

function renderRecipes() {
  const q = $('#recipe-search').value.trim().toLowerCase();
  const matches = state.recipes.filter((r) => !q ||
    [r.name, r.notes, (r.tags || []).join(' '), (r.ingredients || []).join(' ')].join(' ').toLowerCase().includes(q)
  ).sort(byName);
  const list = $('#recipe-list');
  if (!matches.length) {
    list.replaceChildren(el('p', { class: 'empty' }, state.recipes.length
      ? 'No recipes match your search.' : 'No recipes yet. Click “+ New recipe” to add your first one.'));
    return;
  }
  list.replaceChildren(...matches.map((r) => {
    const meta = [r.time, r.servings && `serves ${r.servings}`, r.ingredients && r.ingredients.length && `${r.ingredients.length} ingredients`]
      .filter(Boolean).join(' · ');
    return el('button', { class: 'recipe-card', onclick: () => openRecipeViewer(r.id) },
      el('h3', {}, r.name),
      meta && el('span', { class: 'muted small' }, meta),
      (r.tags || []).length > 0 && el('div', { class: 'tags' }, r.tags.map((t) => el('span', { class: 'tag' }, t))));
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
  const del = $('#delete-recipe-btn');
  del.hidden = !r; del.classList.remove('armed'); del.textContent = 'Delete';
  resetImportBox();
  if (r) {
    $('#f-name').value = r.name;
    $('#f-servings').value = r.servings || '';
    $('#f-time').value = r.time || '';
    $('#f-url').value = r.url || '';
    $('#f-tags').value = (r.tags || []).join(', ');
    $('#f-ingredients').value = (r.ingredients || []).join('\n');
    $('#f-instructions').value = r.instructions || '';
    $('#f-notes').value = r.notes || '';
  }
  $('#recipe-dialog').showModal();
  $('#f-name').focus();
}

$('#recipe-form').addEventListener('submit', (e) => {
  const data = {
    name: $('#f-name').value.trim(),
    servings: $('#f-servings').value ? Number($('#f-servings').value) : null,
    time: $('#f-time').value.trim(),
    url: $('#f-url').value.trim(),
    tags: $('#f-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    ingredients: $('#f-ingredients').value.split('\n').map((s) => s.trim()).filter(Boolean),
    instructions: $('#f-instructions').value.trim(),
    notes: $('#f-notes').value.trim(),
  };
  if (!data.name) { e.preventDefault(); return; }
  let recipe = editingId && findRecipe(editingId);
  if (recipe) Object.assign(recipe, data);
  else { recipe = { id: uid(), ...data }; state.recipes.push(recipe); }
  persistRecipe(recipe);
  renderAll();
});

$('#delete-recipe-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to delete';
    return;
  }
  const id = editingId;
  state.recipes = state.recipes.filter((r) => r.id !== id);
  removeRecipeDoc(id);
  for (const key of Object.keys(state.days)) {
    const day = getDay(key);
    const kept = day.meals.filter((m) => m.recipeId !== id);
    if (kept.length !== day.meals.length) { day.meals = kept; setDay(key, day); }
  }
  $('#recipe-dialog').close();
  renderAll();
});

// ---------- Import a recipe from a link or pasted text ----------

let importBusy = false;

function setImportStatus(text, kind = '') {
  const s = $('#imp-status');
  s.textContent = text;
  s.className = 'small' + (kind ? ' ' + kind : '');
}

function resetImportBox() {
  $('#imp-text').value = '';
  $('#imp-paste').hidden = true;
  $('#imp-paste-toggle').hidden = false;
  setImportStatus('');
}

function showPasteBox() {
  $('#imp-paste').hidden = false;
  $('#imp-paste-toggle').hidden = true;
}
$('#imp-paste-toggle').addEventListener('click', () => { showPasteBox(); $('#imp-text').focus(); });

async function importFromLink() {
  const url = $('#f-url').value.trim();
  if (!url) { setImportStatus('Paste a recipe link first.', 'error'); $('#f-url').focus(); return; }
  if (importBusy) return;
  importBusy = true;
  const btn = $('#imp-link-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  setImportStatus('Reading the recipe from that page…');
  try {
    const recipe = await api('POST', 'import', { url });
    const n = fillRecipeForm(recipe);
    setImportStatus(`Filled in ${n} ingredients and the steps. Check them, then save.`, 'ok');
  } catch (err) {
    if (err.status === 401) return;
    setImportStatus(err.message, 'error');
    if (err.status >= 400 && err.status !== 400) showPasteBox();
  } finally {
    importBusy = false;
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}
$('#imp-link-btn').addEventListener('click', importFromLink);
// Enter in the link box imports instead of submitting the form.
$('#f-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); importFromLink(); }
});

$('#imp-text-btn').addEventListener('click', () => {
  const text = $('#imp-text').value.trim();
  if (!text) { setImportStatus('Paste the recipe text into the box first.', 'error'); $('#imp-text').focus(); return; }
  const parsed = parseRecipeText(text, $('#f-url').value.trim());
  if (!parsed) {
    setImportStatus('Couldn’t find “Ingredients” and “Preparation” (or “Instructions”) headings in that text. Copy the whole recipe, including those headings.', 'error');
    return;
  }
  const n = fillRecipeForm(parsed);
  setImportStatus(`Filled in ${n} ingredients and the steps. Check them, then save.`, 'ok');
});

function fillRecipeForm(r) {
  const setIfEmpty = (sel, value) => { if (value && !$(sel).value.trim()) { $(sel).value = value; flash(sel); } };
  const setAlways = (sel, value) => { if (value) { $(sel).value = value; flash(sel); } };
  setIfEmpty('#f-name', String(r.name || '').trim());
  setIfEmpty('#f-servings', Number(r.servings) > 0 ? String(Math.round(Number(r.servings))) : '');
  setIfEmpty('#f-time', String(r.time || '').trim());
  const tags = Array.isArray(r.tags) ? r.tags.map(String).filter(Boolean).slice(0, 3) : [];
  setIfEmpty('#f-tags', tags.join(', '));
  const ingredients = Array.isArray(r.ingredients) ? r.ingredients.map((i) => String(i).trim()).filter(Boolean) : [];
  setAlways('#f-ingredients', ingredients.join('\n'));
  setAlways('#f-instructions', String(r.instructions || '').trim());
  return ingredients.length;
}
function flash(sel) {
  const node = $(sel);
  node.classList.remove('just-filled');
  void node.offsetWidth;
  node.classList.add('just-filled');
}

let viewingId = null;
function openRecipeViewer(id) {
  const r = findRecipe(id);
  if (!r) return;
  viewingId = id;
  const meta = [r.time, r.servings && `Serves ${r.servings}`].filter(Boolean).join(' · ');
  const ingredients = r.ingredients || [];
  $('#view-content').replaceChildren(
    el('h2', {}, r.name),
    meta && el('p', { class: 'muted' }, meta),
    (r.tags || []).length > 0 && el('div', { class: 'tags' }, r.tags.map((t) => el('span', { class: 'tag' }, t))),
    r.url && el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the original recipe ↗'),
    ingredients.length > 0 && el('h3', {}, 'Ingredients'),
    ingredients.length > 0 && el('ul', {}, ingredients.map((i) => el('li', {}, i))),
    r.instructions && el('h3', {}, 'Instructions'),
    r.instructions && el('p', { class: 'pre' }, r.instructions),
    r.notes && el('h3', {}, 'Notes'),
    r.notes && el('p', { class: 'pre' }, r.notes));
  $('#view-dialog').showModal();
}
$('#view-edit-btn').addEventListener('click', () => { $('#view-dialog').close(); openRecipeEditor(viewingId); });

// ---------- Grocery list ----------
// Built from the ingredients of every saved recipe planned for the week shown, plus items added
// by hand. Identical ingredient lines are merged and counted.

const groceryKey = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');

function getGroceries(week) {
  const g = state.groceries[week];
  return { checked: g ? [...g.checked] : [], extras: g ? [...g.extras] : [] };
}
function setGroceries(week, list) {
  if (!list.checked.length && !list.extras.length) delete state.groceries[week];
  else state.groceries[week] = list;
  persistGroceries(week);
}

function buildGroceryItems(week) {
  const items = new Map();
  for (let i = 0; i < 7; i++) {
    for (const meal of getDay(dateKey(addDays(weekStart, i))).meals) {
      const recipe = meal.recipeId && findRecipe(meal.recipeId);
      if (!recipe) continue;
      for (const line of recipe.ingredients || []) {
        const key = groceryKey(line);
        if (!key) continue;
        const item = items.get(key) || { key, label: line.trim(), n: 0, sources: [] };
        item.n++;
        if (!item.sources.includes(recipe.name)) item.sources.push(recipe.name);
        items.set(key, item);
      }
    }
  }
  const list = [...items.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const x of getGroceries(week).extras) list.push({ key: 'extra:' + x.id, label: x.text, n: 1, sources: [], extraId: x.id });
  return list;
}

function renderGroceries() {
  const week = dateKey(weekStart);
  const items = buildGroceryItems(week);
  const checked = new Set(getGroceries(week).checked);
  const todo = items.filter((i) => !checked.has(i.key));
  const done = items.filter((i) => checked.has(i.key));
  const recipeCount = new Set(items.flatMap((i) => i.sources)).size;

  $('#grocery-summary').textContent = items.length
    ? `${todo.length} to buy · ${done.length} checked off` + (recipeCount ? ` · from ${recipeCount} recipe${recipeCount > 1 ? 's' : ''} planned this week` : '')
    : '';
  const empty = $('#grocery-empty');
  empty.hidden = items.length > 0;
  empty.textContent = 'Nothing to buy yet. Plan saved recipes that have ingredients for this week, or add items above.';
  if (items.length && !todo.length) { empty.hidden = false; empty.textContent = 'All done. Everything is checked off.'; }

  $('#grocery-todo').replaceChildren(...todo.map((i) => groceryRow(week, i, false)));
  $('#grocery-done').replaceChildren(...done.map((i) => groceryRow(week, i, true)));
  $('#grocery-done-wrap').hidden = done.length === 0;
  $('#grocery-done-title').textContent = `Checked off (${done.length})`;
}

function groceryRow(week, item, isChecked) {
  const source = item.extraId ? 'Added by you' : `for ${item.sources.join(', ')}`;
  return el('li', {},
    el('label', {},
      el('input', { type: 'checkbox', checked: isChecked, onchange: (e) => toggleGrocery(week, item.key, e.target.checked) }),
      el('span', { class: 'item' },
        el('span', { class: 'name' }, item.label, item.n > 1 && el('span', { class: 'count' }, ` ×${item.n}`)),
        el('span', { class: 'source' }, source))),
    item.extraId && el('button', { class: 'remove', title: 'Remove item', 'aria-label': `Remove ${item.label}`,
      onclick: () => removeExtra(week, item.extraId) }, '×'));
}

function toggleGrocery(week, key, on) {
  const list = getGroceries(week);
  list.checked = list.checked.filter((k) => k !== key);
  if (on) list.checked.push(key);
  setGroceries(week, list);
  renderGroceries();
}

function removeExtra(week, id) {
  const list = getGroceries(week);
  list.extras = list.extras.filter((x) => x.id !== id);
  list.checked = list.checked.filter((k) => k !== 'extra:' + id);
  setGroceries(week, list);
  renderGroceries();
}

$('#grocery-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#grocery-add-text');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const week = dateKey(weekStart);
  const list = getGroceries(week);
  list.extras.push({ id: uid(), text });
  setGroceries(week, list);
  input.value = '';
  input.focus();
  renderGroceries();
});

$('#grocery-uncheck-all').addEventListener('click', () => {
  const week = dateKey(weekStart);
  const list = getGroceries(week);
  list.checked = [];
  setGroceries(week, list);
  renderGroceries();
});

$('#grocery-btn').addEventListener('click', () => showView('groceries'));

// Copies what's still left to buy.
$('#copy-grocery-btn').addEventListener('click', () => {
  const week = dateKey(weekStart);
  const checked = new Set(getGroceries(week).checked);
  const text = buildGroceryItems(week).filter((i) => !checked.has(i.key))
    .map((i) => `- ${i.label}${i.n > 1 ? ` (×${i.n})` : ''}`).join('\n');
  const btn = $('#copy-grocery-btn');
  const fallback = () => {
    const t = $('#grocery-text');
    t.value = text; t.hidden = false; t.focus(); t.select();
    btn.textContent = 'Selected: press Ctrl/⌘+C';
  };
  try {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy list'; }, 1500);
    }, fallback);
  } catch (err) { fallback(); }
});

// ---------- Backup & restore ----------

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `meal-planner-backup-${dateKey(new Date())}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

let restoreData = null;
$('#restore-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.recipes) || !data.days || typeof data.days !== 'object') throw new Error();
    restoreData = data;
    $('#restore-summary').textContent =
      `${file.name} has ${data.recipes.length} recipes and ${Object.keys(data.days).length} planned days.`;
    $('#restore-dialog').showModal();
  } catch {
    setSync(false, 'That file isn’t a meal planner backup.');
  }
});
$('#restore-confirm').addEventListener('click', async () => {
  $('#restore-dialog').close();
  try {
    await api('POST', 'restore', restoreData);
    await refresh(true);
    setSync(true, 'Backup restored');
  } catch (err) {
    if (err.status !== 401) setSync(false, err.message);
  }
});

// ---------- Passcode ----------

function showLock(message = '') {
  $('#lock-view').hidden = false;
  $('#lock-error').textContent = message;
  for (const id of ['#tabs', '#sync', '#header-actions', '#plan-view', '#recipes-view', '#groceries-view']) $(id).hidden = true;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#passcode').value = '';
  $('#passcode').focus();
}

function showApp() {
  $('#lock-view').hidden = true;
  for (const id of ['#tabs', '#sync', '#header-actions']) $(id).hidden = false;
  showView(currentView);
}

$('#lock-view').addEventListener('submit', async (e) => {
  e.preventDefault();
  storePasscode($('#passcode').value);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  await start();
  btn.disabled = false;
});

$('#lock-btn').addEventListener('click', () => {
  storePasscode('');
  state.recipes = [];
  state.days = {};
  state.groceries = {};
  lastStateJson = '';
  showLock();
});

// ---------- Start & sync ----------

function applyState(data) {
  const json = JSON.stringify(data);
  if (json === lastStateJson) return;
  lastStateJson = json;
  state.recipes = data.recipes || [];
  const days = {};
  for (const [key, d] of Object.entries(data.days || {})) days[key] = { meals: [...(d.meals || [])], notes: d.notes || '' };
  // Typing that hasn't been saved yet wins over what the server last had.
  for (const [key, notes] of pendingNotes) {
    if (days[key]) days[key].notes = notes;
    else if (notes.trim()) days[key] = { meals: [], notes };
  }
  state.days = days;
  state.groceries = {};
  for (const [week, g] of Object.entries(data.groceries || {})) {
    state.groceries[week] = { checked: [...(g.checked || [])], extras: [...(g.extras || [])] };
  }
  renderAll();
}

// Pick up changes made on other devices. Skipped while this device has unsaved changes.
async function refresh(force = false) {
  if (!passcode || (!force && (pendingWrites > 0 || document.hidden))) return;
  try {
    applyState(await api('GET', 'state'));
  } catch (err) {
    if (err.status !== 401 && force) throw err;
  }
}

let syncTimer = null;
async function start() {
  if (!passcode) { showLock(); return; }
  try {
    applyState(await api('GET', 'state'));
  } catch (err) {
    if (err.status !== 401) showLock(err.message);
    return;
  }
  showApp();
  setSync(true, 'All changes saved');
  if (!syncTimer) {
    syncTimer = setInterval(() => refresh(), 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
}
start();
