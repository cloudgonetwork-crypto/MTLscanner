// MTLscanner v1.1.0
// Vercel serverless function — the only place that touches the Alpha Vantage
// API key. This is the "investor" half of the picture: valuation,
// profitability, growth, and dividends — sitting alongside the
// trend/momentum read that api/quote.js provides for traders.
//
// GET /api/fundamentals?symbol=AAPL
// -> { symbol, available: true, data: {...} }
// -> { symbol, available: false, reason: "..." }   (ETF/fund, bad symbol, or daily quota hit)

module.exports = async function handler(req, res) {
  const symbol = (req.query.symbol || "").toUpperCase().trim();
  if (!symbol) {
    res.status(400).json({ error: "Missing ?symbol=" });
    return;
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Server is missing ALPHA_VANTAGE_API_KEY. Set it in Vercel → Project → Settings → Environment Variables.",
    });
    return;
  }

  const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${apiKey}`;

  try {
    const r = await fetch(url);
    const raw = await r.json();

    // Alpha Vantage doesn't use HTTP error codes for this — it always
    // returns 200 with a plain-JSON message instead.
    if (raw.Note || raw.Information) {
      res.status(200).json({
        symbol,
        available: false,
        reason: "Free fundamentals quota reached for today (Alpha Vantage caps free keys at 25 requests/day) — try again later.",
      });
      return;
    }

    if (!raw.Symbol || Object.keys(raw).length === 0) {
      res.status(200).json({
        symbol,
        available: false,
        reason: "No fundamentals for this symbol — common for ETFs and funds, which don't have a P/E ratio, earnings, etc.",
      });
      return;
    }

    // Fundamentals barely move intraday and the free quota is tight, so
    // cache hard: 12 hours fresh, serve stale up to a week while refreshing.
    res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=604800");
    res.status(200).json({
      symbol,
      available: true,
      data: {
        name: raw.Name,
        sector: raw.Sector,
        industry: raw.Industry,
        description: raw.Description,
        marketCap: raw.MarketCapitalization,
        peRatio: raw.PERatio,
        forwardPE: raw.ForwardPE,
        pegRatio: raw.PEGRatio,
        eps: raw.EPS,
        dividendYield: raw.DividendYield,
        profitMargin: raw.ProfitMargin,
        returnOnEquity: raw.ReturnOnEquityTTM,
        revenueGrowthYoY: raw.QuarterlyRevenueGrowthYOY,
        earningsGrowthYoY: raw.QuarterlyEarningsGrowthYOY,
        week52High: raw["52WeekHigh"],
        week52Low: raw["52WeekLow"],
        beta: raw.Beta,
        analystTargetPrice: raw.AnalystTargetPrice,
      },
    });
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach Alpha Vantage: ${err.message}` });
  }
}
