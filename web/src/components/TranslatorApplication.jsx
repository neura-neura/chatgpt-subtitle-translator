"use client"
import React, { useEffect, useRef, useState } from 'react'
import { Button, Input, Card, Textarea, Slider, Switch, CardHeader, CardBody, Divider } from "@nextui-org/react";

import { EyeSlashFilledIcon } from './EyeSlashFilledIcon';
import { EyeFilledIcon } from './EyeFilledIcon';

import { FileUploadButton } from '@/components/FileUploadButton';
import { SubtitleCard } from '@/components/SubtitleCard';
import { downloadString } from '@/utils/download';
import { sampleSrt } from '@/data/sample';

import { Translator, TranslatorStructuredArray, subtitleParser, createOpenAIClient, CooldownContext } from "chatgpt-subtitle-translator"

const OPENAI_API_KEY = "OPENAI_API_KEY"
const OPENAI_BASE_URL = "OPENAI_BASE_URL"
const RATE_LIMIT = "RATE_LIMIT"
const MODEL = "MODEL"
const OLLAMA_GITHUB_PAGES_HINT_DISMISSED = "OLLAMA_GITHUB_PAGES_HINT_DISMISSED"
const SYSTEM_INSTRUCTION_PRESETS = "SYSTEM_INSTRUCTION_PRESETS"

const PreviousDefaultModel = "gpt-4o-mini"
const DefaultModel = "gemma3:12b-it-qat"
const DefaultTemperature = 0
const DefaultOllamaBaseUrl = "http://localhost:11434/v1"

export function TranslatorApplication() {
  // Translator Configuration
  const [APIvalue, setAPIValue] = useState("")
  const [baseUrlValue, setBaseUrlValue] = useState(undefined)
  const [fromLanguage, setFromLanguage] = useState("")
  const [toLanguage, setToLanguage] = useState("English")
  const [systemInstruction, setSystemInstruction] = useState("")
  const [model, setModel] = useState(DefaultModel)
  const [temperature, setTemperature] = useState(DefaultTemperature)
  const [batchSizes, setBatchSizes] = useState([10, 50])
  const [useStructuredMode, setUseStructuredMode] = useState(false)
  const [rateLimit, setRateLimit] = useState(60)
  const [systemInstructionTitle, setSystemInstructionTitle] = useState("")
  const [systemInstructionDescription, setSystemInstructionDescription] = useState("")
  const [savedSystemInstructions, setSavedSystemInstructions] = useState([])
  const [selectedSystemInstructionId, setSelectedSystemInstructionId] = useState("")

  const [isAPIInputVisible, setIsAPIInputVisible] = useState(false)
  const toggleAPIInputVisibility = () => setIsAPIInputVisible(!isAPIInputVisible)

  // Translator State
  const [srtInputText, setSrtInputText] = useState(sampleSrt)
  const [srtOutputText, setSrtOutputText] = useState(sampleSrt)
  const [inputs, setInputs] = useState(subtitleParser.fromSrt(sampleSrt).map(x => x.text))
  const [outputs, setOutput] = useState([])
  const [streamOutput, setStreamOutput] = useState("")
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

  // Persistent Data Restoration
  useEffect(() => {
    setAPIValue(localStorage.getItem(OPENAI_API_KEY) ?? "")
    setRateLimit(Number(localStorage.getItem(RATE_LIMIT) ?? rateLimit))
    setBaseUrlWithModerator(localStorage.getItem(OPENAI_BASE_URL) ?? undefined)
    const storedModel = localStorage.getItem(MODEL)
    setModelValue(!storedModel || storedModel === PreviousDefaultModel ? DefaultModel : storedModel)
    setSiteOrigin(window.location.origin)
    setHideOllamaPagesHint(localStorage.getItem(OLLAMA_GITHUB_PAGES_HINT_DISMISSED) === "true")
    try {
      setSavedSystemInstructions(JSON.parse(localStorage.getItem(SYSTEM_INSTRUCTION_PRESETS) ?? "[]"))
    } catch {
      setSavedSystemInstructions([])
    }
  }, [])

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
    setSelectedSystemInstructionId("")
    setSystemInstructionTitle("")
    setSystemInstructionDescription("")
  }

  function saveSystemInstructionPreset() {
    if (!systemInstruction.trim() || !systemInstructionTitle.trim() || !systemInstructionDescription.trim()) {
      return
    }

    const presetId = selectedSystemInstructionId || crypto.randomUUID()
    const nextPreset = {
      id: presetId,
      title: systemInstructionTitle.trim(),
      description: systemInstructionDescription.trim(),
      text: systemInstruction.trim()
    }

    const nextPresets = selectedSystemInstructionId
      ? savedSystemInstructions.map(preset => preset.id === presetId ? nextPreset : preset)
      : [nextPreset, ...savedSystemInstructions]

    persistSystemInstructionPresets(nextPresets)
    setSelectedSystemInstructionId(presetId)
  }

  function applySystemInstructionPreset(preset) {
    setSelectedSystemInstructionId(preset.id)
    setSystemInstructionTitle(preset.title)
    setSystemInstructionDescription(preset.description)
    setSystemInstruction(preset.text)
  }

  function deleteSystemInstructionPreset(presetId) {
    const nextPresets = savedSystemInstructions.filter(preset => preset.id !== presetId)
    persistSystemInstructionPresets(nextPresets)

    if (selectedSystemInstructionId === presetId) {
      clearSystemInstructionPresetForm()
    }
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
    setIsTestingConnection(true)
    setConnectionTestState("testing")
    setConnectionTestMessage(`Testing ${baseUrl} ...`)

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: APIvalue ? { Authorization: `Bearer ${APIvalue}` } : undefined,
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
          : `Connected. Ollama responded and exposed ${models.length} model(s).`
      )
    } catch (error) {
      setConnectionTestState("error")
      setConnectionTestMessage(error?.message ?? String(error))
    } finally {
      setIsTestingConnection(false)
    }
  }

  async function generate(e) {
    e.preventDefault()
    setTranslatorRunningState(true)
    console.log("[User Interface]", "Begin Generation")
    translatorRunningRef.current = true
    setOutput([])
    setUsageInformation(null)
    let currentStream = ""
    const outputWorkingProgress = subtitleParser.fromSrt(srtInputText)
    const currentOutputs = []
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
        currentOutputs.push(output.finalTransform)
        const srtEntry = outputWorkingProgress[output.index - 1]
        srtEntry.text = output.finalTransform
        setOutput([...currentOutputs])
        setUsageInformation(translatorRef.current.usage)
        setRPMInformation(translatorRef.current.services.cooler?.rate)
      }
      console.log({ sourceInputWorkingCopy: outputWorkingProgress })
      setSrtOutputText(subtitleParser.toSrt(outputWorkingProgress))
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
                          <p>12. Start Ollama again in PowerShell: <code>Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"</code></p>
                          <p>13. Or start it from cmd: <code>start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"</code></p>
                          <p>14. Back on this page, enter the values shown above and click <code>Test Ollama Connection</code>.</p>
                          <p>15. When the test passes, click <code>Import SRT</code>, then <code>Start</code>, and finally <code>Export SRT</code>.</p>
                        </div>

                        <div className="grid gap-1">
                          <p><b>Official references</b></p>
                          <p><a className="text-primary underline" href="https://docs.ollama.com/windows" target="_blank" rel="noopener noreferrer">Ollama for Windows</a></p>
                          <p><a className="text-primary underline" href="https://docs.ollama.com/api/openai-compatibility" target="_blank" rel="noopener noreferrer">OpenAI compatibility</a></p>
                          <p><a className="text-primary underline" href="https://docs.ollama.com/faq" target="_blank" rel="noopener noreferrer">OLLAMA_ORIGINS / FAQ</a></p>
                          <p><a className="text-primary underline" href="https://ollama.com/library/gemma3" target="_blank" rel="noopener noreferrer">Gemma 3 models</a></p>
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
                      onValueChange={setToLanguage}
                    />
                  </div>

                  <div className='w-full'>
                    <Textarea
                      label="System Instruction"
                      minRows={2}
                      description={"Override preset system instruction"}
                      placeholder={`Translate ${fromLanguage ? fromLanguage + " " : ""}to ${toLanguage}`}
                      value={systemInstruction}
                      onValueChange={setSystemInstruction}
                    />
                  </div>

                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <Input
                      className='w-full md:w-4/12'
                      size='sm'
                      type="text"
                      label="Instruction Title"
                      placeholder="Anime JP -> ES"
                      value={systemInstructionTitle}
                      onValueChange={setSystemInstructionTitle}
                    />
                    <Input
                      className='w-full md:w-5/12'
                      size='sm'
                      type="text"
                      label="Instruction Description"
                      placeholder="Keep honorifics, concise subtitles, natural Spanish"
                      value={systemInstructionDescription}
                      onValueChange={setSystemInstructionDescription}
                    />
                    <div className='w-full md:w-3/12 flex items-end gap-2'>
                      <Button
                        className='w-full'
                        type='button'
                        color="primary"
                        variant="flat"
                        onClick={saveSystemInstructionPreset}
                        isDisabled={!systemInstruction.trim() || !systemInstructionTitle.trim() || !systemInstructionDescription.trim()}
                      >
                        Save Instruction
                      </Button>
                      <Button
                        type='button'
                        variant="light"
                        onClick={clearSystemInstructionPresetForm}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>

                  {savedSystemInstructions.length > 0 && (
                    <div className='w-full'>
                      <p className='text-sm font-semibold mb-2'>Saved System Instructions</p>
                      <div className='grid gap-3'>
                        {savedSystemInstructions.map((preset) => (
                          <Card key={preset.id} shadow="sm" className={`border ${selectedSystemInstructionId === preset.id ? 'border-primary' : ''}`}>
                            <CardBody className="flex flex-wrap md:flex-nowrap items-start justify-between gap-3">
                              <div className='flex-1'>
                                <p className='font-semibold'>{preset.title}</p>
                                <p className='text-sm text-default-500'>{preset.description}</p>
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

                  <div className='flex flex-wrap md:flex-nowrap w-full gap-4'>
                    <div className='w-full md:w-1/5'>
                      <Input
                        size='sm'
                        type="text"
                        label="Model"
                        placeholder={DefaultModel}
                        autoComplete='on'
                        value={model}
                        onValueChange={setModelValue}
                      />
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
          <FileUploadButton label={"Import SRT"} onFileSelect={async (file) => {
            // console.log("File", file);
            try {
              const text = await file.text()
              const parsed = subtitleParser.fromSrt(text)
              setSrtInputText(text)
              setInputs(parsed.map(x => x.text))
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
            // console.log(srtOutputText)
            downloadString(srtOutputText, "text/plain", "export.srt")
          }}>
            Export SRT
          </Button>
          <Divider className='mt-3 sm:mt-0' />
        </div>

        <div className="lg:flex lg:gap-4 px-4 mt-4">
          <div className="lg:w-1/2">
            <SubtitleCard label={"Input"}>
              <ol className="py-2 list-decimal line-marker ">
                {inputs.map((line, i) => {
                  return (
                    <li key={i} className=''>
                      <div className='ml-4 truncate'>
                        {line}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </SubtitleCard>
          </div>

          <div className="lg:w-1/2">
            <SubtitleCard label={"Output"}>
              <ol className="py-2 list-decimal line-marker ">
                {outputs.map((line, i) => {
                  return (
                    <li key={i} className=''>
                      <div className='ml-4 truncate'>
                        {line}
                      </div>
                    </li>
                  )
                })}
                <pre className='px-2 text-wrap'>
                  {streamOutput}
                </pre>
              </ol>
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
    </>
  )
}
