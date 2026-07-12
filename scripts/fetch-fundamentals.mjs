// Free, no-key fundamentals via the SEC's official EDGAR XBRL API
// (data.sec.gov). Covers "Company financial statements" / "Earnings reports"
// from the system prompt's allowed-information list, which nothing else in
// this pipeline provides. SEC requires an identifying User-Agent (name +
// contact) on every request — no API key, but rate-limited to 10 req/sec.

const SEC_USER_AGENT = 'StockTradingSimulator research tool (contact: a0938245228@gmail.com)';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const conceptUrl = (cik, concept) => `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;

let cikMapPromise = null;

async function getCikMap() {
  if (!cikMapPromise) {
    cikMapPromise = fetch(TICKERS_URL, { headers: { 'User-Agent': SEC_USER_AGENT } })
      .then(r => r.json())
      .then(data => {
        const map = {};
        for (const entry of Object.values(data)) {
          map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
        }
        return map;
      });
  }
  return cikMapPromise;
}

async function fetchConcept(cik, concept) {
  const res = await fetch(conceptUrl(cik, concept), { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) return null;
  return res.json();
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// XBRL facts mix quarter-only and year-to-date durations under the same
// concept (companies re-report cumulative figures each quarter). Keep only
// entries whose start-to-end span looks like a single fiscal quarter.
function pickQuarterly(units) {
  return units
    .filter(u => (u.form === '10-Q' || u.form === '10-K') && u.start)
    .map(u => ({ ...u, durationDays: daysBetween(u.start, u.end) }))
    .filter(u => u.durationDays >= 80 && u.durationDays <= 100)
    .sort((a, b) => (a.end < b.end ? 1 : -1));
}

function latestAndYoY(units) {
  const quarters = pickQuarterly(units);
  if (!quarters.length) return { latest: null, yoyPct: null, periodEnd: null, form: null };
  const latest = quarters[0];
  const targetDate = new Date(latest.end);
  targetDate.setFullYear(targetDate.getFullYear() - 1);

  let best = null, bestDiffMs = Infinity;
  for (const q of quarters.slice(1)) {
    const diff = Math.abs(new Date(q.end) - targetDate);
    if (diff < bestDiffMs) { bestDiffMs = diff; best = q; }
  }
  const withinThreeWeeks = bestDiffMs < 21 * 86400000;
  const yoyPct = (best && withinThreeWeeks && best.val !== 0)
    ? Math.round(((latest.val - best.val) / Math.abs(best.val)) * 10000) / 100
    : null;

  return { latest: latest.val, yoyPct, periodEnd: latest.end, form: latest.form };
}

async function fetchOne(ticker, cikMap) {
  const cik = cikMap[ticker.toUpperCase()];
  if (!cik) {
    return { ticker, error: 'No SEC CIK mapping (likely an ETF/fund, not an operating company)' };
  }

  // Companies sometimes stop filing under an older revenue tag (e.g. after
  // ASC 606 adoption) without deleting the old entries — the first match by
  // presence alone can silently return a years-stale figure. Compute all
  // candidates and keep whichever has the most recent reporting period.
  const revenueConcepts = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'];
  const revenueCandidates = (await Promise.all(
    revenueConcepts.map(async concept => {
      const data = await fetchConcept(cik, concept);
      return data?.units?.USD ? latestAndYoY(data.units.USD) : null;
    })
  )).filter(r => r && r.periodEnd);
  const revenue = revenueCandidates.length
    ? revenueCandidates.reduce((a, b) => (a.periodEnd > b.periodEnd ? a : b))
    : { latest: null, yoyPct: null, periodEnd: null };

  const [netIncomeData, epsData] = await Promise.all([
    fetchConcept(cik, 'NetIncomeLoss'),
    fetchConcept(cik, 'EarningsPerShareDiluted')
  ]);

  const netIncome = netIncomeData?.units?.USD ? latestAndYoY(netIncomeData.units.USD) : { latest: null, yoyPct: null, periodEnd: null };

  let epsDiluted = null, epsPeriodEnd = null;
  if (epsData?.units?.['USD/shares']) {
    const q = pickQuarterly(epsData.units['USD/shares']);
    if (q.length) { epsDiluted = q[0].val; epsPeriodEnd = q[0].end; }
  }

  if (revenue.latest == null && netIncome.latest == null && epsDiluted == null) {
    return { ticker, error: 'No recent quarterly XBRL facts found for this company' };
  }

  const fiscalPeriodEnd = [revenue.periodEnd, netIncome.periodEnd, epsPeriodEnd]
    .filter(Boolean)
    .reduce((a, b) => (!a || b > a ? b : a), null);

  return {
    ticker,
    fiscalPeriodEnd,
    revenue: revenue.latest,
    revenueYoY: revenue.yoyPct,
    netIncome: netIncome.latest,
    netIncomeYoY: netIncome.yoyPct,
    epsDiluted
  };
}

export async function getFundamentals(tickers) {
  const cikMap = await getCikMap();
  const out = [];
  for (const ticker of tickers) {
    try {
      out.push(await fetchOne(ticker, cikMap));
    } catch (err) {
      out.push({ ticker, error: String(err.message || err) });
    }
  }
  return out;
}
