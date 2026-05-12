// netlify/edge-functions/password-gate.js
//
// Single shared password in front of the entire site.
//
// Flow:
//   GET /              → no cookie → render password form
//   POST / (form)      → check password, set 30-day cookie, redirect to /
//   GET / (with cookie)→ pass through to the static site
//
// The /api/* endpoints are also gated, so the dashboard can only talk to
// the backend after you've authenticated. Logout: clear the pb-auth cookie.
//
// Environment variable: SITE_PASSWORD (set in Netlify dashboard).
// If not set, the function fails closed (refuses access).

const COOKIE_NAME = "pb-auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SALT = "picklebrief-v1"; // changes invalidate all existing sessions

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function loginPage(error = "") {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Picklebrief</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0e1a;
      --surface: #131826;
      --ink: #e8e2cf;
      --ink-muted: #8a8675;
      --gold: #d4a76a;
      --hairline: rgba(232, 226, 207, 0.08);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      background:
        radial-gradient(1200px 800px at 80% -10%, rgba(212, 167, 106, 0.08), transparent 60%),
        radial-gradient(900px 600px at -10% 30%, rgba(124, 224, 168, 0.04), transparent 70%),
        linear-gradient(180deg, #0a0e1a, #050811);
      color: var(--ink);
      font-family: ui-serif, Georgia, serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .gate {
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 16px;
      padding: 40px 36px;
      max-width: 380px;
      width: 100%;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }
    .brand {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 28px;
    }
    .brand-dot {
      width: 32px; height: 32px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, #e8c285, #8a6634);
    }
    .brand-text {
      font-size: 18px;
      font-weight: 500;
      letter-spacing: 0.3px;
    }
    .brand-text em { font-style: italic; color: var(--gold); font-weight: 300; }
    h1 {
      font-size: 22px;
      font-weight: 400;
      margin: 0 0 8px;
    }
    p.sub {
      font-size: 13px;
      color: var(--ink-muted);
      margin: 0 0 24px;
      line-height: 1.5;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    label {
      display: block;
      font-size: 10px;
      color: var(--ink-muted);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 8px;
      font-family: ui-monospace, monospace;
    }
    input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      background: rgba(232, 226, 207, 0.025);
      color: var(--ink);
      border: 1px solid var(--hairline);
      border-radius: 8px;
      font-size: 15px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus { border-color: var(--gold); }
    button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      background: var(--gold);
      color: #1a1208;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      cursor: pointer;
      font-family: ui-monospace, monospace;
      transition: background 0.15s;
    }
    button:hover { background: #e0b87a; }
    .error {
      margin-top: 16px;
      color: #f87a8d;
      font-size: 12.5px;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
  </style>
</head>
<body>
  <form class="gate" method="POST" action="/__auth">
    <div class="brand">
      <div class="brand-dot"></div>
      <div class="brand-text">The Daily <em>Brief</em></div>
    </div>
    <h1>Sign in</h1>
    <p class="sub">Enter the access password to view your portfolio dashboard.</p>
    <label for="pw">Password</label>
    <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required />
    <button type="submit">Unlock</button>
    ${error ? `<div class="error">${error}</div>` : ""}
  </form>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const password = Netlify.env.get("SITE_PASSWORD");

  // Fail closed: if no password is configured, block everything
  if (!password) {
    return new Response(
      "Site password not configured. Set SITE_PASSWORD in Netlify environment variables.",
      { status: 503, headers: { "content-type": "text/plain" } }
    );
  }

  const expectedHash = await sha256(SALT + password);

  // Handle auth submission
  if (path === "/__auth" && req.method === "POST") {
    const form = await req.formData();
    const submitted = String(form.get("password") || "");
    if (submitted && (await sha256(SALT + submitted)) === expectedHash) {
      return new Response("", {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE_NAME}=${expectedHash}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    return loginPage("Wrong password.");
  }

  // Handle logout
  if (path === "/__logout") {
    return new Response("", {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // Check existing session
  const cookie = getCookie(req, COOKIE_NAME);
  if (cookie === expectedHash) {
    // Authenticated — let the request through to the static site / functions
    return context.next();
  }

  // Not authenticated. API calls get 401 JSON; everything else gets the login page.
  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  return loginPage();
};

export const config = {
  path: "/*",
};
