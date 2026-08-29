import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

export const loader = async () => {
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="dns-prefetch" href="//cdn.shopify.com" />
        <link rel="preconnect" href="https://cdn.shopify.com" crossOrigin="" />
        {apiKey ? (
          <>
            <meta name="shopify-api-key" content={apiKey} />
            <script
              src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
              data-api-key={apiKey}
            />
          </>
        ) : null}
        <style>{`html, body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }`}</style>
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
