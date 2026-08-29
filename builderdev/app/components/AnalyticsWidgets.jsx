// app/components/AnalyticsWidgets.jsx
import { useMemo } from "react";
import { useLocation } from "react-router";
import { withShopParams } from "../utils/embedded";
import { formatNumber } from "../utils/format";
import { formatDualCurrency, formatMoney } from "../utils/billingPresentation";
import { MetricTile, SurfaceCard } from "./AppSurface";

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const analyticsGrid = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  alignItems: "stretch",
};

const splitGrid = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  alignItems: "start",
};

export function UsageWidget({
  billing,
  usage,
  upgradeHref = "/app/settings#plans",
  framed = true,
  showPkrInfo = false,
}) {
  const location = useLocation();
  const upgradeUrl = useMemo(
    () => withShopParams(upgradeHref, location.search),
    [upgradeHref, location.search],
  );

  const active = !!billing?.active;
  const planName = billing?.plan?.name || billing?.planKey || "—";
  const u = usage?.usage || {};
  const isTrial = billing?.status === "TRIAL";
  const billingType = String(billing?.plan?.billingType || "").trim();
  const planSenderMode = String(billing?.plan?.senderMode || "").trim();
  const isByonPlan =
    planSenderMode === "own_number" || billing?.plan?.quotaManagedByMeta === true;
  const isByonFreeTrial = isByonPlan && billingType === "free_cap";
  const freeUsage = u.freePlanUsage || {};
  const growthUsage = u.growthUsage || {};
  const byonUsage = u.byonUsage || {};
  const byonTemplateCap = n(
    byonUsage?.outboundMessageCap ??
      billing?.plan?.outboundMessageCap ??
      byonUsage?.templateMessageCap ??
      billing?.plan?.templateMessageCap ??
      0,
  );
  const byonRemainingMessages =
    byonTemplateCap > 0
      ? Math.max(0, n(byonUsage?.remainingMessages ?? byonTemplateCap))
      : null;
  const byonNearCap =
    active &&
    billing?.plan?.quotaManagedByMeta === true &&
    byonUsage?.nearCap === true;
  const byonBlocked =
    active &&
    billing?.plan?.quotaManagedByMeta === true &&
    byonUsage?.blocked === true;
  const growthStoreCountryCode = String(
    growthUsage?.storeCountryCode ||
      billing?.storeCountryCode ||
      billing?.regionalPricing?.storeCountryCode ||
      "",
  ).trim();
  const trialCap = n(u.trialMessageCap ?? billing?.trialMessageCap ?? 10);
  const trialUsed = n(u.trialMessagesUsed ?? billing?.trialMessagesUsed ?? 0);
  const trialRemaining = Math.max(0, trialCap - trialUsed);
  const trialReached = active && isTrial && trialRemaining <= 0;
  const freeCapReached =
    active &&
    billingType === "free_cap" &&
    !isByonPlan &&
    n(freeUsage.remaining) <= 0 &&
    n(freeUsage.limit) > 0;
  const growthNearCap =
    active && billingType === "shopify_metered" && growthUsage.nearCap === true;
  const growthCriticalCap =
    active &&
    billingType === "shopify_metered" &&
    growthUsage.criticalCap === true;
  const growthBlocked =
    active && billingType === "shopify_metered" && growthUsage.blocked === true;

  const content = (
    <s-stack direction="block" gap="base">
      <s-stack
        direction="inline"
        gap="base"
        wrap
        style={{ alignItems: "center" }}
      >
        <s-heading>Usage</s-heading>
        {active ? (
          <s-badge tone="success">{billing?.status || "Active"}</s-badge>
        ) : (
          <s-badge tone="critical">Inactive</s-badge>
        )}
        <s-text tone="subdued">
          Plan: <strong>{planName}</strong>
        </s-text>
      </s-stack>

      {!active ? (
        <s-stack direction="block" gap="tight">
          <s-paragraph tone="critical">
            Billing is inactive. WhatsApp sending is blocked.
          </s-paragraph>
          <s-button href={upgradeUrl} suppressHydrationWarning>
            Choose a plan
          </s-button>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="base">
          {isByonPlan ? (
            <>
              <div style={analyticsGrid}>
                <MetricTile
                  label="Outbound Messages Used"
                  value={formatNumber(byonUsage.messagesSent || 0)}
                  hint={
                    isByonFreeTrial
                      ? "Your Own Number free trial"
                      : byonTemplateCap > 0
                        ? `This billing cycle (${formatNumber(byonTemplateCap)} included)`
                        : "This billing cycle"
                  }
                  soft
                />
                <MetricTile
                  label={byonTemplateCap > 0 ? "Remaining" : "Plan Status"}
                  value={
                    byonTemplateCap > 0
                      ? formatNumber(byonRemainingMessages || 0)
                      : billing?.plan?.name || "Active"
                  }
                  hint={
                    isByonFreeTrial
                      ? "Free trial outbound messages left"
                      : byonTemplateCap > 0
                        ? "Included outbound messages left before OrderX overage billing starts"
                        : "Current BYON package"
                  }
                  soft
                />
                <MetricTile
                  label={isByonFreeTrial ? "Trial Cost" : byonTemplateCap > 0 ? "OrderX Overage" : "Subscription"}
                  value={
                    isByonFreeTrial
                      ? "Free"
                      : byonTemplateCap > 0
                        ? formatDualCurrency({
                            usd: byonUsage.orderxUsageCostUsd || 0,
                            pkr: byonUsage.orderxUsageCostPkr || 0,
                            showPkrInfo,
                          })
                        : billing?.subscriptionId
                          ? "Connected"
                          : "Not linked"
                  }
                  hint={
                    isByonFreeTrial
                      ? "No Shopify charge during the trial"
                      : byonTemplateCap > 0
                        ? "Current billing cycle overage charged by OrderX"
                        : "Shopify subscription state"
                  }
                  soft
                />
              </div>
              <SurfaceCard soft padding="base">
                <s-stack direction="block" gap="tight">
                  {isByonFreeTrial ? (
                    <s-text tone="subdued">
                      Your Own Number Free Trial includes{" "}
                      <strong>{formatNumber(byonTemplateCap || trialCap)}</strong>{" "}
                      outbound messages for 7 days. After the trial, choose
                      Starter, Scale, or Unlimited to keep sending.
                    </s-text>
                  ) : byonTemplateCap > 0 ? (
                    <s-text tone="subdued">
                      This BYON package includes{" "}
                      <strong>{formatNumber(byonTemplateCap)}</strong> outbound
                      messages per billing cycle, then{" "}
                      <strong>
                        {formatMoney(
                          Number(billing?.plan?.usagePrice?.amount || 0.01),
                          "USD",
                        )}
                      </strong>{" "}
                      per extra outbound message.
                    </s-text>
                  ) : null}
                </s-stack>
              </SurfaceCard>
            </>
          ) : billingType === "free_cap" ? (
            <>
              <div style={analyticsGrid}>
                <MetricTile
                  label="Template Messages Used"
                  value={formatNumber(freeUsage.used || 0)}
                  hint={`Total allowance: ${formatNumber(freeUsage.limit || 0)}`}
                  soft
                />
                <MetricTile
                  label="Remaining"
                  value={formatNumber(freeUsage.remaining || 0)}
                  hint="Templates left on OrderX Free"
                  soft
                />
                <MetricTile
                  label="Plan Cost"
                  value="Free"
                  hint="No Shopify charge on OrderX Free"
                  soft
                />
              </div>
              <SurfaceCard soft padding="base">
                <s-text tone="subdued">
                  OrderX Free includes{" "}
                  <strong>{formatNumber(freeUsage.limit || 0)}</strong> template
                  messages total on the OrderX number.
                </s-text>
              </SurfaceCard>
            </>
          ) : billingType === "shopify_metered" ? (
            <>
              <div style={analyticsGrid}>
                <MetricTile
                  label="Messages Sent"
                  value={formatNumber(growthUsage.messagesSent || 0)}
                  hint="Metered outbound messages this billing cycle"
                  soft
                />
                <MetricTile
                  label="Usage Cost"
                  value={formatDualCurrency({
                    usd: growthUsage.usageCostUsd || 0,
                    pkr: growthUsage.usageCostPkr || 0,
                    showPkrInfo,
                  })}
                  hint={`Current cycle cap: ${formatMoney(growthUsage.capUsd || 0, "USD")}`}
                  soft
                />
                <MetricTile
                  label="Estimated Monthly Cost"
                  value={formatDualCurrency({
                    usd: growthUsage.estimatedMonthlyCostUsd || 0,
                    pkr: growthUsage.estimatedMonthlyCostPkr || 0,
                    showPkrInfo,
                  })}
                  hint="Projected from current cycle pace"
                  soft
                />
              </div>
              <SurfaceCard soft padding="base">
                <s-stack direction="block" gap="tight">
                  <s-text tone="subdued">
                    Approx. remaining before cap:{" "}
                    <strong>
                      {growthUsage.remainingMessages == null
                        ? "—"
                        : formatNumber(growthUsage.remainingMessages)}
                    </strong>{" "}
                    messages
                    {growthStoreCountryCode
                      ? ` (${growthStoreCountryCode} baseline)`
                      : ""}
                  </s-text>
                  <s-text tone="subdued">
                    Shopify usage cap:{" "}
                    <strong>
                      {formatDualCurrency({
                        usd: growthUsage.capUsd || 0,
                        pkr: growthUsage.capPkr || 0,
                        showPkrInfo,
                      })}
                    </strong>
                  </s-text>
                  <s-text tone="subdued">
                    Actual Shopify billing follows the recipient country. The
                    message cap shown here is approximate and uses your{" "}
                    {growthStoreCountryCode || "store"} baseline rate.
                  </s-text>
                  {growthUsage.hasSyncedBalanceDrift ? (
                    <s-text tone="subdued">
                      Shopify currently reports{" "}
                      <strong>
                        {formatDualCurrency({
                          usd: growthUsage.externalCostUsd || 0,
                          pkr: growthUsage.externalCostPkr || 0,
                          showPkrInfo,
                        })}
                      </strong>{" "}
                      billed on the active usage line item. OrderX is showing{" "}
                      <strong>
                        {formatDualCurrency({
                          usd: growthUsage.usageCostUsd || 0,
                          pkr: growthUsage.usageCostPkr || 0,
                          showPkrInfo,
                        })}
                      </strong>{" "}
                      here so the amount stays aligned with the metered message
                      count for this cycle.
                    </s-text>
                  ) : null}
                </s-stack>
              </SurfaceCard>
            </>
          ) : billing?.plan?.quotaManagedByMeta === true ? (
            <>
              <div style={analyticsGrid}>
                <MetricTile
                  label="Messages Sent"
                  value={formatNumber(byonUsage.messagesSent || 0)}
                  hint={
                    byonTemplateCap > 0
                      ? `Outbound messages this billing cycle (${formatNumber(byonTemplateCap)} included)`
                      : "Outbound messages this billing cycle"
                  }
                  soft
                />
                <MetricTile
                  label={byonTemplateCap > 0 ? "Remaining" : "Plan Status"}
                  value={
                    byonTemplateCap > 0
                      ? formatNumber(byonRemainingMessages || 0)
                      : billing?.plan?.name || "Active"
                  }
                  hint={
                    byonTemplateCap > 0
                      ? "Included outbound messages left before OrderX overage billing starts"
                      : "Current BYON package"
                  }
                  soft
                />
                <MetricTile
                  label={
                    byonTemplateCap > 0 ? "OrderX Overage" : "Subscription"
                  }
                  value={
                    byonTemplateCap > 0
                      ? formatDualCurrency({
                          usd: byonUsage.orderxUsageCostUsd || 0,
                          pkr: byonUsage.orderxUsageCostPkr || 0,
                          showPkrInfo,
                        })
                      : billing?.subscriptionId
                        ? "Connected"
                        : "Not linked"
                  }
                  hint={
                    byonTemplateCap > 0
                      ? "Current billing cycle overage charged by OrderX"
                      : "Shopify subscription state"
                  }
                  soft
                />
              </div>
              <SurfaceCard soft padding="base">
                <s-stack direction="block" gap="tight">
                  {byonTemplateCap > 0 ? (
                    <s-text tone="subdued">
                      This BYON package includes{" "}
                      <strong>{formatNumber(byonTemplateCap)}</strong> outbound
                      messages per billing cycle, then{" "}
                      <strong>
                        {formatMoney(
                          Number(billing?.plan?.usagePrice?.amount || 0.01),
                          "USD",
                        )}
                      </strong>{" "}
                      per extra outbound message.
                    </s-text>
                  ) : null}
                </s-stack>
              </SurfaceCard>
            </>
          ) : isTrial ? (
            <SurfaceCard soft padding="base">
              <s-text tone="subdued">
                Trial free messages: <strong>{trialUsed}</strong> /{" "}
                <strong>{trialCap}</strong> (Remaining:{" "}
                <strong>{trialRemaining}</strong>)
              </s-text>
            </SurfaceCard>
          ) : (
            <SurfaceCard soft padding="base">
              <s-text tone="subdued">
                Current billing cycle usage:{" "}
                <strong>{formatNumber(u.month || 0)}</strong>
              </s-text>
            </SurfaceCard>
          )}

          {freeCapReached ? (
            <s-banner tone="warning">
              Free plan limit reached. Upgrade to continue sending template
              messages.
            </s-banner>
          ) : growthBlocked ? (
            <s-banner tone="warning">
              Growth usage cap reached. Increase the cap before OrderX sends
              the next message.
            </s-banner>
          ) : growthCriticalCap ? (
            <s-banner tone="warning">
              Only {formatNumber(growthUsage.remainingMessages || 0)} approx.
              messages remain at your {growthStoreCountryCode || "store"}{" "}
              baseline before the current cap is reached.
            </s-banner>
          ) : growthNearCap ? (
            <s-banner tone="warning">
              You are close to the current Growth usage cap. Increase the cap to
              avoid interruptions.
            </s-banner>
          ) : byonBlocked ? (
            <s-banner tone="warning">
              {isByonFreeTrial
                ? "Your Own Number free trial limit reached. Choose Starter, Scale, or Unlimited to continue sending."
                : "BYON overage billing can’t continue on the current subscription. Refresh billing or switch packages before sending more outbound messages this cycle."}
            </s-banner>
          ) : byonNearCap ? (
            <s-banner tone="warning">
              Only {formatNumber(byonRemainingMessages || 0)} included BYON
              outbound messages remain on the current package before OrderX
              starts billing{" "}
              {formatMoney(
                Number(billing?.plan?.usagePrice?.amount || 0.01),
                "USD",
              )}{" "}
              per extra outbound message.
            </s-banner>
          ) : trialReached ? (
            <s-banner tone="warning">
              Trial cap reached. Upgrade to continue.
            </s-banner>
          ) : null}

          <s-button
            href={upgradeUrl}
            variant={
              freeCapReached || trialReached || growthBlocked || byonBlocked
                ? "primary"
                : "secondary"
            }
            suppressHydrationWarning
          >
            {billingType === "shopify_metered" &&
            (growthNearCap || growthCriticalCap || growthBlocked)
              ? "Increase usage cap"
              : billing?.plan?.quotaManagedByMeta === true &&
                  (byonNearCap || byonBlocked)
                ? "Review BYON package"
                : freeCapReached || trialReached
                  ? "Upgrade to resume sending"
                  : "Manage plans"}
          </s-button>
        </s-stack>
      )}
    </s-stack>
  );

  return framed ? (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      {content}
    </s-box>
  ) : (
    content
  );
}

export function AnalyticsSummary({ metrics }) {
  const rows = Array.isArray(metrics) ? metrics : [];

  const last7 = rows.slice(0, 7);
  const last30 = rows.slice(0, 30);

  const sum = (arr, key) => arr.reduce((acc, x) => acc + n(x?.[key]), 0);

  const wa7 = sum(last7, "waMessagesSent");
  const wa30 = sum(last30, "waMessagesSent");
  const savedOrders7 = sum(last7, "savedOrders");
  const savedOrders30 = sum(last30, "savedOrders");
  const rev7 = sum(last7, "savedRevenue");
  const rev30 = sum(last30, "savedRevenue");

  const tiles = [
    { label: "WA sent (7d)", value: wa7 },
    { label: "WA sent (30d)", value: wa30 },
    { label: "Saved orders (7d)", value: savedOrders7 },
    { label: "Saved orders (30d)", value: savedOrders30 },
    { label: "Saved revenue (7d)", value: formatNumber(rev7) },
    { label: "Saved revenue (30d)", value: formatNumber(rev30) },
  ];

  return (
    <div style={analyticsGrid}>
      {tiles.map((tile) => (
        <MetricTile
          key={tile.label}
          label={tile.label}
          value={tile.value}
          soft
        />
      ))}
    </div>
  );
}

export function AttemptsAnalytics({ attempts }) {
  const counts = useMemo(() => {
    const list = Array.isArray(attempts) ? attempts : [];
    return list.reduce(
      (acc, a) => {
        const s = a?.status || "unknown";
        acc.status[s] = (acc.status[s] || 0) + 1;

        if (a?.waTemplateUsed)
          acc.templates[a.waTemplateUsed] =
            (acc.templates[a.waTemplateUsed] || 0) + 1;

        if (a?.lastError)
          acc.errors[a.lastError] = (acc.errors[a.lastError] || 0) + 1;

        return acc;
      },
      { status: {}, templates: {}, errors: {} },
    );
  }, [attempts]);

  const confirmed = n(counts.status.confirmed);
  const cancelled = n(counts.status.cancelled);
  const failed = n(counts.status.failed);
  const waSent = n(counts.status.wa_sent);
  const pending = n(counts.status.pending) + n(counts.status.scheduled);

  const totalResolved = confirmed + cancelled + failed;
  const confirmRate =
    totalResolved > 0 ? Math.round((confirmed / totalResolved) * 100) : 0;
  const cancelRate =
    totalResolved > 0 ? Math.round((cancelled / totalResolved) * 100) : 0;

  const topTemplates = Object.entries(counts.templates)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topErrors = Object.entries(counts.errors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const tiles = [
    { label: "Confirmed", value: confirmed },
    { label: "Cancelled", value: cancelled },
    { label: "WA sent", value: waSent },
    { label: "Pending", value: pending },
    { label: "Failed", value: failed },
    { label: "Confirm rate", value: `${confirmRate}%` },
    { label: "Cancel rate", value: `${cancelRate}%` },
  ];

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="block" gap="tight">
        <s-heading>Attempts analytics</s-heading>
        <div style={analyticsGrid}>
          {tiles.map((tile) => (
            <MetricTile
              key={tile.label}
              label={tile.label}
              value={tile.value}
              soft
            />
          ))}
        </div>
      </s-stack>

      <div style={splitGrid}>
        <SurfaceCard padding="base" soft style={{ minHeight: 190 }}>
          <s-stack direction="block" gap="tight">
            <s-heading>Top templates</s-heading>
            {!topTemplates.length ? (
              <s-paragraph>No template usage yet.</s-paragraph>
            ) : (
              <s-unordered-list>
                {topTemplates.map(([k, v]) => (
                  <s-list-item key={k}>
                    <strong>{k}</strong> — {v}
                  </s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>
        </SurfaceCard>

        <SurfaceCard padding="base" soft style={{ minHeight: 190 }}>
          <s-stack direction="block" gap="tight">
            <s-heading>Top errors</s-heading>
            {!topErrors.length ? (
              <s-paragraph>No errors.</s-paragraph>
            ) : (
              <s-unordered-list>
                {topErrors.map(([k, v]) => (
                  <s-list-item key={k}>
                    <strong>{v}</strong> — {k}
                  </s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-stack>
        </SurfaceCard>
      </div>
    </s-stack>
  );
}
