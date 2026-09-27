import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecipeFromHtml, formatDuration, decodeEntities } from '../src/recipe-import.js';
import { parseRecipeText, titleFromUrl } from '../public/recipe-text.js';

// Shaped like a WordPress site using a recipe-card plugin: the Recipe sits inside an @graph,
// with HTML entities and grouped (HowToSection) steps.
const wordpressPage = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Mediterranean Baked Fish"},
  {"@type":"Recipe","name":"Mediterranean Baked Fish with Tomatoes &amp; Capers",
   "recipeYield":["4","4 servings"],"totalTime":"PT25M",
   "recipeCategory":"Main Course","recipeCuisine":["Mediterranean"],
   "recipeIngredient":["1 &frac12; lb white fish fillet","1 small red onion, chopped","2 tbsp capers","&#8531; cup extra virgin olive oil"],
   "recipeInstructions":[
     {"@type":"HowToSection","name":"Make the sauce","itemListElement":[
       {"@type":"HowToStep","text":"Heat the oil in a pan."},
       {"@type":"HowToStep","text":"Add the onion &amp; cook 3 minutes."}]},
     {"@type":"HowToStep","text":"Bake at 400&deg;F for 15 minutes."}]}
]}</script></head><body><h1>Ignored</h1></body></html>`;

test('reads schema.org Recipe data from an @graph', () => {
  const r = extractRecipeFromHtml(wordpressPage, 'https://www.example.com/baked-fish/');
  assert.equal(r.name, 'Mediterranean Baked Fish with Tomatoes & Capers');
  assert.equal(r.servings, 4);
  assert.equal(r.time, '25 min');
  assert.deepEqual(r.ingredients, [
    '1 ½ lb white fish fillet',
    '1 small red onion, chopped',
    '2 tbsp capers',
    '⅓ cup extra virgin olive oil',
  ]);
  assert.equal(r.instructions, '1. Heat the oil in a pan.\n2. Add the onion & cook 3 minutes.\n3. Bake at 400°F for 15 minutes.');
  assert.deepEqual(r.tags, ['main course', 'mediterranean']);
});

test('handles a top-level array, a string of instructions and a string yield', () => {
  const html = `<script type="application/ld+json">[{"@type":"Organization"},{"@type":["Recipe","NewsArticle"],
    "name":"Weeknight Chili","recipeYield":"Serves 6","cookTime":"PT1H30M",
    "recipeIngredient":["1 lb beans"],"recipeInstructions":"1. Simmer.\\n2. Serve."}]</script>`;
  const r = extractRecipeFromHtml(html, 'https://x.test/chili');
  assert.equal(r.name, 'Weeknight Chili');
  assert.equal(r.servings, 6);
  assert.equal(r.time, '1 hr 30 min');
  assert.equal(r.instructions, '1. Simmer.\n2. Serve.');
});

test('skips broken JSON-LD blocks and keeps looking', () => {
  const html = `<script type="application/ld+json">{ not json</script>
    <script type='application/ld+json'>{"@type":"Recipe","name":"Soup","recipeIngredient":["water"],"recipeInstructions":["Boil."]}</script>`;
  assert.equal(extractRecipeFromHtml(html, '').name, 'Soup');
});

test('falls back to page text when there is no structured data', () => {
  const html = `<html><body><nav>Home</nav><h1>Lemon Pasta</h1><p>By Sam Cook</p>
    <h2>Ingredients</h2><ul><li>8 oz spaghetti</li><li>1 lemon</li></ul>
    <h2>Instructions</h2><ol><li>Boil the pasta.</li><li>Toss with lemon.</li></ol>
    <h2>Notes</h2><p>Great cold.</p></body></html>`;
  const r = extractRecipeFromHtml(html, 'https://x.test/lemon-pasta');
  assert.equal(r.name, 'Lemon Pasta');
  assert.deepEqual(r.ingredients, ['8 oz spaghetti', '1 lemon']);
  assert.equal(r.instructions, '1. Boil the pasta.\n2. Toss with lemon.');
});

test('returns null for a page with no recipe', () => {
  assert.equal(extractRecipeFromHtml('<html><body><p>Hello</p></body></html>', ''), null);
});

test('parses text pasted from an NYT Cooking page', () => {
  const text = `Skip to content\nCrispy Gnocchi With Brussels Sprouts\nBy Ali Slagle\nTotal Time\n25 minutes\nIngredients\nYield:4 servings\n1 package gnocchi\n12 ounces Brussels sprouts\nPreparation\nStep 1\nHeat the oven to 450 degrees.\nStep 2\nRoast until crisp.\nPrivate Notes\nLeave a note`;
  const r = parseRecipeText(text, 'https://cooking.nytimes.com/recipes/1020639-crispy-gnocchi');
  assert.equal(r.name, 'Crispy Gnocchi With Brussels Sprouts');
  assert.equal(r.servings, 4);
  assert.equal(r.time, '25 minutes');
  assert.deepEqual(r.ingredients, ['1 package gnocchi', '12 ounces Brussels sprouts']);
  assert.equal(r.instructions, '1. Heat the oven to 450 degrees.\n2. Roast until crisp.');
});

test('helpers', () => {
  assert.equal(formatDuration('PT45M'), '45 min');
  assert.equal(formatDuration('PT2H'), '2 hr');
  assert.equal(formatDuration('PT90M'), '1 hr 30 min');
  assert.equal(formatDuration('nonsense'), '');
  assert.equal(decodeEntities('Fish &amp; chips &#8211; &#x2019;s'), 'Fish & chips – ’s');
  assert.equal(titleFromUrl('https://www.themediterraneandish.com/mediterranean-baked-fish-recipe-tomato-capers/#jump'),
    'Mediterranean Baked Fish Tomato Capers');
});
