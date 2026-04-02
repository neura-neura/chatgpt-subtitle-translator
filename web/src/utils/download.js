export function downloadBlob(blob, fileName) {
  var a = document.createElement('a');
  a.download = fileName;
  a.href = URL.createObjectURL(blob);
  a.dataset.downloadurl = [blob.type || "application/octet-stream", a.download, a.href].join(':');
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
}

export function downloadString(text, fileType, fileName) {
  var blob = new Blob([text], { type: fileType });
  downloadBlob(blob, fileName)
}

function slugifyFilePart(value, fallback) {
  const normalized = (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalized || fallback
}

export function getFileBaseName(fileName, fallbackBaseName = "export") {
  const trimmedName = `${fileName ?? ""}`.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim() ?? ""
  if (!trimmedName) {
    return fallbackBaseName
  }

  const extensionIndex = trimmedName.lastIndexOf(".")
  if (extensionIndex <= 0) {
    return trimmedName
  }

  return trimmedName.slice(0, extensionIndex)
}

export function buildTranslatedSrtFileName(fileName, language) {
  const baseName = getFileBaseName(fileName, "export")
  const languageSuffix = slugifyFilePart(language, "translated")
  return `${baseName}_${languageSuffix}.srt`
}

export function buildTranslatedSrtArchivePath(fileName, language) {
  const normalizedFileName = `${fileName ?? ""}`.replace(/\\/g, "/").trim()
  const pathParts = normalizedFileName.split("/").filter(Boolean)
  const fileLeaf = pathParts.pop() ?? "export.srt"
  const translatedFileName = buildTranslatedSrtFileName(fileLeaf, language)

  if (pathParts.length === 0) {
    return translatedFileName
  }

  return `${pathParts.join("/")}/${translatedFileName}`
}

export function buildCombinedSrtFileName(fileName, primaryLanguage, secondaryLanguage) {
  const baseName = getFileBaseName(fileName, "combined")
  const primarySuffix = slugifyFilePart(primaryLanguage, "to")
  const secondarySuffix = slugifyFilePart(secondaryLanguage, "translated")
  return `${baseName}_${primarySuffix}_${secondarySuffix}.srt`
}

export function appendFileNameSuffix(fileName, suffix) {
  const baseName = getFileBaseName(fileName, "export")
  const extensionIndex = (fileName ?? "").trim().lastIndexOf(".")
  const extension = extensionIndex > -1 ? fileName.slice(extensionIndex) : ".srt"
  return `${baseName}_${suffix}${extension}`
}
