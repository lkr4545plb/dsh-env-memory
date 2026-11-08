/**
 * dsh-env-memory — one authoritative environment record for every session.
 *
 * Host-only Cordis plugin. It probes the machine locally (milliseconds, no model
 * tokens), keeps a capability contract plus a bounded changelog, renders a
 * byte-stable snapshot into the system prompt, and exposes the detail on demand
 * through the `env_memory` tool.
 *
 * @module dsh-env-memory
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'env-memory'
/** Services this plugin registers against. */
export const inject = ['systemPrompt', 'tools']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STORE_DIR = path.join(DSH_HOME, 'env-memory')
const STATE_FILE = path.join(STORE_DIR, 'state.json')
const SNAPSHOT_FILE = path.join(STORE_DIR, 'SNAPSHOT.md')
const CHANGELOG_FILE = path.join(STORE_DIR, 'CHANGELOG.md')

/** Capabilities worth a presence probe, with the flag their version command takes. */
const CAPS = {
  python3: '-V', python: '-V', pip3: '-V', pip: '-V', uv: '--version',
  node: '-v', npm: '-v', pnpm: '-v', yarn: '-v', bun: '-v', deno: '-V', npx: '-v', corepack: '-v', tsx: '--version', tsc: '-v',
  cargo: '--version', rustc: '--version', go: 'version',
  java: '-version', javac: '-version', mvn: '-v', gradle: '-v', dotnet: '--version',
  docker: '--version', podman: '--version', kubectl: 'version', helm: 'version', terraform: 'version', aws: '--version', gcloud: '--version',
  git: '--version', gh: '--version', rg: '--version', fd: '--version', jq: '--version', yq: '--version',
  curl: '--version', wget: '--version', rsync: '--version', ssh: '-V', tmux: '-V', screen: '-v', htop: '--version',
  ffmpeg: '-version', convert: '--version', chromium: '--version', 'google-chrome': '--version', playwright: '--version',
  sqlite3: '-version', zstd: '-V', unzip: '-v', '7z': 'i', pandoc: '-v', protoc: '--version',
  make: '-v', gcc: '--version', 'g++': '--version', clang: '--version', cmake: '--version', ninja: '--version', 'pkg-config': '--version',
  openssl: 'version', psql: '--version', 'redis-cli': '--version', mongosh: '--version', php: '-v', ruby: '-v', perl: '-v', lua: '-v',
  systemctl: '--version', ufw: '--version', iptables: '--version', crontab: '--version', socat: '-V', nc: '-h',
}

/** Durable-shaped install commands whose success may add a capability. */
const INSTALL = /(?:apt-get|apt|dpkg)\s+(?:install|-i)|pip3?\s+install|uv\s+(?:pip\s+)?install|npm\s+(?:i|install)\s+-g|pnpm\s+(?:add|install)\s+-g|yarn\s+global\s+add|cargo\s+install|go\s+install|brew\s+install|rustup\s+component|corepack\s+enable/

/** Package name → the binary it provides, when the mapping is not the name itself. */
const BIN_ALIAS = {
  'python3-pip': 'pip3', 'python-is-python3': 'python', 'nodejs': 'node',
  'ffmpeg': 'ffmpeg', 'jq': 'jq', 'ripgrep': 'rg', 'fd-find': 'fd',
  'docker.io': 'docker', 'docker-ce': 'docker', 'postgresql-client': 'psql',
}

const NOT_FOUND = /(command not found|ModuleNotFoundError|No module named|No such file or directory|not found: )/i

/* ------------------------------------------------------------------ runtime */

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: 4 << 20, env: process.env }, (error, stdout, stderr) => {
        resolve({ ok: error === null, out: String(stdout ?? ''), err: String(stderr ?? '') })
      })
    } catch (error) {
      resolve({ ok: false, out: '', err: String(error && error.message) })
    }
  })
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function freshState() {
  return { rev: 0, fp: '', updatedAt: 0, fullScanAt: 0, caps: {}, terrain: [], profile: {}, dsh: {}, traps: [], changelog: [], discovery: {} }
}

function mergeState(raw) {
  const base = freshState()
  if (raw === null || typeof raw !== 'object') return base
  return {
    ...base,
    ...raw,
    caps: raw.caps && typeof raw.caps === 'object' ? raw.caps : {},
    terrain: Array.isArray(raw.terrain) ? raw.terrain : [],
    traps: Array.isArray(raw.traps) ? raw.traps : [],
    changelog: Array.isArray(raw.changelog) ? raw.changelog : [],
    discovery: raw.discovery && typeof raw.discovery === 'object' ? raw.discovery : {},
  }
}

/* -------------------------------------------------------------------- probes */

async function fingerprint() {
  const hash = createHash('sha256')
  for (const file of ['/etc/os-release', '/proc/sys/kernel/osrelease', '/etc/hostname']) {
    try {
      hash.update(fs.readFileSync(file))
    } catch { /* absent on some hosts */ }
  }
  hash.update(os.arch())
  hash.update(process.env.DSH_PROFILE || '')
  return hash.digest('hex').slice(0, 8)
}

async function probePresence(bins) {
  const list = bins.map((bin) => `'${bin.replace(/'/g, '')}'`).join(' ')
  const script = `for t in ${list}; do p=$(command -v "$t" 2>/dev/null); printf '%s\\t%s\\n' "$t" "\${p:--}"; done`
  const { out } = await run('bash', ['-c', script], 15000)
  const found = {}
  for (const line of out.split('\n')) {
    const [bin, where] = line.split('\t')
    if (bin) found[bin] = where === '-' || where === undefined ? null : where
  }
  return found
}

async function probeVersions(bins) {
  if (bins.length === 0) return {}
  const lines = bins.map((bin) => {
    const flag = CAPS[bin] || '--version'
    return `printf '%s\\t%s\\n' '${bin}' "$(timeout 3 ${bin} ${flag} 2>&1 | head -1 | cut -c1-60)"`
  })
  const { out } = await run('bash', ['-c', lines.join('; ')], 20000)
  const versions = {}
  for (const line of out.split('\n')) {
    const [bin, ...rest] = line.split('\t')
    if (bin) versions[bin] = rest.join('\t').trim()
  }
  return versions
}

function listShallow(dir, max = 10) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const noise = /^(\.|activate-|.*\.bak|.*\.log$|.*\.lock$)/
    const dirs = entries.filter((entry) => entry.isDirectory() && !noise.test(entry.name)).map((entry) => `${entry.name}/`).sort()
    const files = entries.filter((entry) => entry.isFile() && !noise.test(entry.name)).map((entry) => entry.name).sort()
    const names = [...dirs, ...files]
    const shown = names.slice(0, max)
    return shown.length < names.length ? [...shown, `+${names.length - shown.length}`] : shown
  } catch {
    return []
  }
}

function describeProfile() {
  const dir = process.env.DSH_PROFILE_DIR
  const profile = process.env.DSH_PROFILE || ''
  if (dir === undefined) return { name: profile }
  const patch = path.join(dir, 'cordis.patch.yml')
  try {
    const text = fs.readFileSync(patch, 'utf8')
    const rows = (text.match(/^\s*-\s+id:/gm) || []).length
    const inserts = (text.match(/^\s*-\s+insert:/gm) || []).length
    return { name: profile, patchBytes: Buffer.byteLength(text), rows, inserts }
  } catch {
    return { name: profile }
  }
}

function describeDsh() {
  for (const dir of [path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'), '/opt/node/lib/node_modules/@deepseek-ai/dsh']) {
    const pkg = readJson(path.join(dir, 'package.json'))
    if (pkg && typeof pkg.version === 'string') return { version: pkg.version, dir: path.resolve(dir) }
  }
  return {}
}

function collectTraps(caps) {
  const traps = []
  if (caps.docker && caps.docker.state === 'present' && caps.docker.version) {
    traps.push('沙箱模式 PATH 更窄，docker/node 在沙箱内可能 not found')
  }
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
  if (proxy) traps.push(`出网走代理 ${proxy}`)
  if (!caps.cargo || caps.cargo.state !== 'present') traps.push('无 cargo：rust 系工具不可用，别用 cargo install 绕过')
  if (!caps.uv || caps.uv.state !== 'present') traps.push('无 uv：python 依赖用 pip --break-system-packages 或 venv')
  return traps.slice(0, 5)
}

function diagnosable(where, error) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    const line = `${new Date().toISOString()} ${where}: ${error && error.message ? error.message : String(error)}\n`
    fs.appendFileSync(path.join(STORE_DIR, 'diagnostics.log'), line)
  } catch { /* ignore */ }
}

async function fullScan(state, reason) {
  const bins = Object.keys(CAPS)
  const presence = await probePresence(bins)
  const present = bins.filter((bin) => presence[bin])
  const versions = await probeVersions(present)
  const now = Date.now()
  for (const bin of bins) {
    const where = presence[bin]
    const previous = state.caps[bin]
    if (where) {
      state.caps[bin] = {
        state: 'present',
        path: where,
        version: versions[bin] || previous?.version || '',
        source: previous?.state === 'present' ? previous.source : 'observed',
        at: now,
        contradictions: previous?.contradictions ?? 0,
      }
    } else {
      state.caps[bin] = {
        state: 'absent',
        path: '',
        version: '',
        source: previous?.state === 'absent' ? previous.source : 'observed',
        at: now,
        contradictions: previous?.contradictions ?? 0,
      }
    }
  }
  const terrain = []
  const home = listShallow(DSH_HOME)
  if (home.length > 0) terrain.push(`~/.dsh → ${home.join(' ')}`)
  const cwd = process.env.DSH_WORKSPACE || process.cwd()
  const workspace = listShallow(cwd)
  if (workspace.length > 0) terrain.push(`${cwd.replace(os.homedir(), '~')} → ${workspace.join(' ')}`)
  const dsh = describeDsh()
  if (dsh.dir) terrain.push(`dsh 源码 ${dsh.dir}（读实现来这里，不在工作区）`)
  state.terrain = terrain
  state.profile = describeProfile()
  state.dsh = dsh
  state.traps = collectTraps(state.caps)
  state.fp = await fingerprint()
  state.fullScanAt = now
  state.updatedAt = now
  pushLog(state, `全量扫描(${reason})`, 'scan')
}

/* -------------------------------------------------------------------- render */

function versionOf(cap) {
  const raw = String(cap?.version || '').trim()
  if (raw === '') return ''
  const match = raw.match(/(\d+\.\d+(?:\.\d+)?)/)
  return match ? match[1] : ''
}

function ageLabel(at) {
  if (!at) return 'unknown'
  const hours = (Date.now() - at) / 3_600_000
  if (hours < 1) return 'now'
  if (hours < 24) return `${Math.floor(hours)}h`
  return `${Math.floor(hours / 24)}d`
}

function renderSnapshot(state, maxChars, contract) {
  const caps = state.caps || {}
  const present = []
  const absent = []
  for (const [bin, cap] of Object.entries(caps)) {
    if (cap.state === 'present') present.push(bin === 'python3' && versionOf(cap) ? `python3 ${versionOf(cap)}` : versionOf(cap) ? `${bin} ${versionOf(cap)}` : bin)
    else if (cap.state === 'absent' && cap.contradictions < 2) absent.push(bin)
  }
  present.sort()
  const keep = new Set(['python3', 'node', 'pnpm', 'npm', 'git', 'rg', 'jq', 'curl', 'ffmpeg', 'docker', 'chromium', 'gcc', 'make', 'sqlite3', 'openssl'])
  const head = present.filter((item) => keep.has(item.split(' ')[0]))
  const rest = present.filter((item) => !keep.has(item.split(' ')[0]))
  const lines = []
  lines.push(`[env] rev ${state.rev} · fp ${state.fp || '?'} · scan ${ageLabel(state.fullScanAt)}`)
  lines.push(contract)
  if (head.length > 0 || absent.length > 0) {
    lines.push(`能力 ${head.join(' · ')}${rest.length > 0 ? ` · +${rest.length}` : ''}`)
    if (absent.length > 0) lines.push(`     无: ${absent.slice(0, 10).join(' · ')}`)
  }
  for (const line of state.terrain || []) lines.push(`地形 ${line}`)
  if (state.profile?.name) {
    const profile = state.profile
    const bits = [`dsh ${state.dsh?.version || '?'}`, `profile ${profile.name}`]
    if (profile.patchBytes) bits.push(`patch ${(profile.patchBytes / 1024).toFixed(1)}KB/${profile.rows} 行/${profile.inserts} insert`)
    lines.push(`内幕 ${bits.join(' · ')}`)
  }
  const shellProbe = state.shellProbe
  if (shellProbe && Array.isArray(shellProbe.missing) && shellProbe.missing.length > 0) {
    lines.push(`会话shell(${shellProbe.mode}) 缺: ${shellProbe.missing.slice(0, 8).join(' · ')}（走该 provider 的命令会 not found）`)
  }
  if ((state.traps || []).length > 0) {
    lines.push(`陷阱 ${state.traps.slice(0, 4).join(' · ')}`)
  }
  const recent = (state.changelog || []).slice(-3)
  if (recent.length > 0) {
    lines.push(`变更 ${recent.map((entry) => entry.text).join(' · ')}`)
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`
  return text
}

function renderChangelog(state, limit) {
  const entries = (state.changelog || []).slice(-limit).reverse()
  const lines = [`# env changelog · rev ${state.rev}`, '']
  for (const entry of entries) {
    lines.push(`- ${new Date(entry.at).toISOString()} · ${entry.kind} · ${entry.text}${entry.sid ? ` · ${entry.sid}${entry.seq === undefined ? '' : `#${entry.seq}`}` : ''}`)
  }
  return lines.join('\n')
}

function pushLog(state, text, kind, meta = {}, limit = 200) {
  state.changelog.push({ rev: state.rev, at: Date.now(), kind, text, ...meta })
  if (state.changelog.length > limit) state.changelog.splice(0, state.changelog.length - limit)
}

/* --------------------------------------------------------------------- apply */

/**
 * Mount the environment memory: probe once, publish the snapshot, ingest changes.
 * @param ctx - plugin context.
 * @param config - row configuration.
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  if (!enabled) return
  diagnosable('boot', 'env-memory v2 loaded')
  const snapshotMaxChars = Number.isSafeInteger(config.snapshotMaxChars) ? config.snapshotMaxChars : 1100
  const changelogLimit = Number.isSafeInteger(config.changelogLimit) ? config.changelogLimit : 200

  let state = mergeState(readJson(STATE_FILE))
  let saveTimer
  const calls = new Map()

  const notesFile = path.join(STORE_DIR, 'NOTES.md')
  const contract = `本节是本机 dsh/环境/系统的权威现状（实测），比你的记忆新：不要重复验证已列出的能力。与现实矛盾（command not found/版本不符/路径不存在）以现实为准，修复后往 ${notesFile} 追加一行 "- 主体 | 值 | 说明" 同步；你改了环境也必须同步。明细见 ${CHANGELOG_FILE}`

  function bust(text, kind, meta) {
    state.rev += 1
    state.updatedAt = Date.now()
    pushLog(state, text, kind, meta, changelogLimit)
    scheduleSave()
  }

  function scheduleSave() {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void persist()
    }, 400)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  async function persist() {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, STATE_FILE)
      fs.writeFileSync(SNAPSHOT_FILE, `${renderSnapshot(state, snapshotMaxChars, contract)}\n`)
      fs.writeFileSync(CHANGELOG_FILE, `${renderChangelog(state, changelogLimit)}\n`)
    } catch { /* disk trouble must never break a turn */ }
  }

  function noteCapability(bin, source, changelog = true) {
    if (!bin || !CAPS[bin]) return
    void probePresence([bin]).then((presence) => {
      const where = presence[bin]
      const previous = state.caps[bin]
      const next = where
        ? { state: 'present', path: where, version: previous?.version || '', source, at: Date.now(), contradictions: previous?.contradictions ?? 0 }
        : { state: 'absent', path: '', version: '', source, at: Date.now(), contradictions: (previous?.contradictions ?? 0) + (previous?.state === 'present' ? 1 : 0) }
      if (previous && previous.state === next.state && previous.path === next.path) return
      state.caps[bin] = next
      if (changelog) bust(`${bin} → ${next.state === 'present' ? next.path : '不可用'}`, 'capability', {})
      scheduleSave()
    }).catch(() => {})
  }

  function ingestResult(name, argsText, text, isError) {
    let args = {}
    try {
      args = JSON.parse(argsText || '{}')
    } catch { /* keep empty */ }
    const command = String(args.command || '')
    if (!command) return
    const first = command.trim().split(/\s+/)[0] || ''
    if (INSTALL.test(command) && !isError) {
      const bins = new Set()
      for (const token of command.split(/[\s;|&]+/)) {
        const clean = token.replace(/^["']|["']$/g, '')
        if (!clean || clean.startsWith('-')) continue
        if (CAPS[clean]) bins.add(clean)
        else if (BIN_ALIAS[clean]) bins.add(BIN_ALIAS[clean])
      }
      for (const bin of bins) noteCapability(bin, 'installed-by-dsh')
      if (bins.size > 0) return
    }
    if (isError || NOT_FOUND.test(text)) {
      const match = text.match(/^([a-zA-Z0-9_.+-]+): (command not found|not found)/) || text.match(/([a-zA-Z0-9_.+-]+): command not found/)
      const bin = match ? match[1] : CAPS[first] ? first : ''
      if (bin && CAPS[bin]) {
        const previous = state.caps[bin]
        if (previous && previous.state === 'present') {
          state.caps[bin] = { ...previous, state: 'absent', contradictions: (previous.contradictions ?? 0) + 1, at: Date.now() }
          bust(`${bin} 实测不可用（记忆曾记为 ${previous.path}）`, 'contradiction', {})
        } else if (!previous || previous.state !== 'absent') {
          state.caps[bin] = { state: 'absent', path: '', version: '', source: 'observed', at: Date.now(), contradictions: 0 }
          bust(`${bin} 确认不存在`, 'capability', {})
        }
      }
    }
  }

  /* start-up probe: cheap fingerprint first, full scan on change or first run */
  void (async () => {
    try {
      const fp = await fingerprint()
      const first = state.fullScanAt === 0
      const changed = state.fp !== fp
      if (changed || first) {
        state.rev += 1
        await fullScan(state, first ? '首次扫描' : '环境指纹变化')
        await persist()
      } else {
        state.fp = fp
        scheduleSave()
      }
    } catch (error) { diagnosable('startup', error) }
  })()

  /* append-only inbox: models sync by writing one line, no tool needed */
  const NOTES_HEADER = '# env notes inbox\n'
  let draining = false
  function drainNotes() {
    if (draining) return
    draining = true
    try {
      let text = ''
      try {
        text = fs.readFileSync(notesFile, 'utf8')
      } catch {
        return
      }
      const lines = text.split('\n').filter((line) => line.trim().startsWith('-'))
      if (lines.length === 0) {
        /* normalize at most once: writing the same header unconditionally
           re-arms the watcher and spins forever */
        if (text !== NOTES_HEADER) fs.writeFileSync(notesFile, NOTES_HEADER)
        return
      }
      for (const line of lines) {
        const body = line.trim().replace(/^-\s*/, '')
        const [subjectRaw, valueRaw, detailRaw] = body.split('|').map((part) => (part ?? '').trim())
        if (!subjectRaw) continue
        const key = subjectRaw.replace(/[^A-Za-z0-9_.:+-]/g, '-')
        state.caps[key] = { state: valueRaw ? 'present' : 'absent', path: valueRaw, version: detailRaw, source: 'session-note', at: Date.now(), contradictions: 0 }
        bust(`${key} → ${valueRaw || '不可用'}${detailRaw ? ` (${detailRaw})` : ''}`, 'note', {})
      }
      fs.writeFileSync(notesFile, NOTES_HEADER)
      scheduleSave()
    } catch (error) { diagnosable('notes', error) } finally { draining = false }
  }
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    if (!fs.existsSync(notesFile)) fs.writeFileSync(notesFile, '# env notes inbox\n')
    drainNotes()
    const watcher = fs.watch(STORE_DIR, (_event, name) => {
      if (name === 'NOTES.md') drainNotes()
    })
    watcher.unref?.()
    ctx.effect(() => () => watcher.close(), 'env-memory.notes()')
  } catch (error) { diagnosable('notes-init', error) }

  /* probe through the SESSION's shell provider, so facts match where commands really run */
  const shellProbeFile = path.join(STORE_DIR, 'probe.sh')
  const probedModes = new Set()
  function ensureProbeScript() {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true })
      const bins = Object.keys(CAPS).map((bin) => `'${bin.replace(/'/g, '')}'`).join(' ')
      fs.writeFileSync(shellProbeFile, `for t in ${bins}; do p=$(command -v "$t" 2>/dev/null); printf '%s\\t%s\\n' "$t" "\${p:--}"; done\n`)
      return true
    } catch (error) { diagnosable('probe-script', error); return false }
  }
  async function probeThroughShell(agent) {
    try {
      const shell = typeof ctx.get === 'function' ? ctx.get('shell') : undefined
      if (shell === undefined || agent === undefined) return
      const mode = String(shell.sandboxMode ?? 'default')
      if (probedModes.has(mode)) return
      probedModes.add(mode)
      if (!ensureProbeScript()) return
      let dshEnv
      try { dshEnv = ctx.shellEnv?.collect({ agent }) } catch { /* optional */ }
      let policy
      try { policy = ctx.get?.('sandboxPolicy')?.resolve({ session: agent.session }) } catch { /* optional */ }
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined
      const spec = shell.resolve({
        command: `bash ${shellProbeFile}`,
        ...dshEnv === undefined ? {} : { dshEnv },
        ...policy === undefined ? {} : { sandboxPolicy: policy },
        ...signal === undefined ? {} : { signal },
        timeoutMs: 20000,
        onExpiry: 'kill',
      })
      const result = await (await shell.execute(spec)).result()
      const out = String(result?.stdout?.text ?? '')
      if (out === '') return
      const missing = []
      let present = 0
      for (const line of out.split('\n')) {
        const [bin, where] = line.split('\t')
        if (!bin) continue
        if (where === '-' || where === undefined) missing.push(bin)
        else present += 1
      }
      state.shellProbe = { mode, at: Date.now(), present, missing }
      if (missing.length > 0) {
        bust(`会话shell(${mode}) 缺 ${missing.slice(0, 6).join(',')}${missing.length > 6 ? ` 等 ${missing.length} 项` : ''}`, 'shell-probe', {})
      }
      scheduleSave()
    } catch (error) { diagnosable('shell-probe', error) }
  }

  /* publish the snapshot into every session's system prompt */
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'env-memory',
      order: 10100,
      interpolate: false,
      text: () => renderSnapshot(state, snapshotMaxChars, contract),
    }), 'env-memory.section()')
  } catch (error) { diagnosable('section', error) }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      probeThroughShell(payload.agent).catch((error) => diagnosable('shell-probe-async', error))
      return await next()
    })
  } catch (error) { diagnosable('pre-step', error) }

  /* ingest committed tool activity */
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (event.type === 'tool/call') {
          calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
          if (calls.size > 500) calls.delete(calls.keys().next().value)
          return
        }
        if (event.type !== 'tool/result') return
        const call = calls.get(event.data.callId ?? event.data.message?.toolCallId)
        if (call === undefined) return
        const text = (event.data.message?.content || [])
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        if (text.length <= 4000) ingestResult(call.name, call.arguments, text, event.data.message?.isError === true)
        calls.delete(event.data.callId ?? event.data.message?.toolCallId)
      } catch { /* ignore malformed events */ }
    })
  } catch (error) { diagnosable('session-event', error) }

  /* on-demand detail: query / digest / log / note */
  try {
    const dispose = ctx.tools.register({
      name: 'env_memory',
      description: '本机 dsh/环境/系统的权威记忆（实测事实 + 变更日志）。op:"query" 查某能力/主题的现状与证据；op:"log" 看变更历史（默认 20 条）；op:"digest" 取某一主题的快照段落；op:"note" 记录你刚改动的环境事实（改完必须调用）。系统提示里的 [env] 段已经够了就不要调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', description: 'query | log | digest | note', enum: ['query', 'log', 'digest', 'note'] },
          q: { type: 'string', description: 'query/digest 的检索词，如 python3 / docker / dsh / proxy / 地形' },
          limit: { type: 'number', description: 'log 返回条数，默认 20' },
          subject: { type: 'string', description: 'note 的事实主体，如 python3 / npm-global:pm2' },
          value: { type: 'string', description: 'note 的事实值，如 3.10.12 或 /usr/bin/python3' },
          detail: { type: 'string', description: 'note 的可选说明，如安装命令或原因' },
        },
        required: ['op'],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: 'Markdown 结果' } }, required: ['text'] },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const op = String(args.op || 'query')
        if (op === 'log') {
          const limit = Number.isSafeInteger(args.limit) ? args.limit : 20
          return { text: renderChangelog(state, limit) }
        }
        if (op === 'note') {
          const subject = String(args.subject || '').trim()
          if (!subject) return { text: 'note 需要 subject' }
          const value = String(args.value || '').trim()
          const detail = String(args.detail || '').trim()
          const key = subject.replace(/[^A-Za-z0-9_.:+-]/g, '-')
          const fact = { state: value ? 'present' : 'absent', path: value, version: detail, source: 'model-note', at: Date.now(), contradictions: 0 }
          state.caps[key] = fact
          state.traps = state.traps || []
          bust(`${key} → ${value || '不可用'}${detail ? ` (${detail})` : ''}`, 'note', {})
          await persist()
          return { text: `已记录：${key} = ${value || '不可用'}${detail ? ` (${detail})` : ''} · rev ${state.rev}` }
        }
        if (op === 'digest') {
          const q = String(args.q || '').toLowerCase()
          const lines = renderSnapshot(state, snapshotMaxChars, contract)
            .split('\n')
            .filter((line) => q === '' || line.toLowerCase().includes(q))
          return { text: `# digest · ${q}\n\n${lines.join('\n')}\n\n明细：${CHANGELOG_FILE}` }
        }
        const q = String(args.q || '').toLowerCase()
        const hits = []
        for (const [key, cap] of Object.entries(state.caps)) {
          if (q !== '' && !key.toLowerCase().includes(q)) continue
          hits.push(`${key}: ${cap.state}${cap.path ? ` ${cap.path}` : ''}${cap.version ? ` · ${cap.version}` : ''} · source=${cap.source} · at=${new Date(cap.at).toISOString()}${cap.contradictions ? ` · contradictions=${cap.contradictions}` : ''}`)
          if (hits.length >= 20) break
        }
        for (const line of state.terrain || []) {
          if (q !== '' && !line.toLowerCase().includes(q)) continue
          hits.push(`terrain: ${line}`)
        }
        return { text: hits.length > 0 ? hits.join('\n') : `未命中「${q}」。快照：\n${renderSnapshot(state, snapshotMaxChars, contract)}` }
      },
    })
    diagnosable('tool', `registered dispose=${typeof dispose}`)
  } catch (error) { diagnosable('tool', error) }
}
