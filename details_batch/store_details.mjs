import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import gplay from 'google-play-scraper';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';

const require = createRequire(import.meta.url);
const astore = require('app-store-scraper');
const INPUT = process.env.INPUT_CSV || 'review_artifact/review_mining_all_apps.csv';
const OUT = process.env.OUT_DIR || 'output_details';
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
fs.mkdirSync(OUT, { recursive: true });

const apps = parse(fs.readFileSync(INPUT, 'utf8'), { columns: true, skip_empty_lines: true, bom: true });
const locales = [
  { country: 'de', lang: 'de' },
  { country: 'us', lang: 'en' }
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retry(fn, attempts = 3) {
  let last;
  for (let n = 0; n < attempts; n++) {
    try { return await fn(); }
    catch (err) { last = err; await sleep(600 * (2 ** n) + Math.floor(Math.random() * 400)); }
  }
  throw last;
}

const rows = [];
const errors = [];
const limit = pLimit(CONCURRENCY);
const tasks = [];
for (const app of apps) {
  for (const locale of locales) {
    if (app.google_app_id) tasks.push({ store: 'google_play', app, locale });
    if (app.apple_app_id) tasks.push({ store: 'apple_app_store', app, locale });
  }
}

async function fetchTask(task) {
  const { store, app, locale } = task;
  try {
    let x;
    if (store === 'google_play') {
      x = await retry(() => gplay.app({ appId: app.google_app_id, country: locale.country, lang: locale.lang }));
      rows.push({
        app_name: app.app_name, store, country: locale.country, requested_id: app.google_app_id,
        resolved_id: x.appId || app.google_app_id, title: x.title || '', developer: x.developer || '',
        score: x.score ?? '', ratings: x.ratings ?? '', reviews_total: x.reviews ?? '',
        installs_text: x.installs || '', min_installs: x.minInstalls ?? '', max_installs: x.maxInstalls ?? '',
        price: x.price ?? '', currency: x.currency || '', price_text: x.priceText || '', free: x.free ?? '',
        offers_iap: x.offersIAP ?? '', iap_range: x.IAPRange || '', ad_supported: x.adSupported ?? '',
        genre: x.genre || '', genre_id: x.genreId || '', content_rating: x.contentRating || '',
        released: x.released || '', updated: x.updated ? new Date(x.updated).toISOString() : '', version: x.version || '',
        recent_changes: String(x.recentChanges || '').slice(0, 800), summary: String(x.summary || '').slice(0, 500),
        url: x.url || '', available: true
      });
    } else {
      x = await retry(() => astore.app({ id: Number(app.apple_app_id), country: locale.country, ratings: true }));
      rows.push({
        app_name: app.app_name, store, country: locale.country, requested_id: app.apple_app_id,
        resolved_id: String(x.id || app.apple_app_id), title: x.title || '', developer: x.developer || '',
        score: x.score ?? '', ratings: x.ratings ?? x.reviews ?? '', reviews_total: x.reviews ?? '',
        installs_text: '', min_installs: '', max_installs: '',
        price: x.price ?? '', currency: x.currency || '', price_text: x.priceText || '', free: x.free ?? '',
        offers_iap: '', iap_range: '', ad_supported: '', genre: x.primaryGenre || (x.genres || []).join('; '),
        genre_id: x.primaryGenreId || '', content_rating: x.contentRating || '', released: x.released || '',
        updated: x.updated || '', version: x.version || '', recent_changes: String(x.releaseNotes || '').slice(0, 800),
        summary: String(x.description || '').slice(0, 500), url: x.url || '', available: true
      });
    }
  } catch (err) {
    errors.push({ app_name: app.app_name, store, country: locale.country, requested_id: store === 'google_play' ? app.google_app_id : app.apple_app_id, error: String(err?.message || err) });
  }
}

await Promise.all(tasks.map((task) => limit(() => fetchTask(task))));
rows.sort((a,b) => a.app_name.localeCompare(b.app_name) || a.store.localeCompare(b.store) || a.country.localeCompare(b.country));
const cols = ['app_name','store','country','requested_id','resolved_id','title','developer','score','ratings','reviews_total','installs_text','min_installs','max_installs','price','currency','price_text','free','offers_iap','iap_range','ad_supported','genre','genre_id','content_rating','released','updated','version','recent_changes','summary','url','available'];
fs.writeFileSync(path.join(OUT,'store_app_details.csv'), stringify(rows,{header:true,columns:cols}));
fs.writeFileSync(path.join(OUT,'store_app_details.jsonl'), rows.map((x)=>JSON.stringify(x)).join('\n')+'\n');
fs.writeFileSync(path.join(OUT,'store_app_detail_errors.csv'), stringify(errors,{header:true}));
fs.writeFileSync(path.join(OUT,'store_app_detail_summary.json'), JSON.stringify({ apps: apps.length, tasks: tasks.length, successful: rows.length, failed: errors.length, google_rows: rows.filter(x=>x.store==='google_play').length, apple_rows: rows.filter(x=>x.store==='apple_app_store').length },null,2));
console.log(JSON.stringify({ tasks: tasks.length, rows: rows.length, errors: errors.length }));
