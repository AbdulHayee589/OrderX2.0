export default function ConfirmDialog({
  open = false,
  title = "Confirm action",
  message = "",
  details = [],
  confirmLabel = "Confirm",
  cancelLabel = "Keep current setup",
  onConfirm,
  onCancel,
  loading = false,
  destructive = false,
}) {
  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onCancel}
        style={{
          position: "absolute",
          inset: 0,
          border: "none",
          background: "rgba(15, 23, 42, 0.48)",
          padding: 0,
          cursor: "pointer",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 540,
          borderRadius: 20,
          border: "1px solid #d7dce2",
          background: "#ffffff",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.18)",
          padding: 24,
        }}
      >
        <s-stack direction="block" gap="base">
          <s-heading>{title}</s-heading>
          {message ? <s-text>{message}</s-text> : null}
          {Array.isArray(details) && details.length ? (
            <div
              style={{
                borderRadius: 14,
                background: "#f6f7f8",
                border: "1px solid #e1e5ea",
                padding: 16,
              }}
            >
              <s-stack direction="block" gap="tight">
                {details.map((detail) => (
                  <s-text key={detail}>{detail}</s-text>
                ))}
              </s-stack>
            </div>
          ) : null}
          <s-stack direction="inline" gap="base" wrap>
            <s-button variant="secondary" onClick={onCancel} disabled={loading}>
              {cancelLabel}
            </s-button>
            <s-button
              variant={destructive ? "primary" : "secondary"}
              tone={destructive ? "critical" : undefined}
              onClick={onConfirm}
              {...(loading ? { loading: true } : {})}
            >
              {confirmLabel}
            </s-button>
          </s-stack>
        </s-stack>
      </div>
    </div>
  );
}
