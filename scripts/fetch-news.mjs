// Free, no-key headline fetch via Google News RSS. Only used to give the
// trading agent recent news context (explicitly allowed by the system
// prompt: "News published BEFORE the decision date"). No sentiment scoring —
// just raw headlines + publish date, left for the model to interpret.

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", '#x27': "'"
};

function decodeEntities(s) {
  return s.replace(/&(#?\w+);/g, (m, code) => ENTITY_MAP[code] ?? m);
}

function stripSourceSuffix(title) {
  // Google News titles are usually "Headline - Source Name" — drop the suffix.
  return title.replace(/\s-\s[^-]+$/, '').trim();
}

export async function getNewsHeadlines(ticker, limit = 4) {
  const query = encodeURIComponent(`${ticker} stock when:3d`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const xml = await res.text();

    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRe.exec(xml)) && items.length < limit) {
      const block = match[1];
      const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
      const dateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
      if (!titleMatch) continue;
      const title = stripSourceSuffix(decodeEntities(titleMatch[1].trim()));
      const pubDate = dateMatch ? dateMatch[1].trim() : null;
      items.push({ title, pubDate });
    }
    return items;
  } catch (err) {
    return [];
  }
}

export async function getNewsForTickers(tickers, limit = 4) {
  const out = {};
  for (const ticker of tickers) {
    out[ticker] = await getNewsHeadlines(ticker, limit);
  }
  return out;
}
