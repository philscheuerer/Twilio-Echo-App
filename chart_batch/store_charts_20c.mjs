import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import gplay from 'google-play-scraper';
import { stringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';

const require = createRequire(import.meta.url);
const astore = require('app-store-scraper');

const OUT = process.env.OUT_DIR || 'output_charts';
const NUM = Number(process.env.CHART_SIZE || 50);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
fs.mkdirSync(OUT, { recursive: true });

const countries = [
  ['us','United States','en'], ['de','Germany','de'], ['in','India','en'],
  ['jp','Japan','ja'], ['br','Brazil','pt'], ['mx','Mexico','es'],
  ['ar','Argentina','es'], ['co','Colombia','es'], ['za','South Africa','en'],
  ['ng','Nigeria','en'], ['sa','Saudi Arabia','ar'], ['ca','Canada','en'],
  ['ae','United Arab Emirates','en'], ['gb','United Kingdom','en'], ['fr','France','fr'],
  ['es','Spain','es'], ['tr','Türkiye','tr'], ['id','Indonesia','id'],
  ['kr','South Korea','ko'], ['au','Australia','en']
];

const categories = [
  ['all_apps', null, gplay.category.APPLICATION, 'apps'],
  ['all_games', astore.category.GAMES, gplay.category.GAME, 'games'],
  ['productivity', astore.category.PRODUCTIVITY, gplay.category.PRODUCTIVITY, 'apps'],
  ['lifestyle', astore.category.LIFESTYLE, gplay.category.LIFESTYLE, 'apps'],
  ['health_fitness', astore.category.HEALTH_AND_FITNESS, gplay.category.HEALTH_AND_FITNESS, 'apps'],
  ['education', astore.category.EDUCATION, gplay.category.EDUCATION, 'apps'],
  ['utilities_tools', astore.category.UTILITIES, gplay.category.TOOLS, 'apps'],
  ['puzzle', astore.category.GAMES_PUZZLE, gplay.category.GAME_PUZZLE, 'games'],
  ['simulation', astore.category.GAMES_SIMULATION, gplay.category.GAME_SIMULATION, 'games'],
  ['card', astore.category.GAMES_CARD, gplay.category.GAME_CARD, 'games'],
  ['casual_family', astore.category.GAMES_FAMILY, gplay.category.GAME_CASUAL, 'games'],
  ['word', astore.category.GAMES_WORD, gplay.category.GAME_WORD, 'games']
];

const collectionDefs = {
  top_free: { apple: astore.collection.TOP_FREE_IOS, google: gplay.collection.TOP_FREE },
  top_paid: { apple: astore.collection.TOP_PAID_IOS, google: gplay.collection.TOP_PAID },
  grossing: { apple: astore.collection.TOP_GROSSING_IOS, google: gplay.collection.GROSSING }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retry(fn, label, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      await sleep(500 * (2 ** i) + Math.floor(Math.random() * 300));
    }
  }
  throw new Error(`${label}: ${last?.message || last}`);
}

const tasks = [];
for (const [country, countryName, lang] of countries) {
  for (const [categoryKey, appleCategory, googleCategory, scope] of categories) {
    const collections = ['top_free'];
    if (categoryKey === 'all_apps' || categoryKey === 'all_games') collections.push('top_paid', 'grossing');
    for (const collectionKey of collections) {
      tasks.push({ store: 'apple_app_store', country, countryName, lang, categoryKey, category: appleCategory, scope, collectionKey });
      tasks.push({ store: 'google_play', country, countryName, lang, categoryKey, category: googleCategory, scope, collectionKey });
    }
  }
}

const rows = [];
const errors = [];
const limit = pLimit(CONCURRENCY);
const startedAt = new Date().toISOString();

async function runTask(task) {
  const c = collectionDefs[task.collectionKey];
  const label = `${task.store}/${task.country}/${task.categoryKey}/${task.collectionKey}`;
  try {
    let apps;
    if (task.store === 'apple_app_store') {
      const options = { collection: c.apple, country: task.country, num: NUM, fullDetail: false };
      if (task.category) options.category = task.category;
      apps = await retry(() => astore.list(options), label);
    } else {
      apps = await retry(() => gplay.list({
        collection: c.google,
        category: task.category,
        country: task.country,
        lang: task.lang,
        num: NUM,
        fullDetail: false
      }), label);
    }
    apps.forEach((app, index) => rows.push({
      snapshot_at_utc: startedAt,
      store: task.store,
      country: task.country,
      country_name: task.countryName,
      category: task.categoryKey,
      scope: task.scope,
      collection: task.collectionKey,
      rank: index + 1,
      app_id: String(app.appId || app.id || ''),
      title: app.title || '',
      developer: app.developer || '',
      score: app.score ?? '',
      price: app.price ?? '',
      price_text: app.priceText || '',
      free: app.free ?? '',
      genre: app.genre || app.primaryGenre || '',
      url: app.url || ''
    }));
  } catch (err) {
    errors.push({ ...task, error: String(err.message || err) });
  }
}

await Promise.all(tasks.map((task) => limit(() => runTask(task))));
rows.sort((a,b) => a.store.localeCompare(b.store) || a.country.localeCompare(b.country) || a.category.localeCompare(b.category) || a.collection.localeCompare(b.collection) || a.rank-b.rank);

const columns = ['snapshot_at_utc','store','country','country_name','category','scope','collection','rank','app_id','title','developer','score','price','price_text','free','genre','url'];
fs.writeFileSync(path.join(OUT, 'store_chart_rows.csv'), stringify(rows, { header: true, columns }));
fs.writeFileSync(path.join(OUT, 'store_chart_rows.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'store_chart_errors.csv'), stringify(errors, { header: true }));
fs.writeFileSync(path.join(OUT, 'store_chart_summary.json'), JSON.stringify({
  snapshot_at_utc: startedAt,
  countries: countries.length,
  categories: categories.length,
  tasks: tasks.length,
  successful_tasks: tasks.length - errors.length,
  failed_tasks: errors.length,
  rows: rows.length,
  chart_size_requested: NUM
}, null, 2));
console.log(JSON.stringify({ tasks: tasks.length, rows: rows.length, errors: errors.length }));
