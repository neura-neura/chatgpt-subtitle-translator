"use client"
import React, { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react'
import { Button, Input, Card, Textarea, Slider, Switch, CardHeader, CardBody, Divider, Popover, PopoverTrigger, PopoverContent, Autocomplete, AutocompleteItem } from "@nextui-org/react";

import { EyeSlashFilledIcon } from './EyeSlashFilledIcon';
import { EyeFilledIcon } from './EyeFilledIcon';

import { FileUploadButton } from '@/components/FileUploadButton';
import { SubtitleCard } from '@/components/SubtitleCard';
import { appendFileNameSuffix, buildCombinedSrtFileName, buildTranslatedSrtFileName, downloadString } from '@/utils/download';
import { sampleSrt } from '@/data/sample';
import { buildCombinedSrtText, combineSubtitles, parseSubtitleText, removeREngTag } from '@/utils/subtitleMerge';

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
const DefaultOllamaBaseUrl = "http://localhost:11434/v1"
const MergeLanguageTag = "{\\rENG}"

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

      onLinkedScrollAnchorChange?.({
        rowIndex: filteredRows[anchorFilteredIndex]?.rowIndex ?? 0,
        sourceTableId: tableId,
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

    const nextScrollTop = rowOffsets[targetFilteredIndex] ?? 0
    suppressLinkedScrollRef.current = true
    container.scrollTop = nextScrollTop
    setScrollTop(nextScrollTop)
    window.requestAnimationFrame(() => {
      suppressLinkedScrollRef.current = false
    })
  }, [filteredRows, linkedScrollAnchor, linkedScrollEnabled, rowOffsets, tableId])

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

export function TranslatorApplication() {
  // Translator Configuration
  const [APIvalue, setAPIValue] = useState("")
  const [baseUrlValue, setBaseUrlValue] = useState(undefined)
  const [fromLanguage, setFromLanguage] = useState("")
  const [toLanguage, setToLanguage] = useState("English")
  const [systemInstruction, setSystemInstruction] = useState("")
  const [model, setModel] = useState(DefaultModel)
  const [recentModelOptions, setRecentModelOptions] = useState([])
  const [temperature, setTemperature] = useState(DefaultTemperature)
  const [batchSizes, setBatchSizes] = useState([10, 50])
  const [useStructuredMode, setUseStructuredMode] = useState(false)
  const [rateLimit, setRateLimit] = useState(60)
  const [systemInstructionTitle, setSystemInstructionTitle] = useState("")
  const [systemInstructionDescription, setSystemInstructionDescription] = useState("")
  const [savedSystemInstructions, setSavedSystemInstructions] = useState([])
  const [showInstructionLibrary, setShowInstructionLibrary] = useState(false)
  const [focusInstructionTitle, setFocusInstructionTitle] = useState(false)

  const [isAPIInputVisible, setIsAPIInputVisible] = useState(false)
  const toggleAPIInputVisibility = () => setIsAPIInputVisible(!isAPIInputVisible)

  // Translator State
  const [srtInputText, setSrtInputText] = useState(sampleSrt)
  const [srtOutputText, setSrtOutputText] = useState(sampleSrt)
  const [inputAppliedRows, setInputAppliedRows] = useState(() => buildSubtitleEditorRows(sampleSrt))
  const [inputEditorRows, setInputEditorRows] = useState(() => buildSubtitleEditorRows(sampleSrt))
  const [outputAppliedRows, setOutputAppliedRows] = useState(() => buildSubtitleEditorRows(sampleSrt))
  const [outputEditorRows, setOutputEditorRows] = useState(() => buildSubtitleEditorRows(sampleSrt))
  const [inputs, setInputs] = useState(subtitleParser.fromSrt(sampleSrt).map(x => x.text))
  const [outputs, setOutput] = useState([])
  const [streamOutput, setStreamOutput] = useState("")
  const [importedSubtitleFileName, setImportedSubtitleFileName] = useState("")
  const [mergePrimarySubtitle, setMergePrimarySubtitle] = useState(null)
  const [mergeSecondarySubtitle, setMergeSecondarySubtitle] = useState(null)
  const [keepMergeLanguageTag, setKeepMergeLanguageTag] = useState(false)
  const [mergeStatusMessage, setMergeStatusMessage] = useState("")
  const [translatorRunningState, setTranslatorRunningState] = useState(false)
  /** @type {React.RefObject<Translator>} */
  const translatorRef = useRef(null)
  const translatorRunningRef = useRef(false)

  // Translator Stats
  const [usageInformation, setUsageInformation] = useState(/** @type {typeof Translator.prototype.usage}*/(null))
  const [RPMInfomation, setRPMInformation] = useState(0)
  const [siteOrigin, setSiteOrigin] = useState("")
  const [hideOllamaPagesHint, setHideOllamaPagesHint] = useState(false)
  const [connectionTestMessage, setConnectionTestMessage] = useState("")
  const [connectionTestState, setConnectionTestState] = useState("idle")
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [showTranslationProgressPanel, setShowTranslationProgressPanel] = useState(false)
  const [linkSubtitleScroll, setLinkSubtitleScroll] = useState(false)
  const [linkedSubtitleScrollAnchor, setLinkedSubtitleScrollAnchor] = useState(null)

  // Persistent Data Restoration
  useEffect(() => {
    setAPIValue(localStorage.getItem(OPENAI_API_KEY) ?? "")
    setRateLimit(Number(localStorage.getItem(RATE_LIMIT) ?? rateLimit))
    setBaseUrlWithModerator(localStorage.getItem(OPENAI_BASE_URL) ?? undefined)
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
    if (!mergeStatusMessage) {
      return
    }

    const timeout = window.setTimeout(() => {
      setMergeStatusMessage("")
    }, 5000)

    return () => window.clearTimeout(timeout)
  }, [mergeStatusMessage])

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
    setBaseUrlValue(value)
  }

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
    localStorage.setItem(RATE_LIMIT, value)
    setRateLimit(Number(value))
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

  function dismissMergeToast() {
    setMergeStatusMessage("")
  }

  async function loadMergeSubtitleFile(file, slot) {
    if (!file) {
      return
    }

    try {
      const fileText = await file.text()
      const nextSubtitle = {
        name: file.name,
        text: fileText,
        source: "manual",
      }

      if (slot === "primary") {
        setMergePrimarySubtitle(nextSubtitle)
      }
      else {
        setMergeSecondarySubtitle(nextSubtitle)
      }

      setMergeStatusMessage("")
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
      if (hasInputChanges) {
        const inputDraftText = buildSrtFromSubtitleEditorRows(inputEditorRows)
        const parsedInput = inputDraftText.trim() ? subtitleParser.fromSrt(inputDraftText) : []
        if (inputEditorRows.length > 0 && parsedInput.length !== inputEditorRows.length) {
          throw new Error("Input subtitles are not valid SRT. Fix them before applying changes.")
        }
        const normalizedInputText = buildSrtFromParsedSubtitles(parsedInput)
        const normalizedInputRows = buildSubtitleEditorRows(normalizedInputText)

        startTransition(() => {
          setSrtInputText(normalizedInputText)
          setInputAppliedRows(normalizedInputRows)
          setInputEditorRows(normalizedInputRows)
          setInputs(parsedInput.map(item => item.text))
        })

        if (mergePrimarySubtitle?.source !== "manual") {
          setMergePrimarySubtitle({
            name: importedSubtitleFileName || "source.srt",
            text: normalizedInputText,
            source: "imported",
          })
        }
      }

      if (hasOutputChanges) {
        const outputDraftText = buildSrtFromSubtitleEditorRows(outputEditorRows)
        const parsedOutput = outputDraftText.trim() ? subtitleParser.fromSrt(outputDraftText) : []
        if (outputEditorRows.length > 0 && parsedOutput.length !== outputEditorRows.length) {
          throw new Error("Output subtitles are not valid SRT. Fix them before applying changes.")
        }
        const normalizedOutputText = buildSrtFromParsedSubtitles(parsedOutput)
        const normalizedOutputRows = buildSubtitleEditorRows(normalizedOutputText)

        startTransition(() => {
          setSrtOutputText(normalizedOutputText)
          setOutputAppliedRows(normalizedOutputRows)
          setOutputEditorRows(normalizedOutputRows)
          setOutput(parsedOutput.map(item => item.text))
        })

        if (mergeSecondarySubtitle?.source !== "manual") {
          setMergeSecondarySubtitle(normalizedOutputText.trim() ? {
            name: buildTranslatedSrtFileName(importedSubtitleFileName, toLanguage),
            text: normalizedOutputText,
            source: "generated",
          } : null)
        }
      }
    } catch (error) {
      alert(error?.message ?? error)
    }
  }

  function combineAndDownloadSubtitles() {
    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before combining.")
      return
    }

    if (!mergePrimarySubtitle || !mergeSecondarySubtitle) {
      alert("Choose both subtitle files before combining.")
      return
    }

    const primary = parseSubtitleText(mergePrimarySubtitle.name, mergePrimarySubtitle.text)
    const secondary = parseSubtitleText(mergeSecondarySubtitle.name, mergeSecondarySubtitle.text)

    if (!primary.subtitles.length) {
      alert("Failed to parse the TOP subtitle.")
      return
    }

    if (!secondary.subtitles.length) {
      alert("Failed to parse the BOTTOM subtitle.")
      return
    }

    const combinedSubtitles = combineSubtitles(primary.subtitles, secondary.subtitles, primary.format, "{\\rENG}", true)
    const combinedFileName = keepMergeLanguageTag
      ? buildCombinedSrtFileName(mergePrimarySubtitle.name || importedSubtitleFileName, fromLanguage, toLanguage)
      : appendFileNameSuffix(buildCombinedSrtFileName(mergePrimarySubtitle.name || importedSubtitleFileName, fromLanguage, toLanguage), "no_rENG")
    const combinedSrtText = keepMergeLanguageTag
      ? buildCombinedSrtText(combinedSubtitles)
      : removeREngTag(buildCombinedSrtText(combinedSubtitles))

    downloadString(combinedSrtText, "text/plain", combinedFileName)
    setMergeStatusMessage(`Downloaded ${combinedFileName}`)
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

  async function testOllamaConnection() {
    const baseUrl = (baseUrlValue?.trim() || DefaultOllamaBaseUrl).replace(/\/+$/, "")
    const normalizedApiValue = APIvalue?.trim() ?? ""
    const isLocalOllamaConnection = baseUrl.includes("localhost:11434")
    const shouldSkipAuthorizationHeader = isLocalOllamaConnection && normalizedApiValue.toLowerCase() === "ollama"
    rememberModelValue(model)
    setIsTestingConnection(true)
    setConnectionTestState("testing")
    setConnectionTestMessage(`Testing ${baseUrl} ...`)

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: normalizedApiValue && !shouldSkipAuthorizationHeader ? { Authorization: `Bearer ${normalizedApiValue}` } : undefined,
      })
      const data = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(data?.error?.message ?? data?.message ?? `HTTP ${response.status}`)
      }

      const models = Array.isArray(data?.data) ? data.data : []
      const hasSelectedModel = models.some(item => item?.id === model)
      setConnectionTestState("success")
      setConnectionTestMessage(
        hasSelectedModel
          ? `Connected. ${model} is available in Ollama.`
          : `Connected, but ${model} is not installed in Ollama. Install it with: ollama pull ${model}. Ollama currently exposed ${models.length} model(s).`
      )
    } catch (error) {
      setConnectionTestState("error")
      const rawMessage = error?.message ?? String(error)
      const likelyOllamaCorsFailure = isGitHubPages && isLocalOllamaConnection && rawMessage === "Failed to fetch"

      setConnectionTestMessage(
        likelyOllamaCorsFailure
          ? `Failed to fetch. Ollama is likely rejecting the browser origin. On this PC set OLLAMA_ORIGINS=${siteOrigin}, restart Ollama, then try again.`
          : rawMessage
      )
    } finally {
      setIsTestingConnection(false)
    }
  }

  async function generate(e) {
    e.preventDefault()
    if (hasPendingSubtitleEdits) {
      alert("Apply subtitle changes before starting the translation.")
      return
    }
    rememberModelValue(model)
    setTranslatorRunningState(true)
    console.log("[User Interface]", "Begin Generation")
    translatorRunningRef.current = true
    let currentStream = ""
    const outputWorkingProgress = subtitleParser.fromSrt(srtInputText)
    const currentOutputs = []
    const initialOutputRows = outputWorkingProgress.map((subtitle) => buildOutputEditorRow(subtitle))
    setOutput([])
    setUsageInformation(null)
    setSrtOutputText("")
    setOutputAppliedRows(initialOutputRows)
    setOutputEditorRows(initialOutputRows)
    console.log("OPENAI_BASE_URL", baseUrlValue)
    const openai = createOpenAIClient(APIvalue, true, baseUrlValue)

    const coolerChatGPTAPI = new CooldownContext(rateLimit, 60000, "ChatGPTAPI")

    const TranslatorImplementation = useStructuredMode ? TranslatorStructuredArray : Translator

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
      batchSizes: batchSizes, //[10, 50],
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
      setStreamOutput("")
      for await (const output of translatorRef.current.translateLines(inputs)) {
        if (!translatorRunningRef.current) {
          console.error("[User Interface]", "Aborted")
          break
        }
        const srtEntry = outputWorkingProgress[output.index - 1]
        const cleanedTransform = sanitizeTranslatedSubtitleLine(output.finalTransform, srtEntry?.text ?? "")
        currentOutputs.push(cleanedTransform)
        srtEntry.text = cleanedTransform
        const nextOutputRow = buildOutputEditorRow(srtEntry, cleanedTransform)
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
      }
      console.log({ sourceInputWorkingCopy: outputWorkingProgress })
      const translatedSrt = buildSrtFromParsedSubtitles(outputWorkingProgress)
      const nextOutputRows = buildSubtitleEditorRows(translatedSrt)
      startTransition(() => {
        setSrtOutputText(translatedSrt)
        setOutputAppliedRows(nextOutputRows)
        setOutputEditorRows(nextOutputRows)
      })
      setMergeSecondarySubtitle({
        name: buildTranslatedSrtFileName(importedSubtitleFileName, toLanguage),
        text: translatedSrt,
        source: "generated",
      })
      setMergeStatusMessage("")
    } catch (error) {
      console.error(error)
      alert(error?.message ?? error)
    }
    translatorRunningRef.current = false
    translatorRef.current = null
    setTranslatorRunningState(false)
  }

  async function stopGeneration() {
    console.error("[User Interface]", "Aborting")
    if (translatorRef.current) {
      translatorRunningRef.current = false
      translatorRef.current.abort()
    }
  }

  const translatedExportFileName = buildTranslatedSrtFileName(importedSubtitleFileName, toLanguage)
  const baseCombinedExportFileName = buildCombinedSrtFileName(mergePrimarySubtitle?.name || importedSubtitleFileName, fromLanguage, toLanguage)
  const combinedExportFileName = keepMergeLanguageTag
    ? baseCombinedExportFileName
    : appendFileNameSuffix(baseCombinedExportFileName, "no_rENG")
  const mergePrimaryLabel = mergePrimarySubtitle?.name ?? "Choose the top subtitle"
  const mergeSecondaryLabel = mergeSecondarySubtitle?.source === "generated"
    ? translatedExportFileName
    : mergeSecondarySubtitle?.name ?? "Choose the bottom subtitle"
  const canMergeSubtitles = Boolean(mergePrimarySubtitle?.text && mergeSecondarySubtitle?.text)
  const modelOptions = [...DefaultModelOptions, ...recentModelOptions]
  const hasPendingInputEdits = serializeSubtitleEditorRows(inputEditorRows) !== serializeSubtitleEditorRows(inputAppliedRows)
  const hasPendingOutputEdits = serializeSubtitleEditorRows(outputEditorRows) !== serializeSubtitleEditorRows(outputAppliedRows)
  const hasPendingSubtitleEdits = hasPendingInputEdits || hasPendingOutputEdits
  const translationCompletedCount = outputs.length
  const translationTotalCount = inputs.length

  function handleLinkedSubtitleScrollAnchorChange(nextAnchor) {
    setLinkedSubtitleScrollAnchor((currentAnchor) => {
      if (
        currentAnchor?.rowIndex === nextAnchor?.rowIndex &&
        currentAnchor?.sourceTableId === nextAnchor?.sourceTableId
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
                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <Input
                      className="w-full md:w-6/12"
                      size='sm'
                      // autoFocus={true}
                      value={APIvalue}
                      onValueChange={(value) => setAPIKey(value)}
                      isRequired
                      autoComplete='off'
                      label="OpenAI API Key"
                      variant="flat"
                      description='Stored locally in browser. Use "ollama" for local Ollama.'
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
                      label="OpenAI Base Url"
                      placeholder={DefaultOllamaBaseUrl}
                      autoComplete='on'
                      value={baseUrlValue ?? ""}
                      onValueChange={setBaseUrl}
                      description={`For local Ollama: ${DefaultOllamaBaseUrl}`}
                    />
                  </div>

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
                      onClick={testOllamaConnection}
                      isLoading={isTestingConnection}
                    >
                      Test Ollama Connection
                    </Button>
                    {connectionTestMessage && (
                      <p className={`text-sm ${connectionTestState === "error" ? "text-danger" : connectionTestState === "success" ? "text-success" : "text-default-500"}`}>
                        {connectionTestMessage}
                      </p>
                    )}
                  </div>

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
                      >
                      </Switch>
                      <div className="flex flex-col place-content-center gap-1">
                        <p className="text-small">Use Structured Mode</p>
                        {baseUrlValue && (
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
          <FileUploadButton label={"Import SRT"} accept=".srt" inputId="import-srt-input" onFileSelect={async (file) => {
            // console.log("File", file);
            try {
              const text = await file.text()
              const parsed = subtitleParser.fromSrt(text)
              const nextInputRows = buildSubtitleEditorRows(text)
              startTransition(() => {
                setSrtInputText(text)
                setInputAppliedRows(nextInputRows)
                setInputEditorRows(nextInputRows)
                setInputs(parsed.map(x => x.text))
                setSrtOutputText("")
                setOutputAppliedRows([])
                setOutputEditorRows([])
              })
              setImportedSubtitleFileName(file.name)
              setMergePrimarySubtitle({
                name: file.name,
                text,
                source: "imported",
              })
              setMergeSecondarySubtitle(null)
              setMergeStatusMessage("")
              setOutput([])
              setStreamOutput("")
            } catch (error) {
              alert(error.message ?? error)
            }
          }} />
          {!translatorRunningState && (
            <Button type='submit' form="translator-config-form" color="primary" isDisabled={!APIvalue || translatorRunningState}>
              Start
            </Button>
          )}

          {translatorRunningState && (
            <Button color="danger" onClick={() => stopGeneration()} isLoading={!streamOutput}>
              Stop
            </Button>
          )}

          <Button color="primary" onClick={() => {
            if (hasPendingSubtitleEdits) {
              alert("Apply subtitle changes before exporting.")
              return
            }
            downloadString(srtOutputText, "text/plain", translatedExportFileName)
          }}>
            Export SRT
          </Button>
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
                        The current import is used as the top subtitle and the latest translated SRT is used as the bottom subtitle by default.
                        You can replace either one here with files from your computer.
                      </p>
                    </div>

                    <div className='grid gap-2'>
                      <div>
                        <p className='text-xs font-semibold text-default-600 mb-1'>Top subtitle</p>
                        <FileUploadButton
                          label="Choose Top Subtitle"
                          accept=".srt,.ass"
                          inputId="merge-top-subtitle-input"
                          buttonProps={{ color: "secondary", variant: "flat", className: "w-full" }}
                          onFileSelect={(file) => loadMergeSubtitleFile(file, "primary")}
                        />
                        <p className='text-xs text-default-500 mt-1 break-all'>{mergePrimaryLabel}</p>
                      </div>

                      <div>
                        <p className='text-xs font-semibold text-default-600 mb-1'>Bottom subtitle</p>
                        <FileUploadButton
                          label="Choose Bottom Subtitle"
                          accept=".srt,.ass"
                          inputId="merge-bottom-subtitle-input"
                          buttonProps={{ color: "secondary", variant: "flat", className: "w-full" }}
                          onFileSelect={(file) => loadMergeSubtitleFile(file, "secondary")}
                        />
                        <p className='text-xs text-default-500 mt-1 break-all'>{mergeSecondaryLabel}</p>
                      </div>
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
                      Combined file name: <code>{combinedExportFileName}</code>
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
            <SubtitleCard label={"Input"}>
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
            <SubtitleCard label={"Output"}>
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

            {usageInformation && (
              <Card shadow="sm" className='mt-4 p-4'>
                <span><b>Estimated Usage</b></span>
                <span>Tokens: {usageInformation?.promptTokensUsed} + {usageInformation?.completionTokensUsed} = {usageInformation?.usedTokens}</span>
                {usageInformation?.wastedTokens > 0 && (
                  <span className={'text-danger'}>Wasted: {usageInformation?.promptTokensWasted} + {usageInformation?.completionTokensWasted} = {usageInformation?.wastedTokens} {usageInformation?.wastedPercent}</span>
                )}
                {usageInformation?.cachedTokens > 0 && (
                  <span className={'text-success'}>Cached: {usageInformation?.cachedTokens}</span>
                )}
                {usageInformation?.contextTokens > 0 && (
                  <span>Context: {usageInformation?.contextPromptTokens} + {usageInformation?.contextCompletionTokens} = {usageInformation?.contextTokens}</span>
                )}
                <span>{usageInformation?.promptRate} + {usageInformation?.completionRate} = {usageInformation?.rate} TPM {RPMInfomation} RPM</span>
              </Card>
            )}

          </div>
        </div>
      </div>
      {mergeStatusMessage && (
        <div className='fixed bottom-4 right-4 z-50 max-w-md'>
          <Card shadow="lg" className='border border-success-200 bg-success-50'>
            <CardBody className='flex flex-row items-start gap-3 p-3'>
              <div className='min-w-0 flex-1'>
                <p className='text-sm font-semibold text-success-700'>Merge complete</p>
                <p className='text-sm text-success-700 break-all'>{mergeStatusMessage}</p>
              </div>
              <Button
                isIconOnly
                size='sm'
                variant='light'
                className='text-success-700'
                aria-label="Close merge notification"
                onClick={dismissMergeToast}
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
                  <p className='text-sm font-semibold text-foreground'>Translating {translationCompletedCount}/{translationTotalCount}</p>
                  <p className='truncate text-xs text-default-500'>
                    {showTranslationProgressPanel ? "Hide live progress" : "Show live progress"}
                  </p>
                </div>
              </div>
              <ChevronDownIcon className={`shrink-0 transition-transform ${showTranslationProgressPanel ? "rotate-180" : ""}`} />
            </button>

            {showTranslationProgressPanel && (
              <>
                <Divider />
                <CardBody className='p-0'>
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
