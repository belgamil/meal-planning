// Reads a recipe out of plain text copied from a recipe page, using the usual
// "Ingredients" / "Preparation" (or "Instructions", "Directions", "Method") headings.
// Shared by the browser (pasted text) and the Worker (pages without structured data).

export function parseRecipeText(text, url = '') {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const ingIdx = lines.findIndex((l) => /^ingredients\b/i.test(l));
  const stepIdx = lines.findIndex((l, i) => i > ingIdx && /^(preparation|instructions|directions|method|steps)\b/i.test(l));
  if (ingIdx < 0 || stepIdx < 0) return null;

  const ingredients = lines.slice(ingIdx + 1, stepIdx)
    .filter((l) => !/^(yield|serves|servings)\b/i.test(l))
    .filter((l) => !/^(us customary|metric|1x|2x|3x|cups?|grams?)$/i.test(l));
  const steps = [];
  for (const l of lines.slice(stepIdx + 1)) {
    if (/^(tip|tips|notes?|cooking notes|private notes|nutrition|nutritional|ratings?|comments|video)\b/i.test(l)) break;
    if (/^step \d+:?$/i.test(l)) continue;
    steps.push(l.replace(/^\d+[.)]\s*/, ''));
  }
  if (!ingredients.length && !steps.length) return null;

  // The title usually sits right above the "By <author>" byline; otherwise use the link's slug.
  const byIdx = lines.slice(0, ingIdx).findIndex((l) => /^by\s/i.test(l));
  const title = byIdx > 0 ? lines[byIdx - 1] : titleFromUrl(url);
  const yieldLine = lines.find((l) => /^(yield|serves|servings)\b/i.test(l));
  const servings = yieldLine ? Number((yieldLine.match(/\d+/) || [])[0]) || null : null;
  const timeIdx = lines.findIndex((l) => /^(total time|time)\b/i.test(l));
  const timeLine = timeIdx < 0 ? ''
    : /^(total time|time):?$/i.test(lines[timeIdx]) ? lines[timeIdx + 1] || '' : lines[timeIdx];

  return {
    name: title,
    servings,
    time: timeLine.replace(/^(total time|time)[:\s]*/i, ''),
    ingredients,
    instructions: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    tags: [],
  };
}

export function titleFromUrl(url) {
  let path = '';
  try { path = new URL(url).pathname; } catch { return ''; }
  const slug = path.split('/').filter(Boolean).pop() || '';
  const words = slug.replace(/^\d+-/, '').replace(/\.html?$/, '').split('-').filter(Boolean)
    .filter((w) => w.toLowerCase() !== 'recipe');
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
