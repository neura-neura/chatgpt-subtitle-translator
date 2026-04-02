"use client"
import React, { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react'
import { Button, Input, Card, Textarea, Slider, Switch, CardHeader, CardBody, Divider, Popover, PopoverTrigger, PopoverContent, Autocomplete, AutocompleteItem } from "@nextui-org/react";
import JSZip from "jszip"

import { EyeSlashFilledIcon } from './EyeSlashFilledIcon';
import { EyeFilledIcon } from './EyeFilledIcon';

import { FileUploadButton } from '@/components/FileUploadButton';
import { SubtitleCard } from '@/components/SubtitleCard';
import { appendFileNameSuffix, buildCombinedSrtFileName, buildTranslatedSrtArchivePath, buildTranslatedSrtFileName, downloadBlob, downloadString } from '@/utils/download';
import { createGeminiBrowserClient } from '@/utils/geminiOpenAICompat';
import { sampleSrt } from '@/data/sample';
import { buildCombinedSrtText, combineSubtitles, parseSubtitleText, removeREngTag } from '@/utils/subtitleMerge';
import { playCompletionSound, ensureCompletionNotificationPermission, primeCompletionAudio, showCompletionNotification } from '@/utils/completionAlerts';
import { analyzeSubtitleImport, buildSuggestedRenameFileName, extractSubtitleImports, getPathLeaf, pairSubtitleImports, sortSubtitleImports, suggestRenameBaseName } from '@/utils/subtitleBatch';
import { DefaultGeminiBaseUrl, DefaultGeminiModel, DefaultOllamaBaseUrl, DefaultRateLimit, ProviderTypes, detectProviderType, getProviderDefaults, normalizeBaseUrl, normalizeRateLimit, shouldApplyRecommendedRateLimit } from '@/utils/providerConfig';

import { Translator, TranslatorStructuredArray, subtitleParser, createOpenAIClient, CooldownContext } from "chatgpt-subtitle-translator"

const OPENAI_API_KEY = "OPENAI_API_KEY"
const OPENAI_BASE_URL = "OPENAI_BASE_URL"
const RATE_LIMIT = "RATE_LIMIT"
const MODEL = "MODEL"
const MODEL_HISTORY = "MODEL_HISTORY"
const TO_LANGUAGE = "TO_LANGUAGE"
const SYSTEM_INSTRUCTION = "SYSTEM_INSTRUCTION"
const KEEP_MERGE_LANGUAGE_TAG = "KEEP_MERGE_LANGUAGE_TAG"
const LINK_SUBTITLE_SCROLL = "LINK_SUBTITLE_SCROLL"
const OLLAMA_GITHUB_PAGES_HINT_DISMISSED = "OLLAMA_GITHUB_PAGES_HINT_DISMISSED"
const SYSTEM_INSTRUCTION_PRESETS = "SYSTEM_INSTRUCTION_PRESETS"

const PreviousDefaultModel = "gpt-4o-mini"
const DefaultModel = "translategemma:12b-it-q4_K_M"
const SecondaryDefaultModel = "gemma3:12b-it-qat"
const DefaultModelOptions = [DefaultModel, SecondaryDefaultModel]
const DefaultTemperature = 0
const MergeLanguageTag = "{\\rENG}"
const API_PROVIDER = "API_PROVIDER"

function ChevronDownIcon(props) {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" height="16" viewBox="0 0 24 24" width="16" {...props}>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  )
}

function CloseIcon(props) {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" height="14" viewBox="0 0 24 24" width="14" {...props}>
      <path d="M6 6l12 12" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M18 6l-12 12" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  )
}

function normalizeSubtitleEditorLineBreaks(text) {
  return `${text ?? ""}`
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildFlexibleSourcePattern(source) {
  return normalizeSubtitleEditorLineBreaks(source)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("\\s+")
}

function sanitizeTranslatedSubtitleLine(line, originalSource = "") {
  let cleaned = normalizeSubtitleEditorLineBreaks(line).trim()
  cleaned = cleaned.replace(/^\[Flagged\]\[(?:Model|Moderator)\]\s*/iu, "").trim()

  const sourcePattern = buildFlexibleSourcePattern(originalSource)
  if (!sourcePattern) {
    return cleaned
  }

  const echoedSourcePattern = new RegExp(
    `^(?:["'“”‘’「【\\(\\[]\\s*)?${sourcePattern}(?:\\s*["'“”‘’」】\\)\\]])?\\s*->\\s*`,
    "u"
  )

  if (echoedSourcePattern.test(cleaned)) {
    return cleaned.replace(echoedSourcePattern, "").trim()
  }

  return cleaned
}

function splitSubtitleTextForEditor(text) {
  const normalizedText = normalizeSubtitleEditorLineBreaks(text)
  return {
    hasEngTag: normalizedText.includes(MergeLanguageTag),
    text: normalizedText.split(MergeLanguageTag).join(""),
  }
}

function buildSubtitleTextFromEditor(text, hasEngTag) {
  const normalizedText = normalizeSubtitleEditorLineBreaks(text)

  if (!hasEngTag) {
    return normalizedText
  }

  if (!normalizedText) {
    return MergeLanguageTag
  }

  const lines = normalizedText.split("\n")
  if (lines.length === 1) {
    return `${MergeLanguageTag}${lines[0]}`
  }

  return `${lines[0]}\n${MergeLanguageTag}${lines.slice(1).join("\n")}`
}

function buildSubtitleEditorRows(srtText) {
  if (!srtText?.trim()) {
    return []
  }

  return subtitleParser.fromSrt(srtText).map((item) => {
    const { hasEngTag, text } = splitSubtitleTextForEditor(item.text ?? "")

    return {
      id: item.id ?? "",
      startTime: item.startTime ?? "",
      endTime: item.endTime ?? "",
      text,
      hasEngTag,
    }
  })
}

function buildSrtFromSubtitleEditorRows(rows) {
  if (!rows.length) {
    return ""
  }

  return `${rows.map((row, index) => {
    const subtitleId = `${row.id ?? ""}`.trim() || `${index + 1}`
    const startTime = `${row.startTime ?? ""}`.trim()
    const endTime = `${row.endTime ?? ""}`.trim()
    const subtitleText = buildSubtitleTextFromEditor(row.text ?? "", Boolean(row.hasEngTag))

    return `${subtitleId}\r\n${startTime} --> ${endTime}\r\n${subtitleText}`
  }).join("\r\n\r\n")}\r\n`
}

function buildSrtFromParsedSubtitles(subtitles) {
  if (!subtitles.length) {
    return ""
  }

  return `${subtitles.map((subtitle) => (
    `${subtitle.id}\r\n${subtitle.startTime} --> ${subtitle.endTime}\r\n${normalizeSubtitleEditorLineBreaks(subtitle.text ?? "")}`
  )).join("\r\n\r\n")}\r\n`
}

function serializeSubtitleEditorRows(rows) {
  return JSON.stringify(rows.map((row) => ({
    id: `${row.id ?? ""}`,
    startTime: `${row.startTime ?? ""}`,
    endTime: `${row.endTime ?? ""}`,
    text: normalizeSubtitleEditorLineBreaks(row.text ?? ""),
    hasEngTag: Boolean(row.hasEngTag),
  })))
}

function updateSubtitleEditorRow(setRows, rowIndex, field, value) {
  setRows((rows) => {
    const nextRows = rows.slice()
    nextRows[rowIndex] = { ...nextRows[rowIndex], [field]: value }
    return nextRows
  })
}

function buildOutputEditorRow(subtitle, text = "") {
  const { hasEngTag, text: normalizedText } = splitSubtitleTextForEditor(text)

  return {
    id: subtitle?.id ?? "",
    startTime: subtitle?.startTime ?? "",
    endTime: subtitle?.endTime ?? "",
    text: normalizedText,
    hasEngTag,
  }
}

function formatProviderTranslationError(providerType, errorMessage, recommendedRateLimit) {
  const normalizedMessage = `${errorMessage ?? ""}`.trim()

  if (providerType === ProviderTypes.gemini && /\b429\b|rate limit/i.test(normalizedMessage)) {
    return `Gemini rate limit reached (HTTP 429). Wait about a minute and try again with Rate Limit ${recommendedRateLimit} RPM or lower. Google applies Gemini quotas per project, so canceling and retrying still counts against the same minute window. Original error: ${normalizedMessage}`
  }

  return normalizedMessage || "Translation failed."
}

function getSubtitleEditorRowLineCount(row) {
  return Math.max(1, normalizeSubtitleEditorLineBreaks(row.text ?? "").split("\n").length)
}

function getSubtitleEditorRowHeight(row) {
  return Math.max(124, 92 + (getSubtitleEditorRowLineCount(row) - 1) * 24)
}

function SubtitleEditorTable({
  tableId,
  description,
  rows,
  onRowChange,
  pendingLabel,
  disabled,
  priorityRenderCount = 0,
  linkedScrollEnabled = false,
  linkedScrollAnchor = null,
  onLinkedScrollAnchorChange,
}) {
  const containerRef = useRef(null)
  const suppressLinkedScrollRef = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(640)
  const [searchValue, setSearchValue] = useState("")
  const deferredSearchValue = useDeferredValue(searchValue)
  const rowGap = 10
  const overscan = 500

  const normalizedSearchValue = deferredSearchValue.trim().toLowerCase()
  const indexedRows = rows.map((row, rowIndex) => ({ row, rowIndex }))
  const filteredRows = normalizedSearchValue
    ? indexedRows.filter(({ row }) => {
      const searchableText = [
        row.id,
        row.startTime,
        row.endTime,
        normalizeSubtitleEditorLineBreaks(row.text),
      ].join("\n").toLowerCase()
      return searchableText.includes(normalizedSearchValue)
    })
    : indexedRows

  const rowOffsets = []
  const rowHeights = []
  let totalHeight = 0

  for (const { row } of filteredRows) {
    rowOffsets.push(totalHeight)
    const rowHeight = getSubtitleEditorRowHeight(row)
    rowHeights.push(rowHeight)
    totalHeight += rowHeight + rowGap
  }

  if (filteredRows.length > 0) {
    totalHeight -= rowGap
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const updateViewportMetrics = () => {
      setViewportHeight(container.clientHeight || 640)
      setScrollTop(container.scrollTop)
    }

    const handleScroll = () => {
      const nextScrollTop = container.scrollTop
      setScrollTop(nextScrollTop)

      if (!linkedScrollEnabled || suppressLinkedScrollRef.current || filteredRows.length === 0) {
        return
      }

      let anchorFilteredIndex = 0
      while (
        anchorFilteredIndex + 1 < filteredRows.length &&
        rowOffsets[anchorFilteredIndex + 1] <= nextScrollTop
      ) {
        anchorFilteredIndex += 1
      }

      const anchorRowTop = rowOffsets[anchorFilteredIndex] ?? 0
      const anchorRowHeight = rowHeights[anchorFilteredIndex] ?? 1
      const rowOffsetRatio = Math.max(
        0,
        Math.min(1, (nextScrollTop - anchorRowTop) / anchorRowHeight)
      )

      onLinkedScrollAnchorChange?.({
        rowIndex: filteredRows[anchorFilteredIndex]?.rowIndex ?? 0,
        sourceTableId: tableId,
        rowOffsetRatio,
      })
    }

    updateViewportMetrics()
    container.addEventListener("scroll", handleScroll, { passive: true })
    window.addEventListener("resize", updateViewportMetrics)

    let resizeObserver
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateViewportMetrics)
      resizeObserver.observe(container)
    }

    return () => {
      container.removeEventListener("scroll", handleScroll)
      window.removeEventListener("resize", updateViewportMetrics)
      resizeObserver?.disconnect()
    }
  }, [filteredRows, linkedScrollEnabled, onLinkedScrollAnchorChange, rowOffsets, tableId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    container.scrollTop = 0
    setScrollTop(0)
  }, [deferredSearchValue])

  useEffect(() => {
    if (!linkedScrollEnabled || !linkedScrollAnchor || linkedScrollAnchor.sourceTableId === tableId) {
      return
    }

    const container = containerRef.current
    if (!container || filteredRows.length === 0) {
      return
    }

    let targetFilteredIndex = filteredRows.findIndex((entry) => entry.rowIndex === linkedScrollAnchor.rowIndex)
    if (targetFilteredIndex < 0) {
      targetFilteredIndex = filteredRows.findIndex((entry) => entry.rowIndex > linkedScrollAnchor.rowIndex)
    }
    if (targetFilteredIndex < 0) {
      targetFilteredIndex = filteredRows.length - 1
    }

    const targetRowTop = rowOffsets[targetFilteredIndex] ?? 0
    const targetRowHeight = rowHeights[targetFilteredIndex] ?? 1
    const nextScrollTop = targetRowTop + ((linkedScrollAnchor.rowOffsetRatio ?? 0) * targetRowHeight)
    suppressLinkedScrollRef.current = true
    container.scrollTop = nextScrollTop
    setScrollTop(nextScrollTop)
    window.requestAnimationFrame(() => {
      suppressLinkedScrollRef.current = false
    })
  }, [filteredRows, linkedScrollAnchor, linkedScrollEnabled, rowHeights, rowOffsets, tableId])

  const minVisibleOffset = Math.max(0, scrollTop - overscan)
  const maxVisibleOffset = scrollTop + viewportHeight + overscan
  let visibleStartIndex = 0
  while (
    visibleStartIndex < filteredRows.length &&
    rowOffsets[visibleStartIndex] + rowHeights[visibleStartIndex] < minVisibleOffset
  ) {
    visibleStartIndex += 1
  }

  let visibleEndIndex = visibleStartIndex
  while (visibleEndIndex < filteredRows.length && rowOffsets[visibleEndIndex] <= maxVisibleOffset) {
    visibleEndIndex += 1
  }

  const visibleRowMap = new Map()
  const priorityCount = Math.min(priorityRenderCount, filteredRows.length)

  for (let index = 0; index < priorityCount; index += 1) {
    const entry = filteredRows[index]
    visibleRowMap.set(entry.rowIndex, { ...entry, filteredIndex: index })
  }

  for (let index = visibleStartIndex; index < visibleEndIndex; index += 1) {
    const entry = filteredRows[index]
    if (!entry) {
      continue
    }
    visibleRowMap.set(entry.rowIndex, { ...entry, filteredIndex: index })
  }

  const visibleRows = Array.from(visibleRowMap.values())
    .sort((a, b) => a.rowIndex - b.rowIndex)

  return (
    <div className='px-4 pb-4 pt-3'>
      <div className='mb-2 flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-[11px] text-default-500'>{description}</p>
          <p className='text-[10px] text-default-400'>`\n` and `\N` are shown as real line breaks in the text cell.</p>
        </div>
        {pendingLabel && (
          <span className='shrink-0 rounded-full bg-warning-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-warning-700'>
            {pendingLabel}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className='rounded-xl border border-dashed border-default-200 px-4 py-6 text-sm text-default-500'>
          No subtitles loaded in this panel yet.
        </p>
      ) : (
        <div className='overflow-hidden rounded-xl border border-default-200 bg-content1 shadow-inner'>
          <div className='border-b border-default-200 bg-default-100/80 px-3 py-2'>
            <div className='flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-default-500'>
              <span>Subtitle Rows</span>
              <span>{filteredRows.length}/{rows.length} entries</span>
            </div>
            <div className='mt-2'>
              <input
                className='h-9 w-full rounded-lg border border-default-200 bg-background px-3 text-sm outline-none'
                type="text"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search by number, start, end, or dialogue"
              />
            </div>
          </div>
          {filteredRows.length === 0 ? (
            <div className='px-3 py-8 text-center text-sm text-default-500'>
              No matches for that search.
            </div>
          ) : (
            <div ref={containerRef} className='h-[36rem] overflow-y-auto px-2 py-2'>
              <div className='relative' style={{ height: `${Math.max(totalHeight, 1)}px` }}>
                {visibleRows.map(({ row, rowIndex, filteredIndex }) => {
                  const rowTop = rowOffsets[filteredIndex]
                  const rowHeight = rowHeights[filteredIndex]

                  return (
                    <div
                      key={`${rowIndex}-${row.id}`}
                      className='absolute left-0 right-0'
                      style={{ top: `${rowTop}px`, height: `${rowHeight}px` }}
                    >
                      <div className='h-full rounded-2xl border border-default-200 bg-background/85 px-2.5 py-2 shadow-sm transition-colors hover:border-default-300'>
                        <div className='mb-2 flex flex-wrap items-center gap-2'>
                          <input
                            className='h-8 w-14 rounded-lg border border-default-200 bg-content1 px-2 font-mono text-xs outline-none'
                            type="text"
                            value={row.id}
                            onChange={(event) => onRowChange(rowIndex, "id", event.target.value)}
                            disabled={disabled}
                          />
                          <input
                            className='h-8 w-32 rounded-lg border border-default-200 bg-content1 px-2 font-mono text-xs outline-none'
                            type="text"
                            value={row.startTime}
                            onChange={(event) => onRowChange(rowIndex, "startTime", event.target.value)}
                            disabled={disabled}
                          />
                          <span className='text-xs text-default-400'>to</span>
                          <input
                            className='h-8 w-32 rounded-lg border border-default-200 bg-content1 px-2 font-mono text-xs outline-none'
                            type="text"
                            value={row.endTime}
                            onChange={(event) => onRowChange(rowIndex, "endTime", event.target.value)}
                            disabled={disabled}
                          />
                          <div className='ml-auto flex items-center gap-2 rounded-full bg-default-100 px-2 py-1'>
                            <span className='text-[10px] font-semibold uppercase tracking-[0.14em] text-default-500'>ENG</span>
                            <Switch
                              size='sm'
                              isSelected={Boolean(row.hasEngTag)}
                              onValueChange={(value) => onRowChange(rowIndex, "hasEngTag", value)}
                              isDisabled={disabled}
                            >
                            </Switch>
                          </div>
                        </div>
                        <textarea
                          className='h-[calc(100%-2.5rem)] min-h-[4rem] w-full resize-none rounded-xl border border-default-200 bg-content1 px-3 py-2 font-mono text-sm leading-5 outline-none'
                          rows={getSubtitleEditorRowLineCount(row)}
                          value={row.text}
                          onChange={(event) => onRowChange(rowIndex, "text", event.target.value)}
                          disabled={disabled}
                          spellCheck={false}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProgressiveList({
  items,
  renderItem,
  emptyMessage,
  initialCount = 24,
  batchSize = 24,
  className = "",
  resetKey,
}) {
  const sentinelRef = useRef(null)
  const [visibleCount, setVisibleCount] = useState(initialCount)

  useEffect(() => {
    setVisibleCount(initialCount)
  }, [initialCount, resetKey])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || visibleCount >= items.length) {
      return
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) {
        return
      }

      setVisibleCount((currentCount) => Math.min(items.length, currentCount + batchSize))
    }, {
      rootMargin: "200px",
    })

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [batchSize, items.length, visibleCount])

  if (items.length === 0) {
    return (
      <p className='rounded-2xl border border-dashed border-default-200 px-4 py-6 text-sm text-default-500'>
        {emptyMessage}
      </p>
    )
  }

  return (
    <div className={className}>
      {items.slice(0, visibleCount).map((item, index) => renderItem(item, index))}
      {visibleCount < items.length && (
        <div ref={sentinelRef} className='py-3 text-center text-xs text-default-400'>
          Loading more items...
        </div>
      )}
    </div>
  )
}

function createSubtitleJob(importedSubtitle) {
  const parsedSubtitles = subtitleParser.fromSrt(importedSubtitle.text ?? "")
  if (parsedSubtitles.length === 0) {
    throw new Error(`Failed to parse "${importedSubtitle.displayName ?? importedSubtitle.archivePath ?? "subtitle"}" as SRT.`)
  }

  const normalizedInputText = buildSrtFromParsedSubtitles(parsedSubtitles)
  const normalizedInputRows = buildSubtitleEditorRows(normalizedInputText)

  return {
    id: crypto.randomUUID(),
    name: importedSubtitle.displayName ?? getPathLeaf(importedSubtitle.archivePath, "subtitle.srt"),
    archivePath: importedSubtitle.archivePath ?? importedSubtitle.displayName ?? "subtitle.srt",
    sourceLabel: importedSubtitle.sourceLabel ?? "",
    inputText: normalizedInputText,
    inputAppliedRows: normalizedInputRows,
    inputEditorRows: normalizedInputRows,
    inputs: parsedSubtitles.map((subtitle) => subtitle.text),
    outputText: "",
    outputAppliedRows: [],
    outputEditorRows: [],
    outputs: [],
    status: "ready",
    errorMessage: "",
    completedLines: 0,
    totalLines: parsedSubtitles.length,
  }
}

function buildInitialSubtitleJob() {
  return createSubtitleJob({
    archivePath: "sample.srt",
    displayName: "sample.srt",
    sourceLabel: "Sample",
    text: sampleSrt,
  })
}

function getSubtitleJobStatusLabel(status) {
  switch (status) {
    case "running":
      return "Running"
    case "queued":
      return "Queued"
    case "completed":
      return "Done"
    case "failed":
      return "Failed"
    case "stopped":
      return "Stopped"
    default:
      return "Ready"
  }
}

function getSubtitleJobStatusClasses(status) {
  switch (status) {
    case "running":
      return "bg-primary-100 text-primary-700"
    case "queued":
      return "bg-secondary-100 text-secondary-700"
    case "completed":
      return "bg-success-100 text-success-700"
    case "failed":
      return "bg-danger-100 text-danger-700"
    case "stopped":
      return "bg-warning-100 text-warning-700"
    default:
      return "bg-default-100 text-default-600"
  }
}

function getSubtitleJobSourceCaption(job) {
  if (!job) {
    return ""
  }

  if (!job.sourceLabel) {
    return job.archivePath || job.name
  }

  return `${job.sourceLabel} / ${job.archivePath}`
}

function buildBatchExportFileName(language) {
  const normalizedLanguage = `${language ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (!normalizedLanguage) {
    return "translated_subtitles.zip"
  }

  return `translated_subtitles_${normalizedLanguage}.zip`
}

function normalizeRenamedSubtitleFileName(fileName) {
  const trimmedName = `${fileName ?? ""}`.trim()
  if (!trimmedName) {
    return ""
  }

  return /\.srt$/i.test(trimmedName) ? trimmedName : `${trimmedName}.srt`
}

export function TranslatorApplication() {
  const initialSubtitleJobRef = useRef(null)
  if (!initialSubtitleJobRef.current) {
    initialSubtitleJobRef.current = buildInitialSubtitleJob()
  }

  const initialSubtitleJob = initialSubtitleJobRef.current

  // Translator Configuration
  const [APIvalue, setAPIValue] = useState("")
  const [baseUrlValue, setBaseUrlValue] = useState(undefined)
  const [providerType, setProviderType] = useState(ProviderTypes.custom)
  const [fromLanguage, setFromLanguage] = useState("")
  const [toLanguage, setToLanguage] = useState("English")
  const [systemInstruction, setSystemInstruction] = useState("")
  const [model, setModel] = useState(DefaultModel)
  const [recentModelOptions, setRecentModelOptions] = useState([])
  const [temperature, setTemperature] = useState(DefaultTemperature)
  const [batchSizes, setBatchSizes] = useState([10, 50])
  const [useStructuredMode, setUseStructuredMode] = useState(false)
  const [rateLimit, setRateLimit] = useState(DefaultRateLimit)
  const [systemInstructionTitle, setSystemInstructionTitle] = useState("")
  const [systemInstructionDescription, setSystemInstructionDescription] = useState("")
  const [savedSystemInstructions, setSavedSystemInstructions] = useState([])
  const [showInstructionLibrary, setShowInstructionLibrary] = useState(false)
  const [focusInstructionTitle, setFocusInstructionTitle] = useState(false)

  const [isAPIInputVisible, setIsAPIInputVisible] = useState(false)
  const toggleAPIInputVisibility = () => setIsAPIInputVisible(!isAPIInputVisible)

  // Translator State
  const [subtitleJobs, setSubtitleJobs] = useState(() => [initialSubtitleJob])
  const [selectedJobId, setSelectedJobId] = useState(() => initialSubtitleJob.id)
  const [activeJobId, setActiveJobId] = useState(null)
  const [srtInputText, setSrtInputText] = useState(initialSubtitleJob.inputText)
  const [srtOutputText, setSrtOutputText] = useState("")
  const [inputAppliedRows, setInputAppliedRows] = useState(() => initialSubtitleJob.inputAppliedRows)
  const [inputEditorRows, setInputEditorRows] = useState(() => initialSubtitleJob.inputEditorRows)
  const [outputAppliedRows, setOutputAppliedRows] = useState([])
  const [outputEditorRows, setOutputEditorRows] = useState([])
  const [inputs, setInputs] = useState(initialSubtitleJob.inputs)
  const [outputs, setOutput] = useState([])
  const [streamOutput, setStreamOutput] = useState("")
  const [importedSubtitleFileName, setImportedSubtitleFileName] = useState(initialSubtitleJob.name)
  const [mergePrimarySet, setMergePrimarySet] = useState(null)
  const [mergeSecondarySet, setMergeSecondarySet] = useState(null)
  const [keepMergeLanguageTag, setKeepMergeLanguageTag] = useState(false)
  const [operationToast, setOperationToast] = useState(null)
  const [translatorRunningState, setTranslatorRunningState] = useState(false)
  const [showRenamePanel, setShowRenamePanel] = useState(false)
  const [renameSourceItems, setRenameSourceItems] = useState([])
  const [renameBaseName, setRenameBaseName] = useState("episode")
  const [renameSortMode, setRenameSortMode] = useState("detected")
  const [renameRows, setRenameRows] = useState([])
  /** @type {React.RefObject<Translator>} */
  const translatorRef = useRef(null)
  const translatorRunningRef = useRef(false)
  const translationCooldownRef = useRef(null)
  const translationCooldownKeyRef = useRef("")
  const completionAudioContextRef = useRef(null)

  // Translator Stats
  const [usageInformation, setUsageInformation] = useState(/** @type {typeof Translator.prototype.usage}*/(null))
  const [RPMInfomation, setRPMInformation] = useState(0)
  const [siteOrigin, setSiteOrigin] = useState("")
  const [hideOllamaPagesHint, setHideOllamaPagesHint] = useState(false)
  const [connectionTestMessage, setConnectionTestMessage] = useState("")
  const [connectionTestState, setConnectionTestState] = useState("idle")
  const [connectionTestDetails, setConnectionTestDetails] = useState("")
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [showTranslationProgressPanel, setShowTranslationProgressPanel] = useState(false)
  const [linkSubtitleScroll, setLinkSubtitleScroll] = useState(false)
  const [linkedSubtitleScrollAnchor, setLinkedSubtitleScrollAnchor] = useState(null)

  // Persistent Data Restoration
  useEffect(() => {
    setAPIValue(localStorage.getItem(OPENAI_API_KEY) ?? "")
    const restoredBaseUrl = localStorage.getItem(OPENAI_BASE_URL) ?? undefined
    setBaseUrlWithModerator(restoredBaseUrl)
    const restoredProviderType = localStorage.getItem(API_PROVIDER) ?? detectProviderType(restoredBaseUrl)
    const normalizedProviderType = Object.values(ProviderTypes).includes(restoredProviderType) ? restoredProviderType : ProviderTypes.custom
    setProviderType(normalizedProviderType)
    const storedRateLimit = localStorage.getItem(RATE_LIMIT)
    const parsedRateLimit = normalizeRateLimit(storedRateLimit, getProviderDefaults(normalizedProviderType).recommendedRateLimit ?? DefaultRateLimit)
    const restoredRateLimit = shouldApplyRecommendedRateLimit(normalizedProviderType, storedRateLimit)
      ? getProviderDefaults(normalizedProviderType).recommendedRateLimit
      : parsedRateLimit
    localStorage.setItem(RATE_LIMIT, String(restoredRateLimit))
    setRateLimit(restoredRateLimit)
    setToLanguage(localStorage.getItem(TO_LANGUAGE) ?? "English")
    setSystemInstruction(localStorage.getItem(SYSTEM_INSTRUCTION) ?? "")
    setKeepMergeLanguageTag(localStorage.getItem(KEEP_MERGE_LANGUAGE_TAG) === "true")
    setLinkSubtitleScroll(localStorage.getItem(LINK_SUBTITLE_SCROLL) === "true")
    let storedModelHistory = []
    try {
      storedModelHistory = JSON.parse(localStorage.getItem(MODEL_HISTORY) ?? "[]")
    } catch {
      storedModelHistory = []
    }
    const storedModel = localStorage.getItem(MODEL)
    const restoredModel = !storedModel || storedModel === PreviousDefaultModel ? DefaultModel : storedModel
    const normalizedHistory = normalizeRecentModelOptions(storedModelHistory, restoredModel)
    setRecentModelOptions(normalizedHistory)
    localStorage.setItem(MODEL_HISTORY, JSON.stringify(normalizedHistory))
    setModelValue(restoredModel)
    setSiteOrigin(window.location.origin)
    setHideOllamaPagesHint(localStorage.getItem(OLLAMA_GITHUB_PAGES_HINT_DISMISSED) === "true")
    try {
      setSavedSystemInstructions(JSON.parse(localStorage.getItem(SYSTEM_INSTRUCTION_PRESETS) ?? "[]"))
    } catch {
      setSavedSystemInstructions([])
    }
  }, [])

  useEffect(() => {
    if (!focusInstructionTitle) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const titleInput = document.getElementById("system-instruction-title")
      titleInput?.focus()
      titleInput?.select?.()
      setFocusInstructionTitle(false)
    })

    return () => window.cancelAnimationFrame(frame)
  }, [focusInstructionTitle, showInstructionLibrary])

  useEffect(() => {
    if (!operationToast) {
      return
    }

    const timeout = window.setTimeout(() => {
      setOperationToast(null)
    }, 5000)

    return () => window.clearTimeout(timeout)
  }, [operationToast])

  useEffect(() => {
    if (translatorRunningState) {
      return
    }

    setShowTranslationProgressPanel(false)
  }, [translatorRunningState])

  useEffect(() => {
    if (linkSubtitleScroll) {
      return
    }

    setLinkedSubtitleScrollAnchor(null)
  }, [linkSubtitleScroll])

  const isGitHubPages = siteOrigin.includes("github.io")
  const showOllamaPagesHint = isGitHubPages && !hideOllamaPagesHint
  const showOllamaCorsHint = showOllamaPagesHint && (baseUrlValue ?? "").includes("localhost:11434")

  function setAPIKey(value) {
    localStorage.setItem(OPENAI_API_KEY, value)
    setAPIValue(value)
  }

  function setProviderTypeValue(value, applyDefaults = true) {
    localStorage.setItem(API_PROVIDER, value)
    setProviderType(value)

    if (value === ProviderTypes.gemini && useStructuredMode) {
      setUseStructuredMode(false)
    }

    if (!applyDefaults) {
      return
    }

    const defaults = getProviderDefaults(value)
    if (defaults.baseUrl) {
      setBaseUrl(defaults.baseUrl)
    }
    else {
      setBaseUrl(undefined)
    }

    if (value === ProviderTypes.gemini) {
      setModelValue(DefaultGeminiModel)
      if (shouldApplyRecommendedRateLimit(value, rateLimit)) {
        setRateLimitValue(String(defaults.recommendedRateLimit))
      }
    }
    else if (value === ProviderTypes.ollama && (!model || model === DefaultGeminiModel)) {
      setModelValue(DefaultModel)
    }

    setConnectionTestMessage("")
    setConnectionTestState("idle")
    setConnectionTestDetails("")
  }

  function setBaseUrl(value) {
    if (!value) {
      value = undefined
      localStorage.removeItem(OPENAI_BASE_URL)
    }
    if (value) {
      localStorage.setItem(OPENAI_BASE_URL, value)
    }
    setBaseUrlWithModerator(value)
  }

  function setBaseUrlWithModerator(value) {
    if (!baseUrlValue && value) {
      if (useStructuredMode) {
        setUseStructuredMode(false)
      }
    }
    const detectedProviderType = detectProviderType(value)
    if (detectedProviderType !== providerType && (value || providerType !== ProviderTypes.custom)) {
      localStorage.setItem(API_PROVIDER, detectedProviderType)
      setProviderType(detectedProviderType)
    }
    setBaseUrlValue(value)
  }

  useEffect(() => {
    if (providerType === ProviderTypes.gemini && useStructuredMode) {
      setUseStructuredMode(false)
    }
  }, [providerType, useStructuredMode])

  function setToLanguageValue(value) {
    if (!value) {
      localStorage.removeItem(TO_LANGUAGE)
    }
    else {
      localStorage.setItem(TO_LANGUAGE, value)
    }
    setToLanguage(value)
  }

  function normalizeRecentModelOptions(modelOptions, currentModel = "") {
    const uniqueModels = []
    const currentValue = currentModel?.trim() ?? ""

    for (const modelOption of [currentValue, ...(Array.isArray(modelOptions) ? modelOptions : [])]) {
      const normalizedValue = typeof modelOption === "string" ? modelOption.trim() : ""
      if (!normalizedValue || DefaultModelOptions.includes(normalizedValue) || uniqueModels.includes(normalizedValue)) {
        continue
      }
      uniqueModels.push(normalizedValue)
      if (uniqueModels.length === 5) {
        break
      }
    }

    return uniqueModels
  }

  function persistRecentModelOptions(modelOptions) {
    const normalizedHistory = normalizeRecentModelOptions(modelOptions)
    localStorage.setItem(MODEL_HISTORY, JSON.stringify(normalizedHistory))
    setRecentModelOptions(normalizedHistory)
  }

  function rememberModelValue(modelValue) {
    const normalizedValue = modelValue?.trim()
    if (!normalizedValue || DefaultModelOptions.includes(normalizedValue)) {
      return
    }

    persistRecentModelOptions([normalizedValue, ...recentModelOptions])
  }

  function setSystemInstructionValue(value) {
    if (value === "") {
      localStorage.removeItem(SYSTEM_INSTRUCTION)
    }
    else {
      localStorage.setItem(SYSTEM_INSTRUCTION, value)
    }
    setSystemInstruction(value)
  }

  function setKeepMergeLanguageTagValue(value) {
    localStorage.setItem(KEEP_MERGE_LANGUAGE_TAG, String(value))
    setKeepMergeLanguageTag(value)
  }

  function setLinkSubtitleScrollValue(value) {
    localStorage.setItem(LINK_SUBTITLE_SCROLL, String(value))
    setLinkSubtitleScroll(value)
  }

  /**
   * @param {string} value
   */
  function setRateLimitValue(value) {
    const nextRateLimit = normalizeRateLimit(value, providerDefaults.recommendedRateLimit ?? DefaultRateLimit)
    localStorage.setItem(RATE_LIMIT, String(nextRateLimit))
    setRateLimit(nextRateLimit)
  }

  function getTranslatorCooldownContext() {
    const cooldownKey = `${providerType}|${effectiveBaseUrl}|${rateLimit}`

    if (!translationCooldownRef.current || translationCooldownKeyRef.current !== cooldownKey) {
      translationCooldownRef.current = new CooldownContext(rateLimit, 60000, providerType === ProviderTypes.gemini ? "GeminiAPI" : "ChatGPTAPI")
      translationCooldownKeyRef.current = cooldownKey
    }

    return translationCooldownRef.current
  }

  /**
   * @param {string | undefined} value
   */
  function setModelValue(value) {
    if (!value) {
      localStorage.removeItem(MODEL)
    }
    else {
      localStorage.setItem(MODEL, value)
    }
    setModel(value)
  }

  function persistSystemInstructionPresets(presets) {
    localStorage.setItem(SYSTEM_INSTRUCTION_PRESETS, JSON.stringify(presets))
    setSavedSystemInstructions(presets)
  }

  function clearSystemInstructionPresetForm() {
    setSystemInstructionTitle("")
    setSystemInstructionDescription("")
  }

  function showOperationToast(title, message) {
    setOperationToast({ title, message })
  }

  function dismissOperationToast() {
    setOperationToast(null)
  }

  function setConnectionTestResult(state, message, details = "") {
    setConnectionTestState(state)
    setConnectionTestMessage(message)
    setConnectionTestDetails(details)
  }

  function createMergeSetFromItems(items, sourceLabel, source = "manual") {
    const normalizedItems = Array.from(items ?? []).map((item, index) => ({
      ...analyzeSubtitleImport(item, index),
      text: item.text,
    }))

    return {
      source,
      sourceLabel,
      items: normalizedItems,
    }
  }

  function primeRenameWorkspace(sourceItems, keepPanelVisibility = true) {
    const suggestedBaseName = suggestRenameBaseName(sourceItems)
    const sortedItems = sortSubtitleImports(sourceItems, "detected")
    const totalItems = sortedItems.length

    setRenameSourceItems(sourceItems)
    setRenameBaseName(suggestedBaseName)
    setRenameSortMode("detected")
    setRenameRows(sortedItems.map((item, index) => ({
      id: crypto.randomUUID(),
      sourceItem: item,
      order: index + 1,
      newName: buildSuggestedRenameFileName(suggestedBaseName, index + 1, totalItems),
    })))

    if (!keepPanelVisibility) {
      setShowRenamePanel(false)
    }
  }

  function updateSubtitleJob(jobId, updater) {
    setSubtitleJobs((jobs) => jobs.map((job) => (
      job.id === jobId ? updater(job) : job
    )))
  }

  function syncEditorsWithSubtitleJob(job) {
    if (!job) {
      return
    }

    startTransition(() => {
      setSrtInputText(job.inputText)
      setInputAppliedRows(job.inputAppliedRows)
      setInputEditorRows(job.inputEditorRows)
      setInputs(job.inputs)
      setSrtOutputText(job.outputText)
      setOutputAppliedRows(job.outputAppliedRows)
      setOutputEditorRows(job.outputEditorRows)
      setOutput(job.outputs)
    })

    setImportedSubtitleFileName(job.name)
    setLinkedSubtitleScrollAnchor(null)
  }

  function selectSubtitleJob(jobId) {
    if (translatorRunningState) {
      return
    }

    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before switching files.")
      return
    }

    const nextJob = subtitleJobs.find((job) => job.id === jobId)
    if (!nextJob) {
      return
    }

    setSelectedJobId(jobId)
    syncEditorsWithSubtitleJob(nextJob)
  }

  async function loadMergeSubtitleFiles(files, slot) {
    if (!files?.length) {
      return
    }

    try {
      const extractedItems = await extractSubtitleImports(files)
      const sourceLabel = files.length === 1 ? files[0].name : `${files.length} selected files`
      const nextSet = createMergeSetFromItems(extractedItems, sourceLabel)

      if (slot === "primary") {
        setMergePrimarySet(nextSet)
      }
      else {
        setMergeSecondarySet(nextSet)
      }

      dismissOperationToast()
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  function rebuildRenameRows(sourceItems, sortMode = renameSortMode, baseName = renameBaseName) {
    const sortedItems = sortSubtitleImports(sourceItems, sortMode)
    const totalItems = sortedItems.length

    setRenameRows(sortedItems.map((item, index) => ({
      id: crypto.randomUUID(),
      sourceItem: item,
      order: index + 1,
      newName: buildSuggestedRenameFileName(baseName, index + 1, totalItems),
    })))
  }

  function applyRenameSortMode(nextSortMode) {
    setRenameSortMode(nextSortMode)
    rebuildRenameRows(renameSourceItems, nextSortMode, renameBaseName)
  }

  function autofillRenameNames() {
    const sortedRows = renameRows
      .slice()
      .sort((left, right) => Number(left.order) - Number(right.order) || left.sourceItem.leafName.localeCompare(right.sourceItem.leafName, undefined, { numeric: true, sensitivity: "base" }))

    const totalItems = sortedRows.length
    const nameById = new Map(sortedRows.map((row, index) => [
      row.id,
      buildSuggestedRenameFileName(renameBaseName, index + 1, totalItems),
    ]))

    setRenameRows((rows) => rows.map((row) => ({
      ...row,
      newName: nameById.get(row.id) ?? row.newName,
    })))
  }

  async function downloadRenamedFiles() {
    if (renameRows.length === 0) {
      alert("Load subtitle files before renaming.")
      return
    }

    const normalizedRows = renameRows.map((row) => ({
      ...row,
      newName: normalizeRenamedSubtitleFileName(row.newName),
      order: Number(row.order) || 0,
    }))

    if (normalizedRows.some((row) => !row.newName)) {
      alert("Every renamed file needs a new name.")
      return
    }

    if (new Set(normalizedRows.map((row) => row.newName.toLowerCase())).size !== normalizedRows.length) {
      alert("Renamed files must have unique names.")
      return
    }

    const orderedRows = normalizedRows
      .slice()
      .sort((left, right) => left.order - right.order || left.sourceItem.leafName.localeCompare(right.sourceItem.leafName, undefined, { numeric: true, sensitivity: "base" }))

    try {
      if (orderedRows.length === 1) {
        downloadString(orderedRows[0].sourceItem.text, "text/plain", orderedRows[0].newName)
        showOperationToast("Rename complete", `Downloaded ${orderedRows[0].newName}`)
        return
      }

      const zipFile = new JSZip()
      orderedRows.forEach((row) => {
        zipFile.file(row.newName, row.sourceItem.text)
      })
      const zipBlob = await zipFile.generateAsync({ type: "blob" })
      const zipFileName = `${renameBaseName || "renamed_subtitles"}_renamed.zip`
      downloadBlob(zipBlob, zipFileName)
      showOperationToast("Rename complete", `Downloaded ${orderedRows.length} renamed subtitle files as ${zipFileName}`)
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  function applySubtitleEdits() {
    const hasInputChanges = hasPendingInputEdits
    const hasOutputChanges = hasPendingOutputEdits

    if (!hasInputChanges && !hasOutputChanges) {
      return
    }

    try {
      let nextInputText = srtInputText
      let nextInputRows = inputAppliedRows
      let nextInputs = inputs
      let nextOutputText = srtOutputText
      let nextOutputRows = outputAppliedRows
      let nextOutputs = outputs

      if (hasInputChanges) {
        const inputDraftText = buildSrtFromSubtitleEditorRows(inputEditorRows)
        const parsedInput = inputDraftText.trim() ? subtitleParser.fromSrt(inputDraftText) : []
        if (inputEditorRows.length > 0 && parsedInput.length !== inputEditorRows.length) {
          throw new Error("Input subtitles are not valid SRT. Fix them before applying changes.")
        }
        nextInputText = buildSrtFromParsedSubtitles(parsedInput)
        nextInputRows = buildSubtitleEditorRows(nextInputText)
        nextInputs = parsedInput.map(item => item.text)

        startTransition(() => {
          setSrtInputText(nextInputText)
          setInputAppliedRows(nextInputRows)
          setInputEditorRows(nextInputRows)
          setInputs(nextInputs)
        })
      }

      if (hasOutputChanges) {
        const outputDraftText = buildSrtFromSubtitleEditorRows(outputEditorRows)
        const parsedOutput = outputDraftText.trim() ? subtitleParser.fromSrt(outputDraftText) : []
        if (outputEditorRows.length > 0 && parsedOutput.length !== outputEditorRows.length) {
          throw new Error("Output subtitles are not valid SRT. Fix them before applying changes.")
        }
        nextOutputText = buildSrtFromParsedSubtitles(parsedOutput)
        nextOutputRows = buildSubtitleEditorRows(nextOutputText)
        nextOutputs = parsedOutput.map(item => item.text)

        startTransition(() => {
          setSrtOutputText(nextOutputText)
          setOutputAppliedRows(nextOutputRows)
          setOutputEditorRows(nextOutputRows)
          setOutput(nextOutputs)
        })
      }

      updateSubtitleJob(selectedJobId, (job) => ({
        ...job,
        inputText: nextInputText,
        inputAppliedRows: nextInputRows,
        inputEditorRows: nextInputRows,
        inputs: nextInputs,
        totalLines: nextInputs.length,
        outputText: nextOutputText,
        outputAppliedRows: nextOutputRows,
        outputEditorRows: nextOutputRows,
        outputs: nextOutputs,
        completedLines: nextOutputs.length,
        status: nextOutputText.trim() ? job.status : "ready",
        errorMessage: "",
      }))
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  async function combineAndDownloadSubtitles() {
    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before combining.")
      return
    }

    if (!activeMergePrimarySet || !activeMergeSecondarySet) {
      alert("Choose both subtitle sets before combining.")
      return
    }

    const mergePlan = pairSubtitleImports(activeMergePrimarySet.items, activeMergeSecondarySet.items)
    if (!mergePlan.ok) {
      alert(`${mergePlan.errorTitle}: ${mergePlan.errorMessage}`)
      return
    }

    try {
      const mergedOutputs = []

      for (const pair of mergePlan.pairs) {
        const primary = parseSubtitleText(pair.primary.leafName, pair.primary.text)
        const secondary = parseSubtitleText(pair.secondary.leafName, pair.secondary.text)

        if (!primary.subtitles.length) {
          throw new Error(`Failed to parse the TOP subtitle "${pair.primary.leafName}".`)
        }

        if (!secondary.subtitles.length) {
          throw new Error(`Failed to parse the BOTTOM subtitle "${pair.secondary.leafName}".`)
        }

        const combinedSubtitles = combineSubtitles(primary.subtitles, secondary.subtitles, primary.format, "{\\rENG}", true)
        const combinedFileName = keepMergeLanguageTag
          ? buildCombinedSrtFileName(pair.primary.leafName, fromLanguage, toLanguage)
          : appendFileNameSuffix(buildCombinedSrtFileName(pair.primary.leafName, fromLanguage, toLanguage), "no_rENG")
        const combinedSrtText = keepMergeLanguageTag
          ? buildCombinedSrtText(combinedSubtitles)
          : removeREngTag(buildCombinedSrtText(combinedSubtitles))

        mergedOutputs.push({
          fileName: combinedFileName,
          text: combinedSrtText,
        })
      }

      if (mergedOutputs.length === 1) {
        downloadString(mergedOutputs[0].text, "text/plain", mergedOutputs[0].fileName)
        showOperationToast("Merge complete", `Downloaded ${mergedOutputs[0].fileName}`)
        return
      }

      const zipFile = new JSZip()
      mergedOutputs.forEach((output) => {
        zipFile.file(output.fileName, output.text)
      })
      const zipBlob = await zipFile.generateAsync({ type: "blob" })
      const zipFileName = keepMergeLanguageTag ? "merged_bilingual_batch.zip" : "merged_bilingual_batch_no_rENG.zip"
      downloadBlob(zipBlob, zipFileName)
      showOperationToast("Merge complete", `Downloaded ${mergedOutputs.length} merged subtitle files as ${zipFileName}`)
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  function saveSystemInstructionPreset() {
    if (!systemInstruction.trim()) {
      alert("Write the System Instruction first.")
      return
    }

    if (!showInstructionLibrary) {
      setShowInstructionLibrary(true)
      setSystemInstructionDescription(systemInstruction.trim())
      setFocusInstructionTitle(true)
      return
    }

    if (!systemInstructionTitle.trim()) {
      setFocusInstructionTitle(true)
      alert("Add an Instruction Title before saving.")
      return
    }

    const presetId = crypto.randomUUID()
    const nextPreset = {
      id: presetId,
      title: systemInstructionTitle.trim(),
      description: systemInstructionDescription.trim(),
      text: systemInstruction.trim()
    }

    persistSystemInstructionPresets([nextPreset, ...savedSystemInstructions])
    clearSystemInstructionPresetForm()
  }

  function saveSystemInstructionPresetFromTitleEnter(event) {
    if (event.key !== "Enter") {
      return
    }

    event.preventDefault()
    saveSystemInstructionPreset()
  }

  function applySystemInstructionPreset(preset) {
    setSystemInstructionValue(preset.text?.trim() || preset.description?.trim() || "")
  }

  function deleteSystemInstructionPreset(presetId) {
    const nextPresets = savedSystemInstructions.filter(preset => preset.id !== presetId)
    persistSystemInstructionPresets(nextPresets)
  }

  function closeOllamaPagesHint() {
    setHideOllamaPagesHint(true)
  }

  function dismissOllamaPagesHintForever() {
    localStorage.setItem(OLLAMA_GITHUB_PAGES_HINT_DISMISSED, "true")
    setHideOllamaPagesHint(true)
  }

  async function handleImportFiles(files) {
    if (translatorRunningState) {
      return
    }

    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before importing another batch.")
      return
    }

    try {
      const importedSubtitles = await extractSubtitleImports(files)
      const nextJobs = importedSubtitles.map((importedSubtitle) => createSubtitleJob(importedSubtitle))
      const firstJob = nextJobs[0]

      primeRenameWorkspace(importedSubtitles, false)
      setSubtitleJobs(nextJobs)
      setSelectedJobId(firstJob.id)
      setActiveJobId(null)
      setOutput([])
      setStreamOutput("")
      setUsageInformation(null)
      setRPMInformation(0)
      dismissOperationToast()
      syncEditorsWithSubtitleJob(firstJob)
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  async function exportTranslatedBatch() {
    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before exporting.")
      return
    }

    const translatedJobs = subtitleJobs.filter((job) => job.outputText.trim())
    if (translatedJobs.length === 0) {
      alert("Translate at least one subtitle file before exporting the batch.")
      return
    }

    try {
      const zipFile = new JSZip()
      translatedJobs.forEach((job) => {
        zipFile.file(buildTranslatedSrtArchivePath(job.archivePath || job.name, toLanguage), job.outputText)
      })
      const zipBlob = await zipFile.generateAsync({ type: "blob" })
      const zipFileName = buildBatchExportFileName(toLanguage)

      downloadBlob(zipBlob, zipFileName)
      showOperationToast("Batch export ready", `Downloaded ${translatedJobs.length} translated subtitle file(s) as ${zipFileName}`)
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  function announceTranslationBatchCompletion(completedJobs, failedJobs, totalJobs) {
    const title = failedJobs > 0 ? "Translation finished with warnings" : "Translation complete"
    const message = failedJobs > 0
      ? `Processed ${totalJobs} file(s): ${completedJobs} completed and ${failedJobs} failed.`
      : `Processed ${completedJobs} subtitle file(s) successfully.`

    showOperationToast(title, message)
    playCompletionSound(completionAudioContextRef.current)
    showCompletionNotification(title, message)
  }

  async function testProviderConnection() {
    const defaults = getProviderDefaults(providerType)
    const baseUrl = normalizeBaseUrl(baseUrlValue || defaults.baseUrl)
    const normalizedApiValue = APIvalue?.trim() ?? ""

    if (!baseUrl) {
      alert("Set a base URL before testing the connection.")
      return
    }

    if (!normalizedApiValue) {
      alert("Enter an API key before testing the connection.")
      return
    }

    rememberModelValue(model)
    setIsTestingConnection(true)
    setConnectionTestResult("testing", `Testing ${baseUrl} ...`, "")

    try {
      if (providerType === ProviderTypes.gemini) {
        const modelToTest = model?.trim() || DefaultGeminiModel
        const requestBody = {
          model: modelToTest,
          messages: [
            {
              role: "user",
              content: "Reply exactly with: Gemini API OK",
            },
          ],
          temperature: 0,
          max_tokens: 32,
          stream: false,
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${normalizedApiValue}`,
          },
          body: JSON.stringify(requestBody),
        })
        const responseText = await response.text()
        let data = null
        try {
          data = responseText ? JSON.parse(responseText) : null
        } catch {
          data = { raw: responseText }
        }

        if (!response.ok) {
          const requestError = new Error(data?.error?.message ?? data?.message ?? data?.raw ?? `HTTP ${response.status}`)
          requestError.details = JSON.stringify({
            request: requestBody,
            response: data,
            status: response.status,
          }, null, 2)
          throw requestError
        }

        const replyText = data?.choices?.[0]?.message?.content ?? ""
        setConnectionTestResult(
          "success",
          `Connected. ${modelToTest} replied successfully via the Gemini OpenAI-compatible API.`,
          JSON.stringify({
            request: requestBody,
            response: data,
            replyText,
          }, null, 2)
        )
        return
      }

      const isLocalOllamaConnection = baseUrl.includes("localhost:11434")
      const shouldSkipAuthorizationHeader = isLocalOllamaConnection && normalizedApiValue.toLowerCase() === "ollama"
      const response = await fetch(`${baseUrl}/models`, {
        headers: normalizedApiValue && !shouldSkipAuthorizationHeader ? { Authorization: `Bearer ${normalizedApiValue}` } : undefined,
      })
      const responseText = await response.text()
      let data = null
      try {
        data = responseText ? JSON.parse(responseText) : null
      } catch {
        data = { raw: responseText }
      }

      if (!response.ok) {
        const requestError = new Error(data?.error?.message ?? data?.message ?? data?.raw ?? `HTTP ${response.status}`)
        requestError.details = JSON.stringify({
          response: data,
          status: response.status,
        }, null, 2)
        throw requestError
      }

      const models = Array.isArray(data?.data) ? data.data : []
      const hasSelectedModel = models.some(item => item?.id === model)
      setConnectionTestResult(
        "success",
        hasSelectedModel
          ? `Connected. ${model} is available.`
          : `Connected, but ${model} is not exposed by this provider. The endpoint returned ${models.length} model(s).`,
        JSON.stringify(data, null, 2)
      )
    } catch (error) {
      const rawMessage = error?.message ?? String(error)
      const isLocalOllamaConnection = baseUrl.includes("localhost:11434")
      const likelyOllamaCorsFailure = isGitHubPages && isLocalOllamaConnection && rawMessage === "Failed to fetch"

      setConnectionTestResult(
        "error",
        likelyOllamaCorsFailure
          ? `Failed to fetch. Ollama is likely rejecting the browser origin. On this PC set OLLAMA_ORIGINS=${siteOrigin}, restart Ollama, then try again.`
          : rawMessage
        ,
        error?.details ?? rawMessage
      )
    } finally {
      setIsTestingConnection(false)
    }
  }

  async function translateSubtitleJob(jobSnapshot) {
    let currentStream = ""
    const outputWorkingProgress = subtitleParser.fromSrt(jobSnapshot.inputText)
    const currentOutputs = []
    const workingOutputRows = outputWorkingProgress.map((subtitle) => buildOutputEditorRow(subtitle))
    const jobInProgress = {
      ...jobSnapshot,
      outputText: "",
      outputAppliedRows: workingOutputRows.slice(),
      outputEditorRows: workingOutputRows.slice(),
      outputs: [],
      status: "running",
      errorMessage: "",
      completedLines: 0,
    }

    setSelectedJobId(jobSnapshot.id)
    setActiveJobId(jobSnapshot.id)
    syncEditorsWithSubtitleJob(jobInProgress)
    setUsageInformation(null)
    setRPMInformation(0)
    setStreamOutput("")
    updateSubtitleJob(jobSnapshot.id, () => jobInProgress)

    const isGeminiProvider = providerType === ProviderTypes.gemini
    const translatorUsesStructuredMode = !isGeminiProvider && useStructuredMode
    const openai = isGeminiProvider
      ? createGeminiBrowserClient(APIvalue, baseUrlValue ?? DefaultGeminiBaseUrl)
      : createOpenAIClient(APIvalue, true, baseUrlValue)
    const coolerChatGPTAPI = getTranslatorCooldownContext()
    const TranslatorImplementation = translatorUsesStructuredMode ? TranslatorStructuredArray : Translator

    translatorRef.current = new TranslatorImplementation({ from: fromLanguage, to: toLanguage }, {
      openai,
      cooler: coolerChatGPTAPI,
      onStreamChunk: (data) => {
        if (currentStream === '' && data === "\n") {
          return
        }
        currentStream += data
        setStreamOutput(currentStream)
      },
      onStreamEnd: () => {
        currentStream = ""
        if (translatorRef.current?.aborted) {
          return
        }
        setStreamOutput("")
      },
      onClearLine: () => {
        const progressLines = currentStream.split("\n")
        if (progressLines[0] === "") {
          progressLines.shift()
        }
        progressLines.pop()
        currentStream = progressLines.join("\n") + "\n"
        if (currentStream === "\n") {
          currentStream = ""
        }
        setStreamOutput(currentStream)
      }
    }, {
      useModerator: false,
      batchSizes: batchSizes,
      createChatCompletionRequest: {
        model: model,
        temperature: temperature,
        stream: true
      },
    })

    if (systemInstruction) {
      translatorRef.current.systemInstruction = systemInstruction
    }

    try {
      for await (const output of translatorRef.current.translateLines(jobSnapshot.inputs)) {
        if (!translatorRunningRef.current) {
          break
        }

        const srtEntry = outputWorkingProgress[output.index - 1]
        const cleanedTransform = sanitizeTranslatedSubtitleLine(output.finalTransform, srtEntry?.text ?? "")
        currentOutputs.push(cleanedTransform)
        srtEntry.text = cleanedTransform
        const nextOutputRow = buildOutputEditorRow(srtEntry, cleanedTransform)
        workingOutputRows[output.index - 1] = nextOutputRow

        setOutput([...currentOutputs])
        setOutputAppliedRows((rows) => {
          const nextRows = rows.slice()
          nextRows[output.index - 1] = nextOutputRow
          return nextRows
        })
        setOutputEditorRows((rows) => {
          const nextRows = rows.slice()
          nextRows[output.index - 1] = nextOutputRow
          return nextRows
        })
        setUsageInformation(translatorRef.current.usage)
        setRPMInformation(translatorRef.current.services.cooler?.rate)

        updateSubtitleJob(jobSnapshot.id, (job) => ({
          ...job,
          outputs: [...currentOutputs],
          outputAppliedRows: workingOutputRows.slice(),
          outputEditorRows: workingOutputRows.slice(),
          completedLines: currentOutputs.length,
          status: "running",
        }))
      }

      if (!translatorRunningRef.current) {
        updateSubtitleJob(jobSnapshot.id, (job) => ({
          ...job,
          status: "stopped",
          completedLines: currentOutputs.length,
        }))
        return "stopped"
      }

      const translatedSrt = buildSrtFromParsedSubtitles(outputWorkingProgress)
      const nextOutputRows = buildSubtitleEditorRows(translatedSrt)

      startTransition(() => {
        setSrtOutputText(translatedSrt)
        setOutputAppliedRows(nextOutputRows)
        setOutputEditorRows(nextOutputRows)
        setOutput([...currentOutputs])
      })

      updateSubtitleJob(jobSnapshot.id, (job) => ({
        ...job,
        outputText: translatedSrt,
        outputAppliedRows: nextOutputRows,
        outputEditorRows: nextOutputRows,
        outputs: [...currentOutputs],
        completedLines: currentOutputs.length,
        status: "completed",
        errorMessage: "",
      }))

      return "completed"
    } catch (error) {
      if (!translatorRunningRef.current || translatorRef.current?.aborted) {
        updateSubtitleJob(jobSnapshot.id, (job) => ({
          ...job,
          status: "stopped",
          completedLines: currentOutputs.length,
        }))
        return "stopped"
      }

      const errorMessage = formatProviderTranslationError(
        providerType,
        error?.message ?? String(error),
        providerDefaults.recommendedRateLimit ?? DefaultRateLimit
      )
      console.error(error)
      updateSubtitleJob(jobSnapshot.id, (job) => ({
        ...job,
        status: "failed",
        errorMessage,
        completedLines: currentOutputs.length,
      }))
      return "failed"
    } finally {
      translatorRef.current = null
      setStreamOutput("")
    }
  }

  async function generate(e) {
    e.preventDefault()
    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before starting the translation.")
      return
    }

    if (subtitleJobs.length === 0) {
      alert("Import at least one subtitle file before starting.")
      return
    }

    rememberModelValue(model)
    completionAudioContextRef.current = await primeCompletionAudio(completionAudioContextRef.current).catch(() => null)
    await ensureCompletionNotificationPermission().catch(() => "denied")

    const jobsToTranslate = subtitleJobs.map((job) => ({ ...job }))

    setTranslatorRunningState(true)
    setShowTranslationProgressPanel(true)
    translatorRunningRef.current = true
    setUsageInformation(null)
    setRPMInformation(0)
    dismissOperationToast()
    setSubtitleJobs((jobs) => jobs.map((job) => ({
      ...job,
      status: "queued",
      errorMessage: "",
      outputText: "",
      outputAppliedRows: [],
      outputEditorRows: [],
      outputs: [],
      completedLines: 0,
    })))

    let completedJobs = 0
    let failedJobs = 0
    let stopped = false

    try {
      for (const jobSnapshot of jobsToTranslate) {
        const result = await translateSubtitleJob(jobSnapshot)

        if (result === "stopped") {
          stopped = true
          break
        }

        if (result === "completed") {
          completedJobs += 1
        }
        else if (result === "failed") {
          failedJobs += 1
        }
      }
    } finally {
      translatorRunningRef.current = false
      translatorRef.current = null
      setActiveJobId(null)
      setTranslatorRunningState(false)
    }

    if (stopped) {
      setSubtitleJobs((jobs) => jobs.map((job) => (
        job.status === "queued" ? { ...job, status: "ready" } : job
      )))
      showOperationToast("Translation stopped", "Batch translation was stopped before finishing.")
      return
    }

    announceTranslationBatchCompletion(completedJobs, failedJobs, jobsToTranslate.length)
  }

  async function stopGeneration() {
    if (translatorRef.current) {
      translatorRunningRef.current = false
      translatorRef.current.abort()
    }
  }

  const currentJob = subtitleJobs.find((job) => job.id === selectedJobId) ?? subtitleJobs[0] ?? null
  const activeJob = subtitleJobs.find((job) => job.id === activeJobId) ?? null
  const providerDefaults = getProviderDefaults(providerType)
  const effectiveBaseUrl = baseUrlValue ?? providerDefaults.baseUrl ?? ""
  const providerDisplayName = providerType === ProviderTypes.gemini
    ? "Gemini"
    : providerType === ProviderTypes.ollama
      ? "Ollama"
      : "OpenAI-compatible"
  const connectionTestButtonLabel = providerType === ProviderTypes.gemini
    ? "Test Gemini API"
    : providerType === ProviderTypes.ollama
      ? "Test Ollama Connection"
      : "Test Connection"
  const defaultMergePrimarySet = currentJob ? createMergeSetFromItems([{
    archivePath: currentJob.name,
    displayName: currentJob.name,
    sourceLabel: "Current editor",
    text: currentJob.inputText,
  }], "Current selected subtitle", "current") : null
  const defaultMergeSecondarySet = currentJob?.outputText?.trim() ? createMergeSetFromItems([{
    archivePath: buildTranslatedSrtFileName(currentJob.name, toLanguage),
    displayName: buildTranslatedSrtFileName(currentJob.name, toLanguage),
    sourceLabel: "Current translation",
    text: currentJob.outputText,
  }], "Current translated subtitle", "generated") : null
  const activeMergePrimarySet = mergePrimarySet ?? defaultMergePrimarySet
  const activeMergeSecondarySet = mergeSecondarySet ?? defaultMergeSecondarySet
  const mergePairingPlan = activeMergePrimarySet && activeMergeSecondarySet
    ? pairSubtitleImports(activeMergePrimarySet.items, activeMergeSecondarySet.items)
    : null
  const translatedExportFileName = buildTranslatedSrtFileName(currentJob?.name || importedSubtitleFileName, toLanguage)
  const baseCombinedExportFileName = buildCombinedSrtFileName(activeMergePrimarySet?.items?.[0]?.leafName || currentJob?.name || importedSubtitleFileName, fromLanguage, toLanguage)
  const combinedExportFileName = keepMergeLanguageTag
    ? baseCombinedExportFileName
    : appendFileNameSuffix(baseCombinedExportFileName, "no_rENG")
  const mergePrimaryLabel = activeMergePrimarySet
    ? `${activeMergePrimarySet.items.length} file(s) - ${activeMergePrimarySet.sourceLabel}`
    : "Choose the top subtitle(s)"
  const mergeSecondaryLabel = activeMergeSecondarySet?.source === "generated" && activeMergeSecondarySet.items.length === 1
    ? translatedExportFileName
    : activeMergeSecondarySet
      ? `${activeMergeSecondarySet.items.length} file(s) - ${activeMergeSecondarySet.sourceLabel}`
      : "Choose the bottom subtitle(s)"
  const canMergeSubtitles = Boolean(mergePairingPlan?.ok)
  const modelOptions = [...DefaultModelOptions, ...recentModelOptions]
  const hasPendingInputEdits = serializeSubtitleEditorRows(inputEditorRows) !== serializeSubtitleEditorRows(inputAppliedRows)
  const hasPendingOutputEdits = serializeSubtitleEditorRows(outputEditorRows) !== serializeSubtitleEditorRows(outputAppliedRows)
  const hasPendingSubtitleEdits = hasPendingInputEdits || hasPendingOutputEdits
  const translationCompletedCount = activeJob?.completedLines ?? currentJob?.completedLines ?? outputs.length
  const translationTotalCount = activeJob?.totalLines ?? currentJob?.totalLines ?? inputs.length
  const totalJobsCount = subtitleJobs.length
  const completedJobsCount = subtitleJobs.filter((job) => job.status === "completed").length
  const failedJobsCount = subtitleJobs.filter((job) => job.status === "failed").length
  const translatedJobsCount = subtitleJobs.filter((job) => job.outputText.trim()).length
  const processedLineCount = subtitleJobs.reduce((sum, job) => sum + job.completedLines, 0)
  const totalLineCount = subtitleJobs.reduce((sum, job) => sum + job.totalLines, 0)
  const batchProgressPercent = totalJobsCount > 0 ? Math.min(100, (completedJobsCount / totalJobsCount) * 100) : 0
  const lineProgressPercent = totalLineCount > 0 ? Math.min(100, (processedLineCount / totalLineCount) * 100) : 0
  const activeJobIndex = activeJob ? subtitleJobs.findIndex((job) => job.id === activeJob.id) : -1
  const renameDuplicateNames = new Set(renameRows
    .map((row) => normalizeRenamedSubtitleFileName(row.newName).toLowerCase())
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) !== index))

  function handleLinkedSubtitleScrollAnchorChange(nextAnchor) {
    setLinkedSubtitleScrollAnchor((currentAnchor) => {
      const currentRowOffsetRatio = Math.round((currentAnchor?.rowOffsetRatio ?? 0) * 1000)
      const nextRowOffsetRatio = Math.round((nextAnchor?.rowOffsetRatio ?? 0) * 1000)

      if (
        currentAnchor?.rowIndex === nextAnchor?.rowIndex &&
        currentAnchor?.sourceTableId === nextAnchor?.sourceTableId &&
        currentRowOffsetRatio === nextRowOffsetRatio
      ) {
        return currentAnchor
      }
      return nextAnchor
    })
  }

  return (
    <>
      <div className='w-full'>
        <form id="translator-config-form" onSubmit={(e) => generate(e)}>
          <div className='px-4 pt-4 flex flex-wrap justify-between w-full gap-4'>
            <Card className="z-10 w-full shadow-md border" shadow="none">
              <CardHeader className="flex gap-3 pb-0">
                <div className="flex flex-col">
                  <p className="text-md">Configuration</p>
                </div>
              </CardHeader>
              <CardBody>
                <div className='flex flex-wrap justify-between w-full gap-4'>
                  {showOllamaPagesHint && (
                    <Card shadow="sm" className="w-full border border-warning-200 bg-warning-50">
                      <CardBody className="gap-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p><b>Using Ollama from GitHub Pages</b></p>
                            <p>
                              This GitHub Pages site runs in your browser, so Ollama must allow requests from
                              <code> {siteOrigin}</code> to reach <code>{DefaultOllamaBaseUrl}</code>.
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="light" onClick={closeOllamaPagesHint}>
                              Close
                            </Button>
                            <Button size="sm" color="warning" variant="flat" onClick={dismissOllamaPagesHintForever}>
                              Don't show again
                            </Button>
                          </div>
                        </div>

                        <div className="grid gap-1">
                          <p><b>Use these values in this page</b></p>
                          <p>API Key: <code>ollama</code></p>
                          <p>Base URL: <code>{DefaultOllamaBaseUrl}</code></p>
                          <p>Model: <code>{DefaultModel}</code></p>
                          <p>Structured Mode: <code>off</code></p>
                        </div>

                        <div className="grid gap-1">
                          <p><b>First-time setup on a new Windows PC</b></p>
                          <p>1. Install Ollama with PowerShell: <code>irm https://ollama.com/install.ps1 | iex</code></p>
                          <p>2. Or install Ollama from cmd: <code>curl.exe -L https://registry.ollama.com/download/OllamaSetup.exe -o %TEMP%\OllamaSetup.exe && start /wait "" %TEMP%\OllamaSetup.exe</code></p>
                          <p>3. Verify the install: <code>ollama --version</code></p>
                          <p>4. Download the model: <code>ollama pull {DefaultModel}</code></p>
                          <p>5. Optional quick test: <code>ollama run {DefaultModel} "Translate this to Spanish: Hello world"</code></p>
                          <p>6. If Ollama is not running, start it in PowerShell: <code>Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"</code></p>
                          <p>7. Or start it from cmd: <code>start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"</code></p>
                          <p>8. Before changing environment variables, close Ollama in PowerShell: <code>Stop-Process -Name "ollama","ollama app" -Force -ErrorAction SilentlyContinue</code></p>
                          <p>9. Or close it from cmd: <code>taskkill /IM "ollama.exe" /F &amp; taskkill /IM "ollama app.exe" /F</code></p>
                          <p>10. Set the environment variable in PowerShell: <code>setx OLLAMA_ORIGINS "{siteOrigin}"</code></p>
                          <p>11. Or set it from cmd: <code>setx OLLAMA_ORIGINS "{siteOrigin}"</code></p>
                          <p>12. After <code>setx</code>, close that console and open a new one before running <code>ollama serve</code>. If you use the Ollama app, close it completely and open it again.</p>
                          <p>13. Start Ollama again in PowerShell: <code>Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"</code></p>
                          <p>14. Or start it from cmd: <code>start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"</code></p>
                          <p>15. Back on this page, enter the values shown above and click <code>Test Ollama Connection</code>.</p>
                          <p>16. When the test passes, click <code>Import SRT</code>, then <code>Start</code>, and finally <code>Export SRT</code>.</p>
                        </div>

                        <div className="grid gap-1">
                          <p><b>Official references</b></p>
                          <p><a className="text-primary underline" href="https://docs.ollama.com/windows" target="_blank" rel="noopener noreferrer">Ollama for Windows</a></p>
                          <p><a className="text-primary underline" href="https://docs.ollama.com/api/openai-compatibility" target="_blank" rel="noopener noreferrer">OpenAI compatibility</a></p>
                          <p><a className="text-primary underline" href="https://docs.ollama.com/faq" target="_blank" rel="noopener noreferrer">OLLAMA_ORIGINS / FAQ</a></p>
                          <p><a className="text-primary underline" href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">Ollama model library</a></p>
                        </div>
                      </CardBody>
                    </Card>
                  )}
                  <div className='flex flex-wrap items-end gap-2 w-full'>
                    <Button
                      type='button'
                      size='sm'
                      color={providerType === ProviderTypes.ollama ? "secondary" : "default"}
                      variant={providerType === ProviderTypes.ollama ? "solid" : "flat"}
                      onClick={() => setProviderTypeValue(ProviderTypes.ollama)}
                    >
                      Ollama
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      color={providerType === ProviderTypes.gemini ? "secondary" : "default"}
                      variant={providerType === ProviderTypes.gemini ? "solid" : "flat"}
                      onClick={() => setProviderTypeValue(ProviderTypes.gemini)}
                    >
                      Gemini
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      color={providerType === ProviderTypes.custom ? "secondary" : "default"}
                      variant={providerType === ProviderTypes.custom ? "solid" : "flat"}
                      onClick={() => setProviderTypeValue(ProviderTypes.custom)}
                    >
                      Custom
                    </Button>
                    <p className='text-xs text-default-500'>
                      Provider preset: <span className='font-semibold text-foreground'>{providerDisplayName}</span>
                    </p>
                  </div>

                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <Input
                      className="w-full md:w-6/12"
                      size='sm'
                      value={APIvalue}
                      onValueChange={(value) => setAPIKey(value)}
                      isRequired
                      autoComplete='off'
                      label={providerType === ProviderTypes.gemini ? "Gemini API Key" : "API Key"}
                      variant="flat"
                      description={`${providerDefaults.apiKeyHint} Stored locally in browser.`}
                      endContent={
                        <button className="focus:outline-none" type="button" onClick={toggleAPIInputVisibility}>
                          {isAPIInputVisible ? (
                            <EyeSlashFilledIcon className="text-2xl text-default-400 pointer-events-none" />
                          ) : (
                            <EyeFilledIcon className="text-2xl text-default-400 pointer-events-none" />
                          )}
                        </button>
                      }
                      type={isAPIInputVisible ? "text" : "password"}
                    />
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="Provider Base URL"
                      placeholder={providerDefaults.baseUrl || DefaultOllamaBaseUrl}
                      autoComplete='on'
                      value={effectiveBaseUrl}
                      onValueChange={setBaseUrl}
                      description={providerType === ProviderTypes.gemini
                        ? `Official Gemini OpenAI-compatible endpoint: ${DefaultGeminiBaseUrl}`
                        : providerType === ProviderTypes.ollama
                          ? `For local Ollama: ${DefaultOllamaBaseUrl}`
                          : "Enter any OpenAI-compatible base URL."}
                    />
                  </div>

                  {providerType === ProviderTypes.gemini && (
                    <Card shadow="sm" className="w-full border border-secondary-200 bg-secondary-50">
                      <CardBody className="gap-2 text-sm">
                        <p><b>Gemini quick setup</b></p>
                        <p>API Key: use a Gemini API key from Google AI Studio.</p>
                        <p>Base URL: <code>{DefaultGeminiBaseUrl}</code></p>
                        <p>Suggested model: <code>{DefaultGeminiModel}</code></p>
                        <p>Recommended starting rate limit: <code>{providerDefaults.recommendedRateLimit} RPM</code>.</p>
                        <p>The test button uses Gemini's OpenAI-compatible endpoint, so it checks the same compatibility layer the translator uses.</p>
                        <p>Batch translation uses a browser `fetch` compatibility client for Gemini so the real subtitle queue follows the same provider path more reliably than the generic SDK route.</p>
                        <p>Gemini quotas are applied per project, so stopping and immediately retrying can still hit the same minute window.</p>
                        <p className='text-warning-700'>This app runs in your browser. The key is remembered locally here, but browser-based apps are still a client-side environment, so use a key with the minimum scope you are comfortable exposing to this machine.</p>
                      </CardBody>
                    </Card>
                  )}

                  {showOllamaCorsHint && (
                    <p className="w-full text-xs text-warning-700">
                      If requests fail in GitHub Pages, restart Ollama after setting <code>OLLAMA_ORIGINS={siteOrigin}</code> in Windows environment variables.
                    </p>
                  )}

                  <div className='flex flex-wrap items-center gap-3 w-full'>
                    <Button
                      type='button'
                      color="secondary"
                      variant="flat"
                      onClick={testProviderConnection}
                      isLoading={isTestingConnection}
                    >
                      {connectionTestButtonLabel}
                    </Button>
                    {connectionTestMessage && (
                      <p className={`text-sm ${connectionTestState === "error" ? "text-danger" : connectionTestState === "success" ? "text-success" : "text-default-500"}`}>
                        {connectionTestMessage}
                      </p>
                    )}
                  </div>

                  {connectionTestDetails && (
                    <div className='w-full rounded-2xl border border-default-200 bg-default-50 px-4 py-3'>
                      <p className='text-xs font-semibold uppercase tracking-[0.14em] text-default-500'>Connection Details</p>
                      <pre className='mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-default-700'>
                        {connectionTestDetails}
                      </pre>
                    </div>
                  )}

                  <div className='flex w-full gap-4'>
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="From Language"
                      placeholder="Auto"
                      autoComplete='on'
                      value={fromLanguage}
                      onValueChange={setFromLanguage}
                    />
                    <Input
                      className='w-full md:w-6/12'
                      size='sm'
                      type="text"
                      label="To Language"
                      autoComplete='on'
                      value={toLanguage}
                      onValueChange={setToLanguageValue}
                    />
                  </div>

                  <div className='w-full'>
                    <Textarea
                      label="System Instruction"
                      minRows={2}
                      description={"Override preset system instruction. Save stores this exact text."}
                      placeholder={`Translate ${fromLanguage ? fromLanguage + " " : ""}to ${toLanguage}`}
                      value={systemInstruction}
                      onValueChange={setSystemInstructionValue}
                    />
                  </div>

                  <div className='flex flex-wrap items-center gap-2 w-full'>
                    <Button
                      type='button'
                      color="primary"
                      variant="flat"
                      onClick={saveSystemInstructionPreset}
                    >
                      Save Current Instruction
                    </Button>
                    <Button
                      type='button'
                      variant="light"
                      onClick={() => setShowInstructionLibrary(value => !value)}
                    >
                      {showInstructionLibrary ? "Hide Saved Instructions" : "Show Saved Instructions"}
                    </Button>
                  </div>

                  {showInstructionLibrary && (
                    <>
                      <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                        <Input
                          id="system-instruction-title"
                          className='w-full md:w-5/12'
                          size='sm'
                          type="text"
                          label="Instruction Title"
                          placeholder="Anime JP -> ES"
                          value={systemInstructionTitle}
                          onValueChange={setSystemInstructionTitle}
                          onKeyDown={saveSystemInstructionPresetFromTitleEnter}
                          description="Required to save"
                        />
                        <Input
                          className='w-full md:w-5/12'
                          size='sm'
                          type="text"
                          label="Instruction Description"
                          placeholder="Optional note shown in the saved list"
                          value={systemInstructionDescription}
                          onValueChange={setSystemInstructionDescription}
                          description="Metadata only. Use applies the saved System Instruction text."
                        />
                        <div className='w-full md:w-2/12 flex items-end'>
                          <Button
                            className='w-full'
                            type='button'
                            variant="light"
                            onClick={clearSystemInstructionPresetForm}
                          >
                            Clear Meta
                          </Button>
                        </div>
                      </div>

                      {savedSystemInstructions.length > 0 && (
                        <div className='w-full'>
                          <p className='text-sm font-semibold mb-2'>Saved System Instructions</p>
                          <div className='grid gap-3'>
                            {savedSystemInstructions.map((preset) => (
                              <Card key={preset.id} shadow="sm" className='border'>
                                <CardBody className="flex flex-wrap md:flex-nowrap items-start justify-between gap-3">
                                  <div className='flex-1'>
                                    <p className='font-semibold'>{preset.title}</p>
                                    {preset.description && (
                                      <p className='text-sm text-default-500'>{preset.description}</p>
                                    )}
                                  </div>
                                  <div className='flex gap-2'>
                                    <Button type='button' size='sm' color="primary" variant="flat" onClick={() => applySystemInstructionPreset(preset)}>
                                      Use
                                    </Button>
                                    <Button type='button' size='sm' color="danger" variant="light" onClick={() => deleteSystemInstructionPreset(preset.id)}>
                                      Delete
                                    </Button>
                                  </div>
                                </CardBody>
                              </Card>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <div className='w-full md:w-1/5'>
                      <Autocomplete
                        size='sm'
                        label="Model"
                        placeholder={DefaultModel}
                        inputValue={model}
                        selectedKey={modelOptions.includes(model) ? model : null}
                        onInputChange={setModelValue}
                        onSelectionChange={(value) => {
                          if (typeof value === "string") {
                            setModelValue(value)
                            rememberModelValue(value)
                          }
                        }}
                        menuTrigger="focus"
                        allowsCustomValue
                      >
                        {modelOptions.map((modelOption) => (
                          <AutocompleteItem key={modelOption}>
                            {modelOption}
                          </AutocompleteItem>
                        ))}
                      </Autocomplete>
                    </div>

                    <div className='w-full md:w-1/5 flex'>
                      <Switch
                        size='sm'
                        isSelected={useStructuredMode}
                        onValueChange={setUseStructuredMode}
                        isDisabled={providerType === ProviderTypes.gemini}
                      >
                      </Switch>
                      <div className="flex flex-col place-content-center gap-1">
                        <p className="text-small">Use Structured Mode</p>
                        {providerType === ProviderTypes.gemini ? (
                          <p className="text-tiny text-default-400">
                            Gemini keeps this off automatically because the subtitle queue runs through the OpenAI-compatible fetch path.
                          </p>
                        ) : baseUrlValue && (
                          <p className="text-tiny text-default-400">
                            Base URL is set, disable structured mode for compatibility.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className='w-full md:w-1/5'>
                      <Slider
                        label="Temperature"
                        size="md"
                        hideThumb={true}
                        step={0.05}
                        maxValue={2}
                        minValue={0}
                        value={temperature}
                        onChange={(e) => setTemperature(Number(e))}
                      />
                    </div>

                    <div className='w-full md:w-1/5'>
                      <Slider
                        label="Batch Sizes"
                        size="md"
                        step={10}
                        maxValue={200}
                        minValue={10}
                        value={batchSizes}
                        onChange={(e) => typeof e === "number" ? setBatchSizes([e]) : setBatchSizes(e)}
                      />
                    </div>

                    <div className='w-full md:w-1/5'>
                      <Input
                        size='sm'
                        type="number"
                        min="1"
                        label="Rate Limit"
                        value={rateLimit.toString()}
                        onValueChange={(value) => setRateLimitValue(value)}
                        autoComplete='on'
                        description={providerType === ProviderTypes.gemini
                          ? `Start around ${providerDefaults.recommendedRateLimit} RPM for Gemini. Canceling and retrying still counts against the same project quota window.`
                          : "Maximum requests per minute for the local cooldown."}
                        endContent={
                          <div className="pointer-events-none flex items-center">
                            <span className="text-default-400 text-small">RPM</span>
                          </div>
                        }
                      />
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </div>
        </form>

        <div className='w-full justify-between md:justify-center flex flex-wrap gap-1 sm:gap-4 mt-auto sticky top-0 backdrop-blur px-4 pt-4'>
          <FileUploadButton
            label={"Import SRT / ZIP"}
            accept=".srt,.zip"
            inputId="import-srt-input"
            multiple
            onFilesSelect={handleImportFiles}
            buttonProps={{ isDisabled: translatorRunningState }}
          />
          {renameRows.length > 0 && (
            <Button variant="light" onClick={() => setShowRenamePanel((value) => !value)}>
              {showRenamePanel ? "Hide Rename Panel" : "Show Rename Panel"}
            </Button>
          )}
          {!translatorRunningState && (
            <Button type='submit' form="translator-config-form" color="primary" isDisabled={!APIvalue || translatorRunningState || totalJobsCount === 0}>
              Start
            </Button>
          )}

          {translatorRunningState && (
            <Button color="danger" onClick={() => stopGeneration()} isLoading={!streamOutput}>
              Stop
            </Button>
          )}

          <Button color="primary" isDisabled={!srtOutputText.trim()} onClick={() => {
            if (hasPendingSubtitleEdits) {
              alert("Apply subtitle changes before exporting.")
              return
            }
            downloadString(srtOutputText, "text/plain", translatedExportFileName)
          }}>
            Export SRT
          </Button>
          {totalJobsCount > 1 && (
            <Button color="primary" variant="flat" isDisabled={translatedJobsCount === 0} onClick={exportTranslatedBatch}>
              Export Batch ZIP
            </Button>
          )}
          {usageInformation && (
            <Popover placement="bottom">
              <PopoverTrigger>
                <Button color="default" variant="flat">
                  Usage
                </Button>
              </PopoverTrigger>
              <PopoverContent>
                <div className='w-80 p-4'>
                  <div className='flex flex-col gap-2 text-sm'>
                    <p className='font-semibold text-foreground'>Estimated Usage</p>
                    <p className='text-default-600'>
                      Tokens: {usageInformation?.promptTokensUsed} + {usageInformation?.completionTokensUsed} = {usageInformation?.usedTokens}
                    </p>
                    {usageInformation?.wastedTokens > 0 && (
                      <p className='text-danger'>
                        Wasted: {usageInformation?.promptTokensWasted} + {usageInformation?.completionTokensWasted} = {usageInformation?.wastedTokens} {usageInformation?.wastedPercent}
                      </p>
                    )}
                    {usageInformation?.cachedTokens > 0 && (
                      <p className='text-success'>Cached: {usageInformation?.cachedTokens}</p>
                    )}
                    {usageInformation?.contextTokens > 0 && (
                      <p className='text-default-600'>
                        Context: {usageInformation?.contextPromptTokens} + {usageInformation?.contextCompletionTokens} = {usageInformation?.contextTokens}
                      </p>
                    )}
                    <p className='text-default-600'>
                      {usageInformation?.promptRate} + {usageInformation?.completionRate} = {usageInformation?.rate} TPM {RPMInfomation} RPM
                    </p>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <div className='flex flex-col items-start'>
            <div className='flex items-stretch overflow-hidden rounded-2xl shadow-sm ring-1 ring-secondary/20'>
              <Button
                color="secondary"
                className='rounded-r-none rounded-l-2xl px-5 font-semibold'
                onClick={combineAndDownloadSubtitles}
                isDisabled={!canMergeSubtitles}
              >
                Merge Bilingual
              </Button>
              <Popover placement="bottom-end">
                <PopoverTrigger>
                  <Button
                    color="secondary"
                    className='rounded-l-none rounded-r-2xl min-w-11 w-11 border-l border-white/20 bg-secondary-600'
                    isIconOnly
                    aria-label="Open bilingual merge options"
                  >
                    <ChevronDownIcon />
                  </Button>
                </PopoverTrigger>
                <PopoverContent>
                  <div className='w-80 p-3 flex flex-col gap-3'>
                    <div>
                      <p className='text-sm font-semibold'>Merge top and bottom subtitles</p>
                      <p className='text-xs text-default-500'>
                        The currently selected subtitle file is used as the top subtitle and its latest translated SRT is used as the bottom subtitle by default.
                        You can replace either side with one file, several `.srt`, or a `.zip` with `.srt` files.
                      </p>
                    </div>

                    <div className='grid gap-2'>
                      <div>
                        <p className='text-xs font-semibold text-default-600 mb-1'>Top subtitle</p>
                        <FileUploadButton
                          label="Choose Top Subtitle(s)"
                          accept=".srt,.zip"
                          inputId="merge-top-subtitle-input"
                          buttonProps={{ color: "secondary", variant: "flat", className: "w-full" }}
                          multiple
                          onFilesSelect={(files) => loadMergeSubtitleFiles(files, "primary")}
                        />
                        <div className='mt-1 flex items-center justify-between gap-2'>
                          <p className='text-xs text-default-500 break-all'>{mergePrimaryLabel}</p>
                          {mergePrimarySet && (
                            <Button size='sm' variant='light' onClick={() => setMergePrimarySet(null)}>
                              Use current
                            </Button>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className='text-xs font-semibold text-default-600 mb-1'>Bottom subtitle</p>
                        <FileUploadButton
                          label="Choose Bottom Subtitle(s)"
                          accept=".srt,.zip"
                          inputId="merge-bottom-subtitle-input"
                          buttonProps={{ color: "secondary", variant: "flat", className: "w-full" }}
                          multiple
                          onFilesSelect={(files) => loadMergeSubtitleFiles(files, "secondary")}
                        />
                        <div className='mt-1 flex items-center justify-between gap-2'>
                          <p className='text-xs text-default-500 break-all'>{mergeSecondaryLabel}</p>
                          {mergeSecondarySet && (
                            <Button size='sm' variant='light' onClick={() => setMergeSecondarySet(null)}>
                              Use current
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className='rounded-xl border border-default-200 bg-default-50 px-3 py-3'>
                      <p className='text-xs font-semibold uppercase tracking-[0.14em] text-default-500'>Pairing preview</p>
                      {!activeMergePrimarySet || !activeMergeSecondarySet ? (
                        <p className='mt-2 text-xs text-default-500'>
                          Load both sides to preview the chapter pairing. If you leave the current selection active, the merge stays as a single-file merge.
                        </p>
                      ) : !mergePairingPlan?.ok ? (
                        <>
                          <p className='mt-2 text-sm font-semibold text-danger-600'>{mergePairingPlan?.errorTitle ?? "Unable to pair subtitles"}</p>
                          <p className='mt-1 text-xs text-danger-600'>{mergePairingPlan?.errorMessage}</p>
                        </>
                      ) : (
                        <>
                          <p className='mt-2 text-xs text-default-500'>
                            Matched by <span className='font-semibold text-foreground'>{mergePairingPlan.strategy}</span>. Review the pairs below before downloading.
                          </p>
                          <div className='mt-3 max-h-64 overflow-y-auto pr-1'>
                            <ProgressiveList
                              items={mergePairingPlan.pairs}
                              initialCount={20}
                              batchSize={20}
                              resetKey={mergePairingPlan.pairs.map((pair) => `${pair.primary.archivePath}:${pair.secondary.archivePath}`).join("|")}
                              emptyMessage="No merge pairs ready yet."
                              className='grid gap-2'
                              renderItem={(pair, pairIndex) => (
                                <div key={`${pair.primary.archivePath}-${pair.secondary.archivePath}`} className='rounded-xl border border-default-200 bg-content1 px-3 py-3'>
                                  <p className='text-xs font-semibold text-default-500'>Pair {pairIndex + 1}</p>
                                  <p className='mt-1 break-all text-sm text-foreground'>{pair.primary.leafName}</p>
                                  <p className='text-xs text-default-400'>matches with</p>
                                  <p className='break-all text-sm text-foreground'>{pair.secondary.leafName}</p>
                                </div>
                              )}
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <div className='flex gap-3 rounded-xl bg-default-50 px-3 py-3'>
                      <Switch
                        size='sm'
                        isSelected={keepMergeLanguageTag}
                        onValueChange={setKeepMergeLanguageTagValue}
                      >
                      </Switch>
                      <div className='flex flex-col gap-1'>
                        <p className='text-sm font-semibold'>Keep {"{\\rENG}"} tag</p>
                        <p className='text-xs text-default-500'>
                          Turn this off to remove the exact raw string {"{\\rENG}"} from the exported combined SRT, matching your Python cleanup script.
                        </p>
                      </div>
                    </div>

                    <div className='text-xs text-default-500'>
                      Output: <code>{mergePairingPlan?.pairs?.length > 1 ? (keepMergeLanguageTag ? "merged_bilingual_batch.zip" : "merged_bilingual_batch_no_rENG.zip") : combinedExportFileName}</code>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <p className='mt-1 px-1 text-[11px] font-medium text-default-500'>
              {keepMergeLanguageTag ? 'Current: with {\\rENG}' : 'Current: without {\\rENG}'}
            </p>
          </div>
          <Divider className='mt-3 sm:mt-0' />
        </div>

        <div className='px-4 mt-4'>
          <Card shadow="none" className='border'>
            <CardBody className='gap-4'>
              <div className='flex flex-wrap items-start justify-between gap-4'>
                <div className='min-w-0 flex-1'>
                  <p className='text-base font-semibold'>Subtitle Queue</p>
                  <p className='text-sm text-default-500'>
                    {totalJobsCount} file(s) loaded. The app translates them internally one by one and keeps each result available for review and export.
                  </p>
                </div>

                <div className='grid min-w-[18rem] gap-3 rounded-2xl border border-default-200 bg-default-50 px-4 py-3'>
                  <div>
                    <div className='flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-default-500'>
                      <span>Files</span>
                      <span>{completedJobsCount}/{totalJobsCount}</span>
                    </div>
                    <div className='mt-2 h-2 rounded-full bg-default-200'>
                      <div className='h-2 rounded-full bg-primary transition-all' style={{ width: `${batchProgressPercent}%` }}></div>
                    </div>
                  </div>

                  <div>
                    <div className='flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-default-500'>
                      <span>Lines</span>
                      <span>{processedLineCount}/{totalLineCount}</span>
                    </div>
                    <div className='mt-2 h-2 rounded-full bg-default-200'>
                      <div className='h-2 rounded-full bg-secondary transition-all' style={{ width: `${lineProgressPercent}%` }}></div>
                    </div>
                  </div>

                  {failedJobsCount > 0 && (
                    <p className='text-xs text-danger-600'>{failedJobsCount} file(s) finished with errors.</p>
                  )}
                </div>
              </div>

              <ProgressiveList
                items={subtitleJobs}
                initialCount={24}
                batchSize={24}
                resetKey={subtitleJobs.map((job) => job.id).join("|")}
                emptyMessage="No subtitle files loaded yet."
                className='grid gap-3 lg:grid-cols-2'
                renderItem={(job, index) => {
                  const isSelected = job.id === selectedJobId
                  const isActive = job.id === activeJobId
                  const jobPercent = job.totalLines > 0 ? Math.min(100, (job.completedLines / job.totalLines) * 100) : 0

                  return (
                    <button
                      key={job.id}
                      type='button'
                      className={`rounded-2xl border px-4 py-4 text-left transition ${isSelected ? "border-primary bg-primary-50/60 shadow-sm" : "border-default-200 bg-content1"} ${translatorRunningState ? "cursor-default" : "hover:border-default-300 hover:bg-default-50"}`}
                      onClick={() => selectSubtitleJob(job.id)}
                      disabled={translatorRunningState}
                    >
                      <div className='flex items-start justify-between gap-3'>
                        <div className='min-w-0 flex-1'>
                          <p className='truncate text-sm font-semibold text-foreground'>
                            {index + 1}. {job.name}
                          </p>
                          <p className='mt-1 break-all text-xs text-default-500'>
                            {getSubtitleJobSourceCaption(job)}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${getSubtitleJobStatusClasses(job.status)}`}>
                          {isActive ? "Running now" : getSubtitleJobStatusLabel(job.status)}
                        </span>
                      </div>

                      <div className='mt-4'>
                        <div className='flex items-center justify-between gap-3 text-xs text-default-500'>
                          <span>{job.completedLines}/{job.totalLines} lines</span>
                          <span>{Math.round(jobPercent)}%</span>
                        </div>
                        <div className='mt-2 h-2 rounded-full bg-default-200'>
                          <div className={`h-2 rounded-full transition-all ${job.status === "failed" ? "bg-danger" : job.status === "completed" ? "bg-success" : isActive ? "bg-primary" : "bg-default-400"}`} style={{ width: `${jobPercent}%` }}></div>
                        </div>
                      </div>

                      {job.errorMessage && (
                        <p className='mt-3 text-xs text-danger-600'>{job.errorMessage}</p>
                      )}
                    </button>
                  )
                }}
              />
            </CardBody>
          </Card>
        </div>

        {showRenamePanel && (
          <div className='px-4 mt-4'>
            <Card shadow="none" className='border'>
              <CardBody className='gap-4'>
                <div className='flex flex-wrap items-start justify-between gap-3'>
                  <div className='min-w-0 flex-1'>
                    <p className='text-base font-semibold'>Batch Rename</p>
                    <p className='text-sm text-default-500'>
                      Uses the subtitle files from the main Import action. Adjust the order or names here, then download a single `.srt` or a `.zip` automatically.
                    </p>
                  </div>
                  <div className='flex gap-2'>
                    <Button variant="flat" onClick={autofillRenameNames} isDisabled={renameRows.length === 0}>
                      Autofill Names
                    </Button>
                    <Button color="primary" onClick={downloadRenamedFiles} isDisabled={renameRows.length === 0}>
                      Download Renamed
                    </Button>
                    <Button variant="light" onClick={() => setShowRenamePanel(false)}>
                      Hide
                    </Button>
                  </div>
                </div>

                <div className='flex flex-wrap gap-3'>
                  <Input
                    className='w-full md:w-80'
                    size='sm'
                    label="Base Name"
                    value={renameBaseName}
                    onValueChange={setRenameBaseName}
                    description="Used when you click Autofill Names."
                  />

                  <div className='flex flex-wrap items-end gap-2'>
                    <Button size='sm' variant={renameSortMode === "detected" ? "solid" : "flat"} color="secondary" onClick={() => applyRenameSortMode("detected")}>
                      Sort by Episode
                    </Button>
                    <Button size='sm' variant={renameSortMode === "name" ? "solid" : "flat"} color="secondary" onClick={() => applyRenameSortMode("name")}>
                      Sort A-Z
                    </Button>
                    <Button size='sm' variant={renameSortMode === "original" ? "solid" : "flat"} color="secondary" onClick={() => applyRenameSortMode("original")}>
                      Keep Input Order
                    </Button>
                  </div>
                </div>

                {renameDuplicateNames.size > 0 && (
                  <p className='text-sm text-danger-600'>
                    Duplicate renamed files detected. Each new file name must be unique before downloading.
                  </p>
                )}

                <ProgressiveList
                  items={renameRows}
                  initialCount={30}
                  batchSize={30}
                  resetKey={renameRows.map((row) => row.id).join("|")}
                  emptyMessage="Load subtitle files to start the batch renamer."
                  className='grid gap-3'
                  renderItem={(row) => {
                    const analyzedItem = analyzeSubtitleImport(row.sourceItem)
                    const hasDuplicateName = renameDuplicateNames.has(`${row.newName ?? ""}`.trim().toLowerCase())

                    return (
                      <div key={row.id} className='rounded-2xl border border-default-200 bg-content1 px-4 py-4'>
                        <div className='grid gap-3 md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] md:items-start'>
                          <Input
                            size='sm'
                            type='number'
                            min='1'
                            label="Order"
                            value={String(row.order)}
                            onValueChange={(value) => setRenameRows((rows) => rows.map((currentRow) => currentRow.id === row.id ? { ...currentRow, order: Number(value) || 0 } : currentRow))}
                          />

                          <div className='rounded-xl border border-default-200 bg-default-50 px-3 py-3'>
                            <p className='text-[11px] font-semibold uppercase tracking-[0.14em] text-default-500'>Old Name</p>
                            <p className='mt-1 break-all text-sm font-medium text-foreground'>{analyzedItem.leafName}</p>
                            <p className='mt-1 break-all text-xs text-default-500'>{analyzedItem.archivePath}</p>
                          </div>

                          <Input
                            size='sm'
                            label="New Name"
                            value={row.newName}
                            color={hasDuplicateName ? "danger" : "default"}
                            isInvalid={hasDuplicateName}
                            errorMessage={hasDuplicateName ? "Duplicate name" : ""}
                            onValueChange={(value) => setRenameRows((rows) => rows.map((currentRow) => currentRow.id === row.id ? { ...currentRow, newName: value } : currentRow))}
                          />
                        </div>

                        <div className='mt-3 flex flex-wrap gap-2 text-xs text-default-500'>
                          {analyzedItem.numericKey && (
                            <span className='rounded-full bg-default-100 px-2 py-1'>Episode key: {analyzedItem.numericKey}</span>
                          )}
                          {analyzedItem.tokenKey && (
                            <span className='rounded-full bg-default-100 px-2 py-1'>Clean title: {analyzedItem.tokenKey}</span>
                          )}
                        </div>
                      </div>
                    )
                  }}
                />
              </CardBody>
            </Card>
          </div>
        )}

        <div className='px-4 mt-4'>
          <div className='flex items-center justify-end'>
            <div className='flex items-center gap-3 rounded-2xl border border-default-200 bg-content1 px-4 py-3 shadow-sm'>
              <Switch
                size='sm'
                isSelected={linkSubtitleScroll}
                onValueChange={setLinkSubtitleScrollValue}
              >
              </Switch>
              <div className='flex flex-col gap-0.5'>
                <p className='text-sm font-medium'>Link Input and Output Scroll</p>
                <p className='text-xs text-default-500'>Scroll both editors together by subtitle position.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:flex lg:gap-4 px-4 mt-4">
          <div className="lg:w-1/2">
            <SubtitleCard label={`Input${currentJob ? ` - ${currentJob.name}` : ""}`}>
              <SubtitleEditorTable
                tableId="input"
                description="Editable subtitle rows. Apply changes before translating."
                rows={inputEditorRows}
                pendingLabel={hasPendingInputEdits ? "Pending source changes" : ""}
                disabled={translatorRunningState}
                priorityRenderCount={0}
                linkedScrollEnabled={linkSubtitleScroll}
                linkedScrollAnchor={linkedSubtitleScrollAnchor}
                onLinkedScrollAnchorChange={handleLinkedSubtitleScrollAnchorChange}
                onRowChange={(rowIndex, field, value) => updateSubtitleEditorRow(setInputEditorRows, rowIndex, field, value)}
              />
            </SubtitleCard>
          </div>

          <div className="lg:w-1/2">
            <SubtitleCard label={`Output${currentJob ? ` - ${currentJob.name}` : ""}`}>
              <SubtitleEditorTable
                tableId="output"
                description="Editable translated rows. Applied changes are used for export and merge."
                rows={outputEditorRows}
                pendingLabel={hasPendingOutputEdits ? "Pending translation changes" : ""}
                disabled={translatorRunningState}
                priorityRenderCount={translationCompletedCount}
                linkedScrollEnabled={linkSubtitleScroll}
                linkedScrollAnchor={linkedSubtitleScrollAnchor}
                onLinkedScrollAnchorChange={handleLinkedSubtitleScrollAnchorChange}
                onRowChange={(rowIndex, field, value) => updateSubtitleEditorRow(setOutputEditorRows, rowIndex, field, value)}
              />
            </SubtitleCard>
          </div>
        </div>
      </div>
      {operationToast && (
        <div className='fixed bottom-4 right-4 z-50 max-w-md'>
          <Card shadow="lg" className='border border-success-200 bg-success-50'>
            <CardBody className='flex flex-row items-start gap-3 p-3'>
              <div className='min-w-0 flex-1'>
                <p className='text-sm font-semibold text-success-700'>{operationToast.title}</p>
                <p className='text-sm text-success-700 break-all'>{operationToast.message}</p>
              </div>
              <Button
                isIconOnly
                size='sm'
                variant='light'
                className='text-success-700'
                aria-label="Close operation notification"
                onClick={dismissOperationToast}
              >
                <CloseIcon />
              </Button>
            </CardBody>
          </Card>
        </div>
      )}
      {translatorRunningState && (
        <div className='fixed bottom-4 left-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)]'>
          <Card shadow="lg" className='border border-primary-200 bg-content1/95 backdrop-blur'>
            <button
              type='button'
              className='flex w-full items-center justify-between gap-3 px-4 py-3 text-left'
              onClick={() => setShowTranslationProgressPanel((value) => !value)}
            >
              <div className='flex min-w-0 items-center gap-3'>
                <span className='relative flex h-3 w-3 shrink-0'>
                  <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-40'></span>
                  <span className='relative inline-flex h-3 w-3 rounded-full bg-primary'></span>
                </span>
                <div className='min-w-0'>
                  <p className='text-sm font-semibold text-foreground'>
                    File {activeJobIndex + 1}/{totalJobsCount}: {activeJob?.name ?? currentJob?.name ?? "subtitle"}
                  </p>
                  <p className='truncate text-xs text-default-500'>
                    {translationCompletedCount}/{translationTotalCount} lines translated
                  </p>
                </div>
              </div>
              <ChevronDownIcon className={`shrink-0 transition-transform ${showTranslationProgressPanel ? "rotate-180" : ""}`} />
            </button>

            {showTranslationProgressPanel && (
              <>
                <Divider />
                <CardBody className='gap-3 p-4'>
                  <div>
                    <div className='flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-default-500'>
                      <span>Batch</span>
                      <span>{completedJobsCount}/{totalJobsCount} files</span>
                    </div>
                    <div className='mt-2 h-2 rounded-full bg-default-200'>
                      <div className='h-2 rounded-full bg-primary transition-all' style={{ width: `${batchProgressPercent}%` }}></div>
                    </div>
                  </div>

                  <div>
                    <div className='flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-default-500'>
                      <span>Current file</span>
                      <span>{translationCompletedCount}/{translationTotalCount} lines</span>
                    </div>
                    <div className='mt-2 h-2 rounded-full bg-default-200'>
                      <div className='h-2 rounded-full bg-secondary transition-all' style={{ width: `${translationTotalCount > 0 ? Math.min(100, (translationCompletedCount / translationTotalCount) * 100) : 0}%` }}></div>
                    </div>
                    <p className='mt-2 break-all text-xs text-default-500'>
                      {activeJob ? getSubtitleJobSourceCaption(activeJob) : "Preparing the next subtitle file..."}
                    </p>
                  </div>

                  <pre className='max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 text-sm text-default-600'>
                    {streamOutput || "Waiting for streamed output..."}
                  </pre>
                </CardBody>
              </>
            )}
          </Card>
        </div>
      )}
      {hasPendingSubtitleEdits && (
        <div className='pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4'>
          <Card shadow="lg" className='pointer-events-auto w-full max-w-2xl border border-warning-200 bg-warning-50'>
            <CardBody className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between'>
              <div className='min-w-0 flex-1'>
                <p className='text-sm font-semibold text-warning-800'>Unsaved subtitle edits</p>
                <p className='text-sm text-warning-700'>
                  Apply changes before translating, exporting, or merging.
                  {hasPendingInputEdits && " Source subtitles were edited."}
                  {hasPendingOutputEdits && " Translated subtitles were edited."}
                </p>
              </div>
              <Button color="warning" className='shrink-0 text-white' onClick={applySubtitleEdits}>
                Apply Changes
              </Button>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  )
}
