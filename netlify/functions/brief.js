// Netlify Function: brief
// GET    /api/brief    → { brief: <briefJson> | null, updated_at: <iso> | null }
// PUT    /api/brief    → body is the brief JSON object; stored as the latest brief
// POST   /api/brief    → same as PUT (some clients can't send PUT)
// DELETE /api/brief    → clears the stored brief
//
// Storage: Netlify Blobs (key "brief-latest" + "brief-latest-meta" in store "picklebrief")
// Auth:    none — sanity validation only, same posture as watchlist/research-deleted
//
// Why this exists:
//   The dashboard used to depend on each device clicking "Load brief" with a file
//   in hand. That meant mobile devices showed whatever they'd loaded last, even
//   if a fresher brief had been loaded on desktop. With this endpoint, the first
//   device to load the brief.json file PUTs it here, and every other device pulls
//   it on page load. One source of truth, cross-device.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "picklebrief";
const BRIEF_KEY = "brief-latest";
const META_KEY = "brief-latest-meta";

// Hard cap to keep blob storage sane. A typical fully-populated brief is ~150KB;
// 2MB leaves a lot of headroom while still rejecting accidental huge payloads.
const MAX_BYTES = 2 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function readBrief(store) {
  const raw = await store.get(BRIEF_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readMeta(store) {
  const raw = await store.get(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeBrief(store, brief) {
  const serialized = JSON.stringify(brief);
  if (serialized.length > MAX_BYTES) {
    const err = new Error(`Brief too large (${serialized.length} bytes, max ${MAX_BYTES})`);
    err.code = "TOO_LARGE";
    throw err;
  }
  const meta = {
    updated_at: new Date().toISOString(),
    brief_date: (brief && brief.meta && brief.meta.brief_date) || null,
    schema_version: (brief && brief.schema_version) || null,
    bytes: serialized.length,
  };
  // Write both. If meta write fails after brief write, next GET will still
  // return the brief; meta is best-effort metadata.
  await store.set(BRIEF_KEY, serialized);
  await store.set(META_KEY, JSON.stringify(meta));
  return meta;
}

async function clearBrief(store) {
  // delete() is the correct API per @netlify/blobs but if it's not available
  // for some reason, overwriting with empty string + null meta is equivalent
  // for our read path (readBrief returns null on parse failure).
  try {
    await store.delete(BRIEF_KEY);
    await store.delete(META_KEY);
  } catch {
    await store.set(BRIEF_KEY, "");
    await store.set(META_KEY, "");
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS });
  }

  const store = getStore(STORE_NAME);

  try {
    if (req.method === "GET") {
      const brief = await readBrief(store);
      const meta = await readMeta(store);
      return json({
        brief,
        updated_at: meta ? meta.updated_at : null,
        brief_date: meta ? meta.brief_date : null,
        bytes: meta ? meta.bytes : null,
      });
    }

    if (req.method === "DELETE") {
      await clearBrief(store);
      return json({ ok: true });
    }

    if (req.method === "PUT" || req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      // Accept either the raw brief object, or { brief: {...} } wrapper.
      const brief = body && typeof body === "object" && body.brief && typeof body.brief === "object"
        ? body.brief
        : body;

      // Minimum sanity: must be an object with a meta block. The dashboard
      // expects schema_version, meta, portfolio, etc. — if those are missing
      // it's almost certainly not a brief.
      if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
        return json({ error: "Body must be a brief object" }, 400);
      }
      if (!brief.meta || typeof brief.meta !== "object") {
        return json({ error: "Brief is missing meta block" }, 400);
      }

      try {
        const meta = await writeBrief(store, brief);
        return json({ ok: true, ...meta });
      } catch (err) {
        if (err.code === "TOO_LARGE") return json({ error: err.message }, 413);
        throw err;
      }
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
};

export const config = {
  path: "/api/brief",
};
