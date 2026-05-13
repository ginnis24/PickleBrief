// Netlify Function: positions
// GET    /api/positions    → { positions: [{ticker, shares, avgCost, sector, notes, addedAt}, ...] }
// POST   /api/positions    → { action: "add"|"remove"|"clear"|"bulk-set", ticker?, shares?, avgCost?, sector?, notes?, addedAt?, positions? }
// DELETE /api/positions    → clears the list
//
// User-added positions (the "+ Add position" modal in the dashboard).
// Brief-driven positions come from briefData.snapshot.rows and are never stored here.
//
// Storage: Netlify Blobs (key "positions" in store "picklebrief")
// Limits:  max 100 positions; ticker must match /^[A-Z][A-Z0-9.\-]{0,7}$/; notes ≤ 500 chars
// Auth:    none — sanity validation only (see README)

import { getStore } from "@netlify/blobs";

const STORE_NAME = "picklebrief";
const KEY = "positions";
const MAX_POSITIONS = 100;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,7}$/;

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
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 8);
}

function sanitizePosition(p) {
  if (!p || typeof p !== "object") return null;
  const ticker = normalizeTicker(p.ticker);
  if (!TICKER_RE.test(ticker)) return null;
  const shares = Number(p.shares);
  const avgCost = Number(p.avgCost);
  if (!isFinite(shares) || shares <= 0) return null;
  if (!isFinite(avgCost) || avgCost <= 0) return null;
  return {
    ticker,
    shares,
    avgCost,
    sector: p.sector ? String(p.sector).slice(0, 40) : null,
    notes: p.notes ? String(p.notes).slice(0, 500) : null,
    addedAt: Number.isFinite(Number(p.addedAt)) ? Number(p.addedAt) : Date.now(),
  };
}

async function readList(store) {
  const raw = await store.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Re-sanitize on read so any older / drifted records get normalized
    return parsed.map(sanitizePosition).filter(Boolean);
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
      const positions = await readList(store);
      return json({ positions });
    }

    if (req.method === "DELETE") {
      await writeList(store, []);
      return json({ ok: true, positions: [] });
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
        return json({ ok: true, positions: [] });
      }

      if (action === "add") {
        const incoming = sanitizePosition({
          ticker: body.ticker,
          shares: body.shares,
          avgCost: body.avgCost,
          sector: body.sector,
          notes: body.notes,
          addedAt: body.addedAt,
        });
        if (!incoming) {
          return json({ error: "Invalid position (ticker, shares > 0, avgCost > 0 required)" }, 400);
        }
        // Upsert by ticker — update in place if it already exists
        const idx = list.findIndex((x) => x.ticker === incoming.ticker);
        if (idx >= 0) {
          // Preserve original addedAt on update
          list[idx] = { ...incoming, addedAt: list[idx].addedAt || incoming.addedAt };
        } else {
          if (list.length >= MAX_POSITIONS) {
            return json({ error: `Max ${MAX_POSITIONS} positions` }, 400);
          }
          list.unshift(incoming);
        }
        await writeList(store, list);
        return json({ ok: true, positions: list });
      }

      if (action === "remove") {
        const ticker = normalizeTicker(body.ticker);
        if (!TICKER_RE.test(ticker)) {
          // Idempotent: a remove for an invalid ticker is a no-op, not an error
          return json({ ok: true, positions: list });
        }
        const next = list.filter((x) => x.ticker !== ticker);
        await writeList(store, next);
        return json({ ok: true, positions: next });
      }

      if (action === "bulk-set") {
        // Used for one-time migration from localStorage. Replaces the whole list.
        if (!Array.isArray(body.positions)) {
          return json({ error: "bulk-set requires positions array" }, 400);
        }
        const cleaned = body.positions.map(sanitizePosition).filter(Boolean).slice(0, MAX_POSITIONS);
        // Dedupe by ticker, keeping the first occurrence
        const seen = {};
        const deduped = [];
        for (const p of cleaned) {
          if (seen[p.ticker]) continue;
          seen[p.ticker] = true;
          deduped.push(p);
        }
        await writeList(store, deduped);
        return json({ ok: true, positions: deduped });
      }

      return json({ error: "Unknown action" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
};

export const config = {
  path: "/api/positions",
};
