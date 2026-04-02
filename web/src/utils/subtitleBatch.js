import JSZip from "jszip"
import { getFileBaseName } from "./download"

const SRT_FILE_PATTERN = /\.srt$/i
const ZIP_FILE_PATTERN = /\.zip$/i
const NAME_NOISE_TOKENS = new Set([
  "sub",
  "subs",
  "subtitle",
  "subtitles",
  "translated",
  "translation",
  "traducido",
  "traducida",
  "traduccion",
  "es",
  "esp",
  "espanol",
  "espanollatino",
  "spanish",
  "latino",
  "latin",
  "eng",
  "english",
  "en",
  "dual",
  "multi",
  "mux",
  "v2",
  "v3",
  "final",
  "1080p",
  "720p",
  "480p",
  "webrip",
  "bluray",
  "amzn",
  "nf",
  "web",
  "rip",
  "proper",
  "hc",
])

function normalizePath(path, fallback = "subtitle.srt") {
  const normalized = `${path ?? ""}`.replace(/\\/g, "/").replace(/^\/+/, "").trim()
  return normalized || fallback
}

function normalizeComparableText(value) {
  return `${value ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function getComparableLeafName(fileName) {
  return normalizeComparableText(getFileBaseName(getPathLeaf(fileName), "subtitle"))
}

function getComparableNameTokens(fileName) {
  return getComparableLeafName(fileName)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !NAME_NOISE_TOKENS.has(token))
}

function getNumberGroups(fileName) {
  return getComparableLeafName(fileName).match(/\d+/g) ?? []
}

function buildUniquePairingFromKey(primaryItems, secondaryItems, keyGetter, strategy) {
  const primaryMap = new Map()
  const secondaryMap = new Map()

  for (const item of primaryItems) {
    const key = keyGetter(item)
    if (!key || primaryMap.has(key)) {
      return null
    }
    primaryMap.set(key, item)
  }

  for (const item of secondaryItems) {
    const key = keyGetter(item)
    if (!key || secondaryMap.has(key)) {
      return null
    }
    secondaryMap.set(key, item)
  }

  if (primaryMap.size !== secondaryMap.size) {
    return null
  }

  const pairs = []
  for (const primaryItem of primaryItems) {
    const key = keyGetter(primaryItem)
    const secondaryItem = secondaryMap.get(key)
    if (!secondaryItem) {
      return null
    }
    pairs.push({
      key,
      strategy,
      primary: primaryItem,
      secondary: secondaryItem,
    })
  }

  return pairs
}

export function getPathLeaf(path, fallback = "") {
  const normalized = normalizePath(path, fallback)
  const pathParts = normalized.split("/").filter(Boolean)
  return pathParts[pathParts.length - 1] ?? fallback
}

export function isSrtFileName(fileName) {
  return SRT_FILE_PATTERN.test(`${fileName ?? ""}`)
}

export function isZipFileName(fileName) {
  return ZIP_FILE_PATTERN.test(`${fileName ?? ""}`)
}

export async function extractSubtitleImports(files) {
  const importedFiles = Array.from(files ?? []).filter(Boolean)
  const extractedSubtitles = []

  for (const file of importedFiles) {
    if (isSrtFileName(file.name)) {
      const archivePath = normalizePath(file.name)
      extractedSubtitles.push({
        archivePath,
        displayName: getPathLeaf(archivePath, file.name),
        sourceLabel: "",
        text: await file.text(),
      })
      continue
    }

    if (isZipFileName(file.name)) {
      const zipFile = await JSZip.loadAsync(await file.arrayBuffer())
      const zipEntries = zipFile
        .file(SRT_FILE_PATTERN)
        .filter((entry) => !entry.dir)
        .sort((left, right) => left.name.localeCompare(right.name))

      if (zipEntries.length === 0) {
        throw new Error(`"${file.name}" does not contain any .srt files.`)
      }

      for (const entry of zipEntries) {
        const archivePath = normalizePath(entry.name)
        extractedSubtitles.push({
          archivePath,
          displayName: getPathLeaf(archivePath, file.name),
          sourceLabel: file.name,
          text: await entry.async("string"),
        })
      }
      continue
    }

    throw new Error(`Unsupported file "${file.name}". Only .srt and .zip are allowed.`)
  }

  if (extractedSubtitles.length === 0) {
    throw new Error("No subtitle files were found.")
  }

  return extractedSubtitles
}

export function analyzeSubtitleImport(item, originalIndex = 0) {
  const archivePath = normalizePath(item?.archivePath, item?.displayName ?? "subtitle.srt")
  const leafName = getPathLeaf(archivePath, item?.displayName ?? "subtitle.srt")
  const numberGroups = getNumberGroups(leafName)
  const numericKey = numberGroups.map((group) => group.padStart(4, "0")).join("-")
  const comparableName = getComparableLeafName(leafName)
  const tokenKey = getComparableNameTokens(leafName).join(" ")

  return {
    ...item,
    archivePath,
    displayName: item?.displayName ?? leafName,
    leafName,
    originalIndex,
    comparableName,
    tokenKey,
    numericKey,
    numberGroups,
  }
}

export function pairSubtitleImports(primaryItems, secondaryItems) {
  const analyzedPrimary = Array.from(primaryItems ?? []).map((item, index) => analyzeSubtitleImport(item, index))
  const analyzedSecondary = Array.from(secondaryItems ?? []).map((item, index) => analyzeSubtitleImport(item, index))

  if (analyzedPrimary.length === 0 || analyzedSecondary.length === 0) {
    return {
      ok: false,
      errorTitle: "Missing subtitle set",
      errorMessage: "Load both the top and bottom subtitle sets before merging.",
      pairs: [],
      strategy: null,
    }
  }

  if (analyzedPrimary.length !== analyzedSecondary.length) {
    return {
      ok: false,
      errorTitle: "Different file counts",
      errorMessage: `The top set has ${analyzedPrimary.length} file(s) and the bottom set has ${analyzedSecondary.length}. Both sides must contain the same number of subtitle files.`,
      pairs: [],
      strategy: null,
    }
  }

  if (analyzedPrimary.length === 1 && analyzedSecondary.length === 1) {
    return {
      ok: true,
      errorTitle: "",
      errorMessage: "",
      strategy: "single-file",
      pairs: [{
        key: "single-file",
        strategy: "single-file",
        primary: analyzedPrimary[0],
        secondary: analyzedSecondary[0],
      }],
    }
  }

  const strategyCandidates = [
    ["same relative name", (item) => item.comparableName],
    ["cleaned title", (item) => item.tokenKey],
    ["episode numbers", (item) => item.numericKey],
  ]

  for (const [strategy, keyGetter] of strategyCandidates) {
    const pairs = buildUniquePairingFromKey(analyzedPrimary, analyzedSecondary, keyGetter, strategy)
    if (pairs) {
      return {
        ok: true,
        errorTitle: "",
        errorMessage: "",
        strategy,
        pairs,
      }
    }
  }

  return {
    ok: false,
    errorTitle: "Ambiguous file names",
    errorMessage: [
      "I cannot clearly determine which top subtitle belongs to which bottom subtitle.",
      "Rename the files so both sets share a clear episode key.",
      "Examples: `Serie_Capitulo_01.srt`, `Serie_Capitulo_02.srt`, `MyShow_S01E03.srt`, `MyShow_S01E04.srt`.",
    ].join(" "),
    pairs: [],
    strategy: null,
  }
}

export function sortSubtitleImports(items, sortMode = "detected") {
  const analyzedItems = Array.from(items ?? []).map((item, index) => analyzeSubtitleImport(item, index))

  const sortedItems = analyzedItems.slice().sort((left, right) => {
    if (sortMode === "name") {
      return left.leafName.localeCompare(right.leafName, undefined, { numeric: true, sensitivity: "base" })
    }

    if (sortMode === "detected") {
      const leftKey = left.numericKey || left.tokenKey || left.comparableName
      const rightKey = right.numericKey || right.tokenKey || right.comparableName
      const keyComparison = leftKey.localeCompare(rightKey, undefined, { numeric: true, sensitivity: "base" })
      if (keyComparison !== 0) {
        return keyComparison
      }
      return left.originalIndex - right.originalIndex
    }

    return left.originalIndex - right.originalIndex
  })

  return sortedItems
}

export function suggestRenameBaseName(items) {
  const firstItem = Array.from(items ?? [])[0]
  if (!firstItem) {
    return "episode"
  }

  const comparableName = analyzeSubtitleImport(firstItem).comparableName
    .replace(/\b(s\d+e\d+|season \d+ episode \d+|episode \d+|ep \d+|capitulo \d+|cap \d+|\d+)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const slug = comparableName.replace(/\s+/g, "_")
  return slug || "episode"
}

export function buildSuggestedRenameFileName(baseName, order, totalCount) {
  const safeBaseName = `${baseName ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const normalizedBaseName = safeBaseName || "episode"
  const digits = Math.max(2, `${totalCount}`.length)
  return `${normalizedBaseName}_${String(order).padStart(digits, "0")}.srt`
}
