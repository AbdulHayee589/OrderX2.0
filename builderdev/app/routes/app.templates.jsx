import { useEffect, useMemo, useRef, useState } from "react";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
  useSubmit,
} from "react-router";
import { Modal, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { backendGet, backendPost } from "../server/backend.server";
import { surface } from "../components/AppSurface";
import { withShopParams } from "../utils/embedded";
import { formatDateTime } from "../utils/format";

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers (unchanged)
───────────────────────────────────────────────────────────────────────────── */

const toObject = (value) => (value && typeof value === "object" ? value : {});
const toArray = (value) => (Array.isArray(value) ? value : []);
const RTL_LANGUAGE_BASES = new Set([
  "ar",
  "fa",
  "he",
  "iw",
  "ur",
  "ps",
  "sd",
  "ku",
  "ug",
  "yi",
]);
const CATEGORY_UTILITY = "UTILITY";
const CATEGORY_MARKETING = "MARKETING";

function normalizeLanguageCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function getTemplateTextDirection(language, text = "") {
  const normalizedLanguage = normalizeLanguageCode(language);
  const languageBase = normalizedLanguage.split("-")[0] || "";
  if (RTL_LANGUAGE_BASES.has(languageBase)) return "rtl";
  const source = String(text || "");
  if (/[\u0590-\u08FF]/u.test(source)) return "rtl";
  return "ltr";
}

function statusLabel(status) {
  const normalized = String(status || "draft")
    .trim()
    .toLowerCase();
  if (normalized === "in_review") return "In review";
  if (normalized === "approved") return "Approved";
  if (normalized === "pending") return "Pending";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "missing") return "Missing";
  return "Draft";
}

function normalizeTemplateReviewStatus(value) {
  const normalized = String(value || "draft")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["approved", "active"].includes(normalized)) return "approved";
  if (["in_review", "review", "under_review"].includes(normalized))
    return "in_review";
  if (["pending", "submitted", "processing", "requested"].includes(normalized))
    return "pending";
  if (["rejected", "paused", "disabled", "failed"].includes(normalized))
    return "rejected";
  if (["missing", "not_found"].includes(normalized)) return "missing";
  return "draft";
}

function getRawTemplateStatusCandidates(template) {
  const row = toObject(template);
  return [
    row.forceLocalStatus,
    row.liveStatus,
    row.metaReviewStatus,
    row.metaTemplateStatus,
    row.metaStatus,
    row.reviewStatus,
    row.approvalStatus,
    row.wabaStatus,
    row.templateStatus,
    row.status,
  ].filter((value) => String(value || "").trim());
}

function getTemplateReviewStatus(template, overrides = {}) {
  const row = toObject(template);
  const id = String(row.id || row.templateId || "").trim();
  if (id && overrides[id]) return normalizeTemplateReviewStatus(overrides[id]);

  const candidates = getRawTemplateStatusCandidates(row);

  // Important: if Meta/live status says pending/in_review/rejected, it wins over stale local approved.
  for (const candidate of candidates) {
    const status = normalizeTemplateReviewStatus(candidate);
    if (["pending", "in_review", "rejected", "missing"].includes(status))
      return status;
  }

  if (
    candidates.some(
      (candidate) => normalizeTemplateReviewStatus(candidate) === "approved",
    )
  ) {
    return "approved";
  }

  return normalizeTemplateReviewStatus(row.status || "draft");
}

function isTemplateApprovedForActivation(template, overrides = {}) {
  return getTemplateReviewStatus(template, overrides) === "approved";
}

function isTemplateTestedForActivation(template) {
  const row = toObject(template);
  const status = String(row.testMessageStatus || "")
    .trim()
    .toLowerCase();
  return (
    !!row.testMessageSentAt &&
    !row.testMessageLastError &&
    ["accepted", "sent", "delivered", "read"].includes(status || "accepted")
  );
}

function applyTemplateStatusOverrides(template, overrides = {}) {
  const row = toObject(template);
  const id = String(row.id || row.templateId || "").trim();
  if (!id || !overrides[id]) return row;
  const status = normalizeTemplateReviewStatus(overrides[id]);
  return {
    ...row,
    status,
    forceLocalStatus: status,
  };
}

function applyTemplateStatusOverridesToSystem(templateSystem, overrides = {}) {
  const system = toObject(templateSystem);
  const templates = toArray(system.templates).map((template) =>
    applyTemplateStatusOverrides(template, overrides),
  );
  const templateById = new Map(
    templates.map((template) => [
      String(template.id || template.templateId || ""),
      template,
    ]),
  );
  const flows = toArray(system.flows).map((flow) => {
    const assignedId = String(
      flow?.assignedTemplate?.id || flow?.assignedTemplate?.templateId || "",
    ).trim();
    const assignedTemplate = assignedId
      ? applyTemplateStatusOverrides(
          templateById.get(assignedId) || flow.assignedTemplate,
          overrides,
        )
      : flow.assignedTemplate;
    const assignedApproved = assignedTemplate
      ? isTemplateApprovedForActivation(assignedTemplate, overrides)
      : false;
    return {
      ...flow,
      assignedTemplate,
      ready: Boolean(flow.ready && assignedApproved),
      availableTemplates: toArray(flow.availableTemplates).map((template) =>
        applyTemplateStatusOverrides(template, overrides),
      ),
    };
  });
  return { ...system, templates, flows };
}

function findTemplateById(templateSystem, templateId) {
  const id = String(templateId || "").trim();
  if (!id) return null;
  return (
    toArray(toObject(templateSystem).templates).find(
      (template) =>
        String(template?.id || template?.templateId || "").trim() === id,
    ) || null
  );
}

function normalizeTemplateCategory(value) {
  const normalized = String(value || CATEGORY_UTILITY)
    .trim()
    .toUpperCase();
  return normalized === CATEGORY_MARKETING
    ? CATEGORY_MARKETING
    : CATEGORY_UTILITY;
}

function categoryLabel(value) {
  const normalized = normalizeTemplateCategory(value);
  return normalized === CATEGORY_MARKETING ? "Marketing" : "Utility";
}

const VARIABLE_TOKEN_RE = /{{\s*([^{}]+?)\s*}}/g;
const STRICT_VARIABLE_RE = /^{{[a-z][a-z0-9_]*}}$/;
const VARIABLE_KEY_RE = /^[a-z][a-z0-9_]*$/;

function getAllowedVariableRows(supportedVariables, allVariables) {
  const allowedKeys = new Set(
    toArray(supportedVariables).map((key) => String(key || "").trim()),
  );
  return toArray(allVariables).filter((row) =>
    allowedKeys.has(String(row?.key || "").trim()),
  );
}

function getAllowedVariableKeys(supportedVariables) {
  return new Set(
    toArray(supportedVariables).map((key) => String(key || "").trim()),
  );
}

function extractTemplateVariables(text) {
  const source = String(text || "");
  const matches = [];
  const re = new RegExp(VARIABLE_TOKEN_RE);
  let match;

  while ((match = re.exec(source))) {
    const raw = match[0];
    const key = String(match[1] || "").trim();
    matches.push({
      raw,
      key,
      index: match.index,
      end: match.index + raw.length,
    });
  }

  return matches;
}

function hasBrokenVariableSyntax(text) {
  const source = String(text || "");
  const withoutValidTokens = source.replace(VARIABLE_TOKEN_RE, "");
  return withoutValidTokens.includes("{{") || withoutValidTokens.includes("}}");
}

function uniqueStrings(items) {
  return Array.from(new Set(toArray(items).filter(Boolean)));
}

const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F)/u;

function containsEmoji(value) {
  return EMOJI_RE.test(String(value || ""));
}

function normalizeImageFormat(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^image\//, "")
    .replace(/^\./, "")
    .split(/[;&,\s]/)[0];

  if (normalized === "jpeg") return "jpg";
  return normalized;
}

function getHeaderImageUrlProblem(value, { required = false } = {}) {
  const url = String(value || "").trim();

  if (!url) {
    return required
      ? "Image header needs a public HTTPS JPG or PNG image URL before submitting to Meta."
      : "";
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return "Image link must be a valid public URL, for example https://example.com/product.jpg.";
  }

  if (parsed.protocol !== "https:") {
    return "Image link must start with https://.";
  }

  const path = decodeURIComponent(String(parsed.pathname || "")).toLowerCase();
  const extensionMatch = path.match(/\.([a-z0-9]+)$/);
  const pathFormat = normalizeImageFormat(extensionMatch?.[1] || "");
  const queryFormat = normalizeImageFormat(
    parsed.searchParams.get("fm") ||
      parsed.searchParams.get("format") ||
      parsed.searchParams.get("ext") ||
      parsed.searchParams.get("filetype") ||
      parsed.searchParams.get("type") ||
      "",
  );
  const allowedFormats = new Set(["jpg", "png"]);
  const blockedFormats = new Set([
    "webp",
    "gif",
    "svg",
    "avif",
    "bmp",
    "tif",
    "tiff",
    "ico",
    "heic",
    "heif",
  ]);

  if (pathFormat && allowedFormats.has(pathFormat)) return "";

  if (pathFormat && blockedFormats.has(pathFormat)) {
    return "Image link must be JPG or PNG only. WebP, GIF, SVG, AVIF, and other formats are not allowed for template header images.";
  }

  if (queryFormat && allowedFormats.has(queryFormat)) return "";

  if (queryFormat && blockedFormats.has(queryFormat)) {
    return "Image link format must be JPG or PNG only. Change the URL format parameter to fm=jpg, format=jpg, or format=png.";
  }

  return "Image link must be a direct JPG or PNG URL. Use a link ending in .jpg, .jpeg, .png, or a CDN link with ?fm=jpg / ?format=png. WebP and normal webpage links are not allowed.";
}

function isSupportedHeaderImageUrl(value) {
  return !getHeaderImageUrlProblem(value, { required: true });
}

function validateTemplateTextField({
  label,
  value,
  allowedKeys,
  allowVariables = true,
  required = false,
  maxLength,
  disallowEmoji = false,
}) {
  const errors = [];
  const text = String(value || "");
  const trimmed = text.trim();

  if (required && !trimmed) {
    errors.push(`${label} is required.`);
  }

  if (maxLength && text.length > maxLength) {
    errors.push(`${label} must be ${maxLength} characters or less.`);
  }

  if (disallowEmoji && containsEmoji(text)) {
    errors.push(`${label} cannot contain emojis. Please use plain text only.`);
  }

  if (hasBrokenVariableSyntax(text)) {
    errors.push(
      `${label} has broken {{ }} syntax. Use the smart field buttons instead of typing variables manually.`,
    );
  }

  const tokens = extractTemplateVariables(text);

  if (!allowVariables && tokens.length) {
    errors.push(`${label} cannot contain smart fields.`);
  }

  tokens.forEach((token) => {
    if (!VARIABLE_KEY_RE.test(token.key)) {
      errors.push(
        `${token.raw} is not valid. Smart fields cannot contain spaces or custom words.`,
      );
      return;
    }

    if (token.raw !== `{{${token.key}}}`) {
      errors.push(
        `${token.raw} must be written exactly as {{${token.key}}}. Use the smart field button to insert it safely.`,
      );
    }

    if (!allowedKeys.has(token.key)) {
      errors.push(`${token.raw} is not available for this automation.`);
    }
  });

  if (tokens.length) {
    const firstToken = tokens[0];
    const lastToken = tokens[tokens.length - 1];

    if (text.slice(0, firstToken.index).trim().length === 0) {
      errors.push(
        `${label} cannot start with a smart field. Add words before it.`,
      );
    }

    if (text.slice(lastToken.end).trim().length === 0) {
      errors.push(
        `${label} cannot end with a smart field. Add words after it.`,
      );
    }

    tokens.slice(0, -1).forEach((token, index) => {
      const next = tokens[index + 1];
      const between = text.slice(token.end, next.index);
      if (!between.trim()) {
        errors.push(
          `Add normal words between ${token.raw} and ${next.raw}. Smart fields cannot be side by side.`,
        );
      }
    });
  }

  return errors;
}

function validateTemplateDraft(draft, flowDefinition, variables, options = {}) {
  const mode = String(options.mode || "save").trim();
  const supportedVariables = toArray(flowDefinition?.supportedVariables);
  const allowedKeys = getAllowedVariableKeys(supportedVariables);
  const errors = [];
  const headerType = String(draft?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const buttons = toArray(draft?.buttons);

  if (!String(draft?.displayName || "").trim()) {
    errors.push("Template name is required.");
  }

  if (!["NONE", "TEXT", "IMAGE"].includes(headerType)) {
    errors.push("Choose a valid top title type.");
  }

  if (headerType === "TEXT") {
    errors.push(
      ...validateTemplateTextField({
        label: "Top title",
        value: draft?.headerText,
        allowedKeys,
        allowVariables: true,
        required: false,
        maxLength: 60,
        disallowEmoji: true,
      }),
    );
  }

  errors.push(
    ...validateTemplateTextField({
      label: "Main message",
      value: draft?.bodyText,
      allowedKeys,
      allowVariables: true,
      required: true,
      maxLength: 1024,
    }),
  );

  errors.push(
    ...validateTemplateTextField({
      label: "Small note at bottom",
      value: draft?.footerText,
      allowedKeys,
      allowVariables: false,
      required: false,
      maxLength: 60,
      disallowEmoji: true,
    }),
  );

  if (headerType === "IMAGE") {
    const sampleMediaUrl = String(draft?.sampleMediaUrl || "").trim();
    const imageProblem = getHeaderImageUrlProblem(sampleMediaUrl, {
      required: mode === "submit",
    });
    if (imageProblem) errors.push(imageProblem);
  }

  buttons.forEach((button, index) => {
    const text = String(button?.text || "").trim();
    const type = String(button?.type || "QUICK_REPLY")
      .trim()
      .toUpperCase();
    const allowedTypes = toArray(button?.allowedTypes).length
      ? toArray(button.allowedTypes).map((item) => String(item).toUpperCase())
      : ["QUICK_REPLY"];

    if (!allowedTypes.includes(type)) {
      errors.push(`Button ${index + 1} has an invalid type.`);
    }

    if (!text) {
      errors.push(`Button ${index + 1} needs text.`);
    }

    if (text.length > 25) {
      errors.push(`Button ${index + 1} text must be 25 characters or less.`);
    }

    if (text.includes("{{") || text.includes("}}")) {
      errors.push(`Button ${index + 1} cannot contain smart fields.`);
    }

    if (containsEmoji(text)) {
      errors.push(
        `Button ${index + 1} cannot contain emojis. Use plain text only.`,
      );
    }
  });

  const allowedVariableRows = getAllowedVariableRows(
    supportedVariables,
    variables,
  );
  const allowedVariableMap = new Map(
    allowedVariableRows.map((row) => [String(row.key || "").trim(), row]),
  );
  const usedKeys = uniqueStrings([
    ...extractTemplateVariables(draft?.headerText).map((token) => token.key),
    ...extractTemplateVariables(draft?.bodyText).map((token) => token.key),
  ]);

  usedKeys.forEach((key) => {
    const row = allowedVariableMap.get(key);
    if (!row?.sample && !row?.label) {
      errors.push(
        `Smart field {{${key}}} needs a sample value for Meta review.`,
      );
    }
  });

  return uniqueStrings(errors);
}

function getTemplateHealthChecks(draft, flowDefinition, variables) {
  const supportedVariables = toArray(flowDefinition?.supportedVariables);
  const allowedKeys = getAllowedVariableKeys(supportedVariables);
  const headerType = String(draft?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const bodyText = String(draft?.bodyText || "");
  const footerText = String(draft?.footerText || "");
  const bodyTokens = extractTemplateVariables(bodyText);
  const headerTokens = extractTemplateVariables(draft?.headerText);
  const invalidTokens = [...bodyTokens, ...headerTokens].filter(
    (token) =>
      !VARIABLE_KEY_RE.test(token.key) ||
      !allowedKeys.has(token.key) ||
      token.raw !== `{{${token.key}}}`,
  );
  const submitErrors = validateTemplateDraft(draft, flowDefinition, variables, {
    mode: "submit",
  });

  return [
    {
      label: "Main message added",
      ok: bodyText.trim().length > 0,
      help: "Write the WhatsApp message customers will receive.",
    },
    {
      label: "Only OrderX smart fields used",
      ok:
        invalidTokens.length === 0 &&
        !hasBrokenVariableSyntax(bodyText) &&
        !hasBrokenVariableSyntax(draft?.headerText),
      help: "Use buttons like {{customer_name}}. Do not type custom {{words}}.",
    },
    {
      label: "Smart fields are placed safely",
      ok: !submitErrors.some(
        (error) =>
          error.includes("cannot start") ||
          error.includes("cannot end") ||
          error.includes("side by side"),
      ),
      help: "Meta can reject templates where variables are dangling or too close.",
    },
    {
      label: "Bottom note has no smart fields",
      ok: !footerText.includes("{{") && !footerText.includes("}}"),
      help: "OrderX keeps footer text static to avoid send-time parameter errors.",
    },
    {
      label: "Buttons are valid",
      ok: !submitErrors.some((error) =>
        error.toLowerCase().startsWith("button"),
      ),
      help: "Button text must be simple and 25 characters or less.",
    },
    {
      label: "Image is JPG or PNG",
      ok:
        headerType !== "IMAGE" ||
        isSupportedHeaderImageUrl(String(draft?.sampleMediaUrl || "").trim()),
      help: "For image headers, use a public HTTPS .jpg/.jpeg/.png link, or a CDN link like Unsplash with ?fm=jpg or ?format=png.",
    },
    {
      label: "No emojis in title, footer, or buttons",
      ok:
        !containsEmoji(String(draft?.headerText || "")) &&
        !containsEmoji(String(draft?.footerText || "")) &&
        toArray(draft?.buttons).every(
          (button) => !containsEmoji(String(button?.text || "")),
        ),
      help: "Keep these parts plain text only. Emojis are allowed in the main message, not in top title, bottom note, or buttons.",
    },
    {
      label: "Ready for Meta submission",
      ok: submitErrors.length === 0,
      help: "Save first, then submit the approved draft to Meta.",
    },
  ];
}

function buildSpacedInsertion({ before, token, after }) {
  const left = before && !/[\s\n]$/.test(before) ? " " : "";
  const right = after && !/^[\s\n.,!?;:]/.test(after) ? " " : " ";
  return `${left}${token}${right}`;
}

function resolvePreviewText(text, variables) {
  const map = Object.fromEntries(
    toArray(variables).map((row) => [
      row.key,
      row.sample || row.label || row.key,
    ]),
  );
  return String(text || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const normalized = String(key || "")
      .trim()
      .toLowerCase();
    return String(map[normalized] || `{{${normalized}}}`);
  });
}

function renderPreviewNodes(text, variables) {
  const resolved = resolvePreviewText(text, variables);
  if (!String(resolved || "").trim()) return [];
  const counter = { value: 0 };
  const nextKey = (prefix) => `${prefix}-${counter.value++}`;
  const parseResolved = (input) => {
    const nodes = [];
    let index = 0;
    let plainStart = 0;
    const flushPlain = (end) => {
      if (end > plainStart) nodes.push(input.slice(plainStart, end));
    };
    while (index < input.length) {
      if (input.startsWith("```", index)) {
        const end = input.indexOf("```", index + 3);
        if (end !== -1) {
          flushPlain(index);
          nodes.push(
            <span
              key={nextKey("mono")}
              style={{
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                background: "rgba(15,23,42,0.05)",
                borderRadius: 4,
                padding: "0 4px",
              }}
            >
              {input.slice(index + 3, end)}
            </span>,
          );
          index = end + 3;
          plainStart = index;
          continue;
        }
      }
      const marker = input[index];
      if (marker === "*" || marker === "_" || marker === "~") {
        const end = input.indexOf(marker, index + 1);
        if (end !== -1) {
          flushPlain(index);
          const inner = input.slice(index + 1, end);
          const style =
            marker === "*"
              ? { fontWeight: 800 }
              : marker === "_"
                ? { fontStyle: "italic" }
                : { textDecoration: "line-through" };
          nodes.push(
            <span key={nextKey("fmt")} style={style}>
              {parseResolved(inner)}
            </span>,
          );
          index = end + 1;
          plainStart = index;
          continue;
        }
      }
      index += 1;
    }
    flushPlain(input.length);
    return nodes;
  };
  return parseResolved(resolved);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Design tokens
───────────────────────────────────────────────────────────────────────────── */

const T = {
  // Colors
  bg: "#f8f9fb",
  surface: "#ffffff",
  surfaceAlt: "#f3f4f6",
  border: "#e5e7eb",
  borderLight: "#f0f1f3",
  text: "#111827",
  textSub: "#4b5563",
  textMuted: "#9ca3af",
  accent: "#2563eb",
  accentLight: "#eff6ff",
  accentBorder: "#bfdbfe",
  success: "#16a34a",
  successLight: "#f0fdf4",
  warning: "#d97706",
  warningLight: "#fffbeb",
  danger: "#dc2626",
  dangerLight: "#fef2f2",
  // Typography
  fontDisplay: "'DM Sans', system-ui, sans-serif",
  fontBody: "'DM Sans', system-ui, sans-serif",
  // Radii
  radiusSm: "6px",
  radiusMd: "10px",
  radiusLg: "14px",
  radiusXl: "18px",
  radiusFull: "9999px",
  // Shadows
  shadowSm: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.04)",
  shadowLg: "0 12px 32px rgba(0,0,0,0.10), 0 4px 8px rgba(0,0,0,0.06)",
  shadowXl: "0 24px 64px rgba(0,0,0,0.14), 0 8px 24px rgba(0,0,0,0.08)",
};

/* ─────────────────────────────────────────────────────────────────────────────
   Design components
───────────────────────────────────────────────────────────────────────────── */

function Card({ children, style = {} }) {
  return (
    <div
      style={{
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.radiusLg,
        boxShadow: T.shadowSm,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CardBody({ children, style = {} }) {
  return <div style={{ padding: "20px 24px", ...style }}>{children}</div>;
}

function Badge({ tone = "default", children, style = {} }) {
  const map = {
    success: { bg: "#dcfce7", color: "#15803d", border: "#bbf7d0" },
    warning: { bg: "#fef9c3", color: "#a16207", border: "#fde68a" },
    critical: { bg: "#fee2e2", color: "#b91c1c", border: "#fecaca" },
    info: { bg: "#dbeafe", color: "#1d4ed8", border: "#bfdbfe" },
    subdued: { bg: "#f3f4f6", color: "#6b7280", border: "#e5e7eb" },
    default: { bg: "#f3f4f6", color: "#374151", border: "#e5e7eb" },
    accent: { bg: T.accentLight, color: T.accent, border: T.accentBorder },
  };
  const c = map[tone] || map.default;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 10px",
        borderRadius: T.radiusFull,
        fontSize: 12,
        fontWeight: 600,
        background: c.bg,
        color: c.color,
        border: `1px solid ${c.border}`,
        letterSpacing: "0.01em",
        lineHeight: 1,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function SectionHeader({ title, description, action }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 16,
        marginBottom: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 700,
            color: T.text,
            letterSpacing: "-0.01em",
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              fontSize: 13.5,
              color: T.textSub,
              marginTop: 3,
              lineHeight: 1.5,
            }}
          >
            {description}
          </div>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TemplatePreview (redesigned)
───────────────────────────────────────────────────────────────────────────── */

function TemplatePreview({ draft, variables }) {
  const headerType = String(draft?.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const hasImageHeader = headerType === "IMAGE";
  const sampleImageUrl = String(draft?.sampleMediaUrl || "").trim();
  const direction = getTemplateTextDirection(
    draft?.language,
    `${draft?.headerText || ""} ${draft?.bodyText || ""} ${draft?.footerText || ""}`,
  );
  const align = direction === "rtl" ? "right" : "left";
  const bodyPreview = renderPreviewNodes(draft?.bodyText, variables);
  const headerPreview = renderPreviewNodes(draft?.headerText, variables);
  const footerPreview = renderPreviewNodes(draft?.footerText, variables);

  return (
    <div
      style={{
        background:
          "linear-gradient(160deg, #e2f5e8 0%, #f0f7ff 50%, #faf5ff 100%)",
        borderRadius: T.radiusXl,
        padding: 20,
        border: `1px solid ${T.borderLight}`,
        minHeight: 200,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        position: "sticky",
        top: "20px",
      }}
    >
      {/* Phone chrome */}
      <div
        style={{
          width: "100%",
          maxWidth: 320,
          background: T.surface,
          borderRadius: 20,
          boxShadow: T.shadowLg,
          border: `1px solid ${T.borderLight}`,
          overflow: "hidden",
        }}
      >
        {/* WhatsApp header bar */}
        <div
          style={{
            background: "#075e54",
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "#128c7e",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              color: "#fff",
              fontWeight: 700,
            }}
          >
            B
          </div>
          <div>
            <div
              style={{
                color: "#fff",
                fontWeight: 600,
                fontSize: 13,
                lineHeight: 1.2,
              }}
            >
              Business
            </div>
            <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11 }}>
              Template preview
            </div>
          </div>
        </div>
        {/* Chat area */}
        <div
          style={{
            background: "#e5ddd5",
            padding: "12px 10px",
            minHeight: 120,
          }}
        >
          <div
            style={{
              background: T.surface,
              borderRadius: "0 12px 12px 12px",
              padding: 12,
              maxWidth: "90%",
              boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
            }}
          >
            {hasImageHeader ? (
              <div
                style={{
                  minHeight: 120,
                  borderRadius: 10,
                  marginBottom: 10,
                  background: sampleImageUrl
                    ? `center / cover no-repeat url("${sampleImageUrl}")`
                    : "linear-gradient(135deg, #e0f2fe, #f0fdf4)",
                  border: `1px solid ${T.borderLight}`,
                  display: "grid",
                  placeItems: "center",
                  color: "#0369a1",
                  fontSize: 12,
                  fontWeight: 700,
                  overflow: "hidden",
                }}
              >
                {!sampleImageUrl ? "📷 Product image" : null}
              </div>
            ) : headerType === "TEXT" &&
              String(draft?.headerText || "").trim() ? (
              <div
                dir={direction}
                lang={draft?.language || "en"}
                style={{
                  fontWeight: 700,
                  marginBottom: 8,
                  color: T.text,
                  fontSize: 13,
                  direction,
                  textAlign: align,
                  unicodeBidi: "plaintext",
                }}
              >
                {headerPreview}
              </div>
            ) : null}

            <div
              dir={direction}
              lang={draft?.language || "en"}
              style={{
                whiteSpace: "pre-wrap",
                lineHeight: 1.55,
                color: "#1f2937",
                fontSize: 13,
                direction,
                textAlign: align,
                unicodeBidi: "plaintext",
              }}
            >
              {bodyPreview.length ? (
                bodyPreview
              ) : (
                <span style={{ color: T.textMuted, fontStyle: "italic" }}>
                  Template body will appear here…
                </span>
              )}
            </div>

            {String(draft?.footerText || "").trim() ? (
              <div
                dir={direction}
                lang={draft?.language || "en"}
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: `1px solid ${T.borderLight}`,
                  color: T.textMuted,
                  fontSize: 11,
                  direction,
                  textAlign: align,
                  unicodeBidi: "plaintext",
                }}
              >
                {footerPreview}
              </div>
            ) : null}

            <div style={{ textAlign: "right", marginTop: 4 }}>
              <span style={{ fontSize: 10, color: T.textMuted }}>✓✓ 09:41</span>
            </div>
          </div>

          {toArray(draft?.buttons).length ? (
            <div
              style={{ marginTop: 8, display: "grid", gap: 6, maxWidth: "90%" }}
            >
              {toArray(draft.buttons).map((button) => (
                <div
                  key={`${button.type}-${button.index}-${button.text}`}
                  style={{
                    background: T.surface,
                    borderRadius: 10,
                    color: "#128c7e",
                    padding: "8px 12px",
                    fontSize: 12,
                    fontWeight: 700,
                    textAlign: "center",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  ↩ {button.text}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   VariablePicker
───────────────────────────────────────────────────────────────────────────── */

function VariablePicker({
  supportedVariables,
  allVariables,
  onInsert,
  title = "Smart fields",
  compact = false,
}) {
  const variableRows = getAllowedVariableRows(supportedVariables, allVariables);
  if (!variableRows.length) {
    return (
      <div
        style={{
          padding: "10px 12px",
          borderRadius: T.radiusMd,
          background: T.warningLight,
          border: "1px solid #fde68a",
          color: "#92400e",
          fontSize: 13,
          lineHeight: 1.45,
        }}
      >
        This automation has no smart fields available. Write normal text only.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: T.textSub,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          Click a field to insert it at your cursor
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          padding: compact ? 0 : 10,
          borderRadius: compact ? 0 : T.radiusMd,
          background: compact ? "transparent" : "#f8fafc",
          border: compact ? "none" : `1px solid ${T.border}`,
        }}
      >
        {variableRows.map((row) => {
          const key = String(row.key || "").trim();
          const token = `{{${key}}}`;
          return (
            <button
              key={key}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => onInsert(token)}
              style={{
                borderRadius: T.radiusFull,
                border: `1px solid ${T.accentBorder}`,
                background: "#ffffff",
                color: T.accent,
                padding: compact ? "6px 10px" : "8px 12px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 800,
                boxShadow: "0 1px 2px rgba(15,23,42,0.05)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                outline: "none",
              }}
              title={`${token}${row.sample ? ` → ${row.sample}` : ""}`}
            >
              <span>{row.label || key}</span>
              <code
                style={{
                  fontSize: 10.5,
                  color: "#475569",
                  background: "#eef2ff",
                  borderRadius: 999,
                  padding: "2px 6px",
                  fontWeight: 800,
                }}
              >
                {token}
              </code>
            </button>
          );
        })}
      </div>

      {!compact ? (
        <div
          style={{
            fontSize: 12,
            color: T.textMuted,
            lineHeight: 1.45,
          }}
        >
          Do not type <code>{"{{ }}"}</code> manually. OrderX only accepts
          these fixed smart fields so Meta sending does not fail later.
        </div>
      ) : null}
    </div>
  );
}

function FieldErrors({ errors }) {
  if (!toArray(errors).length) return null;
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {toArray(errors).map((error) => (
        <div
          key={error}
          style={{
            fontSize: 12.5,
            color: "#b91c1c",
            lineHeight: 1.4,
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          <span>⚠</span>
          <span>{error}</span>
        </div>
      ))}
    </div>
  );
}

function ValidationChecklist({ checks, errors }) {
  const hasErrors = toArray(errors).length > 0;
  return (
    <div
      style={{
        border: `1px solid ${hasErrors ? "#fecaca" : "#bbf7d0"}`,
        background: hasErrors ? "#fef2f2" : "#f0fdf4",
        borderRadius: T.radiusLg,
        padding: 14,
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 900,
            color: hasErrors ? "#991b1b" : "#166534",
          }}
        >
          {hasErrors ? "Fix before saving" : "Ready"}
        </div>
        <Badge tone={hasErrors ? "critical" : "success"}>
          {hasErrors
            ? `${errors.length} issue${errors.length === 1 ? "" : "s"}`
            : "All checks passed"}
        </Badge>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {toArray(checks).map((check) => (
          <div
            key={check.label}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "8px 10px",
              borderRadius: 10,
              background: "rgba(255,255,255,0.75)",
              border: `1px solid ${check.ok ? "#dcfce7" : "#fee2e2"}`,
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 99,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                background: check.ok ? "#dcfce7" : "#fee2e2",
                color: check.ok ? "#15803d" : "#b91c1c",
                fontSize: 11,
                fontWeight: 900,
              }}
            >
              {check.ok ? "✓" : "!"}
            </span>
            <span style={{ display: "grid", gap: 2 }}>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 800,
                  color: T.text,
                  lineHeight: 1.25,
                }}
              >
                {check.label}
              </span>
              <span
                style={{ fontSize: 12, color: T.textSub, lineHeight: 1.35 }}
              >
                {check.help}
              </span>
            </span>
          </div>
        ))}
      </div>

      {hasErrors ? <FieldErrors errors={errors} /> : null}
    </div>
  );
}

function NativeTextInput({
  label,
  value,
  onChange,
  inputRef,
  placeholder,
  maxLength,
  dir,
  lang,
  details,
  error,
  type = "text",
}) {
  return (
    <label style={{ display: "grid", gap: 7 }}>
      <span style={{ fontSize: 13, fontWeight: 800, color: T.text }}>
        {label}
      </span>
      <input
        ref={inputRef}
        type={type}
        value={value || ""}
        maxLength={maxLength}
        placeholder={placeholder}
        dir={dir}
        lang={lang}
        onChange={(event) => onChange(event.target.value)}
        style={{
          width: "100%",
          minHeight: 42,
          boxSizing: "border-box",
          border: `1px solid ${error ? "#fca5a5" : T.border}`,
          borderRadius: T.radiusMd,
          background: T.surface,
          color: T.text,
          padding: "0 12px",
          font: "inherit",
          fontSize: 14,
          outline: "none",
          boxShadow: error ? "0 0 0 3px rgba(239,68,68,0.10)" : "none",
        }}
      />
      {details ? (
        <span style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.4 }}>
          {details}
        </span>
      ) : null}
    </label>
  );
}

function FriendlyStatCard({ icon, label, value, help, tone = "default" }) {
  const toneMap = {
    success: { bg: "#f0fdf4", border: "#bbf7d0", color: "#15803d" },
    warning: { bg: "#fffbeb", border: "#fde68a", color: "#a16207" },
    info: { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
    default: { bg: "#ffffff", border: T.border, color: T.text },
  };
  const c = toneMap[tone] || toneMap.default;
  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        background: c.bg,
        borderRadius: 18,
        padding: 16,
        boxShadow: "0 0 18px rgba(15, 23, 42, 0.06)",
        minHeight: 112,
        display: "grid",
        alignContent: "space-between",
        gap: 12,
      }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
      >
        <div style={{ fontSize: 13, color: T.textSub, fontWeight: 800 }}>
          {label}
        </div>
        <div style={{ fontSize: 20 }}>{icon}</div>
      </div>
      <div>
        <div
          style={{
            fontSize: 26,
            fontWeight: 950,
            color: c.color,
            letterSpacing: "-0.04em",
          }}
        >
          {value}
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12.5,
            color: T.textSub,
            lineHeight: 1.4,
          }}
        >
          {help}
        </div>
      </div>
    </div>
  );
}

function HowItWorksStep({ number, title, text }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        border: `1px solid ${T.border}`,
        borderRadius: 18,
        padding: 14,
        background: "#ffffff",
        boxShadow: "0 0 14px rgba(15, 23, 42, 0.05)",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 12,
          background: "#18392b",
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 950,
          flexShrink: 0,
        }}
      >
        {number}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 950, color: T.text }}>
          {title}
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12.5,
            color: T.textSub,
            lineHeight: 1.45,
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

function EmptyFriendlyState({ icon = "📄", title, text, action }) {
  return (
    <div
      style={{
        border: `1px dashed ${T.border}`,
        borderRadius: 20,
        background: "#ffffff",
        padding: "34px 18px",
        textAlign: "center",
        display: "grid",
        justifyItems: "center",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 38 }}>{icon}</div>
      <div style={{ fontSize: 16, fontWeight: 950, color: T.text }}>
        {title}
      </div>
      <div
        style={{
          maxWidth: 520,
          fontSize: 13,
          color: T.textSub,
          lineHeight: 1.55,
        }}
      >
        {text}
      </div>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   FormattedTextArea
───────────────────────────────────────────────────────────────────────────── */

function FormattedTextArea({
  value,
  onChange,
  textareaRef,
  language,
  error = false,
}) {
  const direction = getTemplateTextDirection(language, value);
  const align = direction === "rtl" ? "right" : "left";

  const replaceSelection = (buildText, getCursorOffset) => {
    const el = textareaRef.current;
    const text = String(value || "");
    if (!el) {
      const next = buildText(text, 0, 0);
      onChange(next);
      return;
    }
    const start = Number(el.selectionStart || 0);
    const end = Number(el.selectionEnd || start);
    const next = buildText(text, start, end);
    onChange(next);
    requestAnimationFrame(() => {
      const nextCursor = getCursorOffset
        ? getCursorOffset(start, end, next)
        : start;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const applyWrap = (prefix, suffix = prefix) => {
    replaceSelection(
      (text, start, end) => {
        const selected = text.slice(start, end) || "text";
        return `${text.slice(0, start)}${prefix}${selected}${suffix}${text.slice(end)}`;
      },
      (start, end) => {
        const selectedLength = Math.max(0, end - start) || 4;
        return start + prefix.length + selectedLength;
      },
    );
  };

  const insertEmoji = (emoji) => {
    replaceSelection(
      (text, start, end) => `${text.slice(0, start)}${emoji}${text.slice(end)}`,
      (start) => start + emoji.length,
    );
  };

  const charCount = String(value || "").length;
  const charPct = Math.min(charCount / 1024, 1);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          padding: "8px 10px",
          background: T.surfaceAlt,
          borderRadius: `${T.radiusMd} ${T.radiusMd} 0 0`,
          border: `1px solid ${error ? "#fca5a5" : T.border}`,
          borderBottom: "none",
        }}
      >
        {[
          ["B", "*", { fontWeight: 900 }],
          ["I", "_", { fontStyle: "italic" }],
          ["S", "~", { textDecoration: "line-through" }],
        ].map(([label, marker, labelStyle]) => (
          <button
            key={marker}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyWrap(marker)}
            style={{
              width: 30,
              height: 30,
              borderRadius: T.radiusSm,
              border: `1px solid ${T.border}`,
              background: T.surface,
              color: T.text,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 800,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              ...labelStyle,
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyWrap("```", "```")}
          style={{
            height: 30,
            padding: "0 8px",
            borderRadius: T.radiusSm,
            border: `1px solid ${T.border}`,
            background: T.surface,
            color: T.text,
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "monospace",
            fontWeight: 800,
          }}
        >
          {"</>"}
        </button>
        <div style={{ width: 1, background: T.border, margin: "4px 0" }} />
        {["✅", "📦", "⏳", "📍", "🔁"].map((emoji) => (
          <button
            key={emoji}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertEmoji(emoji)}
            style={{
              width: 30,
              height: 30,
              borderRadius: T.radiusSm,
              border: `1px solid ${T.border}`,
              background: T.surface,
              cursor: "pointer",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {emoji}
          </button>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        dir={direction}
        lang={language || "en"}
        value={value || ""}
        maxLength={1024}
        onChange={(event) => onChange(event.target.value)}
        rows={11}
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          borderRadius: `0 0 ${T.radiusMd} ${T.radiusMd}`,
          border: `1px solid ${error ? "#fca5a5" : T.border}`,
          padding: "13px 14px",
          color: T.text,
          background: T.surface,
          font: "inherit",
          lineHeight: 1.6,
          fontSize: 14,
          outline: "none",
          direction,
          textAlign: align,
          unicodeBidi: "plaintext",
          boxShadow: error ? "0 0 0 3px rgba(239,68,68,0.10)" : "none",
        }}
        placeholder="Example: Hi {{customer_name}}, please confirm your order {{order_name}}."
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: T.textMuted }}>
          Use smart field buttons below. Do not type custom {"{{ }}"} manually.
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 80,
              height: 4,
              borderRadius: 4,
              background: T.surfaceAlt,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${charPct * 100}%`,
                background:
                  charPct > 0.9
                    ? T.danger
                    : charPct > 0.7
                      ? T.warning
                      : T.accent,
                borderRadius: 4,
              }}
            />
          </div>
          <span
            style={{
              fontSize: 12,
              color: charPct > 0.9 ? T.danger : T.textMuted,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {charCount}/1024
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TemplateEditorModal — Shopify modal
───────────────────────────────────────────────────────────────────────────── */

function TemplateEditorModal({
  draft,
  setDraft,
  flowDefinition,
  variables,
  languageOptions,
  onSave,
  onClose,
  saving,
}) {
  const bodyRef = useRef(null);
  const headerTextRef = useRef(null);

  if (!draft || !flowDefinition) return null;

  const supportedVariables = toArray(flowDefinition.supportedVariables);
  const fixedButtons = toArray(flowDefinition.fixedButtons);
  const isOrderConfirmationFlow =
    String(draft.flowKey || flowDefinition.key || "").trim() ===
    "order_confirmation";
  const editableButtons =
    isOrderConfirmationFlow || toArray(draft.buttons).length
      ? toArray(draft.buttons)
      : fixedButtons;
  const draftWithButtons = { ...draft, buttons: editableButtons };
  const headerType = String(draft.headerType || "TEXT")
    .trim()
    .toUpperCase();
  const templateCategory = normalizeTemplateCategory(
    draft.category || flowDefinition.templateCategory,
  );
  const languageCode = String(draft.language || "en").trim() || "en";
  const textDirection = getTemplateTextDirection(
    languageCode,
    `${draft.headerText || ""} ${draft.bodyText || ""}`,
  );
  const supportsImageHeader = !!flowDefinition.supportsImageHeader;
  const isRevision =
    !!draft.templateId &&
    ["approved", "pending", "in_review"].includes(
      String(draft.status || "").toLowerCase(),
    );

  const saveErrors = validateTemplateDraft(
    draftWithButtons,
    flowDefinition,
    variables,
    { mode: "save" },
  );
  const submitErrors = validateTemplateDraft(
    draftWithButtons,
    flowDefinition,
    variables,
    { mode: "submit" },
  );
  const checks = getTemplateHealthChecks(
    draftWithButtons,
    flowDefinition,
    variables,
  );
  const canSaveDraft = !saving && saveErrors.length === 0;

  const allowedKeys = getAllowedVariableKeys(supportedVariables);
  const headerErrors =
    headerType === "TEXT"
      ? validateTemplateTextField({
          label: "Top title",
          value: draft.headerText,
          allowedKeys,
          allowVariables: true,
          required: false,
          maxLength: 60,
          disallowEmoji: true,
        })
      : [];
  const bodyErrors = validateTemplateTextField({
    label: "Main message",
    value: draft.bodyText,
    allowedKeys,
    allowVariables: true,
    required: true,
    maxLength: 1024,
  });
  const footerErrors = validateTemplateTextField({
    label: "Small note at bottom",
    value: draft.footerText,
    allowedKeys,
    allowVariables: false,
    required: false,
    maxLength: 60,
    disallowEmoji: true,
  });

  const updateButton = (index, patch) => {
    setDraft((current) => ({
      ...current,
      buttons: editableButtons.map((button, buttonIndex) =>
        buttonIndex === index ? { ...button, ...patch } : button,
      ),
    }));
  };

  const deleteButton = (index) => {
    setDraft((current) => ({
      ...current,
      buttons: editableButtons.filter(
        (_, buttonIndex) => buttonIndex !== index,
      ),
    }));
  };

  const addButton = (button) => {
    const nextButton = {
      type: button.type || "QUICK_REPLY",
      text: button.text || "",
      index: Number.isFinite(Number(button.index)) ? Number(button.index) : 0,
      action: button.action || null,
      allowedTypes: toArray(button.allowedTypes).length
        ? button.allowedTypes
        : ["QUICK_REPLY"],
    };
    setDraft((current) => ({
      ...current,
      buttons: [...editableButtons, nextButton].sort(
        (a, b) => Number(a.index || 0) - Number(b.index || 0),
      ),
    }));
  };

  const currentButtonActions = new Set(
    editableButtons.map((button) => String(button.action || "").trim()),
  );
  const currentButtonIndexes = new Set(
    editableButtons.map((button) => Number(button.index)),
  );
  const addableButtons = isOrderConfirmationFlow
    ? fixedButtons.filter((button) => {
        const action = String(button.action || "").trim();
        if (action && currentButtonActions.has(action)) return false;
        return !currentButtonIndexes.has(Number(button.index));
      })
    : [];

  const handleSave = () => {
    if (!canSaveDraft) return;
    onSave({ ...draft, buttons: editableButtons });
  };

  const updateFieldValue = (key) => (event) => {
    const nextValue =
      event?.currentTarget?.value ??
      event?.target?.value ??
      event?.detail?.value ??
      "";
    setDraft((current) => ({ ...current, [key]: nextValue }));
  };

  const setFieldValue = (key) => (value) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const insertSmartField = (key, ref, token) => {
    const safeToken = String(token || "").trim();
    if (!STRICT_VARIABLE_RE.test(safeToken)) return;

    const el = ref?.current;
    const currentText = String(draft?.[key] || "");
    const start =
      el && typeof el.selectionStart === "number"
        ? Number(el.selectionStart)
        : currentText.length;
    const end =
      el && typeof el.selectionEnd === "number"
        ? Number(el.selectionEnd)
        : start;
    const before = currentText.slice(0, start);
    const after = currentText.slice(end);
    const insertion = buildSpacedInsertion({ before, token: safeToken, after });
    const next = `${before}${insertion}${after}`;
    const cursor = before.length + insertion.length;

    setDraft((current) => ({ ...current, [key]: next }));

    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  const modeLabel = draft.templateId
    ? "Edit WhatsApp template"
    : "Create WhatsApp template";
  const modalId = "template-editor-modal";

  return (
    <Modal id={modalId} variant="large" open={Boolean(draft)} onHide={onClose}>
      <TitleBar title={modeLabel}>
        <button variant="secondary" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          variant="primary"
          onClick={handleSave}
          disabled={!canSaveDraft}
          type="button"
        >
          Save draft
        </button>
      </TitleBar>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 380px",
          minHeight: 0,
          background: T.bg,
        }}
      >
        <div
          style={{
            overflowY: "auto",
            padding: "24px 28px",
            display: "grid",
            gap: 18,
            alignContent: "start",
            minWidth: 0,
          }}
        >
          {isRevision ? (
            <s-banner tone="warning">
              This template is already approved or under review. Saving creates
              a safe revision instead of changing the live approved template.
            </s-banner>
          ) : null}

          <Card>
            <CardBody>
              <div style={{ display: "grid", gap: 16 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 14,
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 900,
                        color: T.text,
                        letterSpacing: "-0.02em",
                      }}
                    >
                      1. Choose what this message is for
                    </div>
                    <div
                      style={{ fontSize: 13, color: T.textSub, marginTop: 4 }}
                    >
                      OrderX locks the right category and smart fields for
                      this automation.
                    </div>
                  </div>
                  <Badge
                    tone={
                      templateCategory === CATEGORY_MARKETING
                        ? "warning"
                        : "accent"
                    }
                  >
                    {categoryLabel(templateCategory)}
                  </Badge>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                    gap: 12,
                  }}
                >
                  <s-text-field
                    label="Template name"
                    value={draft.displayName || ""}
                    dir={textDirection}
                    lang={languageCode}
                    details="Only shown inside OrderX. Keep it simple, like Order confirmation English."
                    onChange={updateFieldValue("displayName")}
                    onInput={updateFieldValue("displayName")}
                  />
                  <s-select
                    label="Language"
                    value={languageCode}
                    onChange={updateFieldValue("language")}
                  >
                    {toArray(languageOptions).map((language) => (
                      <s-option key={language.code} value={language.code}>
                        {language.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-text-field
                    label="Meta category"
                    value={templateCategory}
                    details="Locked by the selected automation to avoid wrong template type."
                    disabled
                  />
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 900,
                      color: T.text,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    2. Optional top title
                  </div>
                  <div style={{ fontSize: 13, color: T.textSub, marginTop: 4 }}>
                    Keep it short. Image headers need a sample image for Meta
                    review.
                  </div>
                </div>

                <s-select
                  label="Top title type"
                  value={headerType}
                  onChange={(event) =>
                    setDraft((current) => {
                      const nextHeaderType =
                        event?.currentTarget?.value ||
                        event?.target?.value ||
                        event?.detail?.value ||
                        "NONE";

                      return {
                        ...current,
                        headerType: String(nextHeaderType).trim().toUpperCase(),
                        headerText: current.headerText || "",
                        sampleMediaUrl: current.sampleMediaUrl || "",
                      };
                    })
                  }
                >
                  <s-option value="NONE">No top title</s-option>
                  <s-option value="TEXT">Text title</s-option>
                  {supportsImageHeader ? (
                    <s-option value="IMAGE">Image title</s-option>
                  ) : null}
                </s-select>

                {headerType === "TEXT" ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    <NativeTextInput
                      label="Top title text"
                      value={draft.headerText || ""}
                      inputRef={headerTextRef}
                      maxLength={60}
                      dir={textDirection}
                      lang={languageCode}
                      details="Max 60 characters. No emojis. Use smart fields only from the buttons below."
                      error={headerErrors.length > 0}
                      onChange={setFieldValue("headerText")}
                    />
                    <VariablePicker
                      supportedVariables={supportedVariables}
                      allVariables={variables}
                      title="Smart fields for title"
                      onInsert={(token) =>
                        insertSmartField("headerText", headerTextRef, token)
                      }
                    />
                    <FieldErrors errors={headerErrors} />
                  </div>
                ) : null}

                {headerType === "IMAGE" ? (
                  <NativeTextInput
                    label="Sample image URL"
                    value={draft.sampleMediaUrl || ""}
                    dir="ltr"
                    lang="en"
                    placeholder="https://example.com/product-image.jpg"
                    details="Required before submitting to Meta. Use a public https:// JPG/PNG image URL. Accepted: links ending in .jpg, .jpeg, .png, or CDN links like Unsplash with ?fm=jpg / ?format=png. Not allowed: WebP, GIF, SVG, Google Drive preview links, or normal webpages."
                    error={submitErrors.some(
                      (error) =>
                        error.includes("Image header") ||
                        error.includes("Image link"),
                    )}
                    onChange={setFieldValue("sampleMediaUrl")}
                  />
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div style={{ display: "grid", gap: 14 }}>
                <div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 900,
                      color: T.text,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    3. Main message
                  </div>
                  <div style={{ fontSize: 13, color: T.textSub, marginTop: 4 }}>
                    Write the message. Click smart fields to insert order
                    details exactly where your cursor is.
                  </div>
                </div>

                <FormattedTextArea
                  textareaRef={bodyRef}
                  value={draft.bodyText || ""}
                  language={languageCode}
                  error={bodyErrors.length > 0}
                  onChange={(value) =>
                    setDraft((current) => ({ ...current, bodyText: value }))
                  }
                />
                <VariablePicker
                  supportedVariables={supportedVariables}
                  allVariables={variables}
                  title="Smart fields for main message"
                  onInsert={(token) =>
                    insertSmartField("bodyText", bodyRef, token)
                  }
                />
                <FieldErrors errors={bodyErrors} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 900,
                      color: T.text,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    4. Small note at bottom
                  </div>
                  <div style={{ fontSize: 13, color: T.textSub, marginTop: 4 }}>
                    Optional. Keep it static. No smart fields and no emojis
                    here.
                  </div>
                </div>

                <s-text-field
                  label="Footer note"
                  value={draft.footerText || ""}
                  maxLength={60}
                  details="Optional · max 60 characters · no smart fields · no emojis"
                  dir={textDirection}
                  lang={languageCode}
                  onChange={updateFieldValue("footerText")}
                  onInput={updateFieldValue("footerText")}
                />
                <FieldErrors errors={footerErrors} />
              </div>
            </CardBody>
          </Card>

          {editableButtons.length || isOrderConfirmationFlow ? (
            <Card>
              <CardBody>
                <div style={{ display: "grid", gap: 14 }}>
                  <div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 900,
                        color: T.text,
                        letterSpacing: "-0.02em",
                      }}
                    >
                      5. Buttons customers can tap
                    </div>
                    <div
                      style={{ fontSize: 13, color: T.textSub, marginTop: 4 }}
                    >
                      These actions are fixed so OrderX can route replies
                      correctly. Keep button text plain: no emojis and no smart
                      fields.
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    {editableButtons.map((button, index) => (
                      <div
                        key={`${button.action || button.index}-${index}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: isOrderConfirmationFlow
                            ? "minmax(120px, 160px) minmax(0, 1fr) auto"
                            : "160px 1fr",
                          gap: 12,
                          alignItems: "center",
                          padding: 12,
                          border: `1px solid ${T.border}`,
                          borderRadius: 12,
                          background: "#f8fafc",
                        }}
                      >
                        <label style={{ display: "grid", gap: 6 }}>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              color: T.textSub,
                            }}
                          >
                            Type
                          </span>
                          <select
                            value={button.type || "QUICK_REPLY"}
                            onChange={(event) =>
                              updateButton(index, { type: event.target.value })
                            }
                            style={{
                              width: "100%",
                              minHeight: 40,
                              border: `1px solid ${T.border}`,
                              borderRadius: 8,
                              background: T.surface,
                              color: T.text,
                              padding: "0 10px",
                              fontSize: 14,
                              fontWeight: 700,
                            }}
                          >
                            {toArray(
                              button.allowedTypes || ["QUICK_REPLY"],
                            ).map((type) => (
                              <option key={type} value={type}>
                                {String(type).replace(/_/g, " ")}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "grid", gap: 6, minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              color: T.textSub,
                            }}
                          >
                            Button text
                          </span>
                          <input
                            type="text"
                            maxLength={25}
                            value={button.text || ""}
                            onChange={(event) =>
                              updateButton(index, { text: event.target.value })
                            }
                            style={{
                              width: "100%",
                              minHeight: 40,
                              boxSizing: "border-box",
                              border: `1px solid ${containsEmoji(button.text) || String(button.text || "").includes("{{") || String(button.text || "").includes("}}") ? "#fca5a5" : T.border}`,
                              borderRadius: 8,
                              background: T.surface,
                              color: T.text,
                              padding: "0 12px",
                              fontSize: 14,
                              fontWeight: 700,
                            }}
                          />
                        </label>
                        {isOrderConfirmationFlow ? (
                          <button
                            type="button"
                            onClick={() => deleteButton(index)}
                            style={{
                              minHeight: 40,
                              borderRadius: 8,
                              border: `1px solid ${T.border}`,
                              background: T.surface,
                              color: T.danger,
                              padding: "0 14px",
                              cursor: "pointer",
                              fontSize: 14,
                              fontWeight: 800,
                            }}
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    ))}

                    {isOrderConfirmationFlow && !editableButtons.length ? (
                      <div
                        style={{
                          padding: "12px 14px",
                          border: `1px dashed ${T.border}`,
                          borderRadius: 10,
                          color: T.textSub,
                          fontSize: 13,
                        }}
                      >
                        This template will be submitted without quick-reply
                        buttons.
                      </div>
                    ) : null}

                    {addableButtons.length ? (
                      <div
                        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                      >
                        {addableButtons.map((button) => (
                          <button
                            key={button.action || button.index}
                            type="button"
                            onClick={() => addButton(button)}
                            style={{
                              borderRadius: T.radiusFull,
                              border: `1px solid ${T.accentBorder}`,
                              background: T.accentLight,
                              color: T.accent,
                              padding: "8px 12px",
                              cursor: "pointer",
                              fontSize: 13,
                              fontWeight: 800,
                            }}
                          >
                            Add {button.text}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div
          style={{
            borderLeft: `1px solid ${T.border}`,
            background: T.surface,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div
            style={{
              padding: "16px 20px",
              borderBottom: `1px solid ${T.border}`,
              fontSize: 13,
              fontWeight: 900,
              color: T.textSub,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              flexShrink: 0,
            }}
          >
            Preview & checks
          </div>
          <div
            style={{
              overflowY: "auto",
              padding: 18,
              display: "grid",
              gap: 14,
              alignContent: "start",
            }}
          >
            <TemplatePreview
              draft={{ ...draft, buttons: editableButtons }}
              variables={variables}
            />
            <ValidationChecklist checks={checks} errors={saveErrors} />

            {submitErrors.length ? (
              <div
                style={{
                  border: "1px solid #fed7aa",
                  background: "#fff7ed",
                  borderRadius: T.radiusLg,
                  padding: 14,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div
                  style={{ fontSize: 13, fontWeight: 900, color: "#9a3412" }}
                >
                  Before submitting to Meta
                </div>
                <FieldErrors errors={submitErrors} />
              </div>
            ) : (
              <div
                style={{
                  border: "1px solid #bbf7d0",
                  background: "#f0fdf4",
                  borderRadius: T.radiusLg,
                  padding: 14,
                  fontSize: 13,
                  color: "#166534",
                  lineHeight: 1.5,
                  fontWeight: 700,
                }}
              >
                This draft is safe to save. After saving, submit it to Meta from
                the template card.
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   TemplateCard (library row)
───────────────────────────────────────────────────────────────────────────── */

function TemplateCard({
  template,
  flowDefinition,
  isAssigned,
  testRecipientPhone,
  sender,
  submittingIntent,
  statusOverrides = {},
  onAssignFlow,
  onEdit,
  onSendTest,
  onSubmit,
  onDelete,
  variables,
}) {
  const status = getTemplateReviewStatus(template, statusOverrides);
  const canAssign = isTemplateApprovedForActivation(template, statusOverrides);
  const testPassed = isTemplateTestedForActivation(template);
  const canTest =
    canAssign &&
    !!String(testRecipientPhone || "").trim() &&
    !!sender?.phoneNumberId;
  const submitErrors = validateTemplateDraft(
    template,
    flowDefinition,
    variables,
    {
      mode: "submit",
    },
  );
  const canSubmit =
    ["draft", "rejected"].includes(status) && submitErrors.length === 0;

  const statusMap = {
    approved: {
      icon: "✅",
      tone: "success",
      title: "Approved by Meta",
      next: isAssigned
        ? "Active in an automation. You can send a test message anytime."
        : testPassed
          ? "Test send passed. Click “Use for flow”."
          : "Send a test message first, then you can use it for a flow.",
    },
    pending: {
      icon: "⏳",
      tone: "warning",
      title: "Waiting for Meta",
      next: "Meta is reviewing it. Refresh later to check approval.",
    },
    in_review: {
      icon: "👀",
      tone: "warning",
      title: "In review",
      next: "Meta is checking this template. You cannot activate it yet.",
    },
    rejected: {
      icon: "⚠️",
      tone: "critical",
      title: "Needs fixing",
      next: "Open it, fix the issue, then submit again.",
    },
    draft: {
      icon: "📝",
      tone: "subdued",
      title: "Draft",
      next: canSubmit
        ? "Ready to submit to Meta."
        : "Fix the checks before submitting to Meta.",
    },
  };
  const meta = statusMap[status] || statusMap.draft;

  return (
    <div
      style={{
        border: `1px solid ${isAssigned ? "#bbf7d0" : T.border}`,
        borderRadius: 20,
        background: isAssigned
          ? "linear-gradient(180deg, #ffffff 0%, #f0fdf4 100%)"
          : "#ffffff",
        boxShadow: "0 0 18px rgba(15, 23, 42, 0.07)",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "flex-start",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              minWidth: 0,
              flex: 1,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isAssigned ? "#dcfce7" : "#f8fafc",
                border: `1px solid ${isAssigned ? "#bbf7d0" : T.border}`,
                fontSize: 20,
                flexShrink: 0,
              }}
            >
              {meta.icon}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 950, color: T.text }}>
                  {template.displayName}
                </div>
                <Badge tone={meta.tone}>{meta.title}</Badge>
                {isAssigned ? <Badge tone="success">Active</Badge> : null}
                {template.headerType === "IMAGE" ? (
                  <Badge tone="info">Image header</Badge>
                ) : null}
                {status === "approved" ? (
                  <Badge tone={testPassed ? "success" : "warning"}>
                    {testPassed ? "Tested" : "Test required"}
                  </Badge>
                ) : null}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 13,
                  color: T.textSub,
                  lineHeight: 1.5,
                }}
              >
                {meta.next}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginTop: 8,
                }}
              >
                <Badge tone="subdued">{template.flowLabel}</Badge>
                <Badge tone="subdued">
                  {template.languageLabel || template.language}
                </Badge>
                <Badge
                  tone={
                    template.category === CATEGORY_MARKETING
                      ? "warning"
                      : "accent"
                  }
                >
                  {categoryLabel(template.category)}
                </Badge>
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            {canAssign && !isAssigned ? (
              <s-button
                onClick={onAssignFlow}
                loading={submittingIntent === "assign_flow"}
              >
                Use for flow
              </s-button>
            ) : null}
            {status === "approved" ? (
              <s-button
                variant="secondary"
                disabled={!canTest}
                onClick={onSendTest}
                loading={submittingIntent === "send_template_test"}
              >
                Send test
              </s-button>
            ) : null}
            <s-button variant="secondary" onClick={onEdit}>
              {status === "approved" ? "Create revision" : "Edit"}
            </s-button>
            {["draft", "rejected"].includes(status) ? (
              <s-button
                disabled={!canSubmit}
                onClick={onSubmit}
                loading={submittingIntent === "submit_template"}
              >
                Submit to Meta
              </s-button>
            ) : null}
            {["draft", "rejected"].includes(status) &&
            template.source !== "default_pack" ? (
              <s-button
                variant="secondary"
                onClick={onDelete}
                loading={submittingIntent === "delete_template"}
              >
                Delete
              </s-button>
            ) : null}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 360px)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 14,
                background: "#f8fafc",
                border: `1px solid ${T.border}`,
                fontSize: 12.5,
                color: T.textSub,
                lineHeight: 1.45,
              }}
            >
              <strong style={{ color: T.text }}>Meta name:</strong>{" "}
              <code
                style={{
                  background: "#eef2ff",
                  color: "#3730a3",
                  padding: "2px 6px",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                {template.metaTemplateName}
              </code>
            </div>

            {template.rejectionReason && template.rejectionReason !== "NONE" ? (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 14,
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                <strong>Meta rejection:</strong> {template.rejectionReason}
              </div>
            ) : null}

            {submitErrors.length && ["draft", "rejected"].includes(status) ? (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: 14,
                  background: "#fff7ed",
                  border: "1px solid #fed7aa",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 900,
                    color: "#9a3412",
                    marginBottom: 6,
                  }}
                >
                  Fix before Meta submission
                </div>
                <FieldErrors errors={submitErrors} />
              </div>
            ) : null}
          </div>
        </div>
        <TemplatePreview draft={template} variables={variables} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Loader / Action (unchanged)
───────────────────────────────────────────────────────────────────────────── */

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const response = toObject(
    await backendGet("/api/templates", shop).catch(() => ({
      templateSystem: {},
    })),
  );
  return { templateSystem: toObject(response.templateSystem) };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "").trim();

  try {
    if (intent === "refresh_templates") {
      await backendGet("/api/templates?refresh=1&force=1", shop);
      return {
        ok: true,
        intent,
        note: "Template statuses refreshed from Meta",
      };
    }
    if (intent === "add_english_pack") {
      const response = await backendPost(
        "/api/sender/byon/templates/provision",
        shop,
        {},
      );
      return {
        ok: true,
        intent,
        note: response?.note || "English template pack requested",
      };
    }
    if (intent === "save_template") {
      await backendPost("/api/templates/save", shop, {
        templateId: String(form.get("templateId") || "").trim() || null,
        flowKey: String(form.get("flowKey") || "").trim(),
        displayName: String(form.get("displayName") || "").trim(),
        headerType: String(form.get("headerType") || "TEXT").trim(),
        headerText: String(form.get("headerText") || "").trim(),
        sampleMediaUrl: String(form.get("sampleMediaUrl") || "").trim(),
        useProductImageHeader:
          String(form.get("useProductImageHeader") || "") === "true",
        bodyText: String(form.get("bodyText") || "").trim(),
        footerText: String(form.get("footerText") || "").trim(),
        buttons: String(form.get("buttons") || "[]"),
        category: String(form.get("category") || CATEGORY_UTILITY).trim(),
        language: String(form.get("language") || "en").trim(),
      });
      return { ok: true, intent, note: "Template draft saved" };
    }
    if (intent === "submit_template") {
      const templateId = String(form.get("templateId") || "").trim();
      await backendPost("/api/templates/submit", shop, { templateId });

      // After submit, Meta review status is usually PENDING/IN_REVIEW.
      // Force a fresh sync so stale local status cannot instantly show as approved.
      await backendGet("/api/templates?refresh=1&force=1", shop).catch(
        () => null,
      );

      return {
        ok: true,
        intent,
        templateId,
        forceTemplateStatus: "pending",
        note: "Template sent to Meta for review. It cannot be activated until Meta approves it.",
      };
    }
    if (intent === "send_template_test") {
      const templateId = String(form.get("templateId") || "").trim();
      const fresh = toObject(
        await backendGet("/api/templates?refresh=1&force=1", shop).catch(
          () => ({}),
        ),
      );
      const freshTemplate = findTemplateById(fresh.templateSystem, templateId);
      if (!isTemplateApprovedForActivation(freshTemplate)) {
        return {
          ok: false,
          intent,
          error:
            "This template is not approved by Meta yet. Refresh from Meta and wait until it shows Approved.",
        };
      }

      const response = await backendPost("/api/templates/send-test", shop, {
        templateId,
        to: String(form.get("toE164") || "").trim(),
      });
      const destination =
        String(response?.testSend?.to || form.get("toE164") || "").trim() ||
        "your test number";
      return {
        ok: true,
        intent,
        note: `Test sent to ${destination}`,
        testSend: response?.testSend || null,
      };
    }
    if (intent === "send_bare_template_test") {
      const templateId = String(form.get("templateId") || "").trim();
      const fresh = toObject(
        await backendGet("/api/templates?refresh=1&force=1", shop).catch(
          () => ({}),
        ),
      );
      const freshTemplate = findTemplateById(fresh.templateSystem, templateId);
      if (!isTemplateApprovedForActivation(freshTemplate)) {
        return {
          ok: false,
          intent,
          error:
            "This template is not approved by Meta yet. Refresh from Meta and wait until it shows Approved.",
        };
      }

      const response = await backendPost(
        "/api/templates/send-test-bare",
        shop,
        {
          templateId,
          to: String(form.get("toE164") || "").trim(),
        },
      );
      const destination =
        String(response?.testSend?.to || form.get("toE164") || "").trim() ||
        "your test number";
      return {
        ok: true,
        intent,
        note: `Bare template test sent to ${destination}`,
        testSend: response?.testSend || null,
      };
    }
    if (intent === "delete_template") {
      await backendPost("/api/templates/delete", shop, {
        templateId: String(form.get("templateId") || "").trim(),
      });
      return { ok: true, intent, note: "Draft deleted" };
    }
    if (intent === "assign_flow") {
      const flowKey = String(form.get("flowKey") || "").trim();
      const templateId = String(form.get("templateId") || "").trim();

      // Never trust local cached status before activation. Check Meta-synced status first.
      const fresh = toObject(
        await backendGet("/api/templates?refresh=1&force=1", shop).catch(
          () => ({}),
        ),
      );
      const freshTemplate = findTemplateById(fresh.templateSystem, templateId);
      if (!isTemplateApprovedForActivation(freshTemplate)) {
        const status = getTemplateReviewStatus(freshTemplate);
        return {
          ok: false,
          intent,
          templateId,
          forceTemplateStatus: status === "draft" ? "pending" : status,
          error: `This template is ${statusLabel(status)} in Meta, not Approved. You can activate it only after Meta approves it.`,
        };
      }
      if (!isTemplateTestedForActivation(freshTemplate)) {
        return {
          ok: false,
          intent,
          templateId,
          error: "Kindly test send the template first",
        };
      }

      await backendPost("/api/templates/assign-flow", shop, {
        flowKey,
        templateId,
      });
      return {
        ok: true,
        intent,
        note: "Approved template activated for this automation",
      };
    }
    if (intent === "update_flow") {
      const flowKey = String(form.get("flowKey") || "").trim();
      const enabled = String(form.get("enabled") || "") === "true";
      const configRaw = String(form.get("config") || "{}").trim() || "{}";

      if (enabled) {
        const fresh = toObject(
          await backendGet("/api/templates?refresh=1&force=1", shop).catch(
            () => ({}),
          ),
        );
        const freshFlow = toArray(toObject(fresh.templateSystem).flows).find(
          (flow) => String(flow?.flowKey || "").trim() === flowKey,
        );
        const assignedTemplate = toObject(freshFlow?.assignedTemplate);
        if (!isTemplateApprovedForActivation(assignedTemplate)) {
          const status = getTemplateReviewStatus(assignedTemplate);
          return {
            ok: false,
            intent,
            forceTemplateStatus: status === "draft" ? "pending" : status,
            error: `This automation cannot be turned on because its selected template is ${statusLabel(status)}, not Approved.`,
          };
        }
        if (!isTemplateTestedForActivation(assignedTemplate)) {
          return {
            ok: false,
            intent,
            error: "Kindly test send the template first",
          };
        }
      }

      await backendPost("/api/templates/update-flow", shop, {
        flowKey,
        enabled,
        config: JSON.parse(configRaw),
      });
      return { ok: true, intent, note: "Automation flow saved" };
    }
    return { ok: false, intent, error: "Unknown action" };
  } catch (error) {
    return {
      ok: false,
      intent,
      error: error?.message || "Action failed",
      errorData: error?.data || null,
    };
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   Page
───────────────────────────────────────────────────────────────────────────── */

export default function TemplatesPage() {
  const shopify = useAppBridge();
  const { templateSystem: initialTemplateSystem } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const location = useLocation();
  const submit = useSubmit();
  const templateStatusFetcher = useFetcher();
  const templateStatusRequested = useRef(false);
  const [autoRefreshedTemplateSystem, setAutoRefreshedTemplateSystem] =
    useState(null);
  const appHref = (href) => withShopParams(href, location.search);

  useEffect(() => {
    if (templateStatusRequested.current) return;
    templateStatusRequested.current = true;
    templateStatusFetcher.load(
      withShopParams("/app/templates-status", location.search),
    );
  }, [location.search, templateStatusFetcher]);

  useEffect(() => {
    const refreshed = toObject(templateStatusFetcher.data?.templateSystem);
    if (Object.keys(refreshed).length) {
      setAutoRefreshedTemplateSystem(refreshed);
    }
  }, [templateStatusFetcher.data]);

  useEffect(() => {
    setAutoRefreshedTemplateSystem(null);
  }, [initialTemplateSystem]);

  const templateSystem =
    autoRefreshedTemplateSystem || initialTemplateSystem;

  const [templateStatusOverrides, setTemplateStatusOverrides] = useState({});
  const safeTemplateSystem = useMemo(
    () =>
      applyTemplateStatusOverridesToSystem(
        templateSystem,
        templateStatusOverrides,
      ),
    [templateSystem, templateStatusOverrides],
  );

  const sender = toObject(safeTemplateSystem?.sender);
  const templateManagementAllowed =
    safeTemplateSystem?.templateManagementAllowed === true;
  const billingSenderMode = String(
    safeTemplateSystem?.billingSenderMode || "orderx_number",
  ).trim();
  const flows = toArray(safeTemplateSystem?.flows);
  const templates = toArray(safeTemplateSystem?.templates);
  const variables = toArray(safeTemplateSystem?.variables);
  const flowDefinitions = toArray(safeTemplateSystem?.flowDefinitions);
  const languageOptions = toArray(safeTemplateSystem?.languageOptions).length
    ? toArray(safeTemplateSystem.languageOptions)
    : [{ code: "en", label: "English" }];

  const [draft, setDraft] = useState(null);
  const [activeFlowKey, setActiveFlowKey] = useState("");
  const [newTemplateFlowKey, setNewTemplateFlowKey] = useState("");
  const [testRecipientPhone, setTestRecipientPhone] = useState(
    String(sender?.testMessageTargetPhoneE164 || ""),
  );

  const submittingIntent =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("intent") || "")
      : "";

  useEffect(() => {
    if (!actionData?.intent) return;

    if (actionData.intent === "refresh_templates" && actionData.ok) {
      setTemplateStatusOverrides({});
    }

    if (actionData.forceTemplateStatus && actionData.templateId) {
      const templateId = String(actionData.templateId || "").trim();
      const forcedStatus = normalizeTemplateReviewStatus(
        actionData.forceTemplateStatus,
      );
      if (templateId) {
        setTemplateStatusOverrides((current) => ({
          ...current,
          [templateId]: forcedStatus,
        }));
      }
    }

    if (actionData.ok) {
      shopify.toast.show(actionData.note || "Saved");
      if (["save_template", "submit_template"].includes(actionData.intent)) {
        setDraft(null);
        setActiveFlowKey("");
      }
      return;
    }
    if (actionData.error) shopify.toast.show(actionData.error);
  }, [actionData, shopify]);

  const flowDefinitionMap = useMemo(
    () => new Map(flowDefinitions.map((row) => [row.key, row])),
    [flowDefinitions],
  );
  const visibleFlowDefinitions = useMemo(
    () =>
      templateManagementAllowed
        ? flowDefinitions
        : flowDefinitions.filter((row) => row.availableForCurrentPlan),
    [flowDefinitions, templateManagementAllowed],
  );
  const visibleFlows = useMemo(
    () =>
      templateManagementAllowed
        ? flows
        : flows.filter((row) => row.availableForCurrentPlan),
    [flows, templateManagementAllowed],
  );
  const visibleTemplates = useMemo(
    () =>
      templateManagementAllowed
        ? templates
        : templates.filter((row) => row.availableForCurrentPlan),
    [templates, templateManagementAllowed],
  );
  const templateFlowOptions = useMemo(
    () => visibleFlowDefinitions.filter((row) => row.supportsTemplates),
    [visibleFlowDefinitions],
  );
  const activeAssignments = useMemo(() => {
    const map = new Map();
    visibleFlows.forEach((flow) => {
      if (flow?.assignedTemplate?.id) {
        map.set(String(flow.assignedTemplate.id), true);
      }
    });
    return map;
  }, [visibleFlows]);

  useEffect(() => {
    if (!newTemplateFlowKey && templateFlowOptions.length) {
      setNewTemplateFlowKey(templateFlowOptions[0].key);
    }
  }, [newTemplateFlowKey, templateFlowOptions]);

  useEffect(() => {
    const next = String(sender?.testMessageTargetPhoneE164 || "").trim();
    if (!next || String(testRecipientPhone || "").trim()) return;
    setTestRecipientPhone(next);
  }, [sender?.testMessageTargetPhoneE164, testRecipientPhone]);

  const startDraftForFlow = (flowKey) => {
    const definition = toObject(flowDefinitionMap.get(flowKey));
    const defaultTemplate = toObject(definition.defaultTemplate);
    const fixedButtons = toArray(definition.fixedButtons).map(
      (button, index) => ({
        type: button.type || "QUICK_REPLY",
        text: button.text || "",
        index,
        action: button.action || null,
        allowedTypes: toArray(button.allowedTypes).length
          ? button.allowedTypes
          : ["QUICK_REPLY"],
      }),
    );
    setActiveFlowKey(flowKey);
    setDraft({
      templateId: "",
      flowKey,
      category: normalizeTemplateCategory(definition.templateCategory),
      displayName:
        defaultTemplate.displayName || definition.label || "Template",
      language: "en",
      headerType: defaultTemplate.headerType || "TEXT",
      headerText: String(defaultTemplate.headerText || ""),
      sampleMediaUrl: "",
      useProductImageHeader: !!definition.supportsImageHeader,
      bodyText: String(defaultTemplate.bodyText || ""),
      footerText: String(defaultTemplate.footerText || ""),
      buttons: fixedButtons,
      status: "draft",
    });
  };

  const startEditTemplate = (template) => {
    const definition = toObject(flowDefinitionMap.get(template.flowKey));
    setActiveFlowKey(template.flowKey);
    setDraft({
      templateId: template.id,
      flowKey: template.flowKey,
      category: normalizeTemplateCategory(
        definition.templateCategory || template.category,
      ),
      displayName: template.displayName,
      language: template.language || "en",
      headerType: template.headerType || "TEXT",
      headerText: template.headerText || "",
      sampleMediaUrl: template.sampleMediaUrl || "",
      useProductImageHeader: template.useProductImageHeader !== false,
      bodyText: template.bodyText || "",
      footerText: template.footerText || "",
      buttons: toArray(template.buttons),
      status: template.status || "draft",
    });
  };

  const saveDraft = (nextDraft = draft) => {
    const payload = nextDraft || draft;
    if (!payload?.flowKey) return;
    const fd = new FormData();
    fd.set("intent", "save_template");
    fd.set("templateId", String(payload.templateId || ""));
    fd.set("flowKey", String(payload.flowKey || ""));
    fd.set(
      "category",
      String(payload.category || CATEGORY_UTILITY)
        .trim()
        .toUpperCase(),
    );
    fd.set("displayName", String(payload.displayName || ""));
    fd.set("language", String(payload.language || "en"));
    fd.set("headerType", String(payload.headerType || "TEXT"));
    fd.set("headerText", String(payload.headerText || ""));
    fd.set("sampleMediaUrl", String(payload.sampleMediaUrl || ""));
    fd.set(
      "useProductImageHeader",
      payload.useProductImageHeader === false ? "false" : "true",
    );
    fd.set("bodyText", String(payload.bodyText || ""));
    fd.set("footerText", String(payload.footerText || ""));
    fd.set("buttons", JSON.stringify(toArray(payload.buttons)));
    submit(fd, { method: "POST" });
  };

  const postSimpleAction = (intent, values = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    Object.entries(values).forEach(([key, value]) => {
      fd.set(key, typeof value === "string" ? value : JSON.stringify(value));
    });
    submit(fd, { method: "POST" });
  };

  const approvedTemplates = visibleTemplates.filter((template) =>
    isTemplateApprovedForActivation(template, templateStatusOverrides),
  );
  const waitingTemplates = visibleTemplates.filter((template) =>
    ["pending", "in_review"].includes(
      getTemplateReviewStatus(template, templateStatusOverrides),
    ),
  );
  const actionTemplates = visibleTemplates.filter((template) =>
    ["draft", "rejected"].includes(
      getTemplateReviewStatus(template, templateStatusOverrides),
    ),
  );
  const activeFlowCount = visibleFlows.filter((flow) => {
    const assignedApproved = isTemplateApprovedForActivation(
      flow?.assignedTemplate,
      templateStatusOverrides,
    );
    return Boolean(flow.ready && assignedApproved);
  }).length;
  const selectedFlowKey =
    newTemplateFlowKey || templateFlowOptions[0]?.key || "";
  const selectedFlow = toObject(flowDefinitionMap.get(selectedFlowKey));
  const connected = !!sender?.wabaId;

  const createButton = (
    <s-button
      onClick={() => selectedFlowKey && startDraftForFlow(selectedFlowKey)}
      disabled={!selectedFlowKey || !templateManagementAllowed}
    >
      Create safe template
    </s-button>
  );

  return (
    <>
      {draft ? (
        <TemplateEditorModal
          draft={draft}
          setDraft={setDraft}
          flowDefinition={toObject(flowDefinitionMap.get(activeFlowKey))}
          variables={variables}
          languageOptions={languageOptions}
          onSave={saveDraft}
          onClose={() => {
            setDraft(null);
            setActiveFlowKey("");
          }}
          saving={submittingIntent === "save_template"}
        />
      ) : null}

      <s-page suppressHydrationWarning>
        <s-box style={surface.shell}>
          <div style={{ display: "grid", gap: 22 }}>
            {/* <div
              style={{
                borderRadius: 28,
                padding: "28px 30px",
                background:
                  "linear-gradient(135deg, #18392b 0%, #24513d 48%, #0f241b 100%)",
                color: "#ffffff",
                boxShadow: "0 0 34px rgba(24, 57, 43, 0.22)",
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  right: -80,
                  top: -80,
                  width: 220,
                  height: 220,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.08)",
                }}
              />
              <div style={{ position: "relative", display: "grid", gap: 18 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 18,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ maxWidth: 720 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 900,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        opacity: 0.82,
                      }}
                    >
                      WhatsApp templates
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 34,
                        lineHeight: 1.08,
                        fontWeight: 950,
                        letterSpacing: "-0.05em",
                      }}
                    >
                      Build Meta-safe messages without breaking parameters.
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 15,
                        lineHeight: 1.6,
                        opacity: 0.86,
                      }}
                    >
                      Pick an automation, write the message, add only OrderX
                      smart fields, submit to Meta, then activate after
                      approval.
                    </div>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gap: 8,
                      alignContent: "start",
                      minWidth: 230,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        selectedFlowKey && startDraftForFlow(selectedFlowKey)
                      }
                      disabled={!templateManagementAllowed || !selectedFlowKey}
                      style={{
                        border: "1px solid rgba(255,255,255,0.25)",
                        background: "#ffffff",
                        color: "#18392b",
                        minHeight: 46,
                        borderRadius: 14,
                        padding: "0 18px",
                        fontSize: 14,
                        fontWeight: 950,
                        cursor:
                          templateManagementAllowed && selectedFlowKey
                            ? "pointer"
                            : "not-allowed",
                        boxShadow: "0 0 24px rgba(255,255,255,0.22)",
                      }}
                    >
                      + Create template
                    </button>
                    <button
                      type="button"
                      onClick={() => postSimpleAction("refresh_templates")}
                      disabled={!templateManagementAllowed}
                      style={{
                        border: "1px solid rgba(255,255,255,0.24)",
                        background: "rgba(255,255,255,0.10)",
                        color: "#ffffff",
                        minHeight: 42,
                        borderRadius: 14,
                        padding: "0 16px",
                        fontSize: 13,
                        fontWeight: 850,
                        cursor: templateManagementAllowed
                          ? "pointer"
                          : "not-allowed",
                      }}
                    >
                      Refresh from Meta
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                    gap: 10,
                  }}
                >
                  {[
                    "1. Choose automation",
                    "2. Add safe smart fields",
                    "3. Submit to Meta",
                    "4. Activate approved template",
                  ].map((label) => (
                    <div
                      key={label}
                      style={{
                        background: "rgba(255,255,255,0.10)",
                        border: "1px solid rgba(255,255,255,0.14)",
                        borderRadius: 14,
                        padding: "10px 12px",
                        fontSize: 13,
                        fontWeight: 850,
                      }}
                    >
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            </div> */}

            {!connected ? (
              <s-banner tone="warning">
                Connect Your Own Number from{" "}
                <a href={appHref("/app/settings")}>Settings</a> before
                submitting custom templates to Meta.
              </s-banner>
            ) : null}

            {!templateManagementAllowed ? (
              <s-banner tone="info">
                Custom template creation and Meta submission are available only
                on <strong>Your Own Number</strong> plans. Current mode:{" "}
                <strong>
                  {billingSenderMode === "own_number"
                    ? "Your Own Number"
                    : "OrderX Number"}
                </strong>
                .
              </s-banner>
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                gap: 14,
              }}
            >
              <FriendlyStatCard
                icon={connected ? "✅" : "⚠️"}
                label="Connected number"
                value={connected ? "Ready" : "Missing"}
                help={
                  connected
                    ? "Your Meta number is connected."
                    : "Connect before submitting templates."
                }
                tone={connected ? "success" : "warning"}
              />
              <FriendlyStatCard
                icon="✅"
                label="Approved templates"
                value={approvedTemplates.length}
                help="Can be activated and tested."
                tone="success"
              />
              <FriendlyStatCard
                icon="⏳"
                label="Waiting on Meta"
                value={waitingTemplates.length}
                help="Pending or in review."
                tone={waitingTemplates.length ? "warning" : "default"}
              />
              <FriendlyStatCard
                icon="⚡"
                label="Live automations"
                value={`${activeFlowCount}/${visibleFlows.length || 0}`}
                help="Flows that are ready to send."
                tone={activeFlowCount ? "info" : "default"}
              />
            </div>
            {templateManagementAllowed ? (
              <Card style={{ borderRadius: 24 }}>
                <CardBody style={{ padding: 20 }}>
                  <div style={{ display: "grid", gap: 14 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                        flexWrap: "wrap",
                        alignItems: "flex-end",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: 19,
                            fontWeight: 950,
                            color: T.text,
                            letterSpacing: "-0.03em",
                          }}
                        >
                          Test number & Meta sync
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 13,
                            color: T.textSub,
                            lineHeight: 1.5,
                          }}
                        >
                          Save a WhatsApp number here, then click “Send test” on
                          any approved template.
                        </div>
                      </div>
                      <div
                        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                      >
                        <s-button
                          variant="secondary"
                          onClick={() => postSimpleAction("refresh_templates")}
                          loading={submittingIntent === "refresh_templates"}
                        >
                          Refresh from Meta
                        </s-button>
                        <s-button
                          onClick={() => postSimpleAction("add_english_pack")}
                          loading={submittingIntent === "add_english_pack"}
                        >
                          Add English pack
                        </s-button>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "minmax(240px, 360px) minmax(0, 1fr)",
                        gap: 14,
                        alignItems: "end",
                      }}
                    >
                      <s-text-field
                        label="Test recipient WhatsApp number"
                        value={testRecipientPhone}
                        placeholder="+923001234567"
                        details="Use full international format with country code."
                        onChange={(event) =>
                          setTestRecipientPhone(event.target.value)
                        }
                        onInput={(event) =>
                          setTestRecipientPhone(event.target.value)
                        }
                      />
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          paddingBottom: 2,
                        }}
                      >
                        <Badge
                          tone={
                            sender?.templatePackProvisioned
                              ? "success"
                              : "subdued"
                          }
                        >
                          {sender?.templatePackProvisioned
                            ? "Pack provisioned"
                            : "Pack not provisioned"}
                        </Badge>
                        <Badge
                          tone={
                            sender?.templatesApproved ? "success" : "warning"
                          }
                        >
                          {sender?.templatesApproved
                            ? "Core pack approved"
                            : "Waiting on approvals"}
                        </Badge>
                        <Badge tone="subdued">
                          Last sync:{" "}
                          {sender?.templatesLastSyncedAt
                            ? formatDateTime(sender.templatesLastSyncedAt)
                            : "Never"}
                        </Badge>
                      </div>
                    </div>

                    <div
                      style={{
                        border: "1px solid #fed7aa",
                        background: "#fff7ed",
                        borderRadius: 16,
                        padding: 14,
                        fontSize: 13,
                        color: "#9a3412",
                        lineHeight: 1.55,
                      }}
                    >
                      <strong>Image header rule:</strong> if you choose an image
                      title, use a public HTTPS JPG/PNG image URL. Accepted:
                      links ending in <strong>.jpg</strong>,{" "}
                      <strong>.jpeg</strong>, <strong>.png</strong>, or CDN
                      links like Unsplash with <strong>?fm=jpg</strong> /{" "}
                      <strong>?format=png</strong>. Do not use WebP, GIF, SVG,
                      Google Drive preview links, or normal webpage links.
                    </div>
                  </div>
                </CardBody>
              </Card>
            ) : null}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.1fr) minmax(320px, 0.9fr)",
                gap: 18,
                alignItems: "stretch",
              }}
            >
              <Card
                style={{
                  borderRadius: 24,
                  boxShadow: "0 0 22px rgba(15, 23, 42, 0.08)",
                }}
              >
                <CardBody style={{ padding: 22 }}>
                  <div style={{ display: "grid", gap: 16 }}>
                    <div>
                      <div
                        style={{
                          fontSize: 22,
                          fontWeight: 950,
                          color: T.text,
                          letterSpacing: "-0.04em",
                        }}
                      >
                        Start here: create one safe template
                      </div>
                      <div
                        style={{
                          marginTop: 5,
                          fontSize: 14,
                          color: T.textSub,
                          lineHeight: 1.55,
                        }}
                      >
                        Choose what OrderX should automate. The editor will
                        show only the smart fields allowed for that automation.
                      </div>
                    </div>

                    {templateManagementAllowed ? (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(220px, 1fr) auto",
                          gap: 12,
                          alignItems: "end",
                        }}
                      >
                        <s-select
                          label="What message do you want to create?"
                          value={selectedFlowKey}
                          onChange={(event) =>
                            setNewTemplateFlowKey(event.target.value)
                          }
                        >
                          {templateFlowOptions.map((flow) => (
                            <s-option key={flow.key} value={flow.key}>
                              {flow.label}
                            </s-option>
                          ))}
                        </s-select>
                        {createButton}
                      </div>
                    ) : (
                      <EmptyFriendlyState
                        icon="🔒"
                        title="Custom templates are locked on this plan"
                        text="Switch to Your Own Number to create merchant-owned Meta templates and submit them for approval."
                      />
                    )}

                    {selectedFlow?.description ? (
                      <div
                        style={{
                          border: "1px solid #bfdbfe",
                          background: "#eff6ff",
                          color: "#1e3a8a",
                          borderRadius: 16,
                          padding: 14,
                          fontSize: 13,
                          lineHeight: 1.55,
                        }}
                      >
                        <strong>{selectedFlow.label}:</strong>{" "}
                        {selectedFlow.description}
                      </div>
                    ) : null}
                  </div>
                </CardBody>
              </Card>

              <Card
                style={{
                  borderRadius: 24,
                  boxShadow: "0 0 22px rgba(15, 23, 42, 0.08)",
                }}
              >
                <CardBody style={{ padding: 18 }}>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div
                      style={{ fontSize: 16, fontWeight: 950, color: T.text }}
                    >
                      Easy steps
                    </div>
                    <HowItWorksStep
                      number="1"
                      title="Create"
                      text="Write the message. Use smart-field buttons only; do not type {{ }} manually."
                    />
                    <HowItWorksStep
                      number="2"
                      title="Submit"
                      text="OrderX checks the message before it goes to Meta, including JPG/PNG image rules."
                    />
                    <HowItWorksStep
                      number="3"
                      title="Activate"
                      text="After Meta approves it, choose it for an automation and turn that flow on."
                    />
                  </div>
                </CardBody>
              </Card>
            </div>

            {templateManagementAllowed ? (
              <div style={{ display: "grid", gap: 18 }}>
                {/* <div>
                  <SectionHeader
                    title="Your automations"
                    description="Each automation needs one approved template before it can be turned on."
                  />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(320px, 1fr))",
                      gap: 14,
                    }}
                  >
                    {visibleFlows.map((flow) => (
                      <FlowCard
                        key={flow.flowKey}
                        flow={flow}
                        statusOverrides={templateStatusOverrides}
                        onToggle={(flowKey, enabled, config) =>
                          postSimpleAction("update_flow", {
                            flowKey,
                            enabled: String(enabled),
                            config,
                          })
                        }
                        onAssign={(flowKey, templateId) => {
                          if (!templateId) return;
                          postSimpleAction("assign_flow", {
                            flowKey,
                            templateId,
                          });
                        }}
                        onCreate={startDraftForFlow}
                        onEdit={startEditTemplate}
                        settingsHref={appHref("/app/settings")}
                      />
                    ))}
                  </div>
                </div> */}

                <div>
                  <SectionHeader
                    title="Templates that need action"
                    description="Drafts and rejected templates show exactly what must be fixed before Meta submission."
                  />
                  {actionTemplates.length ? (
                    <div style={{ display: "grid", gap: 14 }}>
                      {actionTemplates.map((template) => (
                        <TemplateCard
                          key={template.id}
                          template={template}
                          flowDefinition={toObject(
                            flowDefinitionMap.get(template.flowKey),
                          )}
                          isAssigned={activeAssignments.has(
                            String(template.id),
                          )}
                          testRecipientPhone={testRecipientPhone}
                          sender={sender}
                          submittingIntent={submittingIntent}
                          statusOverrides={templateStatusOverrides}
                          variables={variables}
                          onAssignFlow={() =>
                            postSimpleAction("assign_flow", {
                              flowKey: template.flowKey,
                              templateId: template.id,
                            })
                          }
                          onEdit={() => startEditTemplate(template)}
                          onSendTest={() =>
                            postSimpleAction("send_template_test", {
                              templateId: template.id,
                              toE164: String(testRecipientPhone || "").trim(),
                            })
                          }
                          onSubmit={() =>
                            postSimpleAction("submit_template", {
                              templateId: template.id,
                            })
                          }
                          onDelete={() =>
                            postSimpleAction("delete_template", {
                              templateId: template.id,
                            })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyFriendlyState
                      icon="🎉"
                      title="No broken drafts"
                      text="You do not have rejected or unfinished templates right now."
                    />
                  )}
                </div>

                <div>
                  <SectionHeader
                    title="Approved templates"
                    description="These passed Meta review. Activate them for automations or send a test."
                  />
                  {approvedTemplates.length ? (
                    <div style={{ display: "grid", gap: 14 }}>
                      {approvedTemplates.map((template) => (
                        <TemplateCard
                          key={template.id}
                          template={template}
                          flowDefinition={toObject(
                            flowDefinitionMap.get(template.flowKey),
                          )}
                          isAssigned={activeAssignments.has(
                            String(template.id),
                          )}
                          testRecipientPhone={testRecipientPhone}
                          sender={sender}
                          submittingIntent={submittingIntent}
                          statusOverrides={templateStatusOverrides}
                          variables={variables}
                          onAssignFlow={() =>
                            postSimpleAction("assign_flow", {
                              flowKey: template.flowKey,
                              templateId: template.id,
                            })
                          }
                          onEdit={() => startEditTemplate(template)}
                          onSendTest={() =>
                            postSimpleAction("send_template_test", {
                              templateId: template.id,
                              toE164: String(testRecipientPhone || "").trim(),
                            })
                          }
                          onSubmit={() =>
                            postSimpleAction("submit_template", {
                              templateId: template.id,
                            })
                          }
                          onDelete={() =>
                            postSimpleAction("delete_template", {
                              templateId: template.id,
                            })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyFriendlyState
                      icon="✅"
                      title="No approved templates yet"
                      text="Create a template, submit it to Meta, then approved templates will appear here."
                      action={createButton}
                    />
                  )}
                </div>

                <div>
                  <SectionHeader
                    title="Waiting on Meta"
                    description="These are already submitted. Refresh from Meta to update their status."
                  />
                  {waitingTemplates.length ? (
                    <div style={{ display: "grid", gap: 14 }}>
                      {waitingTemplates.map((template) => (
                        <TemplateCard
                          key={template.id}
                          template={template}
                          flowDefinition={toObject(
                            flowDefinitionMap.get(template.flowKey),
                          )}
                          isAssigned={activeAssignments.has(
                            String(template.id),
                          )}
                          testRecipientPhone={testRecipientPhone}
                          sender={sender}
                          submittingIntent={submittingIntent}
                          statusOverrides={templateStatusOverrides}
                          variables={variables}
                          onAssignFlow={() =>
                            postSimpleAction("assign_flow", {
                              flowKey: template.flowKey,
                              templateId: template.id,
                            })
                          }
                          onEdit={() => startEditTemplate(template)}
                          onSendTest={() =>
                            postSimpleAction("send_template_test", {
                              templateId: template.id,
                              toE164: String(testRecipientPhone || "").trim(),
                            })
                          }
                          onSubmit={() =>
                            postSimpleAction("submit_template", {
                              templateId: template.id,
                            })
                          }
                          onDelete={() =>
                            postSimpleAction("delete_template", {
                              templateId: template.id,
                            })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyFriendlyState
                      icon="⏳"
                      title="Nothing waiting"
                      text="When you submit a template to Meta, it will appear here until approved or rejected."
                    />
                  )}
                </div>
              </div>
            ) : (
              <EmptyFriendlyState
                icon="🔒"
                title="Template builder is locked"
                text="OrderX Number plans use OrderX managed templates. Switch to Your Own Number to create, submit, and activate your own Meta templates."
              />
            )}
          </div>
        </s-box>
      </s-page>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
