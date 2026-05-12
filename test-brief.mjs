// Netlify Function: watchlist
// GET    /api/watchlist           → { tickers: [{ticker, note, added}] }
// POST   /api/watchlist           → { action: "add"|"remove"|"clear", ticker?, note? }
// DELETE /api/watchlist           → clears the list
//
// Storage: Netlify Blobs (key "watchlist" in store "picklebrief")
// Limits:  max 50 tickers; ticker must match /^[A-Z.\-]{1,6}$/; note ≤ 120 chars
// Auth:    none — sanity validation only (see README)

import { getStore } from "@netlify/blobs";

const STORE_NAME = "picklebrief";
const KEY = "watchlist";
const MAX_TICKERS = 50;
const TICKER_RE = /^[A-Z.\-]{1,6}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function normalizeTicker(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 6);
}

async function readList(store) {
  const raw = await store.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeList(store, list) {
  await store.set(KEY, JSON.stringify(list));
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS });
  }

  const store = getStore(STORE_NAME);

  try {
    if (req.method === "GET") {
      const tickers = await readList(store);
      return json({ tickers });
    }

    if (req.method === "DELETE") {
      await writeList(store, []);
      return json({ ok: true, tickers: [] });
    }

    if (req.method === "POST") {
      let body = {};
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const action = String(body.action || "").toLowerCase();
      const list = await readList(store);

      if (action === "clear") {
        await writeList(store, []);
        return json({ ok: true, tickers: [] });
      }

      if (action === "add") {
        const ticker = normalizeTicker(body.ticker);
        if (!TICKER_RE.test(ticker)) {
          return json({ error: "Invalid ticker" }, 400);
        }
        const note = String(body.note || "").slice(0, 120);
        // Dedupe — update note if already present
        const idx = list.findIndex((x) => x.ticker === ticker);
        if (idx >= 0) {
          list[idx].note = note;
        } else {
          if (list.length >= MAX_TICKERS) {
            return json({ error: `Max ${MAX_TICKERS} tickers` }, 400);
          }
          list.unshift({ ticker, note, added: new Date().toISOString() });
        }
        await writeList(store, list);
        return json({ ok: true, tickers: list });
      }

      if (action === "remove") {
        const ticker = normalizeTicker(body.ticker);
        if (!TICKER_RE.test(ticker)) {
          // Idempotent: a remove for an invalid ticker is a no-op, not an error
          return json({ ok: true, tickers: list });
        }
        const next = list.filter((x) => x.ticker !== ticker);
        await writeList(store, next);
        return json({ ok: true, tickers: next });
      }

      return json({ error: "Unknown action" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
};

export const config = {
  path: "/api/watchlist",
};
