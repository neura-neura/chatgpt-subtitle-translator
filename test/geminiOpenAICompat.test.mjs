import test from "node:test"
import assert from "node:assert/strict"

import {
  buildGeminiChatCompletionsUrl,
  extractServerSentEventPayloads,
} from "../web/src/utils/geminiOpenAICompat.js"
import { DefaultGeminiBaseUrl } from "../web/src/utils/providerConfig.js"

test("buildGeminiChatCompletionsUrl normalizes trailing slashes", () => {
  assert.equal(
    buildGeminiChatCompletionsUrl(`${DefaultGeminiBaseUrl}/`),
    `${DefaultGeminiBaseUrl}/chat/completions`
  )
})

test("extractServerSentEventPayloads returns complete SSE payloads", () => {
  const result = extractServerSentEventPayloads(
    'data: {"choices":[{"delta":{"content":"hola"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" mundo"}}]}\n\n'
  )

  assert.deepEqual(result.payloads, [
    '{"choices":[{"delta":{"content":"hola"}}]}',
    '{"choices":[{"delta":{"content":" mundo"}}]}',
  ])
  assert.equal(result.remainingBuffer, "")
})

test("extractServerSentEventPayloads keeps incomplete trailing chunks buffered", () => {
  const result = extractServerSentEventPayloads(
    'data: {"choices":[{"delta":{"content":"hola"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" mundo"}}]}'
  )

  assert.deepEqual(result.payloads, [
    '{"choices":[{"delta":{"content":"hola"}}]}',
  ])
  assert.equal(result.remainingBuffer, 'data: {"choices":[{"delta":{"content":" mundo"}}]}')
})

test("extractServerSentEventPayloads flushes the final payload when requested", () => {
  const result = extractServerSentEventPayloads(
    'data: {"choices":[{"delta":{"content":"hola"}}]}\n\n' +
    "data: [DONE]",
    true
  )

  assert.deepEqual(result.payloads, [
    '{"choices":[{"delta":{"content":"hola"}}]}',
    "[DONE]",
  ])
  assert.equal(result.remainingBuffer, "")
})
