// Netlify Function: research-deleted
// GET    /api/research-deleted    → { tickers: ["AMD", "MU", ...] }
// POST   /api/research-deleted    → { action: "add"|"remove"|"clear", ticker? }
// DELETE /api/research-deleted    → clears the list
//
// Used by the dashboard to remember which research cards the user × dismissed,
// so deletions sync across devices.
//
// Storage: Netlify Blobs (key "research-deleted" in store "picklebrief")

import { getStore } from "@netlify/blobs";

const STORE_NAME = "picklebrief";
const KEY = "research-deleted";
const MAX_TICKERS = 100;
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
    return Array.isArray(parsed) ? parsed.filter((t) => TICKER_RE.test(t)) : [];
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
        if (list.indexOf(ticker) === -1) {
          if (list.length >= MAX_TICKERS) {
            return json({ error: `Max ${MAX_TICKERS} tickers` }, 400);
          }
          list.push(ticker);
        }
        await writeList(store, list);
        return json({ ok: true, tickers: list });
      }

      if (action === "remove") {
        const ticker = normalizeTicker(body.ticker);
        const next = list.filter((t) => t !== ticker);
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
  path: "/api/research-deleted",
};
