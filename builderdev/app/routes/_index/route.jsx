import { useEffect, useState } from "react";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

const EMBEDDED_CONTEXT_KEYS = [
  "shop",
  "host",
  "embedded",
  "id_token",
  "session",
];

function shopFromHost(host) {
  const raw = String(host || "").trim();
  if (!raw) return "";

  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const decoded = atob(padded);
    const match = decoded.match(
      /(?:^|\/)([a-z0-9][a-z0-9-]*\.myshopify\.com)(?:\/|$)/i,
    );
    return String(match?.[1] || "").toLowerCase();
  } catch {
    return "";
  }
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const host = String(url.searchParams.get("host") || "").trim();
  const recoveredShop = shopFromHost(host);
  if (!url.searchParams.get("shop") && recoveredShop) {
    url.searchParams.set("shop", recoveredShop);
  }

  if (
    EMBEDDED_CONTEXT_KEYS.some((key) =>
      String(url.searchParams.get(key) || "").trim(),
    )
  ) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();
  const [checkedEmbeddedContext, setCheckedEmbeddedContext] = useState(false);

  useEffect(() => {
    try {
      const stored = String(
        window.sessionStorage.getItem("orderx:embedded-search") || "",
      ).trim();
      const params = new URLSearchParams(stored);
      const shop = String(params.get("shop") || "").trim();
      const host = String(params.get("host") || "").trim();
      if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) && host) {
        window.location.replace(`/app?${params.toString()}`);
        return;
      }
    } catch {
      // Fall through to the standalone login when storage is unavailable.
    }
    setCheckedEmbeddedContext(true);
  }, []);

  if (!checkedEmbeddedContext) {
    return (
      <main className={styles.index} aria-busy="true">
        <div className={styles.loadingCard}>
          <span className={styles.loadingMark}>C</span>
          <h1 className={styles.heading}>Opening OrderX</h1>
          <p className={styles.text}>Returning to your Shopify dashboard...</p>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>OrderX</h1>
        <p className={styles.text}>
          Open OrderX from Shopify Admin, or enter your store domain to
          reconnect securely.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
      </div>
    </main>
  );
}
