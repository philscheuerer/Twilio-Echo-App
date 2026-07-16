import fs from 'node:fs';
import gplay from 'google-play-scraper';
import appstore from 'app-store-scraper';
import pLimit from 'p-limit';
import { stringify } from 'csv-stringify/sync';

const countries = [
  ['de','Germany'],['us','United States'],['ca','Canada'],['in','India'],['jp','Japan'],
  ['br','Brazil'],['mx','Mexico'],['ar','Argentina'],['co','Colombia'],['za','South Africa'],
  ['ng','Nigeria'],['sa','Saudi Arabia'],['ae','United Arab Emirates'],['gb','United Kingdom'],
  ['fr','France'],['es','Spain'],['tr','Turkey'],['id','Indonesia'],['kr','South Korea'],['au','Australia']
];

const categories = [
  {name:'Productivity', google:gplay.category.PRODUCTIVITY, apple:appstore.category.PRODUCTIVITY},
  {name:'Lifestyle', google:gplay.category.LIFESTYLE, apple:appstore.category.LIFESTYLE},
  {name:'Health & Fitness', google:gplay.category.HEALTH_AND_FITNESS, apple:appstore.category.HEALTH_AND_FITNESS},
  {name:'Education', google:gplay.category.EDUCATION, apple:appstore.category.EDUCATION},
  {name:'Utilities / Tools', google:gplay.category.TOOLS, apple:appstore.category.UTILITIES},
  {name:'Games — Casual', google:gplay.category.GAME_CASUAL, apple:appstore.category.GAMES_ARCADE},
  {name:'Games — Puzzle', google:gplay.category.GAME_PUZZLE, apple:appstore.category.GAMES_PUZZLE},
  {name:'Games — Simulation', google:gplay.category.GAME_SIMULATION, apple:appstore.category.GAMES_SIMULATION},
  {name:'Games — Word', google:gplay.category.GAME_WORD, apple:appstore.category.GAMES_WORD},
  {name:'Games — Card', google:gplay.category.GAME_CARD, apple:appstore.category.GAMES_CARD}
];

const overallCollections = [
  {name:'top_free', google:gplay.collection.TOP_FREE, apple:appstore.collection.TOP_FREE_IOS},
  {name:'top_paid', google:gplay.collection.TOP_PAID, apple:appstore.collection.TOP_PAID_IOS},
  {name:'top_grossing', google:gplay.collection.GROSSING, apple:appstore.collection.TOP_GROSSING_IOS}
];

const categoryCollections = [
  {name:'top_free', google:gplay.collection.TOP_FREE, apple:appstore.collection.TOP_FREE_IOS}
];

const rows = [];
const errors = [];
const limit = pLimit(Number(process.env.CONCURRENCY || 4));
const perList = Number(process.env.PER_LIST || 20);
const scrapedAt = new Date().toISOString();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function retry(fn, label, attempts=3) {
  let last;
  for (let i=1; i<=attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i < attempts) await sleep(700 * i);
    }
  }
  throw new Error(`${label}: ${last?.message || last}`);
}

function pushGoogle(apps, country, countryName, category, chart) {
  apps.forEach((a, i) => rows.push({
    scraped_at_utc: scrapedAt,
    store: 'google_play', country, country_name: countryName, category, chart, rank: i+1,
    app_id: a.appId || '', title: a.title || '', developer: a.developer || '',
    rating: a.score ?? '', rating_count: a.ratings ?? a.reviews ?? '',
    price: a.price ?? '', price_text: a.priceText ?? '', free: a.free ?? '',
    url: a.url || (a.appId ? `https://play.google.com/store/apps/details?id=${a.appId}&hl=en&gl=${country}` : '')
  }));
}

function pushApple(apps, country, countryName, category, chart) {
  apps.forEach((a, i) => rows.push({
    scraped_at_utc: scrapedAt,
    store: 'apple_app_store', country, country_name: countryName, category, chart, rank: i+1,
    app_id: String(a.id || a.appId || ''), title: a.title || '', developer: a.developer || '',
    rating: a.score ?? '', rating_count: a.reviews ?? '',
    price: a.price ?? '', price_text: a.price ? `${a.price} ${a.currency || ''}`.trim() : 'Free', free: a.free ?? '',
    url: a.url || ''
  }));
}

async function googleTask(country, countryName, category, categoryId, coll) {
  const label = `google ${country} ${category} ${coll.name}`;
  try {
    const apps = await retry(() => gplay.list({
      category: categoryId || undefined,
      collection: coll.google,
      num: perList,
      country,
      lang: 'en',
      fullDetail: false
    }), label);
    pushGoogle(apps.slice(0, perList), country, countryName, category, coll.name);
  } catch (e) {
    errors.push({store:'google_play', country, category, chart:coll.name, error:e.message});
  }
  await sleep(250);
}

async function appleTask(country, countryName, category, categoryId, coll) {
  const label = `apple ${country} ${category} ${coll.name}`;
  try {
    const apps = await retry(() => appstore.list({
      collection: coll.apple,
      category: categoryId || undefined,
      num: perList,
      country,
      fullDetail: false
    }), label);
    pushApple(apps.slice(0, perList), country, countryName, category, coll.name);
  } catch (e) {
    errors.push({store:'apple_app_store', country, category, chart:coll.name, error:e.message});
  }
  await sleep(250);
}

const tasks = [];
for (const [country, countryName] of countries) {
  for (const coll of overallCollections) {
    tasks.push(limit(() => googleTask(country, countryName, 'Overall', null, coll)));
    tasks.push(limit(() => appleTask(country, countryName, 'Overall', null, coll)));
  }
  for (const cat of categories) {
    for (const coll of categoryCollections) {
      tasks.push(limit(() => googleTask(country, countryName, cat.name, cat.google, coll)));
      tasks.push(limit(() => appleTask(country, countryName, cat.name, cat.apple, coll)));
    }
  }
}

await Promise.all(tasks);
fs.mkdirSync('output', {recursive:true});
rows.sort((a,b) => a.store.localeCompare(b.store) || a.country.localeCompare(b.country) || a.category.localeCompare(b.category) || a.chart.localeCompare(b.chart) || a.rank-b.rank);
fs.writeFileSync('output/country_store_charts.csv', stringify(rows, {header:true}));
fs.writeFileSync('output/chart_errors.csv', stringify(errors, {header:true}));
const summary = {
  scraped_at_utc: scrapedAt,
  countries: countries.length,
  categories: categories.length,
  rows: rows.length,
  errors: errors.length,
  google_rows: rows.filter(r => r.store === 'google_play').length,
  apple_rows: rows.filter(r => r.store === 'apple_app_store').length,
  unique_apps_google: new Set(rows.filter(r=>r.store==='google_play').map(r=>r.app_id)).size,
  unique_apps_apple: new Set(rows.filter(r=>r.store==='apple_app_store').map(r=>r.app_id)).size,
  settings: {per_list: perList, overall_charts: overallCollections.map(x=>x.name), category_charts: categoryCollections.map(x=>x.name)}
};
fs.writeFileSync('output/chart_summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
