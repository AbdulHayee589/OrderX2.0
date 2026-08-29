import { useEffect, useMemo } from "react";
import { useLocation } from "react-router";

const MESSAGE_TYPE = "ORDERX_BYON_META_CALLBACK";
const MESSAGE_STORAGE_KEY = "ORDERX_BYON_META_CALLBACK_PAYLOAD";

function parseParams(raw) {
  const out = {};
  const p = new URLSearchParams(raw || "");
  for (const [k, v] of p.entries()) {
    out[k] = v;
  }
  return out;
}

export default function ByonMetaCallbackPage() {
  const location = useLocation();

  const payload = useMemo(() => {
    const fromQuery = parseParams(location.search);
    const fromHash = parseParams(
      String(location.hash || "").startsWith("#")
        ? String(location.hash || "").slice(1)
        : location.hash,
    );
    return { ...fromHash, ...fromQuery };
  }, [location.hash, location.search]);

  useEffect(() => {
    const messagePayload = {
      type: MESSAGE_TYPE,
      payload: {
        ...payload,
        redirect_uri: window.location.origin + window.location.pathname,
      },
      at: Date.now(),
    };

    try {
      window.localStorage.setItem(
        MESSAGE_STORAGE_KEY,
        JSON.stringify(messagePayload),
      );
    } catch {
      // ignore
    }

    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(messagePayload, "*");
      }
    } catch {
      // ignore
    }

    let closeAttempts = 0;
    const tryClose = () => {
      closeAttempts += 1;
      try {
        window.close();
      } catch {
        // ignore
      }
      if (closeAttempts >= 12) return;
      if (!window.closed) {
        window.setTimeout(tryClose, 350);
      }
    };
    const timer = window.setTimeout(tryClose, 700);

    return () => window.clearTimeout(timer);
  }, [payload]);

  const hasError = !!payload.error;
  const hasCode = !!payload.code;

  return (
    <div
      style={{
        margin: 0,
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        background: "#f6f6f7",
        color: "#111827",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 20,
        }}
      >
        <h1 style={{ margin: "0 0 10px", fontSize: 18 }}>
          {hasError
            ? "Meta connection returned an error"
            : hasCode
              ? "Meta connection received"
              : "Waiting for Meta callback"}
        </h1>
        <p style={{ margin: 0, lineHeight: 1.4 }}>
          {hasError
            ? payload.error_description || payload.error
            : hasCode
              ? "You can close this window. OrderX will continue setup in the app."
              : "If this window does not close automatically, return to OrderX."}
        </p>
      </div>
    </div>
  );
}
