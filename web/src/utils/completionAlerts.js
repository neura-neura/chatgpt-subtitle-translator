export async function primeCompletionAudio(existingAudioContext) {
  if (typeof window === "undefined") {
    return existingAudioContext ?? null
  }

  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext
  if (!AudioContextClass) {
    return existingAudioContext ?? null
  }

  const audioContext = existingAudioContext ?? new AudioContextClass()
  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(() => {})
  }

  return audioContext
}

export function playCompletionSound(audioContext) {
  if (!audioContext) {
    return
  }

  const startAt = audioContext.currentTime + 0.02
  const notes = [659.25, 880, 1174.66]

  notes.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()
    const noteStart = startAt + (index * 0.18)
    const noteEnd = noteStart + 0.16

    oscillator.type = "sine"
    oscillator.frequency.value = frequency

    gainNode.gain.setValueAtTime(0.0001, noteStart)
    gainNode.gain.exponentialRampToValueAtTime(0.18, noteStart + 0.03)
    gainNode.gain.exponentialRampToValueAtTime(0.0001, noteEnd)

    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)
    oscillator.start(noteStart)
    oscillator.stop(noteEnd)
  })
}

export async function ensureCompletionNotificationPermission() {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported"
  }

  if (Notification.permission !== "default") {
    return Notification.permission
  }

  return Notification.requestPermission()
}

export function showCompletionNotification(title, body) {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return null
  }

  if (Notification.permission !== "granted") {
    return null
  }

  return new Notification(title, {
    body,
    tag: "subtitle-translation-complete",
  })
}
