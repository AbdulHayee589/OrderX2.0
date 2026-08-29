import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCampaignRunSummary,
  classifyCampaignSendFailure,
  fitTemplateParameterValues,
  isCampaignTemplateCatalogFresh,
  resolveCampaignDeliveryTransition,
  runCampaignOperationWithRetry,
  sanitizeTemplateParameterValue,
  shouldRetryCampaignOperation,
} from "../services/campaignSendPolicy.js";
import { resolveTemplateVariableValues } from "../services/templateCatalog.js";
import { buildManagedTemplatePayload } from "../services/whatsapp.js";

test("campaign parameter values remove Meta-invalid whitespace and controls", () => {
  assert.equal(
    sanitizeTemplateParameterValue("  Abdul\r\n\t  Hayee\u0007  "),
    "Abdul Hayee",
  );
  assert.equal(
    sanitizeTemplateParameterValue("", { key: "customer_name" }),
    "Customer",
  );
});

test("campaign template status refreshes are reused only while both catalogs are fresh", () => {
  const now = new Date("2026-07-25T12:00:00.000Z");
  assert.equal(
    isCampaignTemplateCatalogFresh(
      {
        managedTemplatesUpdatedAt: "2026-07-25T11:58:00.000Z",
        campaignLibraryTemplatesUpdatedAt: "2026-07-25T11:59:00.000Z",
      },
      { now, maxAgeMs: 5 * 60 * 1000 },
    ),
    true,
  );
  assert.equal(
    isCampaignTemplateCatalogFresh(
      {
        managedTemplatesUpdatedAt: "2026-07-25T11:58:00.000Z",
        campaignLibraryTemplatesUpdatedAt: null,
      },
      { now, maxAgeMs: 5 * 60 * 1000 },
    ),
    false,
  );
  assert.equal(
    isCampaignTemplateCatalogFresh(
      {
        managedTemplatesUpdatedAt: "2026-07-25T11:50:00.000Z",
        campaignLibraryTemplatesUpdatedAt: "2026-07-25T11:59:00.000Z",
      },
      { now, maxAgeMs: 5 * 60 * 1000 },
    ),
    false,
  );
});

test("campaign parameter values fit inside rendered component limits", () => {
  const template = "Hello {{customer_name}}, products: {{product_list}}.";
  const values = fitTemplateParameterValues(
    template,
    ["A very long customer name", "Product ".repeat(30)],
    80,
  );
  const rendered = template
    .replace("{{customer_name}}", values[0])
    .replace("{{product_list}}", values[1]);
  assert.ok(rendered.length <= 80);
  assert.ok(values.every(Boolean));
});

test("managed campaign variables sanitize body, header, and URL parameters", () => {
  const values = resolveTemplateVariableValues(
    {
      flowKey: "campaign",
      headerType: "TEXT",
      headerText: "Update for {{customer_name}}",
      bodyText: "Order {{order_number}} has {{product_list}}.",
      buttons: [
        {
          type: "URL",
          text: "Track",
          url: "{{tracking_url}}",
        },
      ],
    },
    {
      customer_name: "Abdul\nHayee",
      order_number: "#1\t2",
      product_list: "Shoes     and shirt",
      tracking_url: "https://track.example/abc\n",
    },
  );
  assert.deepEqual(values.header, ["Abdul Hayee"]);
  assert.deepEqual(values.body, ["#1 2", "Shoes and shirt"]);
  assert.deepEqual(values.urlButtons, [
    { index: 0, parameters: ["https://track.example/abc"] },
  ]);

  const payload = buildManagedTemplatePayload({
    to: "+923001234567",
    template: {
      metaTemplateName: "campaign_update",
      headerType: "TEXT",
    },
    code: "en",
    resolvedVariableValues: values,
  });
  assert.deepEqual(
    payload.template.components.find(
      (component) => component.type === "button",
    ),
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [
        { type: "text", text: "https://track.example/abc" },
      ],
    },
  );
});

test("Meta 132018 is reported exactly and is never automatically retried", () => {
  const error = new Error("Parameter format does not match template");
  error.httpStatus = 400;
  error.meta = {
    error: {
      code: 132018,
      message: "Parameter format does not match template",
      error_data: { details: "body parameter contains a newline" },
    },
  };
  const failure = classifyCampaignSendFailure(error);
  assert.equal(failure.code, "invalid_template_parameter");
  assert.equal(failure.label, "Invalid template value");
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /contains a newline/);
  assert.equal(shouldRetryCampaignOperation(error, "dispatch"), false);
});

test("campaign parameter count and length failures remain exact and non-retryable", () => {
  for (const [metaCode, expectedCode] of [
    [132000, "template_parameter_count"],
    [132005, "template_parameter_too_long"],
  ]) {
    const error = new Error("Meta rejected campaign parameters");
    error.httpStatus = 400;
    error.meta = {
      error: {
        code: metaCode,
        message: error.message,
        error_data: { details: `Meta error ${metaCode}` },
      },
    };
    const failure = classifyCampaignSendFailure(error);
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.retryable, false);
    assert.equal(shouldRetryCampaignOperation(error, "dispatch"), false);
  }
});

test("only explicit transient Meta rejections retry during dispatch", async () => {
  let attempts = 0;
  const result = await runCampaignOperationWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("Service temporarily unavailable");
        error.httpStatus = 400;
        error.meta = { error: { code: 131016, message: error.message } };
        throw error;
      }
      return "accepted";
    },
    {
      stage: "dispatch",
      maxAttempts: 3,
      sleep: async () => {},
    },
  );
  assert.equal(result, "accepted");
  assert.equal(attempts, 3);

  const ambiguousNetworkError = new Error("fetch failed");
  ambiguousNetworkError.code = "ECONNRESET";
  assert.equal(
    shouldRetryCampaignOperation(ambiguousNetworkError, "dispatch"),
    false,
  );
  assert.equal(
    shouldRetryCampaignOperation(ambiguousNetworkError, "context"),
    true,
  );

  let ambiguousAttempts = 0;
  await assert.rejects(
    runCampaignOperationWithRetry(
      async () => {
        ambiguousAttempts += 1;
        throw ambiguousNetworkError;
      },
      {
        stage: "dispatch",
        maxAttempts: 3,
        sleep: async () => {},
      },
    ),
    /fetch failed/,
  );
  assert.equal(ambiguousAttempts, 1);
});

test("campaign summaries distinguish acceptance, delivery, reads, and failures", () => {
  const summary = buildCampaignRunSummary(
    { scheduleMode: "immediate", completedAt: null },
    [
      { status: "sent", deliveryStatus: "accepted" },
      { status: "sent", deliveryStatus: "read" },
      { status: "failed", deliveryStatus: "failed" },
      { status: "skipped", deliveryStatus: null },
    ],
    new Date("2026-07-25T00:00:00.000Z"),
  );
  assert.equal(summary.sentCount, 2);
  assert.equal(summary.deliveredCount, 1);
  assert.equal(summary.readCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.successRate, 50);
  assert.equal(summary.deliveryRate, 50);
  assert.equal(summary.failureRate, 25);
  assert.equal(summary.status, "completed_with_failures");
});

test("campaign delivery transitions never downgrade delivered messages", () => {
  assert.equal(resolveCampaignDeliveryTransition("accepted", "sent"), "sent");
  assert.equal(resolveCampaignDeliveryTransition("sent", "failed"), "failed");
  assert.equal(
    resolveCampaignDeliveryTransition("delivered", "failed"),
    "delivered",
  );
  assert.equal(resolveCampaignDeliveryTransition("read", "sent"), "read");
});
