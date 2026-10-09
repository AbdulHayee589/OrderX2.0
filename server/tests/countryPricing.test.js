import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActiveCountryRateMap,
  calculateGrowthCapUnits,
  normalizeCountryCode,
  resolveConfiguredStoreRate,
} from "../services/countryPricing.js";

test("normalizes configured country names and ISO3 aliases to ISO2", () => {
  assert.equal(normalizeCountryCode("United States"), "US");
  assert.equal(normalizeCountryCode("USA"), "US");
  assert.equal(normalizeCountryCode("Pakistan"), "PK");
  assert.equal(normalizeCountryCode("pak"), "PK");
  assert.equal(normalizeCountryCode("United Arab Emirates"), "AE");
  assert.equal(normalizeCountryCode("mys"), "MY");
});

test("uses a configured rate for the resolved default country", () => {
  const pakistanRate = {
    countryCode: "PK",
    countryName: "Pakistan",
    growthPriceUsd: 0.01,
  };
  const rateMap = new Map([["PK", pakistanRate]]);

  assert.equal(
    resolveConfiguredStoreRate(rateMap, {
      explicitStoreCountryCode: "",
      resolvedStoreCountryCode: "PK",
    }),
    pakistanRate,
  );
});

test("enables every country present in the configured active-rate map", () => {
  const configuredCodes = ["US", "PK", "IN", "EG", "SA", "AE", "MY", "ID"];
  const rateMap = new Map(
    configuredCodes.map((countryCode) => [countryCode, { countryCode }]),
  );

  for (const countryCode of configuredCodes) {
    assert.equal(
      resolveConfiguredStoreRate(rateMap, {
        explicitStoreCountryCode: countryCode,
        resolvedStoreCountryCode: countryCode,
      })?.countryCode,
      countryCode,
    );
  }
});

test("does not enable Growth for a country without an active configured rate", () => {
  const rateMap = new Map([["PK", { countryCode: "PK" }]]);

  assert.equal(
    resolveConfiguredStoreRate(rateMap, {
      explicitStoreCountryCode: "US",
      resolvedStoreCountryCode: "US",
    }),
    null,
  );
});

test("builds the Growth allowlist only from active country-rate records", () => {
  const rateMap = buildActiveCountryRateMap([
    {
      countryCode: "PK",
      countryName: "Pakistan",
      growthPriceUsd: 0.01,
      byonUtilityTemplateUsd: 0.01,
      active: true,
    },
    {
      countryCode: "US",
      countryName: "United States",
      growthPriceUsd: 0.04,
      byonUtilityTemplateUsd: 0.02,
      active: false,
    },
  ]);

  assert.equal(rateMap.get("PK")?.growthPriceUsd, 0.01);
  assert.equal(rateMap.has("US"), false);
});

test("keeps the configured Growth price instead of replacing it with a default", () => {
  const rateMap = buildActiveCountryRateMap([
    {
      countryCode: "PK",
      countryName: "Pakistan",
      growthPriceUsd: 0.0175,
      byonUtilityTemplateUsd: 0,
      active: true,
    },
  ]);

  assert.equal(rateMap.get("PK")?.growthPriceUsd, 0.0175);
  assert.equal(rateMap.get("PK")?.byonUtilityTemplateUsd, 0);
});

test("an empty configured allowlist stays empty", () => {
  assert.equal(buildActiveCountryRateMap([]).size, 0);
  assert.equal(
    buildActiveCountryRateMap([
      {
        countryCode: "PK",
        countryName: "Pakistan",
        growthPriceUsd: 0.01,
        byonUtilityTemplateUsd: 0.01,
        active: false,
      },
    ]).size,
    0,
  );
});

test("equal store and recipient prices consume exactly one Growth cap unit", () => {
  assert.equal(calculateGrowthCapUnits(0.01, 0.01), 1);
  assert.equal(calculateGrowthCapUnits(0.0175, 0.0175), 1);
});

test("cross-border Growth rates consume the correct whole cap units", () => {
  assert.equal(calculateGrowthCapUnits(0.02, 0.01), 2);
  assert.equal(calculateGrowthCapUnits(0.03, 0.02), 2);
});
