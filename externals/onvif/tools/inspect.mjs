#!/usr/bin/env node
// Interactive ONVIF inspector: scan the network, connect with saved
// credentials and inspect what each camera really advertises and emits —
// device info, topic tree, detection-type mapping, live events with parser
// verdicts, PTZ spaces. Run `npm run build` first, then `npm run inspect`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import {
  categorizeEvent,
  Discovery,
  extractTopicPaths,
  getSupportedDetectionTypes,
  messagePayload,
  Onvif,
  parseAudioEvent,
  parseDetectionEvent,
  parseMotionEvent
} from '../dist/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CREDENTIALS_FILE = join(__dirname, '.inspect-credentials.json')

const rl = createInterface({ input: process.stdin, output: process.stdout })

function loadStore() {
  if (!existsSync(CREDENTIALS_FILE)) return { devices: {} }
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'))
  } catch {
    return { devices: {} }
  }
}

function saveStore(store) {
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true })
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

const store = loadStore()

function deviceKey(host, port) {
  return `${host}:${port}`
}

function listDevices() {
  const keys = Object.keys(store.devices)
  if (keys.length === 0) {
    console.log('no saved devices — use "scan" or "add <host> [port]"')
    return []
  }
  keys.forEach((key, i) => {
    const d = store.devices[key]
    console.log(`  [${i}] ${key}  ${d.name ?? ''}`)
  })
  return keys
}

async function promptCredentials(key) {
  const existing = store.devices[key]
  const username = (await rl.question(`username for ${key}${existing?.username ? ` [${existing.username}]` : ''}: `)) || existing?.username || ''
  const password = (await rl.question(`password for ${key}${existing?.password ? ' [saved]' : ''}: `)) || existing?.password || ''
  return { username, password }
}

async function connect(host, port) {
  const key = deviceKey(host, port)
  const creds = store.devices[key]?.username ? store.devices[key] : await promptCredentials(key)

  const cam = new Onvif({
    hostname: host,
    port,
    username: creds.username,
    password: creds.password,
    preserveAddress: true
  })
  await cam.connect()

  let name = store.devices[key]?.name
  try {
    const info = await cam.device.getDeviceInformation()
    name = `${info.manufacturer ?? ''} ${info.model ?? ''}`.trim()
  } catch {
    // keep whatever we had
  }

  store.devices[key] = { host, port, username: creds.username, password: creds.password, name }
  saveStore(store)
  console.log(`connected: ${key} ${name ?? ''}`)
  return cam
}

async function scan() {
  console.log('probing network (5s)...')
  const found = await Discovery.probe({ timeout: 5000, resolve: true })
  if (found.length === 0) {
    console.log('nothing found')
    return
  }
  for (const dev of found) {
    const host = dev.hostname ?? '(unknown)'
    const port = dev.port ?? 80
    const key = deviceKey(host, port)
    const known = store.devices[key] ? ' (saved)' : ''
    console.log(`  ${key}${known}`)
    if (!store.devices[key]) {
      const answer = await rl.question('  save this device? [y/N] ')
      if (answer.toLowerCase() === 'y') {
        const creds = await promptCredentials(key)
        store.devices[key] = { host, port, ...creds }
        saveStore(store)
      }
    }
  }
}

function collectSimpleItems(section) {
  if (!section?.simpleItem) return ''
  const items = Array.isArray(section.simpleItem) ? section.simpleItem : [section.simpleItem]
  return items.map((item) => `${item.name}=${item.value}`).join(' ')
}

function describeParsers(message) {
  const verdicts = []
  const motion = parseMotionEvent(message)
  if (motion) verdicts.push(`motion isMotion=${motion.isMotion}`)
  const detection = parseDetectionEvent(message)
  if (detection) verdicts.push(`${detection.category} isDetected=${detection.isDetected}${detection.rule ? ` rule=${detection.rule}` : ''}`)
  const audio = parseAudioEvent(message)
  if (audio) verdicts.push(`audio isDetected=${audio.isAudioDetected ?? audio.isDetected}`)
  return verdicts.length > 0 ? verdicts.join(' | ') : 'UNPARSED'
}

async function watch(cam, raw) {
  console.log('watching events — press Enter to stop')

  const onEvent = (message) => {
    const time = new Date().toTimeString().slice(0, 8)
    const topic = message.topic?._ ?? '(no topic)'
    const payload = messagePayload(message)
    const op = payload?.propertyOperation ?? '-'
    const data = collectSimpleItems(payload?.data)
    const source = collectSimpleItems(payload?.source)
    console.log(`${time} [${categorizeEvent(topic)}] ${topic} (${op})`)
    if (data) console.log(`         data: ${data}`)
    if (source) console.log(`         source: ${source}`)
    console.log(`         parsed: ${describeParsers(message)}`)
    if (raw) console.log(`         raw: ${JSON.stringify(message)}`)
  }
  const onPull = (count) => {
    if (count === 0) console.log(`${new Date().toTimeString().slice(0, 8)} (empty pull cycle)`)
  }
  const onError = (error) => console.log(`event error: ${error?.message ?? error}`)
  const onResubscribed = () => console.log('(re)subscribed')
  const onRenewFailed = (error) => console.log(`renew failed: ${error?.message ?? error}`)

  cam.events.on('event', onEvent)
  cam.events.on('pull', onPull)
  cam.events.on('error', onError)
  cam.events.on('resubscribed', onResubscribed)
  cam.events.on('renewfailed', onRenewFailed)
  cam.events.startEventLoop({ messageLimit: 100 })

  await rl.question('')

  cam.events.stopEventLoop()
  cam.events.off('event', onEvent)
  cam.events.off('pull', onPull)
  cam.events.off('error', onError)
  cam.events.off('resubscribed', onResubscribed)
  cam.events.off('renewfailed', onRenewFailed)
  console.log('stopped watching')
}

async function showTopics(cam) {
  const props = await cam.events.getEventProperties()
  if (!props.topicSet) {
    console.log('camera reports no topicSet')
    return
  }
  const topics = extractTopicPaths(props.topicSet)
  console.log(`advertised topics (${topics.length}):`)
  for (const topic of topics.sort()) {
    console.log(`  ${topic}  → category: ${categorizeEvent(topic)}`)
  }
  const types = getSupportedDetectionTypes(props)
  console.log(`detection types the plugin would create: ${types.join(', ') || '(none)'}`)
}

async function showInfo(cam) {
  try {
    const info = await cam.device.getDeviceInformation()
    console.log(`manufacturer: ${info.manufacturer}  model: ${info.model}`)
    console.log(`firmware: ${info.firmwareVersion}  serial: ${info.serialNumber}`)
  } catch (error) {
    console.log(`device info failed: ${error.message}`)
  }
  console.log(`profiles: ${cam.profiles?.length ?? 0}, default: ${cam.defaultProfile?.name ?? '-'}`)
  console.log(`services: ${Object.keys(cam.uri ?? {}).join(', ')}`)
}

async function showPtz(cam) {
  const cfg = cam.defaultProfile?.PTZConfiguration
  if (!cfg) {
    console.log('no PTZ configuration on default profile')
    return
  }
  const spaceName = (uri) => uri?.split('/').pop()
  console.log('default spaces:', {
    absolutePanTilt: spaceName(cfg.defaultAbsolutePantTiltPositionSpace),
    relativePanTilt: spaceName(cfg.defaultRelativePanTiltTranslationSpace),
    continuousPanTilt: spaceName(cfg.defaultContinuousPanTiltVelocitySpace),
    absoluteZoom: spaceName(cfg.defaultAbsoluteZoomPositionSpace),
    relativeZoom: spaceName(cfg.defaultRelativeZoomTranslationSpace),
    continuousZoom: spaceName(cfg.defaultContinuousZoomVelocitySpace)
  })
  try {
    const nodes = await cam.ptz.getNodes()
    for (const node of Object.values(nodes ?? {})) {
      const byType = {}
      for (const [key, descs] of Object.entries(node.supportedPTZSpaces ?? {})) {
        if (!Array.isArray(descs)) continue
        for (const desc of descs) {
          const uri = desc?.URI
          if (uri) (byType[key] ??= []).push(spaceName(uri))
        }
      }
      console.log(`node "${node.token ?? '?'}" spaces:`, byType)
      console.log(`  home: ${node.homeSupported ?? false}, presets: ${node.maximumNumberOfPresets ?? 0}`)
    }
  } catch (error) {
    console.log(`getNodes failed: ${error.message}`)
  }
  try {
    const status = await cam.ptz.getStatus()
    console.log('status:', JSON.stringify(status))
  } catch (error) {
    console.log(`getStatus failed: ${error.message}`)
  }
}

const PAN_TILT_SPACES = {
  fov: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov',
  generic: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace'
}

async function testMove(cam, dx, dy, spaceArg) {
  if (Number.isNaN(dx) || Number.isNaN(dy)) {
    console.log('usage: move <dx> <dy> [fov|generic]  (deltas -1..1, default space of the camera if omitted)')
    return
  }
  const space = spaceArg ? PAN_TILT_SPACES[spaceArg] : undefined
  if (spaceArg && !space) {
    console.log(`unknown space "${spaceArg}" — use fov or generic`)
    return
  }
  const posOf = (status) => {
    const pt = status?.position?.panTilt
    return pt ? `pan=${pt.x} tilt=${pt.y}` : '(no position)'
  }
  const before = await cam.ptz.getStatus().catch(() => undefined)
  console.log(`before: ${posOf(before)}`)
  await cam.ptz.relativeMove({ translation: { panTilt: { x: dx, y: dy, ...(space ? { space } : {}) } } })
  console.log(`sent relativeMove dx=${dx} dy=${dy} space=${spaceArg ?? '(default)'}`)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const after = await cam.ptz.getStatus().catch(() => undefined)
  console.log(`after:  ${posOf(after)}`)
}

async function auditAll() {
  const keys = Object.keys(store.devices)
  if (keys.length === 0) {
    console.log('no saved devices')
    return
  }
  for (const key of keys) {
    const d = store.devices[key]
    process.stdout.write(`${key.padEnd(22)} `)
    try {
      const cam = await connectQuiet(d)
      const props = await cam.events.getEventProperties().catch(() => undefined)
      const types = props ? getSupportedDetectionTypes(props) : []
      const cfg = cam.defaultProfile?.PTZConfiguration
      const fov = JSON.stringify(props?.topicSet ?? {}).length // rough topic tree size
      const ptz = cfg ? (cfg.defaultRelativePanTiltTranslationSpace?.includes('Fov') ? 'ptz(fov)' : 'ptz') : '-'
      console.log(`${(d.name ?? '').padEnd(28)} ${ptz.padEnd(9)} types: ${types.join(',') || '-'}  topics~${fov}b`)
    } catch (error) {
      console.log(`FAILED: ${error.message}`)
    }
  }
}

async function connectQuiet(d) {
  const cam = new Onvif({
    hostname: d.host,
    port: d.port,
    username: d.username,
    password: d.password,
    preserveAddress: true
  })
  await cam.connect()
  return cam
}

async function deviceMenu(cam, key) {
  for (;;) {
    const cmd = await rl.question(`[${key}] info | topics | watch | watch raw | ptz | move <dx> <dy> [fov|generic] | back > `)
    try {
      if (cmd === 'info') await showInfo(cam)
      else if (cmd === 'topics') await showTopics(cam)
      else if (cmd === 'watch') await watch(cam, false)
      else if (cmd === 'watch raw') await watch(cam, true)
      else if (cmd === 'ptz') await showPtz(cam)
      else if (cmd.startsWith('move')) {
        const [, dx, dy, spaceArg] = cmd.split(/\s+/)
        await testMove(cam, Number(dx), Number(dy), spaceArg)
      } else if (cmd === 'back' || cmd === 'q') return
      else console.log('unknown command')
    } catch (error) {
      console.log(`error: ${error.message}`)
    }
  }
}

async function main() {
  console.log('onvif inspector — scan | add <host> [port] | list | use <n> | audit | quit')
  for (;;) {
    const line = (await rl.question('> ')).trim()
    const [cmd, ...args] = line.split(/\s+/)
    try {
      if (cmd === 'scan') await scan()
      else if (cmd === 'add') {
        const host = args[0]
        const port = Number(args[1] ?? 80)
        if (!host) {
          console.log('usage: add <host> [port]')
          continue
        }
        const key = deviceKey(host, port)
        const creds = await promptCredentials(key)
        store.devices[key] = { host, port, ...creds }
        saveStore(store)
      } else if (cmd === 'list') listDevices()
      else if (cmd === 'use') {
        const keys = Object.keys(store.devices)
        const idx = Number(args[0])
        const key = keys[idx]
        if (!key) {
          console.log('usage: use <index> (see "list")')
          continue
        }
        const d = store.devices[key]
        const cam = await connect(d.host, d.port)
        await deviceMenu(cam, key)
      } else if (cmd === 'audit') await auditAll()
      else if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') break
      else if (cmd) console.log('unknown command')
    } catch (error) {
      console.log(`error: ${error.message}`)
    }
  }
  rl.close()
}

await main()
