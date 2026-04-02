import { OpenAI } from "openai"

import { DefaultGeminiBaseUrl, normalizeBaseUrl } from "./providerConfig.js"

export function buildGeminiChatCompletionsUrl(baseUrl = DefaultGeminiBaseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || DefaultGeminiBaseUrl
  return `${normalizedBaseUrl}/chat/completions`
}

export function extractServerSentEventPayloads(buffer, flush = false) {
  const payloads = []
  let remainingBuffer = buffer ?? ""

  while (true) {
    const boundaryMatch = remainingBuffer.match(/\r?\n\r?\n/)
    if (!boundaryMatch) {
      break
    }

    const boundaryIndex = boundaryMatch.index ?? -1
    const eventBlock = remainingBuffer.slice(0, boundaryIndex)
    remainingBuffer = remainingBuffer.slice(boundaryIndex + boundaryMatch[0].length)

    const payload = eventBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")

    if (payload) {
      payloads.push(payload)
    }
  }

  if (flush && remainingBuffer.trim()) {
    const payload = remainingBuffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")

    if (payload) {
      payloads.push(payload)
      remainingBuffer = ""
    }
  }

  return {
    payloads,
    remainingBuffer,
  }
}

async function parseErrorResponse(response) {
  const rawText = await response.text()
  if (!rawText) {
    return undefined
  }

  try {
    return JSON.parse(rawText)
  } catch {
    return {
      error: {
        message: rawText,
      },
    }
  }
}

async function requestGeminiChatCompletions({
  apiKey,
  baseUrl,
  body,
  signal,
}) {
  try {
    const response = await fetch(buildGeminiChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorBody = await parseErrorResponse(response)
      throw OpenAI.APIError.generate(
        response.status,
        errorBody,
        errorBody?.error?.message ?? `Gemini request failed with status ${response.status}.`,
        response.headers
      )
    }

    return response
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      throw error
    }

    throw new OpenAI.APIConnectionError({
      message: `Gemini network error: ${error?.message ?? "Failed to fetch"}`,
      cause: error,
    })
  }
}

async function* streamGeminiChatCompletions(response, controller) {
  const reader = response.body?.getReader()

  if (!reader) {
    throw new OpenAI.APIConnectionError({
      message: "Gemini returned no readable response stream.",
    })
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let isDone = false

  try {
    while (!isDone) {
      const { value, done } = await reader.read()

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const { payloads, remainingBuffer } = extractServerSentEventPayloads(buffer)
      buffer = remainingBuffer

      for (const payload of payloads) {
        if (payload === "[DONE]") {
          isDone = true
          break
        }

        try {
          yield JSON.parse(payload)
        } catch (error) {
          throw new OpenAI.APIConnectionError({
            message: `Gemini stream parse error: ${error?.message ?? "Invalid JSON chunk"}`,
            cause: error,
          })
        }
      }
    }

    buffer += decoder.decode()
    const flushed = extractServerSentEventPayloads(buffer, true)

    for (const payload of flushed.payloads) {
      if (payload === "[DONE]") {
        break
      }

      try {
        yield JSON.parse(payload)
      } catch (error) {
        throw new OpenAI.APIConnectionError({
          message: `Gemini stream parse error: ${error?.message ?? "Invalid JSON chunk"}`,
          cause: error,
        })
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpenAI.APIUserAbortError()
    }

    throw error
  } finally {
    reader.releaseLock?.()
  }
}

export function createGeminiBrowserClient(apiKey, baseUrl = DefaultGeminiBaseUrl) {
  return {
    chat: {
      completions: {
        create: async (params) => {
          const controller = new AbortController()
          const response = await requestGeminiChatCompletions({
            apiKey,
            baseUrl,
            body: params,
            signal: controller.signal,
          })

          if (!params?.stream) {
            return response.json()
          }

          const stream = streamGeminiChatCompletions(response, controller)
          stream.controller = controller
          return stream
        },
      },
    },
  }
}
