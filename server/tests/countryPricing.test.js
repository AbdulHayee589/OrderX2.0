import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCountryCode,
  resolveConfiguredStoreRate,
} from "../services/countryPricing.js";

test("normalizes configured country names and ISO3 aliases to ISO2", () => {
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
  const configuredCodes = ["PK", "IN", "EG", "SA", "AE", "MY", "ID"];
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
