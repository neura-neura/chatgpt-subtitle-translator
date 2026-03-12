const TIME_RE = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function splitWithMax(value, separator, maxSplits) {
  if (maxSplits <= 0) {
    return [value]
  }

  const parts = []
  let start = 0
  let splits = 0

  for (let index = 0; index < value.length; index += 1) {
    if (splits >= maxSplits) {
      break
    }
    if (value[index] !== separator) {
      continue
    }
    parts.push(value.slice(start, index))
    start = index + 1
    splits += 1
  }

  parts.push(value.slice(start))
  return parts
}

export function timeToMs(hours, minutes, seconds, milliseconds) {
  return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(milliseconds)
}

export function parseSrtText(text) {
  const subtitles = []
  const content = normalizeLineEndings(text).trim()

  if (!content) {
    return subtitles
  }

  const blocks = content.split(/\n\s*\n/g)

  for (const block of blocks) {
    const lines = block.split("\n")
    if (lines.length < 2) {
      continue
    }

    const index = lines[0].trim()
    const timeLine = lines[1].trim()
    const match = TIME_RE.exec(timeLine)

    if (!match) {
      continue
    }

    const [, sh, sm, ss, sms, eh, em, es, ems] = match
    const start_ms = timeToMs(sh, sm, ss, sms)
    const end_ms = timeToMs(eh, em, es, ems)
    const subtitleText = lines.length > 2 ? lines.slice(2).join("\n").trim() : ""

    subtitles.push({
      index,
      time: timeLine,
      text: subtitleText,
      start_ms,
      end_ms,
    })
  }

  return subtitles
}

function assTimeToMs(value) {
  const parts = value.split(":")
  if (parts.length !== 3) {
    return 0
  }

  const secondsAndCentiseconds = parts[2].split(".")
  if (secondsAndCentiseconds.length !== 2) {
    return 0
  }

  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  const seconds = Number(secondsAndCentiseconds[0])
  const centiseconds = Number(secondsAndCentiseconds[1].padEnd(2, "0"))

  return (hours * 3600 + minutes * 60 + seconds) * 1000 + centiseconds * 10
}

export function parseAssText(text) {
  const subtitles = []
  let header = ""
  let eventsStarted = false
  let formatFields = null

  for (let line of normalizeLineEndings(text).split("\n")) {
    line = line.trimEnd()

    if (!eventsStarted) {
      header += `${line}\n`
      if (line.trim() === "[Events]") {
        eventsStarted = true
      }
      continue
    }

    if (line.startsWith("Format:")) {
      formatFields = line.slice(7).trim().split(",").map(field => field.trim())
      continue
    }

    if (!line.startsWith("Dialogue:") || !formatFields) {
      continue
    }

    const fields = splitWithMax(line.slice(9), ",", formatFields.length - 1).map(field => field.trim())
    if (fields.length !== formatFields.length) {
      continue
    }

    const subtitle = {}
    for (let index = 0; index < formatFields.length; index += 1) {
      subtitle[formatFields[index].toLowerCase()] = fields[index]
    }

    const start = subtitle.start ?? "0:00:00.00"
    const end = subtitle.end ?? "0:00:00.00"
    const start_ms = assTimeToMs(start)
    const end_ms = assTimeToMs(end)

    subtitle.text = subtitle.text ?? ""
    subtitle.start_ms = start_ms
    subtitle.end_ms = end_ms
    subtitle.time = `${start} --> ${end}`
    subtitle.index = String(subtitles.length + 1)
    subtitles.push(subtitle)
  }

  if (formatFields === null) {
    formatFields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"]
  }

  return { subtitles, header, formatFields }
}

export function parseSubtitleText(fileName, text) {
  const lowerCaseName = fileName.toLowerCase()

  if (lowerCaseName.endsWith(".srt")) {
    return { subtitles: parseSrtText(text), format: "srt", header: "", formatFields: null }
  }

  if (lowerCaseName.endsWith(".ass")) {
    const { subtitles, header, formatFields } = parseAssText(text)
    return { subtitles, format: "ass", header, formatFields }
  }

  return { subtitles: [], format: null, header: "", formatFields: null }
}

export function formatTimeMs(milliseconds) {
  let remaining = milliseconds
  const hours = Math.floor(remaining / 3600000)
  remaining %= 3600000
  const minutes = Math.floor(remaining / 60000)
  remaining %= 60000
  const seconds = Math.floor(remaining / 1000)
  remaining %= 1000

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")},${remaining.toString().padStart(3, "0")}`
}

export function formatAssTime(milliseconds) {
  let remaining = milliseconds
  const hours = Math.floor(remaining / 3600000)
  remaining %= 3600000
  const minutes = Math.floor(remaining / 60000)
  remaining %= 60000
  const seconds = Math.floor(remaining / 1000)
  remaining %= 1000
  const centiseconds = Math.floor(remaining / 10)

  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`
}

export function rebuildTimeLine(start_ms, end_ms) {
  return `${formatTimeMs(start_ms)} --> ${formatTimeMs(end_ms)}`
}

export function bestMatch(primary, secondaries, startToleranceMs = 500) {
  const p_start = primary.start_ms
  const p_end = primary.end_ms

  let bestIndex = null
  let bestSubtitle = null
  let bestOverlap = -1

  for (let index = 0; index < secondaries.length; index += 1) {
    const subtitle = secondaries[index]
    const s_start = subtitle.start_ms
    const s_end = subtitle.end_ms
    const overlap = Math.min(p_end, s_end) - Math.max(p_start, s_start)

    if (overlap > bestOverlap && overlap > 0) {
      bestOverlap = overlap
      bestIndex = index
      bestSubtitle = subtitle
    }
  }

  if (bestSubtitle !== null) {
    return [bestIndex, bestSubtitle]
  }

  let nearestIndex = null
  let nearestSubtitle = null
  let nearestDelta = null

  for (let index = 0; index < secondaries.length; index += 1) {
    const subtitle = secondaries[index]
    const delta = Math.abs(subtitle.start_ms - p_start)

    if (delta <= startToleranceMs && (nearestDelta === null || delta < nearestDelta)) {
      nearestDelta = delta
      nearestIndex = index
      nearestSubtitle = subtitle
    }
  }

  return nearestSubtitle !== null ? [nearestIndex, nearestSubtitle] : [null, null]
}

export function combineSubtitles(primarySubtitles, secondarySubtitles, primaryFormat, tag = "{\\rENG}", alwaysAddSecondaryLine = true) {
  const newline = primaryFormat === "srt" ? "\n" : "\\N"
  const combinedSubtitles = []

  for (const subtitle of primarySubtitles) {
    const primaryText = subtitle.text ? subtitle.text : ""
    const [, secondarySubtitle] = bestMatch(subtitle, secondarySubtitles, 500)

    let combinedText = primaryText
    if (secondarySubtitle !== null) {
      const secondaryText = secondarySubtitle.text ? secondarySubtitle.text : ""
      combinedText = primaryText + newline + tag + secondaryText
    }
    else if (alwaysAddSecondaryLine) {
      combinedText += newline + tag
    }

    combinedSubtitles.push({
      ...subtitle,
      text: combinedText,
    })
  }

  return combinedSubtitles
}

export function buildCombinedSrtText(combinedSubtitles) {
  const srtCombined = []
  let newIndex = 1

  for (const subtitle of combinedSubtitles) {
    const timeLine = rebuildTimeLine(subtitle.start_ms, subtitle.end_ms)
    const subtitleText = (subtitle.text ?? "").replace(/\\N/g, "\n")
    srtCombined.push(`${newIndex}\n${timeLine}\n${subtitleText}`)
    newIndex += 1
  }

  return `${srtCombined.join("\n\n")}\n`
}
