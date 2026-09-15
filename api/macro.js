// MTLscanner v1.3.0
// Vercel serverless function — macro context for EUR/USD & XAU/USD.
// Combines three free sources into one "outlook" snapshot:
//   - DXY (Dollar Index) proxy, computed from live FX crosses (Twelve Data)
//   - US 10-year nominal & real (TIPS) yields (FRED)
//   - COT futures positioning for EUR FX & Gold (CFTC public Socrata API, no key needed)
//
// GET /api/macro
// -> { dxy, yields, cot: { eur, gold }, outlook: [ "...", "..." ] }
//
// Needs env vars: TWELVE_DATA_API_KEY (already set for quote.js) and FRED_API_KEY
// (free — register at https://fred.stlouisfed.org/docs/api/api_key.html).

module.exports = async function handler(req, res) {
  const tdKey = process.env.TWELVE_DATA_API_KEY;
  const fredKey = process.env.FRED_API_KEY;

  if (!tdKey) {
    res.status(500).json({ error: "Server is missing TWELVE_DATA_API_KEY." });
    return;
  }
  if (!fredKey) {
    res.status(500).json({
      error:
        "Server is missing FRED_API_KEY. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html and add it in Vercel → Project → Settings → Environment Variables.",
    });
    return;
  }

  try {
    const [dxy, yields, cotEur, cotGold] = await Promise.all([
      getDxyProxy(tdKey),
      getYields(fredKey),
      getCot("EURO FX - CHICAGO MERCANTILE EXCHANGE"),
      getCot("GOLD - COMMODITY EXCHANGE INC."),
    ]);

    const outlook = buildOutlook({ dxy, yields, cotEur, cotGold });

    // Real yields and COT only update daily/weekly — cache generously.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
    res.status(200).json({
      asOf: new Date().toISOString(),
      dxy,
      yields,
      cot: { eur: cotEur, gold: cotGold },
      outlook,
    });
  } catch (err) {
    res.status(502).json({ error: `Macro data lookup failed: ${err.message}` });
  }
};

// ---------- DXY proxy from live FX crosses ----------
async function getDxyProxy(key) {
  const pairs = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/CAD", "USD/SEK", "USD/CHF"];
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(
    pairs.join(",")
  )}&apikey=${key}`;
  const r = await fetch(url);
  const data = await r.json();

  const price = (sym) => {
    const entry = data[sym];
    const p = entry && parseFloat(entry.price);
    if (!p || Number.isNaN(p)) throw new Error(`Twelve Data returned no price for ${sym}`);
    return p;
  };

  const eurusd = price("EUR/USD");
  const usdjpy = price("USD/JPY");
  const gbpusd = price("GBP/USD");
  const usdcad = price("USD/CAD");
  const usdsek = price("USD/SEK");
  const usdchf = price("USD/CHF");

  // Standard ICE DXY formula (weights: EUR 57.6%, JPY 13.6%, GBP 11.9%, CAD 9.1%, SEK 4.2%, CHF 3.6%)
  const value =
    50.14348112 *
    Math.pow(eurusd, -0.576) *
    Math.pow(usdjpy, 0.136) *
    Math.pow(gbpusd, -0.119) *
    Math.pow(usdcad, 0.091) *
    Math.pow(usdsek, 0.042) *
    Math.pow(usdchf, 0.036);

  return {
    value: Number(value.toFixed(3)),
    inputs: { eurusd, usdjpy, gbpusd, usdcad, usdsek, usdchf },
  };
}

// ---------- US Treasury yields from FRED ----------
async function getYields(key) {
  const series = async (id) => {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=10`;
    const r = await fetch(url);
    const data = await r.json();
    const obs = (data.observations || []).filter((o) => o.value !== ".");
    if (!obs.length) throw new Error(`No FRED data returned for ${id}`);
    return { date: obs[0].date, value: parseFloat(obs[0].value) };
  };

  const [nominal10y, real10y] = await Promise.all([series("DGS10"), series("DFII10")]);
  return { nominal10y, real10y };
}

// ---------- CFTC Commitments of Traders (public, no key) ----------
async function getCot(marketName) {
  const url =
    `https://publicreporting.cftc.gov/resource/6dca-aqww.json?` +
    `$where=${encodeURIComponent(`market_and_exchange_names='${marketName}'`)}` +
    `&$order=report_date_as_yyyy_mm_dd DESC&$limit=156`; // ~3 years of weekly reports

  const r = await fetch(url);
  if (!r.ok) throw new Error(`CFTC lookup failed for ${marketName} (HTTP ${r.status})`);
  const rows = await r.json();
  if (!rows.length) throw new Error(`No CFTC rows returned for ${marketName}`);

  const netOf = (row) =>
    parseFloat(row.noncomm_positions_long_all || 0) - parseFloat(row.noncomm_positions_short_all || 0);

  const nets = rows.map(netOf);
  const latest = nets[0];
  const sorted = [...nets].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= latest);
  const percentile3y = Math.round((rank / (sorted.length - 1)) * 100);

  return {
    reportDate: rows[0].report_date_as_yyyy_mm_dd,
    netNonCommercial: Math.round(latest),
    percentile3y, // 0 = most net-short in the trailing 3 years, 100 = most net-long
  };
}

// ---------- plain-English synthesis ----------
function buildOutlook({ dxy, yields, cotEur, cotGold }) {
  const lines = [];

  lines.push(
    `US 10-year real yield is ${yields.real10y.value.toFixed(2)}% (as of ${yields.real10y.date}). ` +
      `Falling real yields are historically a gold tailwind; rising real yields are a headwind — gold has no yield of its own, so it competes directly with what bonds pay.`
  );

  lines.push(
    `Dollar Index proxy is ${dxy.value.toFixed(2)}. EUR/USD is roughly 58% of this basket, so this largely mirrors EUR/USD's own trend, inverted — a rising DXY usually means a falling EUR/USD.`
  );

  lines.push(positioningLine("EUR futures", cotEur));
  lines.push(positioningLine("Gold futures", cotGold));

  return lines;
}

function positioningLine(label, cot) {
  if (cot.percentile3y >= 80) {
    return `${label} positioning is stretched net-long (${cot.percentile3y}th percentile of the last 3 years, as of ${cot.reportDate}) — crowded positioning like this can unwind fast if sentiment turns, producing sharper-than-usual pullbacks.`;
  }
  if (cot.percentile3y <= 20) {
    return `${label} positioning is stretched net-short (${cot.percentile3y}th percentile of the last 3 years, as of ${cot.reportDate}) — room for a squeeze higher if sentiment turns.`;
  }
  return `${label} positioning is unremarkable (${cot.percentile3y}th percentile of the last 3 years, as of ${cot.reportDate}) — no positioning extreme to lean on either way right now.`;
}
