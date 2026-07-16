from __future__ import annotations

import json
import math
import os
from pathlib import Path

import kagglehub
import pandas as pd

OUT = Path('output')
OUT.mkdir(parents=True, exist_ok=True)
DATASET = 'yanmaksi/big-startup-secsees-fail-dataset-from-crunchbase'
TARGET = int(os.getenv('TARGET', '2000'))

root = Path(kagglehub.dataset_download(DATASET))
files = sorted([p for p in root.rglob('*') if p.suffix.lower() in {'.csv', '.tsv'}], key=lambda p: p.stat().st_size, reverse=True)
if not files:
    raise RuntimeError(f'No CSV/TSV found under {root}')

frames = []
file_info = []
for file in files:
    sep = '\t' if file.suffix.lower() == '.tsv' else ','
    try:
        df = pd.read_csv(file, sep=sep, low_memory=False, encoding_errors='replace')
    except Exception as exc:
        file_info.append({'file': str(file), 'status': 'error', 'error': str(exc)})
        continue
    if len(df) == 0:
        continue
    file_info.append({'file': str(file), 'status': 'ok', 'rows': len(df), 'columns': list(df.columns)})
    frames.append(df)

if not frames:
    raise RuntimeError('No readable non-empty datasets found')

def norm_col(s: str) -> str:
    return ''.join(ch.lower() if ch.isalnum() else '_' for ch in str(s)).strip('_')

# Prefer the largest table. The referenced dataset is expected to contain roughly 66k organizations.
df = max(frames, key=len).copy()
df.columns = [norm_col(c) for c in df.columns]
cols = set(df.columns)

def pick(*candidates: str) -> str | None:
    for c in candidates:
        if c in cols:
            return c
    for c in candidates:
        hits = [x for x in cols if c in x]
        if hits:
            return sorted(hits, key=len)[0]
    return None

name_col = pick('name', 'company_name', 'organization_name')
fund_col = pick('funding_total_usd', 'funding_total', 'total_funding_usd', 'funding_usd')
status_col = pick('status', 'operating_status')
country_col = pick('country_code', 'country')
city_col = pick('city')
region_col = pick('region')
category_col = pick('category_list', 'category', 'market', 'industry')
home_col = pick('homepage_url', 'website', 'url')
founded_col = pick('founded_at', 'founded_year', 'founded')
rounds_col = pick('funding_rounds', 'num_funding_rounds')
first_funding_col = pick('first_funding_at')
last_funding_col = pick('last_funding_at')

if not name_col or not fund_col:
    raise RuntimeError(f'Could not identify required columns. Columns: {sorted(cols)}')

funding = pd.to_numeric(df[fund_col].astype(str).str.replace(',', '', regex=False), errors='coerce')
eligible = df.loc[funding >= 1_000_000].copy()
eligible['_funding_usd'] = funding.loc[eligible.index]
eligible = eligible.sort_values('_funding_usd', ascending=False).drop_duplicates(subset=[name_col])
if TARGET > 0:
    eligible = eligible.head(TARGET)

out = pd.DataFrame({
    'source_group': 'Additional funded startup directory',
    'source_name': 'Crunchbase-derived Kaggle startup dataset',
    'source_url': 'https://www.kaggle.com/datasets/yanmaksi/big-startup-secsees-fail-dataset-from-crunchbase/data',
    'company_name': eligible[name_col].astype(str).str.strip(),
    'description': '',
    'industry': eligible[category_col].fillna('').astype(str) if category_col else '',
    'location': ((eligible[city_col].fillna('').astype(str) + ', ' if city_col else '') + (eligible[country_col].fillna('').astype(str) if country_col else '')).str.strip(', ') if city_col or country_col else '',
    'city': eligible[city_col].fillna('').astype(str) if city_col else '',
    'region': eligible[region_col].fillna('').astype(str) if region_col else '',
    'country': eligible[country_col].fillna('').astype(str) if country_col else '',
    'status': eligible[status_col].fillna('').astype(str) if status_col else '',
    'website': eligible[home_col].fillna('').astype(str) if home_col else '',
    'founded': eligible[founded_col].fillna('').astype(str) if founded_col else '',
    'funding_rounds': pd.to_numeric(eligible[rounds_col], errors='coerce') if rounds_col else '',
    'first_funding_at': eligible[first_funding_col].fillna('').astype(str) if first_funding_col else '',
    'last_funding_at': eligible[last_funding_col].fillna('').astype(str) if last_funding_col else '',
    'funding_evidence': eligible['_funding_usd'].map(lambda x: f'Crunchbase-derived total funding: ${x:,.0f}'),
    'funding_usd': eligible['_funding_usd'].round().astype('int64'),
    'revenue_evidence': '',
    'revenue_usd': '',
    'eligibility_basis': 'Reported total funding >= $1M',
    'evidence_confidence': 'medium — historical Crunchbase-derived directory record',
})

out.to_csv(OUT / 'crunchbase_eligible_over_1m.csv', index=False)
summary = {
    'dataset': DATASET,
    'download_root': str(root),
    'source_rows': int(len(df)),
    'eligible_rows_before_limit': int((funding >= 1_000_000).sum()),
    'unique_exported': int(len(out)),
    'selected_file': str(max(files, key=lambda p: p.stat().st_size)),
    'identified_columns': {
        'name': name_col, 'funding': fund_col, 'status': status_col, 'country': country_col,
        'city': city_col, 'region': region_col, 'category': category_col, 'website': home_col,
        'founded': founded_col, 'funding_rounds': rounds_col, 'first_funding': first_funding_col,
        'last_funding': last_funding_col,
    },
    'file_info': file_info,
}
(OUT / 'crunchbase_summary.json').write_text(json.dumps(summary, indent=2, default=str), encoding='utf-8')
print(json.dumps(summary, indent=2, default=str))
