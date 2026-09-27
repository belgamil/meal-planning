# Meal Planner

A simple weekly meal planner. Save your recipes, put them on each day of the week, and write notes for each day about what you want to cook.

## Features

- **Weekly plan**: Monday–Sunday cards. Use the arrows to move between weeks, and today is highlighted.
- **Meals per day**: add saved recipes (or just type something like "Leftovers") as Breakfast, Lunch, Dinner or Snack.
- **Daily notes**: free-form notes on each day (prep reminders, who's home, etc.). They save automatically as you type.
- **Recipe library**: name, servings, time, link, tags, ingredients, instructions and notes, with search.
- **Grocery list**: combines the ingredients from every recipe planned for the week, with checkboxes and a copy button.
- **Backup**: export all your data to a JSON file and import it again, for example on another device.

## Running it

There's no build step and nothing to install. Open `index.html` in a browser.

To use it from any device, turn on **GitHub Pages** for this repo (Settings → Pages → deploy from the `main` branch).

## Data

Everything is stored in your browser's `localStorage`, so data stays on the device and browser you use. Use **Export** now and then to keep a backup, or to move your data to another device.
