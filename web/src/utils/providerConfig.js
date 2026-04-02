export const ProviderTypes = {
  custom: "custom",
  ollama: "ollama",
  gemini: "gemini",
}

export const DefaultOllamaBaseUrl = "http://localhost:11434/v1"
export const DefaultGeminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai"
export const DefaultGeminiModel = "gemini-2.5-flash"
export const DefaultRateLimit = 60
export const DefaultGeminiRateLimit = 8

export function normalizeBaseUrl(baseUrl) {
  return `${baseUrl ?? ""}`.trim().replace(/\/+$/, "")
}

export function detectProviderType(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  if (!normalizedBaseUrl) {
    return ProviderTypes.custom
  }

  if (normalizedBaseUrl === normalizeBaseUrl(DefaultGeminiBaseUrl)) {
    return ProviderTypes.gemini
  }

  if (/localhost:11434|127\.0\.0\.1:11434/i.test(normalizedBaseUrl)) {
    return ProviderTypes.ollama
  }

  return ProviderTypes.custom
}

export function getProviderDefaults(providerType) {
  switch (providerType) {
    case ProviderTypes.ollama:
      return {
        baseUrl: DefaultOllamaBaseUrl,
        suggestedModel: "",
        apiKeyHint: 'Use "ollama" for local Ollama.',
        recommendedRateLimit: DefaultRateLimit,
      }
    case ProviderTypes.gemini:
      return {
        baseUrl: DefaultGeminiBaseUrl,
        suggestedModel: DefaultGeminiModel,
        apiKeyHint: "Use a Gemini API key from Google AI Studio.",
        recommendedRateLimit: DefaultGeminiRateLimit,
      }
    default:
      return {
        baseUrl: "",
        suggestedModel: "",
        apiKeyHint: "Use the key expected by your OpenAI-compatible provider.",
        recommendedRateLimit: DefaultRateLimit,
      }
  }
}

export function normalizeRateLimit(value, fallback = DefaultRateLimit) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback
  }
  return Math.round(numericValue)
}

export function shouldApplyRecommendedRateLimit(providerType, rateLimit) {
  const normalizedRateLimit = normalizeRateLimit(rateLimit, DefaultRateLimit)

  if (providerType === ProviderTypes.gemini) {
    return normalizedRateLimit === DefaultRateLimit
  }

  return false
}
