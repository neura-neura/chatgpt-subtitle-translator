import test from "node:test"
import assert from "node:assert/strict"

import {
  ProviderTypes,
  DefaultGeminiBaseUrl,
  DefaultGeminiRateLimit,
  DefaultOllamaBaseUrl,
  detectProviderType,
  getProviderDefaults,
  normalizeBaseUrl,
  normalizeRateLimit,
  shouldApplyRecommendedRateLimit,
} from "../web/src/utils/providerConfig.js"

test("normalizeBaseUrl trims trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1///"), "https://example.com/v1")
})

test("detectProviderType recognizes Gemini base URL", () => {
  assert.equal(detectProviderType(`${DefaultGeminiBaseUrl}/`), ProviderTypes.gemini)
})

test("detectProviderType recognizes Ollama localhost URL", () => {
  assert.equal(detectProviderType(DefaultOllamaBaseUrl), ProviderTypes.ollama)
})

test("getProviderDefaults returns Gemini defaults", () => {
  const geminiDefaults = getProviderDefaults(ProviderTypes.gemini)
  assert.equal(geminiDefaults.baseUrl, DefaultGeminiBaseUrl)
  assert.match(geminiDefaults.apiKeyHint, /Gemini API key/i)
  assert.equal(geminiDefaults.recommendedRateLimit, DefaultGeminiRateLimit)
})

test("normalizeRateLimit falls back when invalid", () => {
  assert.equal(normalizeRateLimit("", 12), 12)
  assert.equal(normalizeRateLimit("7.2", 12), 7)
})

test("shouldApplyRecommendedRateLimit migrates legacy Gemini default", () => {
  assert.equal(shouldApplyRecommendedRateLimit(ProviderTypes.gemini, 60), true)
  assert.equal(shouldApplyRecommendedRateLimit(ProviderTypes.gemini, 8), false)
  assert.equal(shouldApplyRecommendedRateLimit(ProviderTypes.custom, 60), false)
})
