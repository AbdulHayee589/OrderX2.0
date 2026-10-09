import { boundary } from "@shopify/shopify-app-react-router/server";
import { addDocumentResponseHeaders } from "../shopify.server";
import { resolveRequestAppOrigin } from "../utils/publicOrigin";

const APP_BRIDGE_CDN = "https://cdn.shopify.com/shopifycloud/app-bridge.js";

function tryParseUrl(raw, base) {
  try {
    return new URL(raw);
  } catch {
    try {
      return new URL(decodeURIComponent(raw));
    } catch {
      try {
        return new URL(raw, base);
      } catch {
        return null;
      }
    }
  }
}

function isSessionTokenPath(pathname = "") {
  return (
    pathname.endsWith("/app-auth/session-token") ||
    pathname.endsWith("/auth/session-token")
  );
}

function resolveTargetUrl(request) {
  const requestUrl = new URL(request.url);
  const appUrl = String(process.env.SHOPIFY_APP_URL || "").trim();
  const appOrigin = resolveRequestAppOrigin(
    request,
    appUrl || process.env.APP_URL || "",
  );

  const fallback = (() => {
    if (appOrigin) return new URL("/app", appOrigin);
    return new URL("/app", `${requestUrl.protocol}//${requestUrl.host}`);
  })();

  const base = appOrigin || `${requestUrl.protocol}//${requestUrl.host}`;
  const rawReload = String(
    requestUrl.searchParams.get("shopify-reload") || "",
  ).trim();
  let target = rawReload ? tryParseUrl(rawReload, base) : null;
  if (!target || !["http:", "https:"].includes(target.protocol)) {
    target = new URL(fallback.toString());
  }

  // If we somehow landed on session-token again as the target, unwrap one nested
  // shopify-reload level to break infinite loops.
  for (let i = 0; i < 2 && isSessionTokenPath(target.pathname); i += 1) {
    const nestedRaw = String(
      target.searchParams.get("shopify-reload") || "",
    ).trim();
    const nested = nestedRaw ? tryParseUrl(nestedRaw, base) : null;
    if (!nested || !["http:", "https:"].includes(nested.protocol)) break;
    target = nested;
  }

  if (isSessionTokenPath(target.pathname)) {
    target = new URL(fallback.toString());
  }

  // Keep destination on the active app origin in dev/proxy setups.
  if (appOrigin && target.origin !== appOrigin) {
    target = new URL(
      `${appOrigin}${target.pathname}?${target.searchParams.toString()}`,
    );
  }

  const shop =
    requestUrl.searchParams.get("shop") || target.searchParams.get("shop");
  const host =
    requestUrl.searchParams.get("host") || target.searchParams.get("host");
  const embedded =
    requestUrl.searchParams.get("embedded") ||
    target.searchParams.get("embedded") ||
    "1";

  if (shop) target.searchParams.set("shop", shop);
  if (host) target.searchParams.set("host", host);
  target.searchParams.set("embedded", embedded);

  return target;
}

function renderBounceHtml({ apiKey, targetUrl }) {
  const safeApiKey = JSON.stringify(String(apiKey || ""));
  const safeTarget = JSON.stringify(String(targetUrl || "/app"));
  const safeHref = String(targetUrl || "/app")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting back to the app</title>
    <style>
      :root { color-scheme: light; }
      html, body {
        margin: 0;
        height: 100%;
        background: #f6f6f7;
        color: #111827;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        min-height: 100%;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(500px, 92vw);
        background: #fff;
        border: 1px solid #d1d5db;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
        padding: 28px 24px;
        text-align: center;
      }
      h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.3; }
      p { margin: 0; color: #4b5563; line-height: 1.5; }
      .actions { margin-top: 18px; display: flex; justify-content: center; }
      .btn {
        display: inline-block;
        padding: 10px 16px;
        border-radius: 10px;
        border: 1px solid #111827;
        background: #111827;
        color: #fff;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
      }
      .muted { margin-top: 12px; font-size: 12px; color: #6b7280; }
    </style>
    <script data-api-key=${safeApiKey} src="${APP_BRIDGE_CDN}"></script>
  </head>
  <body>
    <main>
      <section class="card" role="status" aria-live="polite">
        <h1>Redirecting back to the app</h1>
        <p>Please wait while we complete billing confirmation.</p>
        <div class="actions">
          <a id="go-back-button" class="btn" href="${safeHref}" target="_top" rel="noopener noreferrer">
            Go back to app
          </a>
        </div>
        <p class="muted">If it does not redirect automatically, click the button above.</p>
      </section>
    </main>
    <script>
      (function () {
        var target = ${safeTarget};
        var started = false;

        function sleep(ms) {
          return new Promise(function (resolve) { setTimeout(resolve, ms); });
        }

        async function getIdToken() {
          for (var i = 0; i < 30; i += 1) {
            try {
              if (window.shopify && typeof window.shopify.idToken === "function") {
                var token = await window.shopify.idToken();
                if (token) return token;
              }
            } catch (e) {}
            await sleep(300);
          }
          return "";
        }

        function navigateTop(destination) {
          try {
            if (window.top && window.top !== window) {
              window.top.location.assign(destination);
              return;
            }
          } catch (e) {}
          try {
            window.location.assign(destination);
          } catch (e) {
            window.location.href = destination;
          }
        }

        async function goToApp() {
          if (started) return;
          started = true;

          var destination = target;
          try {
            var idToken = await getIdToken();
            if (idToken) {
              var u = new URL(destination);
              u.searchParams.set("id_token", idToken);
              destination = u.toString();
            }
          } catch (e) {}

          navigateTop(destination);
        }

        var btn = document.getElementById("go-back-button");
        if (btn) {
          btn.addEventListener("click", function () {
            goToApp();
          });
        }

        setTimeout(goToApp, 300);
      })();
    </script>
  </body>
</html>`;
}

export const loader = async ({ request }) => {
  const targetUrl = resolveTargetUrl(request);

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
  });
  addDocumentResponseHeaders(request, headers);

  return new Response(
    renderBounceHtml({
      apiKey: process.env.SHOPIFY_API_KEY || "",
      targetUrl: targetUrl.toString(),
    }),
    { status: 200, headers },
  );
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
