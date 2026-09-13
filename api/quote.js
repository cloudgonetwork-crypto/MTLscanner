// MTLscanner v1.0.0
// Vercel serverless function — the only place that ever touches the Twelve
// Data API key. The frontend never sees it (keeps it out of page source and
// out of your quota being scraped by strangers).
//
// GET /api/quote?symbol=AAPL
// -> { symbol, live: true, candles: [{date, open, high, low, close, volume}, ...] }

module.exports = async function handler(req, res) {
  const symbol = (req.query.symbol || "").toUpperCase().trim();
  if (!symbol) {
    res.status(400).json({ error: "Missing ?symbol=" });
    return;
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Server is missing TWELVE_DATA_API_KEY. Set it in Vercel → Project → Settings → Environment Variables.",
    });
    return;
  }

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    symbol
  )}&interval=1day&outputsize=300&apikey=${apiKey}`;

  try {
    const r = await fetch(url);
    const data = await r.json();

    if (data.status === "error" || !data.values) {
      res.status(502).json({
        error: data.message || `Twelve Data couldn't return data for "${symbol}".`,
      });
      return;
    }

    // Twelve Data returns newest-first; flip to oldest-first for charting/indicators.
    const candles = data.values
      .map((v) => ({
        date: v.datetime,
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: v.volume ? parseInt(v.volume, 10) : null,
      }))
      .reverse();

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ symbol, live: true, candles });
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach Twelve Data: ${err.message}` });
  }
}
