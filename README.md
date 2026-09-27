# Weeknight Table

A weekly meal planner. Save recipes, import them from a link, plan them onto days, jot notes for each day, drag meals between days, and get a grocery list for the week. Your data syncs across your devices.

It runs as a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) on Cloudflare's free plan:

- `public/` holds the app you see in the browser.
- `src/worker.js` is the API. It saves your recipes and plan, and fetches recipe pages when you import a link.
- Data lives in a Durable Object with a built-in SQLite database (`src/planner-store.js`). No separate database needs to be set up.
- Everything is protected by a passcode that only you know.

## Importing recipes

Paste a recipe link into **Recipe link** and press **Import**. Most recipe sites (for example The Mediterranean Dish, Serious Eats, Bon Appétit and most food blogs) publish the recipe in a standard machine-readable format ([schema.org Recipe](https://schema.org/Recipe)). The importer reads that, and falls back to reading the page text when a site doesn't have it.

Sites behind a login, such as **NYT Cooking**, can't be imported by link. Instead, copy the recipe text from the page and use **Paste the recipe text instead**. Some sites also block automated requests; the app tells you when that happens, and pasting the text works there too.

## Set it up (one time, about 10 minutes)

You need a free Cloudflare account and this GitHub repository.

1. **Create a Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). The free plan is enough.
2. **Connect this repository.** In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**. Connect GitHub when asked, and pick `meal-planning`.
   - Set the production branch to the branch that has this code.
   - Leave the build command empty and keep the deploy command as `npx wrangler deploy`.
   - Click **Deploy**. The first deploy creates the Worker and its database.
3. **Set your passcode.** Open the new `meal-planner` Worker, go to **Settings → Variables and Secrets**, and add:
   - Type: **Secret**
   - Name: `APP_PASSCODE`
   - Value: a passcode you'll remember. It's the only thing protecting your data, so make it long, for example four random words.

   Save and deploy.
4. **Open your planner** at the URL Cloudflare shows (something like `https://meal-planner.<your-name>.workers.dev`), and enter your passcode. Bookmark it, or on a phone use **Share → Add to Home Screen**.
5. **Bring your existing data in (optional).** Click **Restore** and choose a backup file.

From then on, every push to the production branch redeploys automatically.

## Backups

**Back up** downloads everything as a JSON file. **Restore** replaces everything with a backup file, after asking you to confirm.

## Working on the code

```sh
npm install
echo 'APP_PASSCODE="dev-passcode"' > .dev.vars   # local passcode, not committed
npm run dev      # http://localhost:8787
npm test         # recipe import tests
npm run deploy   # deploy from your machine instead of from GitHub
```
