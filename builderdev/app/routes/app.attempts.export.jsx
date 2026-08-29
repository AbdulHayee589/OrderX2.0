import { authenticate } from "../shopify.server";
import { backendGet } from "../server/backend.server";
import { formatDateTime } from "../utils/format";
import { getMerchantTimezone } from "../utils/shopTimezone.server";

const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

function parsePositiveInt(value, fallback, options = {}) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.isFinite(options.min) ? options.min : 1;
  const max = Number.isFinite(options.max)
    ? options.max
    : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, min), max);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function clip(value, maxLen = 140) {
  const text = String(value ?? "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function changeStateLabel(state) {
  const current = String(state || "").trim();
  if (current === "choose_type") return "Change requested";
  if (current === "awaiting_details") return "Awaiting change details";
  if (current === "reconfirm_sent") return "Reconfirm sent";
  return "";
}

function getLastChange(attempt) {
  const changes = Array.isArray(attempt?.changeRequests)
    ? attempt.changeRequests
    : [];
  return changes.length ? changes[changes.length - 1] : null;
}

function buildRequestedParts(attempt) {
  const proposedParts = [];
  if (attempt?.changeProposedName) {
    proposedParts.push(`Name: ${clip(attempt.changeProposedName, 80)}`);
  }

  const qtyOverrides = Array.isArray(attempt?.changeProposedQuantityOverrides)
    ? attempt.changeProposedQuantityOverrides
    : [];
  const validQtyOverrides = qtyOverrides
    .map((row) => {
      const quantity = Number(row?.quantity);
      const lineIndex = Number(row?.lineIndex);
      return {
        quantity:
          Number.isFinite(quantity) && quantity > 0
            ? Math.trunc(quantity)
            : null,
        lineIndex: Number.isFinite(lineIndex) ? Math.trunc(lineIndex) : null,
        productLabel: String(row?.productLabel || "").trim(),
      };
    })
    .filter((row) => Number.isFinite(row.quantity) && row.quantity > 0)
    .sort((a, b) => (a.lineIndex ?? 0) - (b.lineIndex ?? 0));

  if (validQtyOverrides.length) {
    for (const row of validQtyOverrides) {
      proposedParts.push(
        row.productLabel
          ? `Qty (${clip(row.productLabel, 70)}): ${row.quantity}`
          : `Qty: ${row.quantity}`,
      );
    }
  } else {
    const proposedQtyRaw = attempt?.changeProposedQuantity;
    const proposedQty =
      typeof proposedQtyRaw === "number"
        ? proposedQtyRaw
        : Number(proposedQtyRaw);
    if (Number.isFinite(proposedQty) && proposedQty > 0) {
      const qtyProduct = String(
        attempt?.changeProposedQuantityProductLabel || "",
      ).trim();
      proposedParts.push(
        qtyProduct
          ? `Qty (${clip(qtyProduct, 70)}): ${Math.trunc(proposedQty)}`
          : `Qty: ${Math.trunc(proposedQty)}`,
      );
    }
  }

  if (attempt?.changeProposedAmountText) {
    proposedParts.push(
      `New amount: ${clip(attempt.changeProposedAmountText, 60)}`,
    );
  }
  if (attempt?.changeProposedAddress) {
    proposedParts.push(`Address: ${clip(attempt.changeProposedAddress, 180)}`);
  }
  return proposedParts;
}

function buildAttemptsCsv(attempts, merchantTimezone) {
  const rows = Array.isArray(attempts) ? attempts : [];
  const header = [
    "createdAtIso",
    "displayTime",
    "attemptTimezone",
    "orderName",
    "stage",
    "status",
    "changeState",
    "changeStateLabel",
    "customerName",
    "phoneE164",
    "storeCountryCode",
    "recipientCountryCodeResolved",
    "crossBorderRateApplied",
    "orderAmount",
    "orderCurrency",
    "waTemplateUsed",
    "requestedSummary",
    "changeProposedName",
    "changeProposedAddress",
    "changeProposedQuantity",
    "changeProposedQuantityProductLabel",
    "changeProposedAmountText",
    "changeRequestsCount",
    "lastChangeKind",
    "lastChangeText",
    "lastChangeResolution",
    "lastError",
  ];

  return [
    header.map(csvEscape).join(","),
    ...rows.map((item) => {
      const lastChange = getLastChange(item);
      const requestedParts = buildRequestedParts(item);
      return [
        item?.createdAt ? new Date(item.createdAt).toISOString() : "",
        item?.createdAt
          ? formatDateTime(item.createdAt, item?.timezone || merchantTimezone)
          : "",
        item?.timezone || "",
        item?.orderName || "",
        item?.stage || "",
        item?.status || "",
        item?.changeState || "",
        changeStateLabel(item?.changeState),
        item?.customerName || "",
        item?.phoneE164 || "",
        item?.storeCountryCode || "",
        item?.recipientCountryCodeResolved || "",
        item?.crossBorderRateApplied ? "yes" : "no",
        item?.orderAmount ?? "",
        item?.orderCurrency ?? "",
        item?.waTemplateUsed || "",
        requestedParts.join(" | "),
        item?.changeProposedName || "",
        item?.changeProposedAddress || "",
        item?.changeProposedQuantity ?? "",
        item?.changeProposedQuantityProductLabel || "",
        item?.changeProposedAmountText || "",
        Array.isArray(item?.changeRequests) ? item.changeRequests.length : 0,
        lastChange?.kind || "",
        lastChange?.text || "",
        lastChange?.resolution || "",
        item?.lastError || "",
      ]
        .map(csvEscape)
        .join(",");
    }),
  ].join("\n");
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const merchantTimezone = await getMerchantTimezone(admin);
  const url = new URL(request.url);

  const range = String(url.searchParams.get("range") || "this_cycle").trim();
  const q = String(url.searchParams.get("q") || "").trim();
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 25, {
    min: 10,
    max: 100,
  });

  const exportParams = new URLSearchParams();
  exportParams.set("range", range);
  exportParams.set("page", "1");
  exportParams.set("pageSize", String(pageSize));
  exportParams.set("export", "1");
  if (q) exportParams.set("q", q);

  const attemptsExportRaw = await backendGet(
    `/api/attempts?${exportParams.toString()}`,
    shop,
  ).catch(() => ({ items: [] }));
  const attemptsExport = toObject(attemptsExportRaw);
  const csv = buildAttemptsCsv(toArray(attemptsExport.items), merchantTimezone);
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cod_attempts_${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};

export default function AttemptsExportResource() {
  return null;
}
