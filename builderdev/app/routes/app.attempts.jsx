import { useEffect, useMemo, useState } from "react";
import { Form, useFetcher, useLoaderData, useLocation } from "react-router";
import { Modal, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet, backendPost } from "../server/backend.server";
import { UsageWidget, AttemptsAnalytics } from "../components/AnalyticsWidgets";
import {
  EmptyState,
  MetricTile,
  PageTitle,
  SectionDivider,
  SurfaceCard,
  surface,
} from "../components/AppSurface";
import { withShopParams } from "../utils/embedded";
import { formatDateTime } from "../utils/format";
import { getMerchantTimezone } from "../utils/shopTimezone.server";
import { shouldShowPkrInfo } from "../utils/billingPresentation";

const RANGE_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "last_week", label: "Last Week" },
  { value: "this_cycle", label: "This Cycle" },
  { value: "last_30_days", label: "Last 30 Days" },
  { value: "last_6_months", label: "Last 6 Months" },
  { value: "last_12_months", label: "Last 12 Months" },
];
const PAGE_SIZE_OPTIONS = [25, 50, 100];
const ORDER_PAGE_SIZE_OPTIONS = [10, 25, 50];

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

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
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
  const page = parsePositiveInt(url.searchParams.get("page"), 1, {
    min: 1,
    max: 10000,
  });
  const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 25, {
    min: 10,
    max: 100,
  });

  const attemptsParams = new URLSearchParams();
  attemptsParams.set("range", range);
  attemptsParams.set("page", String(page));
  attemptsParams.set("pageSize", String(pageSize));
  if (q) attemptsParams.set("q", q);

  if (url.searchParams.get("download") === "csv") {
    const exportParams = new URLSearchParams(attemptsParams);
    exportParams.set("export", "1");
    const attemptsExportRaw = await backendGet(
      `/api/attempts?${exportParams.toString()}`,
      shop,
    ).catch(() => ({ items: [] }));
    const attemptsExport = toObject(attemptsExportRaw);
    const csv = buildAttemptsCsv(
      toArray(attemptsExport.items),
      merchantTimezone,
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cod_attempts_${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const [usageRaw, attemptsRaw] = await Promise.all([
    backendGet("/api/usage", shop).catch(() => null),
    backendGet(`/api/attempts?${attemptsParams.toString()}`, shop).catch(
      () => ({ items: [], pagination: {}, filters: {}, summary: {} }),
    ),
  ]);

  const usage = toObject(usageRaw);
  const attemptsView = toObject(attemptsRaw);

  return {
    billing: usage?.billing || null,
    usage,
    attemptsView,
    merchantTimezone,
    filters: {
      range,
      q,
      page,
      pageSize,
    },
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "trigger") {
    const attemptId = String(form.get("attemptId") || "").trim();
    if (!attemptId) return { ok: false, error: "Missing attemptId" };

    try {
      await backendPost("/api/attempts/trigger", shop, { attemptId });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || "Failed to trigger" };
    }
  }

  if (intent === "scheduleForOrder") {
    const orderLookup = String(form.get("orderLookup") || "").trim();
    if (!orderLookup) return { ok: false, error: "Order name is required" };
    const when = String(form.get("when") || "").trim();
    try {
      await backendPost("/api/attempts/trigger", shop, {
        orderLookup,
        ...(when ? { when } : {}),
      });
      return { ok: true, intent: "scheduleForOrder" };
    } catch (e) {
      return { ok: false, error: e?.message || "Failed to schedule attempt" };
    }
  }

  if (intent === "scheduleOrders") {
    const orderGids = Array.from(
      new Set(
        form
          .getAll("orderGids")
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    );
    if (!orderGids.length) {
      return { ok: false, error: "Select at least one order" };
    }
    const when = String(form.get("when") || "").trim();
    try {
      const response = await backendPost("/api/attempts/schedule-bulk", shop, {
        orderGids,
        ...(when ? { when } : {}),
      });
      return response;
    } catch (e) {
      return { ok: false, error: e?.message || "Failed to schedule orders" };
    }
  }

  return { ok: false, error: "Unknown intent" };
};

function Badge({ status }) {
  let tone = "subdued";
  if (status === "confirmed") tone = "success";
  if (status === "cancelled") tone = "critical";
  if (["pending", "wa_sent", "scheduled"].includes(status)) tone = "warning";
  if (status === "failed") tone = "critical";
  if (status === "skipped") tone = "subdued";
  return <s-badge tone={tone}>{status}</s-badge>;
}

function attemptBorder(status) {
  if (status === "confirmed") return "#059669";
  if (status === "cancelled" || status === "failed") return "#dc2626";
  if (["scheduled", "pending", "wa_sent"].includes(status)) return "#d97706";
  return "#94a3b8";
}

const filterPanelStyle = {
  display: "grid",
  gap: 16,
};

const inlineFilterRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "center",
};

const inputStyle = {
  width: "100%",
  minHeight: 42,
  borderRadius: 12,
  border: "1px solid #cbd5e1",
  padding: "10px 12px",
  fontSize: 14,
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
};

const labelStyle = {
  display: "grid",
  gap: 6,
  minWidth: 180,
  flex: "1 1 220px",
};

function buildAmountText(attempt) {
  if (attempt?.orderAmount && attempt?.orderCurrency) {
    return `${Number(attempt.orderAmount).toFixed(2)} ${attempt.orderCurrency}`;
  }
  return "—";
}

function formatOrderAmount(order) {
  const amount = Number(order?.amount || 0);
  const currency = String(order?.currencyCode || "").trim();
  if (!Number.isFinite(amount) || !currency) return "—";
  return `${amount.toFixed(2)} ${currency}`;
}

export default function AttemptsPage() {
  const loaderData = toObject(useLoaderData());
  const billing = loaderData.billing || null;
  const usage = toObject(loaderData.usage);
  const attemptsView = toObject(loaderData.attemptsView);
  const merchantTimezone = loaderData.merchantTimezone || "UTC";
  const filters = {
    range: "this_cycle",
    q: "",
    page: 1,
    pageSize: 25,
    ...toObject(loaderData.filters),
  };
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const scheduleFetcher = useFetcher();
  const ordersFetcher = useFetcher();
  const location = useLocation();

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [orderSearchDraft, setOrderSearchDraft] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderAfter, setOrderAfter] = useState(null);
  const [orderHistory, setOrderHistory] = useState([]);
  const [orderPageSize, setOrderPageSize] = useState(10);
  const [orderRequestKey, setOrderRequestKey] = useState("");
  const [selectedOrders, setSelectedOrders] = useState({});
  const [scheduleWhen, setScheduleWhen] = useState("");

  const attempts = useMemo(() => toArray(attemptsView?.items), [attemptsView]);
  const pagination = useMemo(
    () => toObject(attemptsView?.pagination),
    [attemptsView],
  );
  const summary = useMemo(
    () => toObject(attemptsView?.summary),
    [attemptsView],
  );
  const rawOrderPickerData = toObject(ordersFetcher.data);
  const orderPickerData =
    rawOrderPickerData.requestKey === orderRequestKey ? rawOrderPickerData : {};
  const orderPickerOrders = toArray(orderPickerData.orders);
  const orderPickerPageInfo = toObject(orderPickerData.pageInfo);
  const selectedOrderRows = useMemo(
    () => Object.values(selectedOrders || {}),
    [selectedOrders],
  );
  const selectedOrderGids = useMemo(
    () => selectedOrderRows.map((row) => row.orderGid).filter(Boolean),
    [selectedOrderRows],
  );
  const scheduleResult = toObject(scheduleFetcher.data);
  const scheduleFailures = toArray(scheduleResult.results).filter(
    (row) => row && row.ok === false,
  );

  const appHref = (href) => withShopParams(href, location.search);
  const buildOrderPickerHref = ({
    search = "",
    after = null,
    first = 10,
  } = {}) => {
    const cleanSearch = String(search || "").trim();
    const cleanAfter = String(after || "").trim();
    const safeFirst = ORDER_PAGE_SIZE_OPTIONS.includes(Number(first))
      ? Number(first)
      : 10;
    const requestKey = `${cleanSearch}::${cleanAfter}::${safeFirst}`;
    const params = new URLSearchParams();
    params.set("first", String(safeFirst));
    params.set("requestKey", requestKey);
    if (cleanSearch) params.set("q", cleanSearch);
    if (cleanAfter) params.set("after", cleanAfter);
    const query = params.toString();
    return {
      requestKey,
      href: withShopParams(`/app/attempts/orders?${query}`, location.search),
    };
  };
  const loadOrdersPage = ({
    search = orderSearch,
    after = orderAfter,
    first = orderPageSize,
  } = {}) => {
    const request = buildOrderPickerHref({ search, after, first });
    setOrderRequestKey(request.requestKey);
    ordersFetcher.load(request.href);
  };
  const buildAttemptsHref = (overrides = {}) => {
    const params = new URLSearchParams(location.search || "");
    params.delete("download");
    Object.entries(overrides).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") {
        params.delete(key);
        return;
      }
      params.set(key, String(value));
    });
    const query = params.toString();
    return appHref(`/app/attempts${query ? `?${query}` : ""}`);
  };
  const resetOrderPicker = () => {
    setOrderSearchDraft("");
    setOrderSearch("");
    setOrderAfter(null);
    setOrderHistory([]);
    setOrderPageSize(10);
    setOrderRequestKey("");
    setSelectedOrders({});
    setScheduleWhen("");
  };

  const openSchedulePicker = () => {
    resetOrderPicker();
    setScheduleOpen(true);
    loadOrdersPage({ search: "", after: null, first: 10 });
  };

  const closeSchedulePicker = () => {
    setScheduleOpen(false);
    resetOrderPicker();
  };

  useEffect(() => {
    if (fetcher.data?.ok) {
      shopify.toast.show("Attempt scheduled");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error);
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (!scheduleFetcher.data) return;
    const payload = toObject(scheduleFetcher.data);
    const summaryData = toObject(payload.summary);
    const results = toArray(payload.results);
    const failed = Number(summaryData.failed || 0);
    const scheduled = Number(summaryData.scheduled || 0);
    const created = Number(summaryData.created || 0);
    const updated = Number(summaryData.updated || 0);
    const firstError =
      results.find((row) => row && row.ok === false)?.error ||
      payload.error ||
      null;

    if (scheduled > 0 && failed === 0) {
      shopify.toast.show(
        created > 0 || updated > 0
          ? `Scheduled ${scheduled} order${scheduled === 1 ? "" : "s"}`
          : "Orders scheduled",
      );
      setScheduleOpen(false);
      setOrderSearchDraft("");
      setOrderSearch("");
      setOrderAfter(null);
      setOrderHistory([]);
      setOrderPageSize(10);
      setOrderRequestKey("");
      setSelectedOrders({});
      setScheduleWhen("");
      return;
    }

    if (scheduled > 0 && failed > 0) {
      shopify.toast.show(
        `Scheduled ${scheduled} order${scheduled === 1 ? "" : "s"} with ${failed} failure${failed === 1 ? "" : "s"}`,
      );
      if (firstError) {
        shopify.toast.show(firstError);
      }
      return;
    }

    if (firstError) {
      shopify.toast.show(firstError);
    }
  }, [scheduleFetcher.data, shopify]);

  const exportHref = appHref(
    `/app/attempts/export?range=${encodeURIComponent(filters.range || "this_cycle")}&q=${encodeURIComponent(filters.q || "")}&pageSize=${encodeURIComponent(filters.pageSize || 25)}`,
  );
  const isSearching = Boolean(filters?.q);
  const submitScheduledAttempts = () => {
    if (!selectedOrderGids.length) return;
    const fd = new FormData();
    fd.set("intent", "scheduleOrders");
    for (const orderGid of selectedOrderGids) {
      fd.append("orderGids", orderGid);
    }
    if (scheduleWhen) {
      const scheduledDate = new Date(scheduleWhen);
      if (!Number.isFinite(scheduledDate.getTime())) {
        shopify.toast.show("Choose a valid schedule time or leave it blank");
        return;
      }
      fd.set("when", scheduledDate.toISOString());
    }
    scheduleFetcher.submit(fd, { method: "post" });
  };
  const scheduleSubmitting = scheduleFetcher.state === "submitting";
  const ordersLoading =
    ordersFetcher.state === "loading" ||
    (!!orderRequestKey && rawOrderPickerData.requestKey !== orderRequestKey);
  const applyOrderSearch = () => {
    const nextSearch = orderSearchDraft.trim();
    setOrderHistory([]);
    setOrderAfter(null);
    setOrderSearch(nextSearch);
    loadOrdersPage({ search: nextSearch, after: null, first: orderPageSize });
  };
  const clearOrderSearch = () => {
    setOrderSearchDraft("");
    setOrderHistory([]);
    setOrderAfter(null);
    setOrderSearch("");
    loadOrdersPage({ search: "", after: null, first: orderPageSize });
  };
  const visibleSelectableOrderGids = orderPickerOrders
    .filter((row) => row.eligibleForOrderX)
    .map((row) => row.orderGid)
    .filter(Boolean);
  const allVisibleSelected =
    visibleSelectableOrderGids.length > 0 &&
    visibleSelectableOrderGids.every((gid) => !!selectedOrders[gid]);
  const toggleOrderSelection = (row) => {
    if (!row?.orderGid || !row?.eligibleForOrderX) return;
    setSelectedOrders((current) => {
      const next = { ...(current || {}) };
      if (next[row.orderGid]) {
        delete next[row.orderGid];
      } else {
        next[row.orderGid] = row;
      }
      return next;
    });
  };
  const toggleVisibleSelection = (checked) => {
    setSelectedOrders((current) => {
      const next = { ...(current || {}) };
      for (const row of orderPickerOrders) {
        if (!row?.eligibleForOrderX || !row?.orderGid) continue;
        if (checked) {
          next[row.orderGid] = row;
        } else {
          delete next[row.orderGid];
        }
      }
      return next;
    });
  };
  const goNextOrdersPage = () => {
    if (!orderPickerPageInfo?.hasNextPage || !orderPickerPageInfo?.endCursor) {
      return;
    }
    setOrderHistory((current) => [...current, orderAfter]);
    setOrderAfter(orderPickerPageInfo.endCursor);
    loadOrdersPage({
      search: orderSearch,
      after: orderPickerPageInfo.endCursor,
      first: orderPageSize,
    });
  };
  const goPreviousOrdersPage = () => {
    if (!orderHistory.length) return;
    const nextHistory = orderHistory.slice(0, -1);
    const previousAfter = orderHistory[orderHistory.length - 1] ?? null;
    setOrderHistory(nextHistory);
    setOrderAfter(previousAfter);
    loadOrdersPage({
      search: orderSearch,
      after: previousAfter,
      first: orderPageSize,
    });
  };

  return (
    <s-page suppressHydrationWarning>
      <s-button
        slot="primary-action"
        onClick={openSchedulePicker}
        suppressHydrationWarning
      >
        Schedule Orders
      </s-button>

      <s-box style={surface.shell}>
        <PageTitle
          title="Order Confimations"
          // subtitle="Track confirmation history, reschedule eligible orders, and audit customer reply outcomes from one place."
          right={
            <s-button href={exportHref} variant="secondary">
              Export CSV
            </s-button>
          }
        />
        <SectionDivider />

        <s-section heading="Snapshot">
          <s-stack direction="inline" gap="base" wrap>
            <MetricTile
              label="Matching Attempts"
              value={summary.total || 0}
              hint={`Showing ${pagination.rowStart || 0}-${pagination.rowEnd || 0} of ${summary.total || 0}`}
              soft
            />
            <MetricTile
              label="Confirmed"
              value={summary.confirmed || 0}
              hint="Customer approved orders"
              soft
            />
            <MetricTile
              label="Pending"
              value={summary.pending || 0}
              hint="Scheduled, sent, or waiting for reply"
              soft
            />
            <MetricTile
              label="Failures"
              value={(summary.failed || 0) + (summary.skipped || 0)}
              hint="Failed or skipped attempts in this view"
              soft
            />
            <MetricTile
              label="Cross-Border (Page)"
              value={summary.crossBorder || 0}
              hint="Visible attempts where recipient number country differs from the store country"
              soft
            />
          </s-stack>
        </s-section>

        <SectionDivider />
        <s-section heading="Filters">
          <SurfaceCard padding="base" soft>
            <div style={filterPanelStyle}>
              <div style={inlineFilterRowStyle}>
                {RANGE_OPTIONS.map((option) => {
                  const active = filters.range === option.value;
                  return (
                    <s-button
                      key={option.value}
                      href={buildAttemptsHref({ range: option.value, page: 1 })}
                      variant={active ? "primary" : "secondary"}
                    >
                      {option.label}
                    </s-button>
                  );
                })}
              </div>

              <Form method="get" action={appHref("/app/attempts")}>
                <div style={{ display: "grid", gap: 14 }}>
                  <input type="hidden" name="range" value={filters.range} />
                  <input type="hidden" name="page" value="1" />
                  <div style={inlineFilterRowStyle}>
                    <label style={{ ...labelStyle, flex: "2 1 420px" }}>
                      <span style={surface.rowLabel}>Search</span>
                      <input
                        name="q"
                        type="search"
                        placeholder="Search order, customer, phone, status, stage, template, change, or error"
                        defaultValue={filters.q || ""}
                        style={inputStyle}
                      />
                    </label>
                    <label
                      style={{
                        ...labelStyle,
                        minWidth: 140,
                        flex: "0 0 160px",
                      }}
                    >
                      <span style={surface.rowLabel}>Page size</span>
                      <select
                        name="pageSize"
                        defaultValue={String(filters.pageSize || 25)}
                        style={inputStyle}
                      >
                        {PAGE_SIZE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option} / page
                          </option>
                        ))}
                      </select>
                    </label>
                    <div style={{ display: "flex", gap: 10, alignSelf: "end" }}>
                      <s-button type="submit">Apply</s-button>
                      <s-button
                        href={buildAttemptsHref({ q: null, page: 1 })}
                        variant="secondary"
                      >
                        Clear search
                      </s-button>
                    </div>
                  </div>
                  <s-text tone="subdued">
                    Search supports multiple categories in one box. Examples:{" "}
                    <code>status:failed</code>, <code>phone:+923</code>,{" "}
                    <code>order:#1021</code>, <code>template:orderx</code>.
                  </s-text>
                  <s-text tone="subdued">
                    CSV export includes every record matching the current range
                    and search, not just the current page.
                  </s-text>
                </div>
              </Form>
            </div>
          </SurfaceCard>

          <s-section heading="Latest attempts">
            {!attempts.length ? (
              <SurfaceCard soft padding="none">
                <EmptyState
                  title={
                    isSearching
                      ? "No attempts match these filters"
                      : "No attempts found yet"
                  }
                  message={
                    isSearching
                      ? "Try a broader time range or simplify the search terms to surface matching confirmations."
                      : "OrderX will list scheduled, sent, and resolved confirmations here as orders begin flowing through the app."
                  }
                  action={
                    isSearching ? (
                      <s-button
                        href={buildAttemptsHref({ q: null, page: 1 })}
                        variant="secondary"
                      >
                        Clear search
                      </s-button>
                    ) : null
                  }
                />
              </SurfaceCard>
            ) : (
              <SurfaceCard soft padding="none">
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      minWidth: "1180px",
                      fontSize: 14,
                    }}
                  >
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {[
                          "Order",
                          "Customer",
                          "Status",
                          "Stage",
                          "Sent at",
                          "Template",
                          "Requested changes",
                          "Latest customer change",
                          "Error",
                          "Action",
                        ].map((label) => (
                          <th
                            key={label}
                            style={{
                              textAlign: "left",
                              padding: "12px 14px",
                              fontWeight: 700,
                              color: "#334155",
                              borderBottom: "1px solid #e2e8f0",
                              whiteSpace: "nowrap",
                              position: "sticky",
                              top: 0,
                              background: "#f8fafc",
                              zIndex: 1,
                            }}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((attempt) => {
                        const lastChange = getLastChange(attempt);
                        const stateLabel = changeStateLabel(
                          attempt?.changeState,
                        );
                        const proposedParts = buildRequestedParts(attempt);
                        const sentAt = attempt?.createdAt
                          ? formatDateTime(
                              attempt.createdAt,
                              attempt.timezone || merchantTimezone,
                            )
                          : "—";
                        const lastChangeText = lastChange?.text
                          ? `${
                              String(lastChange.kind || "") === "address"
                                ? "New address"
                                : `Change (${lastChange.kind || "—"})`
                            }: ${clip(lastChange.text, 180)}${
                              lastChange.resolution
                                ? ` (${lastChange.resolution})`
                                : ""
                            }`
                          : "—";
                        const rowLoading =
                          fetcher.state === "submitting" &&
                          fetcher.formData?.get("attemptId") ===
                            String(attempt._id);

                        return (
                          <tr
                            key={attempt._id}
                            style={{
                              borderBottom: "1px solid #eef2f7",
                              boxShadow: `inset 4px 0 0 ${attemptBorder(
                                attempt.status,
                              )}`,
                            }}
                          >
                            <td
                              style={{ padding: "14px", verticalAlign: "top" }}
                            >
                              <div
                                style={{
                                  display: "grid",
                                  gap: 4,
                                  minWidth: 190,
                                }}
                              >
                                <div
                                  style={{ fontWeight: 700, color: "#0f172a" }}
                                >
                                  {attempt.orderName || "Order"}
                                </div>
                                <div style={{ color: "#475569", fontSize: 12 }}>
                                  {buildAmountText(attempt)}
                                </div>
                                <div style={{ color: "#64748b", fontSize: 12 }}>
                                  {attempt.orderGid || "—"}
                                </div>
                              </div>
                            </td>
                            <td
                              style={{ padding: "14px", verticalAlign: "top" }}
                            >
                              <div
                                style={{
                                  display: "grid",
                                  gap: 4,
                                  minWidth: 180,
                                }}
                              >
                                <div
                                  style={{ fontWeight: 600, color: "#0f172a" }}
                                >
                                  {attempt.customerName || "—"}
                                </div>
                                <div style={{ color: "#475569", fontSize: 12 }}>
                                  {attempt.phoneE164 || "—"}
                                </div>
                                {attempt.crossBorderRateApplied ? (
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 6,
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    <s-badge tone="warning">
                                      Cross-border
                                    </s-badge>
                                    <span
                                      style={{
                                        color: "#64748b",
                                        fontSize: 12,
                                      }}
                                    >
                                      {attempt.storeCountryCode || "Store"} →{" "}
                                      {attempt.recipientCountryCodeResolved ||
                                        "Recipient"}
                                    </span>
                                  </div>
                                ) : null}
                                <div style={{ color: "#64748b", fontSize: 12 }}>
                                  {attempt.storeName || "—"}
                                </div>
                              </div>
                            </td>
                            <td
                              style={{
                                padding: "14px",
                                minWidth: "100px",
                                verticalAlign: "top",
                              }}
                            >
                              <div style={{ display: "grid", gap: 8 }}>
                                <Badge status={attempt.status || "—"} />
                                {stateLabel ? (
                                  <s-badge tone="warning">{stateLabel}</s-badge>
                                ) : null}
                              </div>
                            </td>
                            <td
                              style={{
                                padding: "14px",
                                verticalAlign: "top",
                                whiteSpace: "nowrap",
                                color: "#334155",
                              }}
                            >
                              {attempt.stage || "—"}
                            </td>
                            <td
                              style={{
                                padding: "14px",
                                verticalAlign: "top",
                                whiteSpace: "nowrap",
                                color: "#334155",
                              }}
                            >
                              {sentAt}
                            </td>
                            <td
                              style={{ padding: "14px", verticalAlign: "top" }}
                            >
                              <div
                                style={{
                                  maxWidth: 180,
                                  lineHeight: 1.4,
                                  color: "#334155",
                                }}
                              >
                                {attempt.waTemplateUsed || "—"}
                              </div>
                            </td>
                            <td
                              style={{ padding: "14px", verticalAlign: "top" }}
                            >
                              <div
                                style={{
                                  maxWidth: 280,
                                  whiteSpace: "normal",
                                  lineHeight: 1.4,
                                  color: proposedParts.length
                                    ? "#1f2937"
                                    : "#94a3b8",
                                }}
                              >
                                {proposedParts.length
                                  ? proposedParts.join(" | ")
                                  : "—"}
                              </div>
                            </td>
                            <td
                              style={{ padding: "14px", verticalAlign: "top" }}
                            >
                              <div
                                style={{
                                  maxWidth: 260,
                                  whiteSpace: "normal",
                                  lineHeight: 1.4,
                                  color: lastChange?.text
                                    ? "#334155"
                                    : "#94a3b8",
                                }}
                              >
                                {lastChangeText}
                              </div>
                            </td>
                            <td
                              style={{ padding: "14px", verticalAlign: "top" }}
                            >
                              <div
                                style={{
                                  maxWidth: 240,
                                  whiteSpace: "normal",
                                  lineHeight: 1.4,
                                  color: attempt.lastError
                                    ? "#b91c1c"
                                    : "#94a3b8",
                                }}
                              >
                                {attempt.lastError
                                  ? clip(attempt.lastError, 220)
                                  : "—"}
                              </div>
                            </td>
                            <td
                              style={{
                                padding: "14px",
                                verticalAlign: "top",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {[
                                "failed",
                                "scheduled",
                                "skipped",
                                "expired",
                              ].includes(attempt.status) ? (
                                <s-button
                                  variant="secondary"
                                  onClick={() => {
                                    const fd = new FormData();
                                    fd.set("intent", "trigger");
                                    fd.set("attemptId", attempt._id);
                                    fetcher.submit(fd, { method: "post" });
                                  }}
                                  {...(rowLoading ? { loading: true } : {})}
                                >
                                  Retry now
                                </s-button>
                              ) : (
                                <span style={{ color: "#94a3b8" }}>—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 16px",
                    borderTop: "1px solid #e2e8f0",
                    background: "#ffffff",
                  }}
                >
                  <div style={{ color: "#475569", fontSize: 13 }}>
                    Showing {pagination.rowStart || 0}-{pagination.rowEnd || 0}{" "}
                    of {pagination.total || 0}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <s-button
                      href={buildAttemptsHref({
                        page: Math.max(1, (pagination.page || 1) - 1),
                      })}
                      variant="secondary"
                      disabled={!pagination.hasPrevious}
                    >
                      Previous
                    </s-button>
                    <span style={{ color: "#334155", fontWeight: 600 }}>
                      Page {pagination.page || 1} of{" "}
                      {pagination.totalPages || 1}
                    </span>
                    <s-button
                      href={buildAttemptsHref({
                        page: (pagination.page || 1) + 1,
                      })}
                      variant="secondary"
                      disabled={!pagination.hasNext}
                    >
                      Next
                    </s-button>
                  </div>
                </div>
              </SurfaceCard>
            )}
          </s-section>
        </s-section>

        <SectionDivider />
        <s-section heading="Usage">
          <SurfaceCard padding="base">
            <UsageWidget
              billing={billing}
              usage={usage}
              upgradeHref={appHref("/app/plans")}
              framed={false}
              showPkrInfo={shouldShowPkrInfo(merchantTimezone)}
            />
          </SurfaceCard>
        </s-section>

        <SectionDivider />
        <s-section heading="Analytics">
          <SurfaceCard padding="base">
            <s-text tone="subdued">
              {Number(pagination.total || 0) > attempts.length
                ? "Analytics below reflect the current page. Use export for full-range analysis."
                : "Analytics below reflect the current filtered result set."}
            </s-text>
            <div style={{ marginTop: 12 }} />
            <AttemptsAnalytics attempts={attempts} />
          </SurfaceCard>
        </s-section>
      </s-box>

      <Modal
        id="schedule-attempt-modal"
        variant="large"
        open={scheduleOpen}
        onHide={closeSchedulePicker}
      >
        <TitleBar title="Schedule attempts for orders">
          <button
            type="button"
            onClick={() => {
              closeSchedulePicker();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedOrderGids.length || scheduleSubmitting}
            onClick={submitScheduledAttempts}
          >
            Schedule selected
          </button>
        </TitleBar>
        <div
          style={{
            display: "grid",
            gap: 18,
            padding: "8px 4px 4px",
            minWidth: 0,
          }}
        >
          <SurfaceCard soft padding="base">
            <div style={{ display: "grid", gap: 14 }}>
              {scheduleFailures.length ? (
                <s-banner tone="critical">
                  <div style={{ display: "grid", gap: 6 }}>
                    <div>
                      {scheduleFailures.length} order
                      {scheduleFailures.length === 1 ? "" : "s"} could not be
                      scheduled.
                    </div>
                    <div style={{ fontSize: 13 }}>
                      {scheduleFailures
                        .slice(0, 3)
                        .map((row) => row.error || row.orderGid)
                        .join(" • ")}
                      {scheduleFailures.length > 3 ? " • ..." : ""}
                    </div>
                  </div>
                </s-banner>
              ) : null}

              <div style={{ color: "#475569", lineHeight: 1.55, fontSize: 14 }}>
                Search Shopify orders, select one or more orders with a phone
                number, and schedule them together. Leave the time blank to
                queue them immediately.
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  alignItems: "end",
                }}
              >
                <label style={{ ...labelStyle, flex: "2 1 380px" }}>
                  <span style={surface.rowLabel}>Search orders</span>
                  <input
                    type="search"
                    placeholder="Order #, customer name, email, or phone"
                    value={orderSearchDraft}
                    onChange={(event) =>
                      setOrderSearchDraft(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyOrderSearch();
                      }
                    }}
                    style={inputStyle}
                  />
                </label>

                <label
                  style={{
                    ...labelStyle,
                    minWidth: 140,
                    flex: "0 0 180px",
                  }}
                >
                  <span style={surface.rowLabel}>Page size</span>
                  <select
                    value={String(orderPageSize)}
                    onChange={(event) => {
                      const nextSize = Number.parseInt(event.target.value, 10);
                      const safeSize = Number.isFinite(nextSize)
                        ? nextSize
                        : 10;
                      setOrderHistory([]);
                      setOrderAfter(null);
                      setOrderPageSize(safeSize);
                      loadOrdersPage({
                        search: orderSearch,
                        after: null,
                        first: safeSize,
                      });
                    }}
                    style={inputStyle}
                  >
                    {ORDER_PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option} / page
                      </option>
                    ))}
                  </select>
                </label>

                <div style={{ display: "flex", gap: 10, alignSelf: "end" }}>
                  <s-button type="button" onClick={applyOrderSearch}>
                    Apply search
                  </s-button>
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={clearOrderSearch}
                  >
                    Clear
                  </s-button>
                </div>
              </div>

              <label style={{ display: "grid", gap: 6, maxWidth: 320 }}>
                <span
                  style={{ fontWeight: 600, fontSize: 14, color: "#334155" }}
                >
                  Send at (optional)
                </span>
                <input
                  type="datetime-local"
                  value={scheduleWhen}
                  onChange={(e) => setScheduleWhen(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ color: "#94a3b8", fontSize: 12 }}>
                  Leave blank to schedule immediately.
                </span>
              </label>
            </div>
          </SurfaceCard>

          <SurfaceCard soft padding="none">
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 16px",
                borderBottom: "1px solid #e2e8f0",
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ color: "#0f172a", fontWeight: 700 }}>
                  {selectedOrderRows.length
                    ? `${selectedOrderRows.length} order${
                        selectedOrderRows.length === 1 ? "" : "s"
                      } selected`
                    : "No orders selected"}
                </div>
                <div style={{ color: "#64748b", fontSize: 13 }}>
                  {orderPickerData.ok === false && orderPickerData.error
                    ? orderPickerData.error
                    : "Manual scheduling can select any order with a customer phone number."}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={() => toggleVisibleSelection(!allVisibleSelected)}
                >
                  {allVisibleSelected ? "Clear visible" : "Select visible"}
                </s-button>
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={() => setSelectedOrders({})}
                  disabled={!selectedOrderRows.length}
                >
                  Clear selected
                </s-button>
              </div>
            </div>

            {ordersLoading ? (
              <div style={{ padding: 20, color: "#64748b" }}>
                Loading orders…
              </div>
            ) : null}

            {orderPickerData.ok === false && orderPickerData.error ? (
              <div style={{ padding: 16 }}>
                <s-banner tone="critical">{orderPickerData.error}</s-banner>
              </div>
            ) : null}

            {!orderPickerOrders.length && !ordersLoading ? (
              <EmptyState
                title="No orders found"
                message="Try a broader search or move to a different page range to find the orders you want to schedule."
              />
            ) : null}

            {orderPickerOrders.length ? (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    minWidth: "1080px",
                    fontSize: 14,
                  }}
                >
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      {[
                        "",
                        "Order",
                        "Customer",
                        "Status",
                        "Payment",
                        "Amount",
                        "Created",
                        "Eligible",
                      ].map((label, index) => (
                        <th
                          key={label || index}
                          style={{
                            textAlign: "left",
                            padding: "12px 14px",
                            fontWeight: 700,
                            color: "#334155",
                            borderBottom: "1px solid #e2e8f0",
                            whiteSpace: "nowrap",
                            position: "sticky",
                            top: 0,
                            background: "#f8fafc",
                            zIndex: 1,
                          }}
                        >
                          {index === 0 ? (
                            <input
                              type="checkbox"
                              checked={allVisibleSelected}
                              onChange={(event) =>
                                toggleVisibleSelection(event.target.checked)
                              }
                              aria-label="Select all visible orders"
                            />
                          ) : (
                            label
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderPickerOrders.map((order) => {
                      const selected = !!selectedOrders[order.orderGid];
                      const lineSummary = Array.isArray(order.lineSummary)
                        ? order.lineSummary
                        : [];
                      const amountText = formatOrderAmount(order);

                      return (
                        <tr
                          key={order.orderGid}
                          style={{
                            borderBottom: "1px solid #eef2f7",
                            opacity: order.eligibleForOrderX ? 1 : 0.58,
                          }}
                        >
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!order.eligibleForOrderX}
                              onChange={() => toggleOrderSelection(order)}
                              aria-label={`Select ${order.orderName}`}
                            />
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <div
                              style={{ display: "grid", gap: 4, minWidth: 220 }}
                            >
                              <div
                                style={{ fontWeight: 700, color: "#0f172a" }}
                              >
                                {order.orderName || "—"}
                              </div>
                              <div style={{ color: "#475569", fontSize: 12 }}>
                                {order.orderGid}
                              </div>
                              {lineSummary.length ? (
                                <div style={{ color: "#64748b", fontSize: 12 }}>
                                  {lineSummary.join(" • ")}
                                </div>
                              ) : null}
                            </div>
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <div
                              style={{ display: "grid", gap: 4, minWidth: 180 }}
                            >
                              <div
                                style={{ fontWeight: 600, color: "#0f172a" }}
                              >
                                {order.customerName || "—"}
                              </div>
                              <div style={{ color: "#475569", fontSize: 12 }}>
                                {order.customerEmail ||
                                  order.customerPhone ||
                                  order.shippingPhone ||
                                  order.billingPhone ||
                                  "—"}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <div style={{ display: "grid", gap: 8 }}>
                              <s-badge tone="subdued">
                                {order.displayFinancialStatus || "Unknown"}
                              </s-badge>
                              <s-badge tone="subdued">
                                {order.displayFulfillmentStatus || "Unknown"}
                              </s-badge>
                            </div>
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <div style={{ maxWidth: 220, color: "#334155" }}>
                              {Array.isArray(order.paymentGatewayNames) &&
                              order.paymentGatewayNames.length
                                ? order.paymentGatewayNames.join(", ")
                                : "—"}
                            </div>
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <div style={{ color: "#0f172a", fontWeight: 600 }}>
                              {amountText}
                            </div>
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            <div
                              style={{ color: "#334155", whiteSpace: "nowrap" }}
                            >
                              {order.createdAt
                                ? formatDateTime(
                                    order.createdAt,
                                    merchantTimezone,
                                  )
                                : "—"}
                            </div>
                          </td>
                          <td style={{ padding: "14px", verticalAlign: "top" }}>
                            {order.eligibleForOrderX ? (
                              <div style={{ display: "grid", gap: 6 }}>
                                <s-badge tone="success">Ready</s-badge>
                                {order.isCodOrder ? (
                                  <s-badge tone="subdued">COD</s-badge>
                                ) : (
                                  <s-badge tone="warning">Manual</s-badge>
                                )}
                              </div>
                            ) : (
                              <s-badge tone="critical">
                                {order.hasPhone ? "Invalid phone" : "No phone"}
                              </s-badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 16px",
                borderTop: "1px solid #e2e8f0",
                background: "#ffffff",
              }}
            >
              <div style={{ color: "#475569", fontSize: 13 }}>
                {orderPickerOrders.length
                  ? `${orderPickerOrders.length} orders loaded`
                  : "No orders loaded"}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={goPreviousOrdersPage}
                  disabled={!orderHistory.length || ordersLoading}
                >
                  Previous
                </s-button>
                <span style={{ color: "#334155", fontWeight: 600 }}>
                  Page {orderHistory.length + 1}
                </span>
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={goNextOrdersPage}
                  disabled={!orderPickerPageInfo?.hasNextPage || ordersLoading}
                >
                  Next
                </s-button>
              </div>
            </div>
          </SurfaceCard>
        </div>
      </Modal>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
