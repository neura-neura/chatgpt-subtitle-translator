import test from "node:test"
import assert from "node:assert/strict"

import {
  ProviderTypes,
  DefaultGeminiBaseUrl,
  DefaultOllamaBaseUrl,
  detectProviderType,
  getProviderDefaults,
  normalizeBaseUrl,
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
})
