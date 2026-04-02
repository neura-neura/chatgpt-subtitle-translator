import JSZip from "jszip"

const SRT_FILE_PATTERN = /\.srt$/i
const ZIP_FILE_PATTERN = /\.zip$/i

function normalizePath(path, fallback = "subtitle.srt") {
  const normalized = `${path ?? ""}`.replace(/\\/g, "/").replace(/^\/+/, "").trim()
  return normalized || fallback
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
