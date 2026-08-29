import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import { boundary as appBoundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet } from "../server/backend.server";
import { withShopParams } from "../utils/embedded";
import { formatDateTime } from "../utils/format";
import { getMerchantTimezone } from "../utils/shopTimezone.server";

// ─── Constants ────────────────────────────────────────────────────────────────
const THREAD_PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const toArray = (v) => (Array.isArray(v) ? v : []);
const toObject = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};

function parsePositiveInt(value, fallback, options = {}) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.isFinite(options.min) ? options.min : 1;
  const max = Number.isFinite(options.max)
    ? options.max
    : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, min), max);
}

function friendlySlug(v) {
  return String(v || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function titleCase(v) {
  return friendlySlug(v)
    .split(" ")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
function friendlySenderMode(v) {
  const m = String(v || "").trim();
  if (m === "own_number") return "Your Number";
  if (m === "orderx_number") return "OrderX";
  return m ? titleCase(m) : "Unknown";
}
function friendlyTemplateLabel(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  const label = friendlySlug(raw)
    .replace(/^orderx\s+/i, "")
    .replace(/^cod\s+/i, "")
    .replace(/^orderx\s+/i, "");
  return titleCase(label || raw);
}
function friendlyKindLabel(v) {
  const r = String(v || "")
    .trim()
    .toLowerCase();
  if (!r) return "";
  if (r === "customer_reply") return "Customer reply";
  if (r.includes("review_request")) return "Review request";
  if (r.includes("abandoned_cart")) return "Abandoned cart";
  if (r.includes("order_dispatched")) return "Dispatched";
  if (r.includes("tracking_updated")) return "Tracking update";
  if (r.includes("order_cancelled")) return "Cancelled";
  if (r.includes("order_update")) return "Order update";
  if (r.includes("cod_confirm")) return "Order confirmation";
  if (r.includes("support_info")) return "Support info";
  return titleCase(r);
}
function mergeByKey(current = [], incoming = [], key = "id") {
  const map = new Map();
  for (const row of toArray(current)) {
    const v = String(row?.[key] || "").trim();
    if (v) map.set(v, row);
  }
  for (const row of toArray(incoming)) {
    const v = String(row?.[key] || "").trim();
    if (v) map.set(v, row);
  }
  return Array.from(map.values());
}
function messageDisplayText(msg) {
  const display = String(msg?.displayText || "").trim();
  if (
    display &&
    !looksLikeJsonBlob(display) &&
    !looksLikeDebugMetaBlob(display)
  )
    return display;
  const t = String(msg?.text || "").trim();
  if (t && !looksLikeJsonBlob(t) && !looksLikeDebugMetaBlob(t)) return t;
  const system = friendlySystemMessage(msg, display || t);
  if (system) return system;
  const tn = String(msg?.templateName || "").trim();
  if (tn) return friendlyTemplateLabel(tn);
  const k = String(msg?.kind || "").trim();
  if (k) return friendlyKindLabel(k);
  return "Message";
}
function threadDisplayPreview(thread) {
  const d = String(thread?.displayText || "").trim();
  if (d && !looksLikeJsonBlob(d) && !looksLikeDebugMetaBlob(d)) return d;
  const p = String(thread?.lastMessagePreview || "").trim();
  if (p && !looksLikeJsonBlob(p) && !looksLikeDebugMetaBlob(p)) return p;
  const t = String(thread?.lastMessageText || "").trim();
  if (t && !looksLikeJsonBlob(t) && !looksLikeDebugMetaBlob(t))
    return t.replace(/\s+/g, " ");
  const summary = friendlySystemMessage(thread, d || t || p);
  if (summary) return summary;
  const tn = String(thread?.lastTemplateName || "").trim();
  if (tn) return friendlyTemplateLabel(tn);
  const k = String(thread?.lastKind || "").trim();
  if (k) return friendlyKindLabel(k);
  return "Conversation";
}
function avatarInitial(thread) {
  const src = String(thread?.partnerE164 || thread?.threadKey || "").trim();
  return src ? src.replace(/\D/g, "").slice(-2) || "?" : "?";
}
function normalizeMessages(messages = []) {
  return toArray(messages).map((m) => ({
    ...m,
    id: String(m?.id || m?.waMessageId || "").trim(),
  }));
}
function normalizeThreads(threads = []) {
  return toArray(threads).map((t) => ({
    ...t,
    id: String(t?.id || t?.threadKey || "").trim(),
    threadKey: String(t?.threadKey || t?.id || "").trim(),
  }));
}

function looksLikeJsonBlob(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  );
}

function looksLikeDebugMetaBlob(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text.startsWith("{") || text.startsWith("[")) {
    return /"source"\s*:|"flowKey"\s*:|"templateSource"\s*:|"managedTemplate/i.test(
      text,
    );
  }
  return false;
}

function tryParseJson(value) {
  const text = String(value || "").trim();
  if (!looksLikeJsonBlob(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function friendlySystemMessage(entity, fallbackText = "") {
  const meta =
    entity && typeof entity.meta === "object" && !Array.isArray(entity.meta)
      ? entity.meta
      : tryParseJson(fallbackText) || tryParseJson(entity?.metaPreview) || null;
  const kind = String(entity?.kind || "")
    .trim()
    .toLowerCase();
  const source = String(meta?.source || "")
    .trim()
    .toLowerCase();
  const flowKey = String(meta?.flowKey || entity?.flowKey || "")
    .trim()
    .toLowerCase();

  if (
    kind === "managed_template_test_send" ||
    source === "managed_template_test_send"
  ) {
    return "Managed template test send";
  }
  if (
    kind === "managed_template_bare_test_send" ||
    source === "managed_template_bare_test_send"
  ) {
    return "Managed template bare test send";
  }
  if (
    kind === "byon_live_test_template" ||
    source === "byon_live_test_template"
  ) {
    return "Template test send";
  }
  if (kind.includes("review_request") || flowKey === "review_request") {
    return "Review request";
  }
  if (
    kind.includes("abandoned_cart") ||
    flowKey === "abandoned_cart_recovery"
  ) {
    return "Abandoned cart recovery";
  }
  if (kind.includes("tracking_updated") || flowKey === "tracking_updated") {
    return "Tracking update";
  }
  if (kind.includes("order_dispatched") || flowKey === "order_dispatched") {
    return "Order dispatched";
  }
  if (kind.includes("order_cancelled") || flowKey === "order_cancelled") {
    return "Order cancelled";
  }
  if (kind.includes("order_update") || flowKey === "order_update_generic") {
    return "Order update";
  }
  if (kind.includes("cod_confirm") || flowKey === "order_confirmation") {
    return "Order confirmation";
  }
  if (source) {
    return titleCase(source.replace(/^attempt_/, "").replace(/_/g, " "));
  }
  return "";
}

// ─── Loader ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const scope = String(url.searchParams.get("scope") || "inbox")
    .trim()
    .toLowerCase();
  const q = String(url.searchParams.get("q") || "").trim();
  const thread = String(url.searchParams.get("thread") || "").trim();
  const page = parsePositiveInt(url.searchParams.get("page"), 1, {
    min: 1,
    max: 100000,
  });
  const before = String(url.searchParams.get("before") || "").trim();
  const requestKey =
    String(url.searchParams.get("requestKey") || "").trim() || null;

  const loadPageMeta = scope !== "threads" && scope !== "messages";
  const merchantTimezone = loadPageMeta
    ? await getMerchantTimezone(admin)
    : "PKT";

  let senderData = {};
  if (loadPageMeta) {
    const sr = await backendGet("/api/sender", shop).catch(() => ({
      ok: false,
      sender: null,
    }));
    senderData = toObject(sr?.sender);
  }

  const bmp = (params) => {
    const q = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      const n = String(v || "").trim();
      if (n) q.set(k, n);
    });
    return q.toString();
  };

  if (scope === "threads") {
    const r = await backendGet(
      `/api/messages?${bmp({ scope: "threads", q, thread, page, pageSize: THREAD_PAGE_SIZE, requestKey })}`,
      shop,
    ).catch(() => ({
      ok: false,
      items: [],
      pagination: {},
      summary: {},
      selectedThread: null,
    }));
    return {
      scope,
      requestKey,
      q,
      thread,
      merchantTimezone,
      sender: senderData,
      ...r,
      threads: normalizeThreads(r?.items),
    };
  }
  if (scope === "messages") {
    const r = await backendGet(
      `/api/messages?${bmp({ scope: "messages", thread, before, pageSize: MESSAGE_PAGE_SIZE, requestKey })}`,
      shop,
    ).catch(() => ({
      ok: false,
      messages: [],
      messagePagination: {},
      selectedThread: null,
    }));
    return {
      scope,
      requestKey,
      q,
      thread,
      merchantTimezone,
      sender: senderData,
      ...r,
      messages: normalizeMessages(r?.messages),
    };
  }

  const r = await backendGet(
    `/api/messages?${bmp({ scope: "inbox", q, thread, page, pageSize: THREAD_PAGE_SIZE, messagePageSize: MESSAGE_PAGE_SIZE, requestKey })}`,
    shop,
  ).catch(() => ({
    ok: false,
    items: [],
    pagination: {},
    summary: {},
    messages: [],
    messagePagination: {},
    selectedThread: null,
  }));
  return {
    scope: "inbox",
    requestKey,
    q,
    thread,
    merchantTimezone,
    sender: senderData,
    ...r,
    threads: normalizeThreads(r?.items),
    messages: normalizeMessages(r?.messages),
  };
};

// ─── WA colour tokens ─────────────────────────────────────────────────────────
const WA = {
  bg: "#f4f7fb",
  panel: "#ffffff",
  header: "#ffffff",
  headerBorder: "#dbe3ea",
  hover: "#f8fafc",
  active: "#ecfdf5",
  divider: "#e5edf2",
  green: "#128c7e",
  greenDim: "rgba(18,140,126,0.12)",
  bubbleOut: "#dcfce7",
  bubbleIn: "#ffffff",
  text: "#0f172a",
  textSub: "#475569",
  textMuted: "#94a3b8",
  scrollThumb: "#cbd5e1",
  tagBg: "#eefbf7",
  tagText: "#0f766e",
  badgeBg: "#0f766e",
  badgeText: "#ffffff",
  inputBg: "#f8fafc",
  inputBorder: "#dbe3ea",
  searchIcon: "#94a3b8",
};

// ─── Tiny UI atoms ─────────────────────────────────────────────────────────────
function Tag({ children }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 20,
        fontSize: 10,
        fontWeight: 600,
        background: WA.tagBg,
        color: WA.tagText,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Badge({ children }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 700,
        background: WA.badgeBg,
        color: WA.badgeText,
      }}
    >
      {children}
    </span>
  );
}

function Avatar({ thread, size = 46 }) {
  const initial = avatarInitial(thread);
  const colors = ["#00a884", "#0b67a1", "#7b66ff", "#d45f3c", "#2d8653"];
  const idx = (initial.charCodeAt(0) || 0) % colors.length;
  return (
    <div
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: "50%",
        background: colors[idx],
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.38,
        fontWeight: 700,
        color: "#fff",
        userSelect: "none",
      }}
    >
      {initial}
    </div>
  );
}

function TickIcon({ double = false, read = false }) {
  const color = read ? WA.green : WA.textMuted;
  return double ? (
    <svg
      width="16"
      height="11"
      viewBox="0 0 16 11"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M1 5.5L5 9.5L15 1.5"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 5.5L9 9.5"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg
      width="12"
      height="9"
      viewBox="0 0 12 9"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M1 4.5L4.5 8L11 1"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke={WA.searchIcon} strokeWidth="1.8" />
      <path
        d="M14 14L18 18"
        stroke={WA.searchIcon}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M1 1L13 13M13 1L1 13"
        stroke={WA.searchIcon}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 18,
        height: 18,
        border: `2px solid ${WA.divider}`,
        borderTopColor: WA.green,
        borderRadius: "50%",
        animation: "wa-spin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

// ─── Main Page Component ───────────────────────────────────────────────────────
export default function MessagesPage() {
  const loaderData = toObject(useLoaderData());
  const location = useLocation();
  const navigate = useNavigate();
  const threadsFetcher = useFetcher();
  const messagesFetcher = useFetcher();

  const merchantTimezone = loaderData.merchantTimezone || "PKT";
  const sender = toObject(loaderData.sender);

  const loaderSnapshot = useMemo(
    () => ({
      scope: String(loaderData.scope || "inbox").trim(),
      q: String(loaderData.q || "").trim(),
      thread: String(
        loaderData.thread || loaderData.selectedThreadKey || "",
      ).trim(),
      requestKey: String(loaderData.requestKey || "").trim(),
      threads: normalizeThreads(loaderData.threads),
      pagination: toObject(loaderData.pagination),
      summary: toObject(loaderData.summary),
      selectedThread: toObject(loaderData.selectedThread),
      messages: normalizeMessages(loaderData.messages),
      messagePagination: toObject(loaderData.messagePagination),
    }),
    [
      loaderData.scope,
      loaderData.q,
      loaderData.thread,
      loaderData.requestKey,
      loaderData.threads,
      loaderData.pagination,
      loaderData.summary,
      loaderData.selectedThread,
      loaderData.selectedThreadKey,
      loaderData.messages,
      loaderData.messagePagination,
    ],
  );

  const [searchDraft, setSearchDraft] = useState(loaderSnapshot.q);
  const [searchQuery, setSearchQuery] = useState(loaderSnapshot.q);
  const [threadItems, setThreadItems] = useState(loaderSnapshot.threads);
  const [threadPagination, setThreadPagination] = useState(
    loaderSnapshot.pagination,
  );
  const [threadSummary, setThreadSummary] = useState(loaderSnapshot.summary);
  const [selectedThread, setSelectedThread] = useState(
    loaderSnapshot.selectedThread,
  );
  const [selectedThreadKey, setSelectedThreadKey] = useState(
    loaderSnapshot.thread,
  );
  const [messages, setMessages] = useState(loaderSnapshot.messages);
  const [messagePagination, setMessagePagination] = useState(
    loaderSnapshot.messagePagination,
  );
  const [threadLoadError, setThreadLoadError] = useState("");
  const [messageLoadError, setMessageLoadError] = useState("");
  const [threadRequestKey, setThreadRequestKey] = useState("");
  const [messageRequestKey, setMessageRequestKey] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [mobilePane, setMobilePane] = useState(
    loaderSnapshot.thread ? "chat" : "list",
  );

  const threadsScrollRef = useRef(null);
  const messagesScrollRef = useRef(null);
  const pendingScrollBottomRef = useRef(false);
  const pendingScrollSnapshotRef = useRef(null);

  const appHref = (href) => withShopParams(href, location.search);

  const senderMode = String(
    sender?.currentBillingSenderMode ||
      sender?.activeMode ||
      sender?.preferenceMode ||
      "",
  ).trim();
  const threadCount = Number(threadSummary?.totalThreads || 0);
  const messageCount = Number(threadSummary?.messageCount || 0);
  const inboundCount = Number(threadSummary?.inboundCount || 0);
  const outboundCount = Number(threadSummary?.outboundCount || 0);
  const templateCount = Number(threadSummary?.templateCount || 0);

  const selectedKey = String(
    selectedThread?.threadKey || selectedThreadKey || "",
  ).trim();
  const activeThread = useMemo(
    () =>
      selectedThread ||
      threadItems.find((t) => t.threadKey === selectedKey) ||
      null,
    [selectedThread, selectedKey, threadItems],
  );

  const canLoadMoreThreads = Boolean(threadPagination?.hasNext);
  const canLoadMoreMessages = Boolean(messagePagination?.hasMoreBefore);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const media = window.matchMedia("(max-width: 768px)");
    const sync = () => setIsMobile(Boolean(media.matches));
    sync();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobilePane("chat");
      return;
    }
    setMobilePane(selectedKey ? "chat" : "list");
  }, [isMobile, selectedKey]);

  // ── Sync loader changes ──────────────────────────────────────────────────────
  useEffect(() => {
    setSearchDraft(loaderSnapshot.q);
    setSearchQuery(loaderSnapshot.q);
    setThreadItems(loaderSnapshot.threads);
    setThreadPagination(loaderSnapshot.pagination);
    setThreadSummary(loaderSnapshot.summary);
    setSelectedThread(loaderSnapshot.selectedThread);
    setSelectedThreadKey(loaderSnapshot.thread);
    setMessages(loaderSnapshot.messages);
    setMessagePagination(loaderSnapshot.messagePagination);
    setThreadLoadError("");
    setMessageLoadError("");
    setThreadRequestKey("");
    setMessageRequestKey("");
    pendingScrollBottomRef.current = true;
    pendingScrollSnapshotRef.current = null;
  }, [loaderSnapshot]);

  // ── Scroll restore after prepend ───────────────────────────────────────────
  useEffect(() => {
    const snap = pendingScrollSnapshotRef.current;
    if (!snap || !messagesScrollRef.current) return;
    const el = messagesScrollRef.current;
    requestAnimationFrame(() => {
      el.scrollTop = Math.max(
        0,
        el.scrollHeight - snap.previousHeight + snap.previousTop,
      );
      pendingScrollSnapshotRef.current = null;
    });
  }, [messages]);

  // ── Scroll to bottom on new thread ─────────────────────────────────────────
  useEffect(() => {
    if (!pendingScrollBottomRef.current || !messagesScrollRef.current) return;
    if (!messages.length) {
      pendingScrollBottomRef.current = false;
      return;
    }
    const el = messagesScrollRef.current;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      pendingScrollBottomRef.current = false;
    });
  }, [messages, selectedKey]);

  // ── Threads fetcher response ────────────────────────────────────────────────
  useEffect(() => {
    const payload = toObject(threadsFetcher.data);
    if (!payload?.requestKey || payload.requestKey !== threadRequestKey) return;
    if (payload.error) {
      setThreadLoadError(String(payload.error || "Failed to load chats"));
      return;
    }
    const incoming = normalizeThreads(payload.threads || payload.items);
    const page = Number(payload?.pagination?.page || 1);
    setThreadPagination(toObject(payload.pagination));
    setThreadSummary(toObject(payload.summary));
    setSelectedThread(toObject(payload.selectedThread));
    setSelectedThreadKey(
      String(payload.thread || payload.selectedThreadKey || "").trim(),
    );
    setThreadItems((cur) =>
      page > 1 ? mergeByKey(cur, incoming, "threadKey") : incoming,
    );
    setThreadLoadError("");
  }, [threadRequestKey, threadsFetcher.data]);

  // ── Messages fetcher response ───────────────────────────────────────────────
  useEffect(() => {
    const payload = toObject(messagesFetcher.data);
    if (!payload?.requestKey || payload.requestKey !== messageRequestKey)
      return;
    if (payload.error) {
      setMessageLoadError(String(payload.error || "Failed to load messages"));
      return;
    }
    const incoming = normalizeMessages(payload.messages || payload.items);
    setMessagePagination(toObject(payload.messagePagination));
    setSelectedThread(toObject(payload.selectedThread || activeThread));
    setMessages((cur) => mergeByKey(incoming, cur, "id"));
    setMessageLoadError("");
  }, [activeThread, messageRequestKey, messagesFetcher.data]);

  // ── Navigation helpers ──────────────────────────────────────────────────────
  const buildRouteHref = (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      const n = String(v || "").trim();
      if (n) q.set(k, n);
    });
    return appHref(`/app/messages${q.toString() ? `?${q.toString()}` : ""}`);
  };

  const submitSearch = (e) => {
    e.preventDefault();
    const next = String(searchDraft || "").trim();
    setSearchQuery(next);
    navigate(buildRouteHref(next ? { q: next } : {}));
  };

  const openThread = (threadKey) => {
    const k = String(threadKey || "").trim();
    if (!k) return;
    if (isMobile) setMobilePane("chat");
    navigate(
      buildRouteHref({ ...(searchQuery ? { q: searchQuery } : {}), thread: k }),
    );
  };

  const goBackToChats = () => {
    if (isMobile) setMobilePane("list");
  };

  const loadMoreThreads = () => {
    if (!canLoadMoreThreads || threadsFetcher.state !== "idle") return;
    const nextPage = Number(threadPagination?.page || 1) + 1;
    const rk = `threads::${searchQuery}::${nextPage}::${THREAD_PAGE_SIZE}`;
    setThreadRequestKey(rk);
    const p = new URLSearchParams({
      scope: "threads",
      page: String(nextPage),
      pageSize: String(THREAD_PAGE_SIZE),
      requestKey: rk,
    });
    if (searchQuery) p.set("q", searchQuery);
    if (selectedKey) p.set("thread", selectedKey);
    threadsFetcher.load(appHref(`/app/messages?${p.toString()}`));
  };

  const loadOlderMessages = () => {
    if (
      !selectedKey ||
      !canLoadMoreMessages ||
      messagesFetcher.state !== "idle"
    )
      return;
    const cursor = String(messagePagination?.beforeCursor || "").trim();
    if (!cursor) return;
    const el = messagesScrollRef.current;
    if (el)
      pendingScrollSnapshotRef.current = {
        previousHeight: el.scrollHeight,
        previousTop: el.scrollTop,
      };
    const rk = `messages::${selectedKey}::${cursor}::${MESSAGE_PAGE_SIZE}`;
    setMessageRequestKey(rk);
    const p = new URLSearchParams({
      scope: "messages",
      thread: selectedKey,
      before: cursor,
      pageSize: String(MESSAGE_PAGE_SIZE),
      requestKey: rk,
    });
    messagesFetcher.load(appHref(`/app/messages?${p.toString()}`));
  };

  const handleThreadsScroll = () => {
    const el = threadsScrollRef.current;
    if (!el || threadsFetcher.state !== "idle" || !canLoadMoreThreads) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 140)
      loadMoreThreads();
  };

  const handleMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el || messagesFetcher.state !== "idle" || !canLoadMoreMessages) return;
    if (el.scrollTop < 120) loadOlderMessages();
  };

  const threadsLoading =
    threadsFetcher.state !== "idle" ||
    (!!threadRequestKey &&
      toObject(threadsFetcher.data)?.requestKey !== threadRequestKey);
  const messagesLoading =
    messagesFetcher.state !== "idle" ||
    (!!messageRequestKey &&
      toObject(messagesFetcher.data)?.requestKey !== messageRequestKey);

  const showSidebar = !isMobile || mobilePane === "list";
  const showChatPanel = !isMobile || mobilePane === "chat";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        background: WA.bg,
        height: "calc(100vh - 56px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: "12px",
        boxShadow: "20px 20px 20px 20px rgba(0, 0, 0, 0.1)",
      }}
    >
      <style>{`
        @keyframes wa-spin { to { transform: rotate(360deg); } }
        .wa-scroll::-webkit-scrollbar { width: 6px; }
        .wa-scroll::-webkit-scrollbar-track { background: transparent; }
        .wa-scroll::-webkit-scrollbar-thumb { background: ${WA.scrollThumb}; border-radius: 3px; }
        .wa-thread-btn { transition: background 0.12s; }
        .wa-thread-btn:hover { background: ${WA.hover} !important; }
        .wa-search-input::placeholder { color: ${WA.textSub}; }
        .wa-search-input:focus { outline: none; }
        @media (max-width: 800px) {
          .wa-sidebar,
          .wa-chat-panel {
            width: 100% !important;
          }
        }
      `}</style>

      {/* ── Top bar ── */}
      <div
        style={{
          height: 56,
          background: WA.header,
          borderBottom: `1px solid ${WA.headerBorder}`,
          display: "flex",

          alignItems: "center",
          padding: "0 18px",
          gap: 16,
          flexShrink: 0,
          boxShadow: "0 1px 0 rgba(15, 23, 42, 0.02)",
        }}
      >
        <div
          style={{
            display: "flex",

            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: WA.green,
              boxShadow: "0 8px 18px rgba(18,140,126,0.22)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.524 5.847L0 24l6.335-1.486A11.953 11.953 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.8 9.8 0 01-4.964-1.348l-.355-.212-3.762.883.938-3.656-.233-.374A9.77 9.77 0 012.182 12C2.182 6.574 6.574 2.182 12 2.182c5.426 0 9.818 4.392 9.818 9.818 0 5.426-4.392 9.818-9.818 9.818z" />
            </svg>
          </div>
          <span style={{ color: WA.text, fontWeight: 700, fontSize: 17 }}>
            Messages
          </span>
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <Tag>
            {senderMode === "own_number"
              ? "Your Own Number"
              : "OrderX Number"}
          </Tag>
          <Tag>{threadCount} chats</Tag>
          <Tag>{messageCount} msgs</Tag>
        </div>
      </div>

      {/* ── Two-pane layout ── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {/* ══ LEFT SIDEBAR ══ */}
        <div
          className="wa-sidebar"
          style={{
            width: isMobile ? "100%" : 360,
            flexShrink: 0,
            display: showSidebar ? "flex" : "none",
            flexDirection: "column",
            background: WA.panel,
            borderRight: `1px solid ${WA.headerBorder}`,
          }}
        >
          {/* Search bar */}
          <div
            style={{
              padding: "10px 12px",
              borderBottom: `1px solid ${WA.divider}`,
              flexShrink: 0,
            }}
          >
            <Form
              method="get"
              action={appHref("/app/messages")}
              onSubmit={submitSearch}
            >
              <input type="hidden" name="thread" value="" />
              <div
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 12,
                    pointerEvents: "none",
                    display: "flex",
                  }}
                >
                  <SearchIcon />
                </div>
                <input
                  className="wa-search-input"
                  type="search"
                  name="q"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  placeholder="Search or start new chat"
                  style={{
                    width: "100%",
                    height: 38,
                    borderRadius: 12,
                    border: `1px solid ${WA.inputBorder}`,
                    background: WA.inputBg,
                    padding: "0 36px 0 38px",
                    fontSize: 14,
                    color: WA.text,
                    boxSizing: "border-box",
                  }}
                />
                {searchDraft && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchDraft("");
                      setSearchQuery("");
                      navigate(buildRouteHref({}));
                    }}
                    style={{
                      position: "absolute",
                      right: 10,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                    }}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            </Form>

            {/* Stats row */}
            <div
              style={{
                display: "flex",
                gap: 6,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              <Tag>{inboundCount} inbound</Tag>
              <Tag>{outboundCount} outbound</Tag>
              <Tag>{templateCount} templates</Tag>
            </div>
          </div>

          {/* Thread list */}
          {threadLoadError && (
            <div
              style={{
                padding: "10px 14px",
                background: "#fef2f2",
                color: "#b91c1c",
                fontSize: 13,
              }}
            >
              {threadLoadError}
            </div>
          )}

          <div
            ref={threadsScrollRef}
            onScroll={handleThreadsScroll}
            className="wa-scroll"
            style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
          >
            {!threadItems.length ? (
              <div
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: WA.textSub,
                  fontSize: 14,
                }}
              >
                {searchQuery ? "No chats match this search." : "No chats yet."}
              </div>
            ) : (
              <>
                {threadItems.map((thread) => {
                  const active = thread.threadKey === selectedKey;
                  const preview = threadDisplayPreview(thread);
                  const kindLabel = friendlyKindLabel(
                    thread.lastKind || thread.lastDirection,
                  );

                  return (
                    <button
                      key={thread.threadKey}
                      type="button"
                      className="wa-thread-btn"
                      onClick={() => openThread(thread.threadKey)}
                      style={{
                        display: "flex",
                        width: "100%",
                        padding: "12px 16px",
                        gap: 12,
                        alignItems: "center",
                        background: active ? WA.active : "transparent",
                        border: "none",
                        borderBottom: `1px solid ${WA.divider}`,
                        cursor: "pointer",
                        textAlign: "left",
                        boxSizing: "border-box",
                        transition:
                          "background 0.12s ease, box-shadow 0.12s ease",
                      }}
                    >
                      <Avatar thread={thread} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <span
                            style={{
                              color: WA.text,
                              fontWeight: 600,
                              fontSize: 15,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {thread.partnerE164 ||
                              thread.threadKey ||
                              "Conversation"}
                          </span>
                          <span
                            style={{
                              color: active ? WA.green : WA.textMuted,
                              fontSize: 11,
                              flexShrink: 0,
                            }}
                          >
                            {thread.lastMessageAt
                              ? formatDateTime(
                                  thread.lastMessageAt,
                                  merchantTimezone,
                                )
                              : ""}
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 4,
                            marginTop: 3,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              minWidth: 0,
                              overflow: "hidden",
                            }}
                          >
                            {thread.lastDirection === "outbound" && (
                              <TickIcon double read />
                            )}
                            <span
                              style={{
                                color: WA.textSub,
                                fontSize: 13,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {preview}
                            </span>
                          </div>
                          <div
                            style={{ display: "flex", gap: 4, flexShrink: 0 }}
                          >
                            {kindLabel ? (
                              <Badge>{thread.messageCount || 0}</Badge>
                            ) : null}
                          </div>
                        </div>
                        {kindLabel ? (
                          <div style={{ marginTop: 4 }}>
                            <Tag>{kindLabel}</Tag>
                            {thread.lastSenderMode ? (
                              <>
                                &nbsp;
                                <Tag>
                                  {friendlySenderMode(thread.lastSenderMode)}
                                </Tag>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </button>
                  );
                })}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    padding: "12px 0",
                  }}
                >
                  {threadsLoading ? (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        color: WA.textSub,
                        fontSize: 13,
                      }}
                    >
                      <Spinner /> Loading…
                    </div>
                  ) : canLoadMoreThreads ? (
                    <button
                      type="button"
                      onClick={loadMoreThreads}
                      style={{
                        background: "none",
                        border: `1px solid ${WA.headerBorder}`,
                        color: WA.green,
                        borderRadius: 20,
                        padding: "6px 18px",
                        fontSize: 13,
                        cursor: "pointer",
                      }}
                    >
                      Load more
                    </button>
                  ) : (
                    <span style={{ color: WA.textMuted, fontSize: 12 }}>
                      No more chats
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ══ RIGHT CHAT PANEL ══ */}
        <div
          className="wa-chat-panel"
          style={{
            flex: 1,
            minWidth: 0,
            display: showChatPanel ? "flex" : "none",
            flexDirection: "column",
            background:
              "linear-gradient(135deg, rgba(236,253,245,0.75) 0%, rgba(240,249,255,0.75) 50%, rgba(255,255,255,0.95) 100%)",
          }}
        >
          {/* Chat header */}
          <div
            style={{
              height: 56,
              background: WA.header,
              borderBottom: `1px solid ${WA.headerBorder}`,
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              gap: 12,
              flexShrink: 0,
            }}
          >
            {activeThread ? (
              <>
                {isMobile ? (
                  <button
                    type="button"
                    onClick={goBackToChats}
                    style={{
                      border: `1px solid ${WA.headerBorder}`,
                      background: "#fff",
                      color: WA.text,
                      borderRadius: 10,
                      padding: "7px 10px",
                      fontSize: 12,
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    Chats
                  </button>
                ) : null}
                <Avatar thread={activeThread} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: WA.text,
                      fontWeight: 600,
                      fontSize: 15,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {activeThread.partnerE164 ||
                      activeThread.threadKey ||
                      "Conversation"}
                  </div>
                  <div
                    style={{ color: WA.textSub, fontSize: 12, marginTop: 1 }}
                  >
                    {activeThread.messageCount || 0} messages ·{" "}
                    {activeThread.lastMessageAt
                      ? formatDateTime(
                          activeThread.lastMessageAt,
                          merchantTimezone,
                        )
                      : "—"}
                  </div>
                </div>
                {!isMobile && (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                    }}
                  >
                    <Tag>{activeThread.inboundCount || 0} in</Tag>
                    <Tag>{activeThread.outboundCount || 0} out</Tag>
                    {activeThread.lastSenderMode ? (
                      <Tag>
                        {friendlySenderMode(activeThread.lastSenderMode)}
                      </Tag>
                    ) : null}
                  </div>
                )}
              </>
            ) : (
              <span style={{ color: WA.textSub, fontSize: 15 }}>
                Select a conversation
              </span>
            )}
          </div>

          {/* Messages area */}
          {messageLoadError && (
            <div
              style={{
                padding: "8px 16px",
                background: "#fef2f2",
                color: "#b91c1c",
                fontSize: 13,
                flexShrink: 0,
              }}
            >
              {messageLoadError}
            </div>
          )}

          <div
            ref={messagesScrollRef}
            onScroll={handleMessagesScroll}
            className="wa-scroll"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "12px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              background:
                "linear-gradient(180deg, rgba(248,250,252,0.92) 0%, rgba(255,255,255,0.98) 100%)",
            }}
          >
            {!activeThread ? (
              <div
                style={{
                  margin: "auto",
                  textAlign: "center",
                  color: WA.textSub,
                }}
              >
                <div style={{ fontSize: 48, marginBottom: 12 }}>💬</div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 600,
                    color: WA.text,
                    marginBottom: 8,
                  }}
                >
                  Select a conversation
                </div>
                <div style={{ fontSize: 14 }}>
                  Choose a chat from the left panel to view messages.
                </div>
              </div>
            ) : !messages.length ? (
              <div
                style={{
                  margin: "auto",
                  textAlign: "center",
                  color: WA.textSub,
                }}
              >
                <div style={{ fontSize: 14 }}>
                  No messages in this chat yet.
                </div>
              </div>
            ) : (
              <>
                {/* Load older trigger */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    padding: "4px 0 8px",
                  }}
                >
                  {messagesLoading ? (
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        color: WA.textSub,
                        fontSize: 12,
                      }}
                    >
                      <Spinner /> Loading older messages…
                    </div>
                  ) : canLoadMoreMessages ? (
                    <button
                      type="button"
                      onClick={loadOlderMessages}
                      style={{
                        background: WA.header,
                        border: "none",
                        color: WA.green,
                        borderRadius: 20,
                        padding: "5px 16px",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      Load older messages
                    </button>
                  ) : (
                    <span
                      style={{
                        background: WA.header,
                        color: WA.textSub,
                        borderRadius: 8,
                        padding: "4px 14px",
                        fontSize: 12,
                      }}
                    >
                      Start of conversation
                    </span>
                  )}
                </div>

                {/* Message bubbles */}
                {messages.map((msg, idx) => {
                  const out = msg.direction === "outbound";
                  const text = messageDisplayText(msg);
                  const time = msg.createdAt
                    ? formatDateTime(msg.createdAt, merchantTimezone)
                    : "";
                  const kindL = friendlyKindLabel(msg.kind);
                  const tplL = friendlyTemplateLabel(msg.templateName);
                  const previewButtons = toArray(msg.previewButtons);
                  const headerMediaUrl = String(
                    msg?.meta?.headerMediaUrlUsed ||
                      msg?.meta?.flowContext?.product_image_url ||
                      msg?.meta?.product_image_url ||
                      "",
                  ).trim();

                  // Group consecutive same-direction messages (no extra gap)
                  const prevMsg = messages[idx - 1];
                  const sameDir = prevMsg?.direction === msg.direction;

                  return (
                    <div
                      key={
                        msg.id || msg.waMessageId || `${msg.createdAt}-${idx}`
                      }
                      style={{
                        display: "flex",
                        justifyContent: out ? "flex-end" : "flex-start",
                        marginTop: sameDir ? 2 : 10,
                      }}
                    >
                      <div
                        style={{
                          maxWidth: isMobile ? "88%" : "65%",
                          minWidth: 80,
                          background: out ? WA.bubbleOut : WA.bubbleIn,
                          borderRadius: out
                            ? "12px 12px 2px 12px"
                            : "12px 12px 12px 2px",
                          padding: "10px 12px",
                          boxShadow: "0 1px 3px rgba(15, 23, 42, 0.08)",
                          border: `1px solid ${out ? "rgba(18,140,126,0.16)" : WA.divider}`,
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        {headerMediaUrl ? (
                          <div
                            style={{
                              overflow: "hidden",
                              borderRadius: 12,
                              background: "#eef2f7",
                              border: `1px solid ${WA.divider}`,
                              marginBottom: 2,
                            }}
                          >
                            <img
                              src={headerMediaUrl}
                              alt=""
                              style={{
                                display: "block",
                                width: "100%",
                                maxHeight: 240,
                                objectFit: "cover",
                              }}
                            />
                          </div>
                        ) : null}

                        {/* Tags row */}
                        {(kindL || tplL) && (
                          <div
                            style={{
                              display: "flex",
                              gap: 4,
                              flexWrap: "wrap",
                              marginBottom: 5,
                            }}
                          >
                            {kindL ? <Tag>{kindL}</Tag> : null}
                            {tplL && tplL !== kindL ? <Tag>{tplL}</Tag> : null}
                          </div>
                        )}

                        {/* Message text */}
                        <div
                          dir="auto"
                          style={{
                            color: WA.text,
                            fontSize: 14,
                            lineHeight: 1.55,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {text}
                        </div>

                        {previewButtons.length ? (
                          <div
                            style={{
                              display: "grid",
                              gap: 6,
                              marginTop: 2,
                            }}
                          >
                            {previewButtons.map((label, buttonIdx) => (
                              <div
                                key={`${msg.id || msg.waMessageId || idx}-btn-${buttonIdx}`}
                                style={{
                                  border: "1px solid rgba(18,140,126,0.2)",
                                  background: "#f8fafc",
                                  color: WA.green,
                                  borderRadius: 12,
                                  padding: "9px 12px",
                                  textAlign: "center",
                                  fontSize: 13,
                                  fontWeight: 600,
                                  lineHeight: 1.35,
                                }}
                              >
                                {label}
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {/* Timestamp + tick */}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            alignItems: "center",
                            gap: 3,
                            whiteSpace: "nowrap",
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontSize: 11, color: WA.textMuted }}>
                            {time}
                          </span>
                          {out && <TickIcon double read />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => appBoundary.headers(headersArgs);
