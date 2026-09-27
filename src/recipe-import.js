// Turns a recipe web page into the planner's recipe fields.
// Most recipe sites embed schema.org "Recipe" data as JSON-LD for search engines; that is
// read first. Pages without it fall back to reading the page text.

import { parseRecipeText } from '../public/recipe-text.js';

export function extractRecipeFromHtml(html, url) {
  const fromLd = findJsonLdRecipe(html);
  if (fromLd) return normalizeLdRecipe(fromLd);
  return parseRecipeText(htmlToText(html), url);
}

function findJsonLdRecipe(html) {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    let data;
    try {
      data = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const found = searchForRecipe(data);
    if (found) return found;
  }
  return null;
}

function isRecipe(node) {
  const type = node && node['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

function searchForRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchForRecipe(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (isRecipe(node)) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    const found = searchForRecipe(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeLdRecipe(r) {
  const ingredients = toArray(r.recipeIngredient || r.ingredients).map(cleanText).filter(Boolean);
  const steps = flattenInstructions(r.recipeInstructions);
  const tags = [...toArray(r.recipeCategory), ...toArray(r.recipeCuisine)]
    .flatMap((t) => String(t).split(','))
    .map((t) => cleanText(t).toLowerCase())
    .filter((t, i, all) => t && t.length <= 30 && all.indexOf(t) === i)
    .slice(0, 3);
  return {
    name: cleanText(r.name || ''),
    servings: parseServings(r.recipeYield),
    time: formatDuration(r.totalTime) || formatDuration(r.cookTime) || '',
    ingredients,
    instructions: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    tags,
  };
}

// recipeInstructions may be a string, a list of strings, HowToStep objects, or HowToSections
// that group steps.
function flattenInstructions(node) {
  if (!node) return [];
  if (typeof node === 'string') {
    return cleanText(node, true).split('\n').map((s) => s.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
  }
  if (Array.isArray(node)) return node.flatMap(flattenInstructions);
  if (typeof node === 'object') {
    if (node.itemListElement) return flattenInstructions(node.itemListElement);
    return flattenInstructions(node.text || node.name || '');
  }
  return [];
}

function parseServings(yieldValue) {
  for (const y of toArray(yieldValue)) {
    const n = Number((String(y).match(/\d+/) || [])[0]);
    if (n > 0) return n;
  }
  return null;
}

// ISO 8601 durations such as "PT1H15M" -> "1 hr 15 min".
export function formatDuration(value) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i.exec(String(value || '').trim());
  if (!m) return '';
  const days = Number(m[1] || 0);
  let hours = Number(m[2] || 0) + days * 24;
  let minutes = Number(m[3] || 0);
  hours += Math.floor(minutes / 60);
  minutes %= 60;
  const parts = [];
  if (hours) parts.push(`${hours} hr`);
  if (minutes) parts.push(`${minutes} min`);
  return parts.join(' ');
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function cleanText(s, keepLines = false) {
  let text = decodeEntities(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
  text = keepLines
    ? text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
    : text.replace(/\s+/g, ' ');
  return text.trim();
}

export function htmlToText(html) {
  const body = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(br|p|div|li|ul|ol|h[1-6]|tr|table|section|header|footer|nav|article|aside|main)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
