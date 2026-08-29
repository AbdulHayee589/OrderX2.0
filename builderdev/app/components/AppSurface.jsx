import { useMemo } from "react";

// ── Design tokens ──────────────────────────────────────────────────────────
export const tokens = {
  radius: { sm: 8, md: 10, lg: 14, xl: 18, xxl: 22, pill: 999 },
  shadow: {
    xs: "0 1px 3px rgba(15,23,42,0.06)",
    sm: "0 2px 8px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.04)",
    md: "0 4px 16px rgba(15,23,42,0.08), 0 2px 6px rgba(15,23,42,0.04)",
    lg: "0 12px 32px rgba(15,23,42,0.10), 0 4px 12px rgba(15,23,42,0.05)",
    xl: "0 24px 56px rgba(15,23,42,0.13), 0 8px 20px rgba(15,23,42,0.06)",
  },
  color: {
    bg: "#ffffff",
    bgSoft: "#f8fafc",
    bgSubtle: "#f1f5f9",
    border: "rgba(15,23,42,0.08)",
    borderStrong: "rgba(15,23,42,0.14)",
    text: "#0f172a",
    textSub: "#475569",
    textMuted: "#94a3b8",
    success: "#059669",
    successBg: "#ecfdf5",
    warning: "#d97706",
    warningBg: "#fffbeb",
    critical: "#dc2626",
    criticalBg: "#fef2f2",
    info: "#0284c7",
    infoBg: "#f0f9ff",
    wa: "#25d366",
    waDark: "#128c7e",
    accent: "#6366f1",
    accentBg: "#eef2ff",
  },
};

// ── Surface style objects ──────────────────────────────────────────────────
export const surface = {
  shell: { display: "grid", gap: 24 },

  hero: {
    borderRadius: tokens.radius.xxl,
    border: `1px solid ${tokens.color.borderStrong}`,
    background: "linear-gradient(180deg, #ffffff 0%, #f6f6f7 100%)",
    boxShadow: tokens.shadow.sm,
    color: tokens.color.text,
    overflow: "hidden",
  },

  heroContent: { padding: "28px 0px", display: "grid", gap: 14 },

  heroTitle: {
    margin: 0,
    fontSize: 26,
    lineHeight: 1.2,
    fontWeight: 800,
    letterSpacing: "-0.025em",
    color: tokens.color.text,
  },

  heroSubtitle: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.65,
    color: tokens.color.textSub,
    maxWidth: 720,
  },

  heroChips: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 },

  heroChip: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: tokens.radius.pill,
    border: `1px solid ${tokens.color.border}`,
    padding: "5px 12px",
    background: tokens.color.bg,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.01em",
    color: tokens.color.textSub,
  },

  card: {
    borderRadius: tokens.radius.lg,
    border: `1px solid ${tokens.color.border}`,
    background: tokens.color.bg,
    boxShadow: tokens.shadow.sm,
  },

  softCard: {
    borderRadius: tokens.radius.lg,
    border: `1px solid ${tokens.color.border}`,
    background: `linear-gradient(180deg, ${tokens.color.bg} 0%, ${tokens.color.bgSoft} 100%)`,
    boxShadow: tokens.shadow.sm,
  },

  tileValue: {
    margin: "8px 0 0 0",
    fontSize: 30,
    fontWeight: 800,
    lineHeight: 1.1,
    letterSpacing: "-0.03em",
    color: tokens.color.text,
  },

  tileLabel: {
    margin: 0,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: tokens.color.textSub,
    fontWeight: 700,
  },

  rowLabel: {
    margin: 0,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: tokens.color.textMuted,
    fontWeight: 700,
  },

  rowValue: {
    margin: "6px 0 0 0",
    color: tokens.color.text,
    fontWeight: 600,
  },

  tileHint: {
    margin: "8px 0 0 0",
    color: tokens.color.textSub,
    fontSize: 12,
    lineHeight: 1.45,
  },
};

// ── Components ─────────────────────────────────────────────────────────────

export function HeroBanner({ title, subtitle, chips = [] }) {
  return (
    <s-box padding="none" style={surface.hero}>
      <div style={surface.heroContent}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background:
                "linear-gradient(135deg, rgba(0,128,96,0.14) 0%, rgba(45,55,72,0.08) 100%)",
              border: `1px solid ${tokens.color.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              boxShadow: tokens.shadow.xs,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 16.25V7.75a.75.75 0 01.75-.75h10.5a.75.75 0 01.75.75v8.5a.75.75 0 01-.75.75H6.75A.75.75 0 016 16.25z"
                stroke={tokens.color.text}
                strokeWidth="1.5"
              />
              <path
                d="M9 12h6M9 9.5h3.5M9 14.5h4.5"
                stroke={tokens.color.textSub}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div> */}
          <h2 style={surface.heroTitle}>{title}</h2>
        </div>
        {subtitle ? <p style={surface.heroSubtitle}>{subtitle}</p> : null}
        {chips?.length ? (
          <div style={surface.heroChips}>
            {chips.map((chip) => (
              <span key={chip} style={surface.heroChip}>
                {chip}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </s-box>
  );
}

export function SurfaceCard({
  children,
  padding = "base",
  soft = false,
  style = null,
}) {
  const merged = useMemo(
    () => ({ ...(soft ? surface.softCard : surface.card), ...(style || {}) }),
    [soft, style],
  );
  return (
    <s-box
      padding={padding}
      borderWidth="none"
      borderRadius="none"
      style={merged}
    >
      {children}
    </s-box>
  );
}

export function MetricTile({
  label,
  value,
  soft = false,
  hint = "",
  compact = false,
  style = null,
  labelStyle = null,
  valueStyle = null,
  hintStyle = null,
  accent = null,
}) {
  const tileStyle = compact
    ? { minWidth: 120, flex: "1 1 132px", padding: "12px 14px" }
    : { minWidth: 180, flex: "1 1 180px", padding: "18px 20px" };

  const compactLabelStyle = compact
    ? { ...surface.tileLabel, fontSize: 10, letterSpacing: "0.08em" }
    : surface.tileLabel;

  const compactValueStyle = compact
    ? {
        ...surface.tileValue,
        marginTop: 6,
        fontSize: "clamp(18px, 1.8vw, 22px)",
        lineHeight: 1.2,
        letterSpacing: "-0.02em",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }
    : {
        ...surface.tileValue,
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      };

  const compactHintStyle = compact
    ? { ...surface.tileHint, marginTop: 6, fontSize: 11, lineHeight: 1.3 }
    : surface.tileHint;

  const accentStyle = accent
    ? { borderLeft: `3px solid ${accent}`, paddingLeft: compact ? 11 : 17 }
    : {};

  return (
    <SurfaceCard
      soft={soft}
      style={{ ...tileStyle, ...accentStyle, ...(style || {}) }}
    >
      <p style={{ ...compactLabelStyle, ...(labelStyle || {}) }}>{label}</p>
      <p style={{ ...compactValueStyle, ...(valueStyle || {}) }}>{value}</p>
      {hint ? (
        <p style={{ ...compactHintStyle, ...(hintStyle || {}) }}>{hint}</p>
      ) : null}
    </SurfaceCard>
  );
}

// ── PageTitle — replaces raw <h2> page headings ────────────────────────────
export function PageTitle({ title, subtitle, right = null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        paddingBottom: 4,
      }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: tokens.color.text,
            lineHeight: 1.2,
          }}
        >
          {title}
        </h2>
        {subtitle ? (
          <p
            style={{
              margin: "6px 0 0 0",
              fontSize: 14,
              color: tokens.color.textSub,
              lineHeight: 1.55,
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {right ? <div style={{ flexShrink: 0 }}>{right}</div> : null}
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────
export function EmptyState({ title, message, action = null, icon = null }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        gap: 12,
        textAlign: "center",
      }}
    >
      {icon || (
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: `linear-gradient(135deg, ${tokens.color.bgSubtle} 0%, ${tokens.color.bgSoft} 100%)`,
            border: `1px solid ${tokens.color.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 4,
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              stroke={tokens.color.textMuted}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
      <div style={{ fontWeight: 700, fontSize: 15, color: tokens.color.text }}>
        {title}
      </div>
      {message ? (
        <div
          style={{
            fontSize: 13,
            color: tokens.color.textSub,
            lineHeight: 1.65,
            maxWidth: 380,
          }}
        >
          {message}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

// ── InfoRow — key-value pair inside a card ─────────────────────────────────
export function InfoRow({ label, value, tone = null, last = false }) {
  const valueColor =
    tone === "success"
      ? tokens.color.success
      : tone === "critical"
        ? tokens.color.critical
        : tone === "warning"
          ? tokens.color.warning
          : tokens.color.text;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 16,
        padding: "9px 0",
        borderBottom: last ? "none" : `1px solid ${tokens.color.border}`,
      }}
    >
      <span
        style={{ fontSize: 13, color: tokens.color.textSub, flexShrink: 0 }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: valueColor,
          textAlign: "right",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── StatusPill — better than raw s-badge for inline use ───────────────────
export function StatusPill({ children, tone = "subdued" }) {
  const palettes = {
    success: {
      bg: tokens.color.successBg,
      color: tokens.color.success,
      border: "#a7f3d0",
    },
    warning: {
      bg: tokens.color.warningBg,
      color: tokens.color.warning,
      border: "#fde68a",
    },
    critical: {
      bg: tokens.color.criticalBg,
      color: tokens.color.critical,
      border: "#fecaca",
    },
    info: {
      bg: tokens.color.infoBg,
      color: tokens.color.info,
      border: "#bae6fd",
    },
    accent: {
      bg: tokens.color.accentBg,
      color: tokens.color.accent,
      border: "#c7d2fe",
    },
    subdued: {
      bg: tokens.color.bgSubtle,
      color: tokens.color.textSub,
      border: "#e2e8f0",
    },
  };
  const p = palettes[tone] || palettes.subdued;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: tokens.radius.pill,
        border: `1px solid ${p.border}`,
        padding: "3px 10px",
        background: p.bg,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color: p.color,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ── SectionDivider ─────────────────────────────────────────────────────────
export function SectionDivider({ spacing = 20 }) {
  return <div style={{ height: spacing }} />;
}
