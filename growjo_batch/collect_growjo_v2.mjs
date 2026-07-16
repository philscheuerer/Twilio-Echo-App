import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { stringify } from 'csv-stringify/sync';

const OUT = path.resolve('output');
fs.mkdirSync(OUT, { recursive: true });
const scrapedAt = new Date().toISOString();
const maxPages = Number(process.env.MAX_PAGES || 28);
const target = Number(process.env.TARGET || 1350);
const detailLimit = Number(process.env.DETAIL_LIMIT || 350);
const detailConcurrency = Number(process.env.DETAIL_CONCURRENCY || 5);
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseAmount(s) {
  const m = clean(s).replace(/,/g, '').match(/\$?([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]?.toUpperCase() === 'K') n *= 1e3;
  if (m[2]?.toUpperCase() === 'M') n *= 1e6;
  if (m[2]?.toUpperCase() === 'B') n *= 1e9;
  return Math.round(n);
}
function writeCsv(name, rows) {
  if (!rows.length) { fs.writeFileSync(path.join(OUT, name), '\n'); return; }
  const cols = [...rows.reduce((s,r)=>{Object.keys(r).forEach(k=>s.add(k));return s;},new Set())];
  fs.writeFileSync(path.join(OUT, name), stringify(rows,{header:true,columns:cols}));
}

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({locale:'en-US',viewport:{width:1440,height:1200}});
const page = await context.newPage();
const all = [];
const pageStats = [];

for (let p=1; p<=maxPages && all.length<target; p++) {
  const url = p===1 ? 'https://growjo.com/' : `https://growjo.com/home/${p}`;
  try {
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForTimeout(700);
    const extracted = await page.evaluate(() => {
      const clean = v => String(v??'').replace(/\s+/g,' ').trim();
      const links = Array.from(document.querySelectorAll('a[href*="/company/"]'));
      const rows = [];
      const seen = new Set();
      for (const a of links) {
        const name = clean(a.innerText);
        const href = a.href;
        if (!name || seen.has(href)) continue;
        let selected = null;
        for (let node=a.parentElement, depth=0; node && depth<10; node=node.parentElement, depth++) {
          const raw = node.innerText || '';
          const money = raw.match(/\$[0-9.,]+\s*[KMB]?/gi) || [];
          const companyLinks = node.querySelectorAll('a[href*="/company/"]').length;
          if (companyLinks===1 && money.length>=2 && raw.length<1200) { selected=node; break; }
        }
        if (!selected) continue;
        const raw = selected.innerText || '';
        const lines = raw.split(/\n+/).map(clean).filter(Boolean);
        const money = raw.match(/\$[0-9.,]+\s*[KMB]?/gi) || [];
        const pct = (raw.match(/-?[0-9.,]+\s*%/) || [''])[0];
        let rank = null;
        for (const line of lines) if (/^\d{1,5}$/.test(line)) { rank=Number(line); break; }
        if (!rank) rank = Number((raw.match(/^\s*(\d{1,5})\b/)||[,''])[1]);
        if (!rank) continue;
        const childTexts = Array.from(selected.children).map(x=>clean(x.innerText)).filter(Boolean);
        rows.push({rank,company_name:name,growjo_url:href,funding_text:money[0]||'',revenue_text:money[1]||'',growth_text:pct,raw_text:clean(raw),lines:lines.join(' | '),child_texts:childTexts.join(' | ')});
        seen.add(href);
      }
      return rows;
    });
    if (p===1) {
      fs.writeFileSync(path.join(OUT,'growjo_page1_debug.json'),JSON.stringify({count:extracted.length,sample:extracted.slice(0,5)},null,2));
      if (!extracted.length) {
        fs.writeFileSync(path.join(OUT,'growjo_page1_text.txt'),await page.locator('body').innerText().catch(()=>''));
        fs.writeFileSync(path.join(OUT,'growjo_page1.html'),await page.content());
      }
    }
    const before=all.length;
    for (const r of extracted) {
      const funding=parseAmount(r.funding_text), revenue=parseAmount(r.revenue_text);
      if ((funding||0)<1_000_000 && (revenue||0)<1_000_000) continue;
      all.push({
        source_group:'Additional funded/revenue startup directory',source_name:'Growjo Top 10,000',source_url:r.growjo_url,
        directory_rank:r.rank,company_name:r.company_name,description:'',industry:'',location:'',country:'',employee_range:'',employees:'',
        funding_evidence:r.funding_text,funding_usd:funding||'',revenue_evidence:`${r.revenue_text} (Growjo estimate)`,revenue_usd:revenue||'',
        employee_growth_pct:Number(String(r.growth_text).replace(/[^0-9.-]/g,''))||'',eligibility_basis:(funding||0)>=1_000_000?'Funding >= $1M':'Estimated annual revenue >= $1M',
        evidence_confidence:funding?'medium — directory-reported funding':'low-medium — estimated revenue',raw_row:r.raw_text,row_lines:r.lines,row_children:r.child_texts,scraped_at_utc:scrapedAt
      });
    }
    pageStats.push({page:p,url,status:'ok',extracted:extracted.length,eligible_added:all.length-before});
  } catch(e) { pageStats.push({page:p,url,status:'error',error:e.message,extracted:0,eligible_added:0}); }
  await sleep(250);
}

const dedup=[...new Map(all.sort((a,b)=>a.directory_rank-b.directory_rank).map(r=>[r.company_name.toLowerCase(),r])).values()];
let cursor=0;
async function enrichWorker(){
  const dp=await context.newPage();
  while(true){
    const i=cursor++; if(i>=Math.min(detailLimit,dedup.length)) break;
    const row=dedup[i];
    try{
      await dp.goto(row.source_url,{waitUntil:'domcontentloaded',timeout:60000});
      await dp.waitForTimeout(250);
      const d=await dp.evaluate(()=>{
        const text=document.body.innerText||'';
        const desc=(text.split(/What Is [^?]+\?/i)[1]||'').split(/keywords:/i)[0]||'';
        const industry=(text.match(/Growjo Ranking\s+([^\n]+)\s+Industry/i)||[,''])[1];
        return {description:desc.replace(/\s+/g,' ').trim(),industry:(industry||'').replace(/\s+/g,' ').trim()};
      });
      row.description=clean(d.description).slice(0,1400); if(d.industry) row.industry=d.industry; row.detail_enriched=Boolean(row.description);
    }catch(e){row.detail_enriched=false;row.detail_error=e.message;}
    await sleep(100);
  }
  await dp.close();
}
await Promise.all(Array.from({length:detailConcurrency},()=>enrichWorker()));
await page.close();await context.close();await browser.close();
writeCsv('growjo_eligible_over_1m.csv',dedup);writeCsv('growjo_page_stats.csv',pageStats);
const summary={scraped_at_utc:scrapedAt,eligible_unique_companies:dedup.length,pages_attempted:pageStats.length,pages_ok:pageStats.filter(x=>x.status==='ok').length,pages_error:pageStats.filter(x=>x.status==='error').length,detail_enriched:dedup.filter(x=>x.detail_enriched).length,funding_over_1m:dedup.filter(x=>Number(x.funding_usd||0)>=1e6).length,revenue_over_1m:dedup.filter(x=>Number(x.revenue_usd||0)>=1e6).length};
fs.writeFileSync(path.join(OUT,'growjo_summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
