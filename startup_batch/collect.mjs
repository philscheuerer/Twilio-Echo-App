import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { stringify } from 'csv-stringify/sync';

const OUT = path.resolve('output');
fs.mkdirSync(OUT, { recursive: true });
const scrapedAt = new Date().toISOString();

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => clean(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function writeCsv(name, rows) {
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
  fs.writeFileSync(path.join(OUT, name), stringify(rows, { header: true, columns: cols }));
}

function moneyToUsd(currency, value, unit='') {
  let n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = unit.toLowerCase();
  if (u === 'k' || u.includes('thousand')) n *= 1e3;
  if (u === 'm' || u.includes('million') || u === 'mn') n *= 1e6;
  if (u === 'b' || u.includes('billion') || u === 'bn') n *= 1e9;
  const fx = currency === '€' ? 1.17 : currency === '£' ? 1.34 : currency === '₹' ? 0.0117 : currency === 'A$' ? 0.66 : currency === 'C$' ? 0.73 : 1;
  return Math.round(n * fx);
}

function extractMoney(text) {
  const out = [];
  const re = /(A\$|C\$|US\$|USD\s*|EUR\s*|GBP\s*|INR\s*|[$€£₹])\s*([0-9]+(?:[.,][0-9]+)*)\s*(billion|million|thousand|bn|mn|[KMB])?/gi;
  for (const m of String(text || '').matchAll(re)) {
    let cur = m[1].trim();
    if (/USD|US\$|\$/.test(cur)) cur = '$';
    if (/EUR|€/.test(cur)) cur = '€';
    if (/GBP|£/.test(cur)) cur = '£';
    if (/INR|₹/.test(cur)) cur = '₹';
    const usd = moneyToUsd(cur, m[2].replace(',', '.'), m[3] || '');
    if (usd) out.push({ raw: m[0], usd });
  }
  const crore = /(?:Rs\.?|INR|₹)\s*([0-9]+(?:\.[0-9]+)?)\s*crore/gi;
  for (const m of String(text || '').matchAll(crore)) out.push({ raw: m[0], usd: Math.round(Number(m[1]) * 10_000_000 * 0.0117) });
  return out;
}

function maxEvidenceAmount(text, excludeValuation=false) {
  let t = String(text || '');
  if (excludeValuation) t = t.split(/valuation|valued at|Bewertung|Unternehmenswert/i)[0];
  const vals = extractMoney(t).map(x => x.usd);
  return vals.length ? Math.max(...vals) : null;
}

function normalizeYcHit(h, requestedBatch) {
  const batch = clean(h.batch || h.batch_name || h.batchName || requestedBatch);
  const slug = clean(h.slug || h.company_slug || h.objectID || slugify(h.name || h.title));
  const tags = Array.isArray(h.tags) ? h.tags.join(' | ') : clean(h.tags);
  const industries = Array.isArray(h.industries) ? h.industries.join(' | ') : clean(h.industry || h.industries);
  return {
    source_group: 'Y Combinator 2025-2026',
    source_name: 'Y Combinator official company directory',
    source_url: `https://www.ycombinator.com/companies/${slug}`,
    company_name: clean(h.name || h.title),
    slug,
    batch,
    founded_year: h.year_founded || h.founded_year || h.yearFounded || '',
    description: clean(h.one_liner || h.oneLiner || h.description),
    industry: industries,
    subindustry: clean(h.subindustry || h.sub_industry),
    tags,
    location: clean(h.all_locations || h.location || h.locations),
    website: clean(h.website || h.website_url || h.url),
    team_size: h.team_size ?? h.teamSize ?? '',
    status: clean(h.status),
    top_company: Boolean(h.top_company || h.topCompany),
    funding_evidence: 'YC standard investment: $500,000',
    funding_usd: 500000,
    eligibility_basis: 'All YC companies in 2025/2026 requested regardless of $1M threshold',
    scraped_at_utc: scrapedAt
  };
}

async function scrapeYc(browser) {
  const fallbackBatches = ['Winter 2025','Spring 2025','Summer 2025','Fall 2025','Winter 2026','Spring 2026','Summer 2026','Fall 2026'];
  const detect = await browser.newPage({ locale: 'en-US' });
  let detected = [];
  try {
    await detect.goto('https://www.ycombinator.com/companies', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await detect.waitForTimeout(3000);
    const txt = await detect.locator('body').innerText().catch(() => '');
    detected = Array.from(new Set((txt.match(/(?:Winter|Spring|Summer|Fall) 202[56]/g) || [])));
  } catch {}
  await detect.close();
  const batches = Array.from(new Set([...detected, ...fallbackBatches]));
  const all = [];
  const batchSummary = [];

  for (const batch of batches) {
    const page = await browser.newPage({ locale: 'en-US' });
    const networkHits = [];
    page.on('response', async (response) => {
      try {
        if (!response.url().includes('algolia.net') || response.request().method() !== 'POST') return;
        const json = await response.json();
        for (const result of json.results || []) for (const hit of result.hits || []) networkHits.push(hit);
      } catch {}
    });
    const url = new URL('https://www.ycombinator.com/companies');
    url.searchParams.append('batch', batch);
    let domRows = [];
    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3500);
      let stable = 0, last = -1;
      for (let i=0; i<50 && stable<5; i++) {
        const count = await page.locator('a[href^="/companies/"]').count().catch(() => 0);
        if (count === last) stable++; else stable = 0;
        last = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
      }
      domRows = await page.locator('a[href^="/companies/"]').evaluateAll((els) => els.map((a) => ({
        href: a.getAttribute('href') || '', text: (a.innerText || '').trim()
      })).filter(x => /^\/companies\/[a-z0-9-]+\/?$/i.test(x.href)));
    } catch (e) {
      batchSummary.push({ batch, status: 'error', error: e.message, count: 0 });
      await page.close();
      continue;
    }

    const normalized = [];
    const seen = new Set();
    for (const h of networkHits) {
      const hb = clean(h.batch || h.batch_name || h.batchName);
      if (hb && hb !== batch) continue;
      const r = normalizeYcHit(h, batch);
      if (!r.company_name || seen.has(r.slug)) continue;
      seen.add(r.slug); normalized.push(r);
    }
    if (normalized.length < 5) {
      for (const d of domRows) {
        const slug = d.href.split('/').filter(Boolean).pop();
        if (seen.has(slug)) continue;
        const lines = d.text.split(/\n+/).map(clean).filter(Boolean);
        const name = lines[0] || slug;
        const description = lines.slice(1).filter(x => !x.includes(batch)).join(' · ');
        const r = normalizeYcHit({ name, slug, one_liner: description, batch }, batch);
        seen.add(slug); normalized.push(r);
      }
    }
    all.push(...normalized);
    batchSummary.push({ batch, status: normalized.length ? 'ok' : 'empty_or_not_public', count: normalized.length, network_hits: networkHits.length, dom_links: domRows.length, url: url.toString() });
    await page.close();
    await sleep(500);
  }

  const dedup = Array.from(new Map(all.map(r => [`${r.batch}|${r.slug}`, r])).values());
  writeCsv('yc_2025_2026.csv', dedup);
  writeCsv('yc_batch_summary.csv', batchSummary);
  return { rows: dedup, summary: batchSummary };
}

function parseTopStartupCard(card) {
  const text = card.text || '';
  const between = (a, b) => {
    const s = text.indexOf(a); if (s < 0) return '';
    const rest = text.slice(s + a.length);
    const e = b ? rest.search(b) : -1;
    return clean(e >= 0 ? rest.slice(0, e) : rest);
  };
  const description = between('What they do:', /Quick facts:/i);
  const quickFacts = between('Quick facts:', /Funding:/i);
  const funding = between('Funding:', /Founders:|Take action:/i);
  const hq = (quickFacts.match(/HQ:\s*(.*?)(?=\s+\d{1,4}-\d{1,4}\s+employees|\s+Founded:|$)/i) || [,''])[1];
  const size = (quickFacts.match(/(\d{1,4}-\d{1,4}|\d{1,4}\+)\s+employees/i) || [,''])[1];
  const founded = (quickFacts.match(/Founded:\s*(\d{4})/i) || [,''])[1];
  const preValuation = funding.split(/valuation|valued at/i)[0];
  let fundingUsd = maxEvidenceAmount(preValuation, false);
  let revenueUsd = null;
  let basis = '';
  const full = `${description} ${funding}`;
  const fig = full.match(/([789])-figure\s+(?:annual\s+)?revenue/i);
  if (fig) revenueUsd = fig[1] === '7' ? 1e6 : fig[1] === '8' ? 1e7 : 1e8;
  const revenueSentences = full.split(/[.;]\s+/).filter(s => /revenue|sales|ARR|turnover/i.test(s));
  for (const s of revenueSentences) revenueUsd = Math.max(revenueUsd || 0, maxEvidenceAmount(s) || 0) || revenueUsd;
  if ((fundingUsd || 0) >= 1_000_000) basis = 'reported funding >= $1M';
  else if ((revenueUsd || 0) >= 1_000_000) basis = 'reported revenue >= $1M';
  else if (/Series\s+[A-I]|growth round|post-IPO/i.test(funding)) { fundingUsd = 1_000_000; basis = 'Series A+ stage implies >$1M; amount not stated'; }
  return {
    source_group: 'Additional funded startup directory',
    source_name: 'TopStartups.io',
    source_url: 'https://topstartups.io/',
    company_name: clean(card.name),
    company_url: clean(card.companyUrl),
    description,
    industry: clean(card.tags),
    location: clean(hq),
    employee_range: clean(size),
    founded_year: founded,
    funding_evidence: funding,
    funding_usd: fundingUsd || '',
    revenue_evidence: revenueUsd ? revenueSentences.join(' | ') : '',
    revenue_usd: revenueUsd || '',
    eligibility_basis: basis,
    eligible_over_1m: Boolean(basis),
    raw_text: clean(text),
    scraped_at_utc: scrapedAt
  };
}

async function scrapeTopStartups(browser) {
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1200 } });
  await page.goto('https://topstartups.io/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);
  let stable = 0, last = 0;
  for (let i=0; i<180 && stable<8; i++) {
    const count = await page.locator('h3').count();
    if (count === last) stable++; else stable = 0;
    last = count;
    const show = page.getByText('Show more', { exact: true }).last();
    if (await show.count() && await show.isVisible().catch(() => false)) {
      await show.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(650);
    } else {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(650);
    }
  }

  const cards = await page.locator('h3').evaluateAll((headings) => headings.map((h) => {
    let node = h;
    for (let i=0; i<8 && node; i++, node=node.parentElement) {
      const txt = (node.innerText || '');
      if (txt.includes('What they do:') && txt.includes('Quick facts:') && txt.includes('Funding:') && node.querySelectorAll('h3').length <= 1) {
        const links = Array.from(node.querySelectorAll('a[href]')).map(a => a.href);
        const companyUrl = links.find(u => !u.includes('topstartups.io') && !u.includes('linkedin.com') && !u.includes('glassdoor.com') && !u.includes('trustpilot.com') && !u.includes('ashbyhq.com') && !u.includes('substack.com')) || '';
        const what = txt.split('What they do:')[1]?.split('Quick facts:')[0] || '';
        const tags = what.split(/\n+/).slice(1).join(' | ');
        return { name: h.innerText, text: txt, companyUrl, tags };
      }
    }
    return null;
  }).filter(Boolean));
  await page.close();
  const parsed = cards.map(parseTopStartupCard).filter(r => r.company_name);
  const dedup = Array.from(new Map(parsed.map(r => [r.company_name.toLowerCase(), r])).values());
  const eligible = dedup.filter(r => r.eligible_over_1m);
  writeCsv('topstartups_all.csv', dedup);
  writeCsv('topstartups_eligible_over_1m.csv', eligible);
  fs.writeFileSync(path.join(OUT, 'topstartups_summary.json'), JSON.stringify({ total: dedup.length, eligible: eligible.length, scraped_at_utc: scrapedAt }, null, 2));
  return { rows: dedup, eligible };
}

const tvSeeds = [
  ['Shark Tank US','en','Bombas'],['Shark Tank US','en','Scrub Daddy'],['Shark Tank US','en','Poppi (drink)'],['Shark Tank US','en','Everlywell'],['Shark Tank US','en','Ring (company)'],['Shark Tank US','en','The Bouqs Company'],['Shark Tank US','en','Cousins Maine Lobster'],['Shark Tank US','en','The Comfy'],['Shark Tank US','en','DUDE Wipes'],['Shark Tank US','en','Squatty Potty'],['Shark Tank US','en','Tipsy Elves'],['Shark Tank US','en','Kodiak Cakes'],['Shark Tank US','en','BeatBox Beverages'],['Shark Tank US','en','PhoneSoap'],['Shark Tank US','en','Simply Fit Board'],['Shark Tank US','en','Sleep Styler'],['Shark Tank US','en','Lovepop'],['Shark Tank US','en','Tower Paddle Boards'],['Shark Tank US','en','Grace and Lace'],['Shark Tank US','en','Red Dress Boutique'],['Shark Tank US','en','ReadeREST'],['Shark Tank US','en',"Bubba's Q"],['Shark Tank US','en','Wicked Good Cupcakes'],['Shark Tank US','en','Groovebook'],['Shark Tank US','en','Bantam Bagels'],['Shark Tank US','en','Plated (meal kits)'],['Shark Tank US','en','Coffee Meets Bagel'],['Shark Tank US','en','Copa Di Vino'],['Shark Tank US','en','Bug Bite Thing'],['Shark Tank US','en','Blueland'],['Shark Tank US','en','Yellow Leaf Hammocks'],['Shark Tank US','en','PiperWai'],['Shark Tank US','en','Fresh Patch'],['Shark Tank US','en','LuminAID'],['Shark Tank US','en','Nuts ’N More'],['Shark Tank US','en','FiberFix'],
  ["Dragons' Den UK",'en','Reggae Reggae Sauce'],["Dragons' Den UK",'en','Tangle Teezer'],["Dragons' Den UK",'en','Trunki'],["Dragons' Den UK",'en','Wonderbly'],["Dragons' Den UK",'en','Skinny Tan'],["Dragons' Den UK",'en','GripIt Fixings'],["Dragons' Den UK",'en','Craft Gin Club'],["Dragons' Den UK",'en','PerfectTed'],["Dragons' Den UK",'en','Chocbox'],["Dragons' Den UK",'en','Magic Whiteboard'],["Dragons' Den UK",'en','Razzamataz Theatre Schools'],["Dragons' Den UK",'en','The Snaffling Pig Co'],["Dragons' Den UK",'en','Look After My Bills'],["Dragons' Den UK",'en','Hungryhouse'],["Dragons' Den UK",'en','Destination London'],["Dragons' Den UK",'en','Approved Food'],["Dragons' Den UK",'en','Hornit'],
  ['Die Höhle der Löwen','de','Ankerkraut'],['Die Höhle der Löwen','de','Little Lunch'],['Die Höhle der Löwen','de','Waterdrop'],['Die Höhle der Löwen','de','3Bears'],['Die Höhle der Löwen','de','Happybrush'],['Die Höhle der Löwen','de','Everdrop'],['Die Höhle der Löwen','de','ArtNight'],['Die Höhle der Löwen','de','BitterLiebe'],['Die Höhle der Löwen','de','Smartsleep'],['Die Höhle der Löwen','de',"Luicella's Ice Cream"],['Die Höhle der Löwen','de',"Rokitta's Rostschreck"],['Die Höhle der Löwen','de','Veluvia'],['Die Höhle der Löwen','de','Meine Spielzeugkiste'],['Die Höhle der Löwen','de','PonyHütchen'],['Die Höhle der Löwen','de','SugarShape'],['Die Höhle der Löwen','de','Presize'],
  ['Shark Tank India','en','Snitch (fashion brand)'],['Shark Tank India','en','Skippi Ice Pops'],['Shark Tank India','en','Beyond Snack'],['Shark Tank India','en','The Bear House'],['Shark Tank India','en','Hammer Lifestyle'],['Shark Tank India','en','Namhya Foods'],['Shark Tank India','en','BluePine Foods'],['Shark Tank India','en','Bummer (company)'],['Shark Tank India','en','TagZ Foods'],['Shark Tank India','en','Get-A-Whey'],['Shark Tank India','en','Rare Planet'],['Shark Tank India','en','Auli Lifestyle'],['Shark Tank India','en','Menstrupedia'],['Shark Tank India','en','Wakao Foods'],['Shark Tank India','en','Paradyes'],['Shark Tank India','en','STAGE (Indian streaming service)'],['Shark Tank India','en','Flatheads'],['Shark Tank India','en','Hair Originals'],['Shark Tank India','en','Revamp Moto'],['Shark Tank India','en','Sunfox Technologies'],['Shark Tank India','en','MeMeraki'],['Shark Tank India','en','Raja Rani Coaching']
];

async function wikiPage(lang, title) {
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts|info&inprop=url&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
  const res = await fetch(api, { headers: { 'user-agent': 'StartupLandscapeResearch/1.0' } });
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const json = await res.json();
  const p = Object.values(json.query?.pages || {})[0] || {};
  return { title: p.title || title, extract: p.extract || '', url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`, missing: Boolean(p.missing !== undefined) };
}

function tvEvidence(extract) {
  const sentences = String(extract || '').split(/(?<=[.!?])\s+/);
  const relevant = sentences.filter(s => /revenue|sales|turnover|funding|raised|investment|sold for|acquired|Umsatz|Erlös|Finanzierung|Investment|verkauft|Übernahme|crore/i.test(s));
  let maxUsd = 0, best = '';
  for (const s of relevant) {
    const amt = maxEvidenceAmount(s);
    if ((amt || 0) > maxUsd) { maxUsd = amt; best = clean(s); }
  }
  return { maxUsd: maxUsd || null, evidence: best, relevant: relevant.slice(0, 8).map(clean).join(' | ') };
}

async function scrapeTv() {
  const rows = [];
  for (const [show, lang, title] of tvSeeds) {
    try {
      const p = await wikiPage(lang, title);
      if (p.missing) continue;
      const ev = tvEvidence(p.extract);
      const desc = clean(p.extract.split(/\n+/)[0]).slice(0, 700);
      rows.push({
        source_group: 'TV pitch success', source_name: show, source_url: p.url,
        company_name: p.title, description: desc, funding_or_revenue_evidence: ev.evidence,
        evidence_context: ev.relevant, evidence_usd: ev.maxUsd || '',
        eligible_over_1m: Boolean((ev.maxUsd || 0) >= 1_000_000),
        eligibility_basis: (ev.maxUsd || 0) >= 1_000_000 ? 'Wikipedia-linked public evidence >= $1M' : 'Seeded TV alumnus; threshold not verified from Wikipedia extract',
        scraped_at_utc: scrapedAt
      });
    } catch (e) {
      rows.push({ source_group:'TV pitch success', source_name:show, source_url:'', company_name:title, description:'', funding_or_revenue_evidence:'', evidence_context:'', evidence_usd:'', eligible_over_1m:false, eligibility_basis:`lookup_error: ${e.message}`, scraped_at_utc:scrapedAt });
    }
    await sleep(100);
  }
  const eligible = rows.filter(r => r.eligible_over_1m);
  writeCsv('tv_pitch_candidates_all.csv', rows);
  writeCsv('tv_pitch_verified_over_1m.csv', eligible);
  return { rows, eligible };
}

const browser = await chromium.launch({ headless: true });
let yc, top;
try {
  yc = await scrapeYc(browser);
  top = await scrapeTopStartups(browser);
} finally {
  await browser.close();
}
const tv = await scrapeTv();
const summary = {
  scraped_at_utc: scrapedAt,
  yc_companies: yc.rows.length,
  yc_batches: yc.summary,
  topstartups_total: top.rows.length,
  topstartups_eligible_over_1m: top.eligible.length,
  tv_seeded: tv.rows.length,
  tv_verified_over_1m: tv.eligible.length
};
fs.writeFileSync(path.join(OUT, 'collection_summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
