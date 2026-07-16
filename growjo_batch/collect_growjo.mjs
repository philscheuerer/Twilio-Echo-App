import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { stringify } from 'csv-stringify/sync';

const OUT = path.resolve('output');
fs.mkdirSync(OUT, { recursive: true });
const scrapedAt = new Date().toISOString();
const maxPages = Number(process.env.MAX_PAGES || 26);
const target = Number(process.env.TARGET || 1250);
const concurrency = Number(process.env.DETAIL_CONCURRENCY || 5);
const detailLimit = Number(process.env.DETAIL_LIMIT || 350);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

function parseAmount(s) {
  const x = clean(s).replace(/,/g, '');
  if (!x || /N\/?A|---|^-$/.test(x)) return null;
  const m = x.match(/\$?([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]?.toUpperCase() === 'K') n *= 1e3;
  if (m[2]?.toUpperCase() === 'M') n *= 1e6;
  if (m[2]?.toUpperCase() === 'B') n *= 1e9;
  return Math.round(n);
}

function parseGrowth(s) {
  const m = clean(s).match(/-?[0-9]+(?:\.[0-9]+)?/);
  return m ? Number(m[0]) : null;
}

function toCsv(name, rows) {
  const cols = [...rows.reduce((set, row) => { Object.keys(row).forEach(k => set.add(k)); return set; }, new Set())];
  fs.writeFileSync(path.join(OUT, name), stringify(rows, { header: true, columns: cols }));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
const rows = [];
const pageStats = [];

for (let p = 1; p <= maxPages && rows.length < target; p++) {
  const url = p === 1 ? 'https://growjo.com/' : `https://growjo.com/home/${p}`;
  let status = 'ok', error = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(900);
    const data = await page.evaluate(() => {
      const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
      const out = [];
      const trs = Array.from(document.querySelectorAll('tr'));
      for (const tr of trs) {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => clean(td.innerText));
        const a = tr.querySelector('a[href^="/company/"]');
        if (!a || tds.length < 8) continue;
        const rank = Number((tds[0] || '').replace(/[^0-9]/g, ''));
        if (!rank) continue;
        out.push({
          rank,
          company_name: clean(a.innerText),
          growjo_url: new URL(a.getAttribute('href'), location.origin).href,
          city: tds[2] || '',
          country: tds[3] || '',
          funding_text: tds[4] || '',
          industry: tds[5] || '',
          employees_text: tds[6] || '',
          revenue_text: tds[7] || '',
          growth_text: tds[8] || '',
          row_text: clean(tr.innerText)
        });
      }
      if (out.length) return out;
      const links = Array.from(document.querySelectorAll('a[href^="/company/"]'));
      for (const a of links) {
        let node = a;
        for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
          const txt = clean(node.innerText);
          const rank = Number((txt.match(/^\s*(\d{1,5})\b/) || [,''])[1]);
          if (rank && /\$[0-9.]+[KMB]?/i.test(txt) && node.querySelectorAll('a[href^="/company/"]').length === 1) {
            const money = txt.match(/\$[0-9.,]+\s*[KMB]?/gi) || [];
            out.push({
              rank,
              company_name: clean(a.innerText),
              growjo_url: new URL(a.getAttribute('href'), location.origin).href,
              city: '', country: '', funding_text: money[0] || '', industry: '', employees_text: '',
              revenue_text: money[1] || '', growth_text: (txt.match(/-?[0-9.]+%/) || [''])[0], row_text: txt
            });
            break;
          }
        }
      }
      return out;
    });
    const before = rows.length;
    for (const r of data) {
      const funding = parseAmount(r.funding_text);
      const revenue = parseAmount(r.revenue_text);
      if ((funding || 0) < 1_000_000 && (revenue || 0) < 1_000_000) continue;
      rows.push({
        source_group: 'Additional funded/revenue startup directory',
        source_name: 'Growjo Top 10,000',
        source_url: r.growjo_url,
        directory_rank: r.rank,
        company_name: r.company_name,
        description: '',
        industry: r.industry,
        location: [r.city, r.country].filter(Boolean).join(', '),
        country: r.country,
        employee_range: r.employees_text,
        employees: Number(String(r.employees_text).replace(/[^0-9]/g, '')) || '',
        funding_evidence: r.funding_text,
        funding_usd: funding || '',
        revenue_evidence: `${r.revenue_text} (Growjo estimate)`,
        revenue_usd: revenue || '',
        employee_growth_pct: parseGrowth(r.growth_text) ?? '',
        eligibility_basis: (funding || 0) >= 1_000_000 ? 'Funding >= $1M' : 'Estimated annual revenue >= $1M',
        evidence_confidence: funding ? 'medium — directory-reported funding' : 'low-medium — estimated revenue',
        scraped_at_utc: scrapedAt,
        raw_row: r.row_text
      });
    }
    pageStats.push({ page: p, url, status, extracted: data.length, eligible_added: rows.length - before });
  } catch (e) {
    status = 'error'; error = e.message;
    pageStats.push({ page: p, url, status, error, extracted: 0, eligible_added: 0 });
  }
  await sleep(350);
}

const dedup = [...new Map(rows.sort((a,b) => a.directory_rank - b.directory_rank).map(r => [r.company_name.toLowerCase(), r])).values()];

// Enrich a bounded top subset from public company detail pages. This improves product descriptions
// for ranking while keeping the page footprint modest.
const enrichTargets = dedup.slice(0, detailLimit);
let cursor = 0;
async function worker() {
  const detailPage = await context.newPage();
  while (true) {
    const i = cursor++;
    if (i >= enrichTargets.length) break;
    const row = enrichTargets[i];
    try {
      await detailPage.goto(row.source_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await detailPage.waitForTimeout(300);
      const d = await detailPage.evaluate(() => {
        const body = document.body.innerText || '';
        const section = body.split(/What Is [^?]+\?/i)[1]?.split(/keywords:/i)[0] || '';
        const website = Array.from(document.querySelectorAll('a[href^="http"]')).map(a => a.href)
          .find(u => !u.includes('growjo.com') && !u.includes('lead411.com') && !u.includes('linkedin.com')) || '';
        return { description: section.replace(/\s+/g,' ').trim(), website };
      });
      row.description = clean(d.description).slice(0, 1200);
      row.website = d.website;
      row.detail_enriched = Boolean(row.description);
    } catch (e) {
      row.detail_enriched = false;
      row.detail_error = e.message;
    }
    await sleep(120);
  }
  await detailPage.close();
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

await page.close();
await context.close();
await browser.close();

toCsv('growjo_eligible_over_1m.csv', dedup);
toCsv('growjo_page_stats.csv', pageStats);
const summary = {
  scraped_at_utc: scrapedAt,
  eligible_unique_companies: dedup.length,
  pages_attempted: pageStats.length,
  pages_ok: pageStats.filter(x => x.status === 'ok').length,
  pages_error: pageStats.filter(x => x.status === 'error').length,
  detail_enriched: dedup.filter(x => x.detail_enriched).length,
  funding_over_1m: dedup.filter(x => Number(x.funding_usd || 0) >= 1_000_000).length,
  revenue_over_1m: dedup.filter(x => Number(x.revenue_usd || 0) >= 1_000_000).length
};
fs.writeFileSync(path.join(OUT, 'growjo_summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
