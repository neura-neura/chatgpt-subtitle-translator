export function downloadString(text, fileType, fileName) {
  var blob = new Blob([text], { type: fileType });

  var a = document.createElement('a');
  a.download = fileName;
  a.href = URL.createObjectURL(blob);
  a.dataset.downloadurl = [fileType, a.download, a.href].join(':');
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
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
  const trimmedName = (fileName ?? "").trim()
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

export function buildCombinedSrtFileName(fileName, primaryLanguage, secondaryLanguage) {
  const baseName = getFileBaseName(fileName, "combined")
  const primarySuffix = slugifyFilePart(primaryLanguage, "source")
  const secondarySuffix = slugifyFilePart(secondaryLanguage, "translated")
  return `${baseName}_${primarySuffix}_${secondarySuffix}.srt`
}
