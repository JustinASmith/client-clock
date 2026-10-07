// client-clock: logs your time, Claude's time and your 5-hour/weekly usage per client.
//
// Every session appends its own events to ~/.claude/client-clock/ledger/<session>.jsonl
// (one file per session, so parallel sessions never write the same file). Reports read
// the files back and work out, per client:
//   you     the gap before each prompt you send, up to IDLE_CAP_MS, plus time a phone
//           client watched Claude work, plus /ledger add entries; overlapping
//           sessions count once, split evenly between the clients active at that moment
//   Claude  the wall-clock length of Claude's turns (parallel sessions can overlap)
//   usage   each rise in the 5-hour and weekly windows between two readings, split by what
//           each client's sessions spent at API prices in that stretch (the windows are
//           account-wide), or by tokens when no session logged a cost
//   lockout time spent at 100% of a window until it reset, split the same way
//
// A session's client comes from, in order: CLIENT_CLOCK_CLIENT in its environment, the
// label on its repo's remote, the label on its folder, then the longest folder rule that
// matches it (for tools that run Claude Code in folders of their own, like HyperFrames Studio).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ClientClockBand,
  ClientClockDash,
  ClientClockPeriod,
  ClientClockRow,
  ClientClockSplit,
  ClientClockWindow,
} from '../types'

type $T = EngineInterface
type Shown = (label: string) => string

const band = atom({ plugin: 'client-clock', key: 'band' } as const, null)
const dash = atom({ plugin: 'client-clock', key: 'dash' } as const, null)
const period = atom({ plugin: 'client-clock', key: 'period' } as const, 'week')
const PANE = 'client-clock'

const IDLE_CAP_MS = 10 * 60 * 1000
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const PERSONAL = 'personal'
const UNASSIGNED = 'unassigned'
const OTHER = 'other (outside Claude Code)'
const BEFORE = 'before tracking'
const NOT_CLIENTS = new Set([PERSONAL, UNASSIGNED, OTHER, BEFORE])
const HOUR = 3600 * 1000
const FIVE_MS = 5 * HOUR
const WEEK_MS = 7 * 24 * HOUR
const WINDOW_MS: Record<string, number> = { five_hour: FIVE_MS, seven_day: WEEK_MS }

type Limit = { k: string; p: number; r?: string }

export type Rec = {
  t: number
  kind: 'start' | 'prompt' | 'turn' | 'limits' | 'attach' | 'detach' | 'manual' | 'end'
  session?: string
  root?: string
  remote?: string
  pin?: string
  label?: string | null
  origin?: string
  during?: boolean
  ms?: number
  agent?: boolean
  tok?: number
  cost?: number
  limits?: Limit[]
  surface?: string
  client?: string
  minutes?: number
  note?: string
}

type Totals = {
  youMs: number
  manualMs: number
  agentMs: number
  prompts: number
  turns: number
  tokens: number
  cost: number
  fivePts: number
  weekPts: number
  lockoutMs: number
  roots: Set<string>
}

const emptyTotals = (): Totals => ({
  youMs: 0,
  manualMs: 0,
  agentMs: 0,
  prompts: 0,
  turns: 0,
  tokens: 0,
  cost: 0,
  fivePts: 0,
  weekPts: 0,
  lockoutMs: 0,
  roots: new Set(),
})

// ---------- where things live ----------

type Ctx = { session: string; root: string; remote: string | null; pin: string | null; home: string; dir: string }
let ctx: Ctx | null = null

async function context($: $T): Promise<Ctx> {
  if (ctx) return ctx
  const [session, repo, cwd, home, pin] = await Promise.all([
    $.session.id(),
    $.session.repo(),
    $.session.cwd(),
    $.env.get('HOME'),
    $.env.get('CLIENT_CLOCK_CLIENT'),
  ])
  ctx = {
    session,
    root: repo?.root ?? cwd,
    remote: remoteKey(repo?.remote),
    pin: pin?.trim().slice(0, 32) || null,
    home: home ?? '',
    dir: `${home ?? '.'}/.claude/client-clock`,
  }
  return ctx
}

// Where a ledger line was written: the repo's root and, when it has one, its remote.
function where(c: Ctx) {
  return c.remote ? { root: c.root, remote: c.remote } : { root: c.root }
}

// One key for every clone of a repo: git@github.com:o/n.git and https://github.com/o/n
// are both github.com/o/n.
export function remoteKey(url: string | null | undefined): string | null {
  if (!url) return null
  let s = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(s)
  if (scp) s = `${scp[1]}/${scp[2]}`
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/')
  return s.toLowerCase() || null
}

// The label map keeps three kinds of key: a repo's remote (so every clone of it counts
// for the same client), a folder, and a folder rule with * wildcards.
const remoteSlot = (key: string) => `remote:${key}`
const ruleSlot = (pattern: string) => `rule:${pattern}`

const rules = new Map<string, RegExp>()

// A rule matches its folder and every folder inside it; * stands for any part of one name.
function ruleMatches(pattern: string, root: string) {
  let re = rules.get(pattern)
  if (!re) {
    const body = pattern
      .replace(/\/+$/, '')
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')
    re = new RegExp(`^${body}(/.*)?$`)
    rules.set(pattern, re)
  }
  return re.test(root)
}

export function labelFor(map: Record<string, string>, root: string | undefined, remote: string | null | undefined) {
  const byRemote = remote ? map[remoteSlot(remote)] : undefined
  if (byRemote) return byRemote
  if (!root) return null
  const byFolder = map[root]
  if (byFolder) return byFolder
  let best: { length: number; label: string } | null = null
  for (const [key, label] of Object.entries(map)) {
    if (!key.startsWith('rule:')) continue
    const pattern = key.slice('rule:'.length)
    if ((!best || pattern.length > best.length) && ruleMatches(pattern, root)) best = { length: pattern.length, label }
  }
  return best?.label ?? null
}

const clientOf = (map: Record<string, string>, c: Ctx) => c.pin ?? labelFor(map, c.root, c.remote)

const tilde = (path: string, home: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
const untilde = (path: string, home: string) => (path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path)
const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

async function mapping($: $T): Promise<Record<string, string>> {
  return ((await $.store.get('clients')) ?? {}) as Record<string, string>
}

async function budgets($: $T): Promise<Record<string, number>> {
  return ((await $.store.get('budgets')) ?? {}) as Record<string, number>
}

async function rates($: $T): Promise<Record<string, number>> {
  return ((await $.store.get('rates')) ?? {}) as Record<string, number>
}

// Labels this session's folder, and its remote when it has one.
async function setLabel($: $T, label: string) {
  const c = await context($)
  await $.store.set('clients', {
    ...(await mapping($)),
    [c.root]: label,
    ...(c.remote ? { [remoteSlot(c.remote)]: label } : {}),
  })
}

// ---------- the ledger ----------

// Appends one event to this session's ledger file, one write at a time. The mod's API
// has no append, so the file is rewritten from a copy kept here.
let chain: Promise<unknown> = Promise.resolve()
let own: { path: string; text: string } | null = null

function append($: $T, rec: Rec): Promise<unknown> {
  chain = chain
    .then(async () => {
      const c = await context($)
      const path = `${c.dir}/ledger/${c.session}.jsonl`
      const before = own?.path === path ? own.text : (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
      own = { path, text: `${before}${JSON.stringify(rec)}\n` }
      await $.fs.write(path, own.text)
    })
    .catch(err => $.ui.log(`client-clock: could not write the ledger (${String(err).slice(0, 80)})`))
  return chain
}

// Ledger files already read, kept until they change.
const parsed = new Map<string, { mtimeMs: number; size: number; recs: Rec[] }>()

async function loadSince($: $T, since: number): Promise<Rec[]> {
  const c = await context($)
  const dir = `${c.dir}/ledger`
  if (!(await $.fs.exists(dir))) return []
  const out: Rec[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < since) continue
    let hit = parsed.get(f.name)
    if (!hit || hit.mtimeMs !== f.mtimeMs || hit.size !== f.size) {
      const session = f.name.slice(0, -'.jsonl'.length)
      const recs: Rec[] = []
      for (const line of String(await $.fs.read(`${dir}/${f.name}`)).split('\n')) {
        if (!line) continue
        try {
          recs.push({ ...(JSON.parse(line) as Rec), session })
        } catch {
          // a line cut short by a crash: skip it
        }
      }
      hit = { mtimeMs: f.mtimeMs, size: f.size, recs }
      parsed.set(f.name, hit)
    }
    for (const r of hit.recs) out.push(r)
  }
  return out.sort((a, b) => a.t - b.t)
}

// When the clock started: the earliest line in the ledger, worked out once and kept.
async function trackedSince($: $T): Promise<number> {
  const kept = await $.store.get('since')
  if (typeof kept === 'number') return kept
  const c = await context($)
  const dir = `${c.dir}/ledger`
  let first = await $.clock.now()
  if (await $.fs.exists(dir)) {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      const line = String(await $.fs.read(`${dir}/${f.name}`)).split('\n', 1)[0] ?? ''
      try {
        const t = (JSON.parse(line) as Rec).t
        if (typeof t === 'number' && t < first) first = t
      } catch {
        // an empty or broken file
      }
    }
  }
  await $.store.set('since', first)
  return first
}

// ---------- the arithmetic ----------

type CostPoint = { t: number; usd: number; label: string }

export function summarize(
  recs: Rec[],
  map: Record<string, string>,
  from: number,
  to: number,
  now: number,
  opts: { since?: number } = {},
) {
  const totals = new Map<string, Totals>()
  const get = (label: string) => {
    let t = totals.get(label)
    if (!t) totals.set(label, (t = emptyTotals()))
    return t
  }
  const labelOf = (r: Rec) => labelFor(map, r.root, r.remote) || r.label || UNASSIGNED
  const inRange = (t: number) => t >= from && t < to

  const bySession = new Map<string, Rec[]>()
  for (const r of recs) {
    if (!r.session) continue
    const list = bySession.get(r.session) ?? []
    list.push(r)
    bySession.set(r.session, list)
  }

  const spans: Array<{ a: number; b: number; label: string }> = []
  const turns: Array<{ a: number; t: number; tok: number; label: string }> = []
  const costs: CostPoint[][] = []

  for (const list of bySession.values()) {
    let last: number | null = null
    let lastCost: number | null = null // the session's running cost total; null until a baseline
    let pin: string | null = null // CLIENT_CLOCK_CLIENT, which outranks every label
    let sessionLabel = UNASSIGNED
    const watching: Array<{ a: number; b: number }> = []
    const working: Array<{ a: number; b: number }> = []
    const attached = new Map<string, number>()
    // The session's running cost at API prices, as points in time.
    const series: CostPoint[] = []
    const mark = (t: number, usd: number | undefined) => {
      const end = series[series.length - 1]
      if (typeof usd === 'number' && (!end || t >= end.t)) series.push({ t, usd, label: sessionLabel })
    }
    // A session spends nothing while it waits: its cost holds until the next turn starts.
    const hold = (t: number) => {
      const end = series[series.length - 1]
      if (end && t > end.t) series.push({ t, usd: end.usd, label: sessionLabel })
    }
    for (const r of list) {
      if (r.kind === 'start' && r.pin) pin = r.pin
      if (r.root) sessionLabel = pin ?? labelOf(r)
      if (r.kind === 'start') {
        last = r.t
        if (typeof r.cost === 'number') lastCost = r.cost
        mark(r.t, r.cost)
      } else if (r.kind === 'prompt') {
        if (!r.during) hold(r.t)
        if (!HUMAN_ORIGINS.has(r.origin ?? '')) continue
        const label = pin ?? labelOf(r)
        const gap = last === null ? 0 : Math.min(r.t - last, IDLE_CAP_MS)
        if (gap > 0) spans.push({ a: r.t - gap, b: r.t, label })
        last = r.t
        if (inRange(r.t)) get(label).prompts += 1
      } else if (r.kind === 'turn') {
        const label = pin ?? labelOf(r)
        // cost is the session's running total: spend is the rise since the last reading,
        // and a first reading with no baseline (a session already running) counts as 0
        const cost = typeof r.cost === 'number' ? r.cost : null
        const spent = cost !== null && lastCost !== null ? Math.max(0, cost - lastCost) : 0
        if (cost !== null) lastCost = cost
        if (!r.agent) hold(r.t - (r.ms ?? 0))
        mark(r.t, r.cost)
        turns.push({ a: r.t - (r.ms ?? 0), t: r.t, tok: r.tok ?? 0, label })
        if (!r.agent) {
          last = r.t
          working.push({ a: r.t - (r.ms ?? 0), b: r.t })
        }
        if (!inRange(r.t)) continue
        const tot = get(label)
        tot.tokens += r.tok ?? 0
        tot.cost += spent
        if (r.root) tot.roots.add(r.root)
        if (!r.agent) {
          tot.agentMs += r.ms ?? 0
          tot.turns += 1
        }
      } else if (r.kind === 'limits') {
        mark(r.t, r.cost)
      } else if (r.kind === 'attach') {
        // A phone checking in counts; the desktop app and IDEs stay attached to any open session.
        if (r.client && r.surface === 'mobile') attached.set(r.client, r.t)
      } else if (r.kind === 'detach') {
        const since = r.client ? attached.get(r.client) : undefined
        if (r.client && since !== undefined) {
          watching.push({ a: since, b: r.t })
          attached.delete(r.client)
        }
      } else if (r.kind === 'manual') {
        if (inRange(r.t)) get(r.label || sessionLabel).manualMs += (r.minutes ?? 0) * 60 * 1000
      }
    }
    if (series.length > 1) costs.push(series)
    for (const since of attached.values()) watching.push({ a: since, b: now })
    // A phone counts as you only while Claude was working.
    for (const w of watching) {
      for (const k of working) {
        const a = Math.max(w.a, k.a)
        const b = Math.min(w.b, k.b)
        if (b > a) spans.push({ a, b, label: sessionLabel })
      }
    }
  }

  // Your time, unioned: a moment counts once, split evenly between the clients active then.
  const edges: Array<{ t: number; d: number; label: string }> = []
  for (const s of spans) {
    const a = Math.max(s.a, from)
    const b = Math.min(s.b, to)
    if (b > a) edges.push({ t: a, d: 1, label: s.label }, { t: b, d: -1, label: s.label })
  }
  edges.sort((x, y) => x.t - y.t || x.d - y.d)
  const active = new Map<string, number>()
  let prevT = 0
  for (const edge of edges) {
    if (active.size > 0 && edge.t > prevT) {
      const share = (edge.t - prevT) / active.size
      for (const label of active.keys()) get(label).youMs += share
    }
    const n = (active.get(edge.label) ?? 0) + edge.d
    if (n > 0) active.set(edge.label, n)
    else active.delete(edge.label)
    prevT = edge.t
  }

  // Usage: split each rise between two readings by what each client's sessions spent in
  // that stretch. Without costs, by tokens, each turn's spread over the time it ran.
  turns.sort((x, y) => x.t - y.t)
  const weight = (x: { a: number; t: number; tok: number }, a: number, b: number) =>
    x.t > x.a ? (x.tok * Math.max(0, Math.min(x.t, b) - Math.max(x.a, a))) / (x.t - x.a) : x.t > a && x.t <= b ? x.tok : 0
  const previous = new Map<string, { t: number; p: number; r?: string }>()
  const shares = new Map<string, Map<string, number>>()
  const lockouts = new Map<string, { a: number; b: number }>()
  for (const r of recs) {
    if (r.kind !== 'limits') continue
    for (const l of r.limits ?? []) {
      const span = WINDOW_MS[l.k]
      if (!span) continue
      const id = `${l.k}@${l.r ?? '?'}`
      const before = previous.get(l.k)
      const isSameWindow = before !== undefined && before.r === l.r
      const startT = isSameWindow ? before.t : l.r ? Date.parse(l.r) - span : r.t
      const rise = isSameWindow ? l.p - before.p : l.p
      previous.set(l.k, { t: r.t, p: l.p, r: l.r })
      if (l.p >= 100 && l.r && !lockouts.has(id)) lockouts.set(id, { a: r.t, b: Date.parse(l.r) })
      if (rise <= 0 || !inRange(r.t)) continue
      const split = shares.get(id) ?? new Map<string, number>()
      shares.set(id, split)
      // A window that opened before the clock started holds usage it never saw.
      if (!isSameWindow && opts.since !== undefined && startT < opts.since) {
        split.set(BEFORE, (split.get(BEFORE) ?? 0) + rise)
        continue
      }
      const by = new Map<string, number>()
      for (const series of costs) spend(series, startT, r.t, by)
      if (sumOf(by) === 0) {
        for (const x of turns) {
          const w = weight(x, startT, r.t)
          if (w > 0) by.set(x.label, (by.get(x.label) ?? 0) + w)
        }
      }
      const sum = sumOf(by)
      if (sum === 0) split.set(OTHER, (split.get(OTHER) ?? 0) + rise)
      else for (const [label, w] of by) split.set(label, (split.get(label) ?? 0) + (rise * w) / sum)
    }
  }
  for (const [id, split] of shares) {
    const isWeek = id.startsWith('seven_day')
    const total = [...split.values()].reduce((n, v) => n + v, 0)
    const lock = lockouts.get(id)
    for (const [label, pts] of split) {
      const tot = get(label)
      if (isWeek) tot.weekPts += pts
      else tot.fivePts += pts
      if (lock && total > 0) {
        const locked = Math.max(0, Math.min(lock.b, to, now) - Math.max(lock.a, from))
        tot.lockoutMs += (locked * pts) / total
      }
    }
  }
  return totals
}

// What one session spent between a and b: each rise in its running cost is spread evenly
// over the stretch between the two points around it.
function spend(series: CostPoint[], a: number, b: number, into: Map<string, number>) {
  const first = series[0]
  const end = series[series.length - 1]
  if (!first || !end || end.t <= a || first.t > b) return
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1]
    const q = series[i]
    if (!p || !q || q.t <= a) continue
    if (p.t >= b) break
    const rise = q.usd - p.usd
    if (rise <= 0) continue
    const part = q.t > p.t ? (Math.min(q.t, b) - Math.max(p.t, a)) / (q.t - p.t) : 1
    if (part > 0) into.set(q.label, (into.get(q.label) ?? 0) + rise * part)
  }
}

const sumOf = (m: Map<string, number>) => [...m.values()].reduce((n, v) => n + v, 0)

// Each client's points of one window, largest first.
function splitOf(totals: Map<string, Totals>, key: 'fivePts' | 'weekPts', shown: Shown): ClientClockSplit {
  return [...totals]
    .map(([label, t]) => ({ label: shown(label), pts: t[key] }))
    .filter(x => x.pts >= 0.5)
    .sort((x, y) => y.pts - x.pts)
}

// ---------- time helpers ----------

function startOfDay(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfWeek(ms: number) {
  const d = new Date(startOfDay(ms))
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

function minusDays(ms: number, days: number) {
  const d = new Date(ms)
  d.setDate(d.getDate() - days)
  return d.getTime()
}

function formatMs(ms: number) {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function hours(ms: number) {
  return (ms / HOUR).toFixed(2)
}

function money(usd: number) {
  return `$${usd.toFixed(usd < 100 ? 2 : 0)}`
}

// Quoted for CSV. A leading =, +, - or @ gets a ' in front, so a spreadsheet shows the
// value as text instead of running it as a formula (a commit message could start with one).
export function csvText(s: string) {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

function clockTime(iso?: string) {
  if (!iso) return 'soon'
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}

function day(ms: number) {
  try {
    return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

function localDate(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- demo mode ----------

// In demo mode every client shows as "client a", "client b", ... in the band, the pane,
// /ledger, /client and exports, and folder names are hidden, so the clock can go in a
// screenshot or on a shared screen. Each client keeps its letter.
async function shower($: $T, labels: Iterable<string> = []): Promise<Shown> {
  if ((await $.store.get('demo')) !== true) return label => label
  const aliases = { ...(((await $.store.get('aliases')) ?? {}) as Record<string, string>) }
  const count = Object.keys(aliases).length
  const known = [...Object.values(await mapping($)), ...Object.keys(await budgets($)), ...Object.keys(await rates($))]
  for (const label of [...new Set([...known, ...labels])].sort()) {
    if (!NOT_CLIENTS.has(label) && !aliases[label]) aliases[label] = aliasAt(Object.keys(aliases).length)
  }
  if (Object.keys(aliases).length !== count) await $.store.set('aliases', aliases)
  return label => (NOT_CLIENTS.has(label) ? label : aliases[label] ?? 'client ?')
}

function aliasAt(i: number) {
  return i < 26 ? `client ${String.fromCharCode(97 + i)}` : `client ${i + 1}`
}

async function isDemo($: $T) {
  return (await $.store.get('demo')) === true
}

// ---------- the band ----------

let refreshing = false

async function refreshBand($: $T) {
  if (refreshing) return
  refreshing = true
  try {
    const c = await context($)
    const now = await $.clock.now()
    const map = await mapping($)
    const label = clientOf(map, c)
    const usage = await $.session.usage()
    const five = usage.rateLimits.find(l => l.kind === 'five_hour')
    const week = usage.rateLimits.find(l => l.kind === 'seven_day')
    const dayFrom = startOfDay(now)
    const weekFrom = week?.resetsAt ? Date.parse(week.resetsAt) - WEEK_MS : startOfWeek(now)
    const fiveFrom = five?.resetsAt ? Date.parse(five.resetsAt) - FIVE_MS : now - FIVE_MS
    const since = await trackedSince($)
    const recs = await loadSince($, Math.min(dayFrom, weekFrom, fiveFrom))
    const today = summarize(recs, map, dayFrom, now + 1, now, { since })
    const thisWeek = summarize(recs, map, weekFrom, now + 1, now, { since })
    const thisFive = summarize(recs, map, fiveFrom, now + 1, now, { since })
    const budget = label ? (await budgets($))[label] ?? null : null
    const known = [...new Set(Object.values(map))].filter(l => l !== PERSONAL).sort()
    const shown = await shower($, label ? [label, ...known] : known)
    const value: ClientClockBand = {
      label,
      shown: label ? shown(label) : null,
      known: known.map(l => ({ label: l, shown: shown(l) })),
      youMs: label ? (today.get(label)?.youMs ?? 0) + (today.get(label)?.manualMs ?? 0) : 0,
      agentMs: label ? today.get(label)?.agentMs ?? 0 : 0,
      five: five?.percentUsed ?? null,
      week: week?.percentUsed ?? null,
      labelWeek: label ? thisWeek.get(label)?.weekPts ?? 0 : 0,
      budget,
    }
    await update($, band, () => value)

    if (!label || label === PERSONAL) return
    const warnings: Array<[string, string]> = []
    if (budget !== null && value.labelWeek >= budget) {
      warnings.push([
        `budget:${label}:${week?.resetsAt ?? weekFrom}`,
        `${shown(label)} has used about ${Math.round(value.labelWeek)} points of your weekly limit (budget ${budget}).`,
      ])
    }
    const fiveAll = [...thisFive.values()].reduce((n, t) => n + t.fivePts, 0)
    const fiveMine = thisFive.get(label)?.fivePts ?? 0
    if (five && five.percentUsed >= 80 && fiveAll > 0 && fiveMine / fiveAll >= 0.5) {
      warnings.push([
        `five:${label}:${five.resetsAt ?? fiveFrom}`,
        `${shown(label)} is ${Math.round((100 * fiveMine) / fiveAll)}% of this 5-hour window (${Math.round(five.percentUsed)}% used, resets ${clockTime(five.resetsAt)}).`,
      ])
    }
    if (warnings.length === 0) return
    const warned = ((await $.store.get('warned')) ?? []) as string[]
    const fresh = warnings.filter(([key]) => !warned.includes(key))
    for (const [, text] of fresh) $.ui.toast(text)
    if (fresh.length) await $.store.set('warned', [...warned, ...fresh.map(([key]) => key)].slice(-100))
  } catch (err) {
    $.ui.log(`client-clock: ${String(err).slice(0, 120)}`)
  } finally {
    refreshing = false
  }
}

async function assign($: $T, label: string) {
  await setLabel($, label)
  const shown = await shower($, [label])
  $.ui.toast(label === PERSONAL ? 'This repo is personal: not billed.' : `This repo now counts as ${shown(label)}.`)
  await refreshBand($)
}

// ---------- the report ----------

function periodOf(what: string, now: number) {
  const week = startOfWeek(now)
  if (what === 'today') return { from: startOfDay(now), to: now + 1, title: 'today' }
  if (what === 'week') return { from: week, to: now + 1, title: 'this week' }
  if (what === 'lastweek') return { from: minusDays(week, 7), to: week, title: 'last week' }
  return null
}

// Your commits on any local branch of these repos, so work on a branch or in a worktree
// counts; worktrees of one repo share their commits, so each counts once.
async function commitLog($: $T, roots: Set<string>, from: number, to: number) {
  const seen = new Map<string, { t: number; subject: string }>()
  for (const root of roots) {
    const email = await $.process.run(['git', '-C', root, 'config', 'user.email'], { timeoutMs: 5000 }).catch(() => null)
    const author = email && email.exitCode === 0 ? email.stdout.trim() : ''
    const run = await $.process
      .run(
        [
          'git', '-C', root, 'log', '--branches', '--no-merges', '--pretty=%H%x09%ct%x09%s',
          ...(author ? ['--fixed-strings', `--author=${author}`] : []),
          `--since=${new Date(from).toISOString()}`, `--until=${new Date(to).toISOString()}`,
        ],
        { timeoutMs: 10000 },
      )
      .catch(() => null)
    if (!run || run.exitCode !== 0) continue
    for (const line of run.stdout.split('\n')) {
      const [hash, ct, ...subject] = line.split('\t')
      if (hash && !seen.has(hash)) seen.set(hash, { t: Number(ct) * 1000, subject: subject.join('\t') })
    }
  }
  return [...seen].map(([hash, c]) => ({ hash, ...c })).sort((x, y) => x.t - y.t)
}

export async function commitsIn($: $T, roots: Set<string>, from: number, to: number) {
  return (await commitLog($, roots, from, to)).length
}

// One row per client for a period: what /ledger prints and the /clock pane draws.
async function report($: $T, which: string, now: number) {
  const span = periodOf(which, now)
  if (!span) return null
  const map = await mapping($)
  const b = await budgets($)
  const rate = await rates($)
  const recs = await loadSince($, minusDays(span.from, 7))
  const totals = summarize(recs, map, span.from, span.to, now, { since: await trackedSince($) })
  const rows: ClientClockRow[] = []
  for (const [label, t] of totals) {
    if (t.youMs + t.manualMs + t.agentMs + t.fivePts + t.weekPts <= 0) continue
    const youMs = t.youMs + t.manualMs
    const perHour = rate[label] ?? null
    rows.push({
      label,
      youMs,
      addedMs: t.manualMs,
      agentMs: t.agentMs,
      prompts: t.prompts,
      turns: t.turns,
      fivePts: t.fivePts,
      weekPts: t.weekPts,
      cost: t.cost,
      lockoutMs: t.lockoutMs,
      commits: await commitsIn($, t.roots, span.from, span.to),
      budget: b[label] ?? null,
      rate: perHour,
      billable: perHour === null ? null : (perHour * youMs) / HOUR,
    })
  }
  rows.sort((x, y) => y.youMs + y.agentMs - (x.youMs + x.agentMs))
  return { span, rows }
}

// The folders behind "unassigned" in a period, so each can be given a client: tools that
// run Claude Code in folders of their own land here until a folder rule covers them.
async function unassignedIn($: $T, span: { from: number; to: number }, now: number) {
  const map = await mapping($)
  const recs = await loadSince($, minusDays(span.from, 7))
  const pinned = new Set(recs.filter(r => r.kind === 'start' && r.pin).map(r => r.session))
  const probe = { ...map }
  const sdk = new Set<string>()
  for (const r of recs) {
    if (!r.root || pinned.has(r.session) || labelFor(map, r.root, r.remote) !== null) continue
    probe[r.root] = `?${r.root}`
    if (r.kind === 'prompt' && r.origin === 'sdk') sdk.add(r.root)
  }
  const totals = summarize(recs, probe, span.from, span.to, now, { since: await trackedSince($) })
  return [...totals]
    .filter(([label, t]) => label.startsWith('?') && t.youMs + t.manualMs + t.agentMs + t.fivePts + t.weekPts > 0)
    .map(([label, t]) => ({
      root: label.slice(1),
      youMs: t.youMs + t.manualMs,
      agentMs: t.agentMs,
      fivePts: t.fivePts,
      weekPts: t.weekPts,
      sdk: sdk.has(label.slice(1)),
    }))
    .sort((x, y) => y.youMs + y.agentMs - (x.youMs + x.agentMs))
}

async function exportCsv($: $T, span: { from: number; to: number }, rows: ClientClockRow[], shown: Shown) {
  const c = await context($)
  const path = `${c.dir}/exports/ledger-${localDate(span.from)}-to-${localDate(span.to - 1)}.csv`
  const header =
    'client,you_hours,added_hours,claude_hours,prompts,turns,five_hour_points,weekly_points,api_equivalent_usd,lockout_hours,commits,rate,billable'
  const lines = rows.map(r =>
    [
      csvText(shown(r.label)),
      hours(r.youMs - r.addedMs),
      hours(r.addedMs),
      hours(r.agentMs),
      r.prompts,
      r.turns,
      r.fivePts.toFixed(1),
      r.weekPts.toFixed(1),
      r.cost.toFixed(2),
      hours(r.lockoutMs),
      r.commits,
      r.rate ?? '',
      r.billable === null ? '' : r.billable.toFixed(2),
    ].join(','),
  )
  await $.fs.write(path, `${header}\n${lines.join('\n')}\n`)
  return path
}

// One row per day per client, ready for an invoice: your hours, what they come to at the
// client's rate, and what you did (your /ledger add notes and commit messages that day).
async function timesheet($: $T, which: string, now: number) {
  const span = periodOf(which, now)
  if (!span) return null
  const c = await context($)
  const map = await mapping($)
  const rate = await rates($)
  const since = await trackedSince($)
  const recs = await loadSince($, minusDays(span.from, 7))
  const whole = summarize(recs, map, span.from, span.to, now, { since })
  const commits = new Map<string, Array<{ t: number; subject: string }>>()
  for (const [label, t] of whole) {
    if (NOT_CLIENTS.has(label) && label !== UNASSIGNED) continue
    const roots = new Set(t.roots)
    for (const [key, l] of Object.entries(map)) if (l === label && key.startsWith('/')) roots.add(key)
    commits.set(label, await commitLog($, roots, span.from, span.to))
  }
  const rows: Array<{ date: string; label: string; youMs: number; agentMs: number; rate: number | null; billable: number | null; commits: number; what: string }> = []
  for (let d = span.from; d < Math.min(span.to, now + 1); d = minusDays(d, -1)) {
    const end = Math.min(minusDays(d, -1), span.to)
    for (const [label, t] of summarize(recs, map, d, end, now, { since })) {
      const youMs = t.youMs + t.manualMs
      if (label === OTHER || label === BEFORE || youMs + t.agentMs <= 0) continue
      const notes = recs.filter(r => r.kind === 'manual' && r.label === label && r.note && r.t >= d && r.t < end).map(r => r.note ?? '')
      const done = (commits.get(label) ?? []).filter(x => x.t >= d && x.t < end).map(x => x.subject)
      const perHour = rate[label] ?? null
      rows.push({
        date: localDate(d),
        label,
        youMs,
        agentMs: t.agentMs,
        rate: perHour,
        billable: perHour === null ? null : (perHour * youMs) / HOUR,
        commits: done.length,
        what: [...notes, ...done].join('; '),
      })
    }
  }
  const shown = await shower($, rows.map(r => r.label))
  const path = `${c.dir}/exports/timesheet-${localDate(span.from)}-to-${localDate(Math.min(span.to, now + 1) - 1)}.csv`
  const header = 'date,client,you_hours,claude_hours,rate,billable,commits,description'
  const lines = rows.map(r =>
    [
      r.date,
      csvText(shown(r.label)),
      hours(r.youMs),
      hours(r.agentMs),
      r.rate ?? '',
      r.billable === null ? '' : r.billable.toFixed(2),
      r.commits,
      csvText(r.what),
    ].join(','),
  )
  if (rows.length) await $.fs.write(path, `${header}\n${lines.join('\n')}\n`)
  return { span, rows, path, shown }
}

let dashOpen = false
let dashRefreshing = false

async function refreshDash($: $T) {
  if (dashRefreshing) return
  dashRefreshing = true
  try {
    const now = await $.clock.now()
    const which: ClientClockPeriod = await read($, period)
    const r = await report($, which, now)
    if (!r) return
    const c = await context($)
    const map = await mapping($)
    const usage = await $.session.usage()
    const since = await trackedSince($)
    const loose = await unassignedIn($, r.span, now)
    const demo = await isDemo($)
    const shown = await shower($, r.rows.map(row => row.label))
    // The bars' own windows, with each client's points of them.
    const windowOf = async (kind: string, span: number): Promise<ClientClockWindow | null> => {
      const l = usage.rateLimits.find(x => x.kind === kind)
      if (!l) return null
      const start = l.resetsAt ? Date.parse(l.resetsAt) - span : now - span
      const totals = summarize(await loadSince($, start), map, start, now + 1, now, { since })
      return { pct: l.percentUsed, resetsAt: l.resetsAt ?? null, split: splitOf(totals, kind === 'five_hour' ? 'fivePts' : 'weekPts', shown) }
    }
    const value: ClientClockDash = {
      period: which,
      title: r.span.title,
      from: r.span.from,
      to: r.span.to,
      five: await windowOf('five_hour', FIVE_MS),
      week: await windowOf('seven_day', WEEK_MS),
      rows: r.rows.map(row => ({ ...row, label: shown(row.label) })),
      loose: loose.slice(0, 3).map((x, i) => ({ name: demo ? `folder ${i + 1}` : folderName(tilde(x.root, c.home)), ms: x.youMs + x.agentMs })),
      looseCount: loose.length,
      demo,
      updatedAt: now,
    }
    await update($, dash, () => value)
  } catch (err) {
    $.ui.log(`client-clock: ${String(err).slice(0, 120)}`)
  } finally {
    dashRefreshing = false
  }
}

function resetLabel(iso: string, now: number) {
  const at = Date.parse(iso)
  try {
    const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (at - now < 20 * HOUR) return time
    return `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${time}`
  } catch {
    return iso
  }
}

// A markdown table: the first column left, the rest right.
function table(head: string[], rows: Array<Array<string | number>>) {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ]
}

// ---------- hooks ----------

let timer: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ctx = null
    own = null
    const c = await context($)
    const map = await mapping($)
    const usage = await $.session.usage()
    await append($, {
      t: await $.clock.now(),
      kind: 'start',
      ...where(c),
      ...(c.pin ? { pin: c.pin } : {}),
      label: clientOf(map, c),
      cost: usage.cost?.usd,
    })
    await $.command.register({
      name: 'client',
      description: "Client clock: set or show this repo's client",
      argumentHint: '[name | personal | name in <folder> | budget <points> | rate <per hour> | forget <folder>]',
    })
    await $.command.register({
      name: 'ledger',
      description: 'Client clock: your time, Claude time and usage per client',
      argumentHint: '[today | week | lastweek | csv | timesheet | unassigned | add 30m note]',
    })
    await $.command.register({ name: 'clock', description: 'Client clock: open the dashboard', argumentHint: '[demo [on | off]]' })
    dashOpen = (await read($, dash)) !== null
    if (usage.rateLimits.length) {
      await append($, {
        t: await $.clock.now(),
        kind: 'limits',
        limits: usage.rateLimits.map(l => ({ k: l.kind, p: l.percentUsed, r: l.resetsAt })),
        cost: usage.cost?.usd,
      })
    }
    timer?.cancel()
    timer = $.clock.every(60000, () => {
      void refreshBand($)
      if (dashOpen) void refreshDash($)
    })
    void refreshBand($)
    if (dashOpen) void refreshDash($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const c = await context($)
    void append($, {
      t: await $.clock.now(),
      kind: 'prompt',
      ...where(c),
      origin: e.origin.kind,
      during: Boolean(e.turnId),
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const c = await context($)
    const usage = await $.session.usage()
    const u = e.usage as unknown as Record<string, number> | undefined
    const tok = u
      ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)
      : 0
    void append($, {
      t: await $.clock.now(),
      kind: 'turn',
      ...where(c),
      ms: e.durationMs,
      agent: e.agentId !== undefined,
      tok: Math.round(tok),
      cost: usage.cost?.usd,
    })
    void refreshBand($)
    if (dashOpen) void refreshDash($)
    return next(e)
  })

  // Readings of the usage windows. The engine measures when a window moves a whole point,
  // mid-turn too, so each reading carries the session's running cost: a turn still running
  // counts for its client.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length) {
      void append($, {
        t: await $.clock.now(),
        kind: 'limits',
        limits: e.rateLimits.map(l => ({ k: l.kind, p: l.percentUsed, r: l.resetsAt })),
        cost: e.cost?.usd,
      })
      void refreshBand($)
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    void append($, { t: await $.clock.now(), kind: 'attach', surface: e.surface, client: e.clientId })
    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    void append($, { t: await $.clock.now(), kind: 'detach', surface: e.surface, client: e.clientId })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await append($, { t: await $.clock.now(), kind: 'end' })
    return next(e)
  })

  on('command.run', { command: 'client' }, async ($, e) => {
    const c = await context($)
    const map = await mapping($)
    const args = e.args.trim()
    const refresh = () => {
      void refreshBand($)
      if (dashOpen) void refreshDash($)
    }
    if (!args) {
      const b = await budgets($)
      const rate = await rates($)
      const label = clientOf(map, c)
      const known = [...new Set(Object.values(map))].sort()
      const shown = await shower($, known)
      const demo = await isDemo($)
      const ruleKeys = Object.keys(map).filter(key => key.startsWith('rule:'))
      const about = (l: string) => {
        const notes = [b[l] ? `budget ${b[l]} pts/week` : '', rate[l] ? `$${rate[l]}/hour` : ''].filter(Boolean)
        return notes.length ? `${shown(l)} (${notes.join(', ')})` : shown(l)
      }
      return {
        text: [
          c.pin
            ? `This session counts as ${shown(c.pin)}: CLIENT_CLOCK_CLIENT is set.`
            : `This repo${demo ? '' : ` (${tilde(c.root, c.home)})`} is ${label ? shown(label) : 'not assigned to a client yet'}.`,
          known.length ? `Clients so far: ${known.map(about).join(', ')}.` : '',
          ruleKeys.length
            ? demo
              ? `Folder rules: ${ruleKeys.length} (hidden in demo mode).`
              : `Folder rules: ${ruleKeys.map(key => `${tilde(key.slice('rule:'.length), c.home)} → ${map[key]}`).join(', ')}.`
            : '',
          'Set it with /client <name>, /client personal, /client <name> in <folder>, /client budget <points of your weekly limit>, or /client rate <per hour>.',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }
    const [first, second] = args.split(/\s+/)
    const label = clientOf(map, c)
    if (first === 'budget' || first === 'rate') {
      if (!label || label === PERSONAL) return { text: 'Assign this repo to a client first: /client <name>.' }
      const shown = await shower($, [label])
      if (first === 'budget') {
        const points = Number(second)
        if (!Number.isFinite(points) || points <= 0 || points > 100) {
          return { text: 'Give the budget in points of your weekly limit, 1 to 100: /client budget 25' }
        }
        await $.store.set('budgets', { ...(await budgets($)), [label]: points })
        refresh()
        return { text: `${shown(label)}: budget of ${points} points of your weekly limit. You'll get a heads-up when it's reached.` }
      }
      const all = await rates($)
      if (second === 'off' || second === '0') {
        const { [label]: _dropped, ...rest } = all
        await $.store.set('rates', rest)
        refresh()
        return { text: `${shown(label)}: no hourly rate.` }
      }
      const amount = Number((second ?? '').replace(/^\$/, ''))
      if (!Number.isFinite(amount) || amount <= 0) return { text: 'Give your hourly rate for this client: /client rate 95' }
      await $.store.set('rates', { ...all, [label]: amount })
      refresh()
      return { text: `${shown(label)}: $${amount}/hour. /ledger and the timesheet show what your time comes to.` }
    }
    if (first === 'forget') {
      const target = untilde(args.slice('forget'.length).trim(), c.home)
      if (!(target in map) && !(ruleSlot(target) in map)) return { text: `No label or rule for ${tilde(target, c.home)}.` }
      const { [target]: _folder, [ruleSlot(target)]: _rule, ...rest } = map
      await $.store.set('clients', rest)
      refresh()
      return { text: `Forgot ${tilde(target, c.home)}.` }
    }
    // A folder of a tool's (HyperFrames Studio, a script, a scheduled task): /client acme in
    // ~/.hyperframes-studio/Acme*. The rule covers folders inside it, and later ones it matches.
    const at = args.lastIndexOf(' in ')
    if (at > 0) {
      const name = args.slice(0, at).trim().slice(0, 32)
      const target = untilde(args.slice(at + ' in '.length).trim(), c.home).replace(/\/+$/, '')
      if (!name || !target.startsWith('/')) return { text: 'Give a folder: /client acme in ~/.hyperframes-studio/Acme*' }
      await $.store.set('clients', {
        ...map,
        [ruleSlot(target)]: name,
        ...(target.includes('*') ? {} : { [target]: name }),
      })
      refresh()
      const shown = await shower($, [name])
      return {
        text: `${tilde(target, c.home)} now counts as ${shown(name)}, and so does earlier work there${target.includes('*') ? ' and in any folder the pattern matches' : ''}.`,
      }
    }
    const name = args.slice(0, 32)
    await setLabel($, name)
    refresh()
    const shown = await shower($, [name])
    return {
      text: [
        name === PERSONAL
          ? 'This repo is personal: logged, not billed.'
          : `This repo now counts as ${shown(name)}. Earlier work in it counts as ${shown(name)} too.`,
        c.pin ? `This session still counts as ${shown(c.pin)}: CLIENT_CLOCK_CLIENT is set.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const c = await context($)
    const now = await $.clock.now()
    const args = e.args.trim()

    if (/^add\b/i.test(args)) {
      const m = /^add\s+(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs)?\b\s*(.*)$/i.exec(args)
      if (!m) return { text: 'Add time with /ledger add 30m what you did (or 1.5h).' }
      const minutes = Number(m[1]) * (m[2] && m[2].toLowerCase().startsWith('h') ? 60 : 1)
      const label = clientOf(await mapping($), c)
      if (!label || label === PERSONAL) return { text: 'Assign this repo to a client first: /client <name>.' }
      await append($, { t: now, kind: 'manual', ...where(c), label, minutes, note: m[3] || undefined })
      void refreshBand($)
      const shown = await shower($, [label])
      return { text: `Added ${formatMs(minutes * 60000)} to ${shown(label)}${m[3] ? `: ${m[3]}` : ''}.` }
    }

    const words = args.split(/\s+/).filter(Boolean)
    const sub = words[0] === 'csv' || words[0] === 'timesheet' || words[0] === 'unassigned' ? words[0] : null
    const which = (sub ? words[1] : words[0]) ?? 'week'
    const usage = 'Try /ledger today, /ledger week, /ledger lastweek, /ledger csv week, /ledger timesheet week, /ledger unassigned, or /ledger add 30m note.'

    if (sub === 'unassigned') {
      const span = periodOf(which, now)
      if (!span) return { text: usage }
      const loose = await unassignedIn($, span, now)
      if (loose.length === 0) return { text: `Nothing unassigned ${span.title}.` }
      const demo = await isDemo($)
      return {
        text: [
          `**Unassigned ${span.title}**: folders Claude Code ran in that no client covers`,
          '',
          ...table(
            ['folder', 'you', 'Claude', '5-hour pts', 'weekly pts'],
            loose.map((x, i) => [
              `${demo ? `folder ${i + 1}` : tilde(x.root, c.home)}${x.sdk ? ' (run by a tool)' : ''}`,
              formatMs(x.youMs),
              formatMs(x.agentMs),
              x.fivePts ? x.fivePts.toFixed(0) : '',
              x.weekPts ? x.weekPts.toFixed(1) : '',
            ]),
          ),
          '',
          demo
            ? 'Folder names are hidden in demo mode: /clock demo off shows them.'
            : 'Give one a client with /client <name> in <folder>. A pattern covers the folders a tool makes later too: /client acme in ~/.hyperframes-studio/Acme*',
        ].join('\n'),
      }
    }

    if (sub === 'timesheet') {
      const sheet = await timesheet($, which, now)
      if (!sheet) return { text: usage }
      if (sheet.rows.length === 0) return { text: `Nothing logged ${sheet.span.title} yet.` }
      const billing = sheet.rows.some(r => r.billable !== null)
      return {
        text: [
          `**Timesheet, ${sheet.span.title}**`,
          '',
          ...table(
            ['date', 'client', 'you', 'Claude', ...(billing ? ['billable'] : []), 'what'],
            sheet.rows.map(r => [
              r.date,
              sheet.shown(r.label),
              formatMs(r.youMs),
              formatMs(r.agentMs),
              ...(billing ? [r.billable === null ? '' : money(r.billable)] : []),
              r.what.length > 80 ? `${r.what.slice(0, 79)}…` : r.what,
            ]),
          ),
          '',
          `Wrote it to ${sheet.path}`,
        ].join('\n'),
      }
    }

    const r = await report($, which, now)
    if (!r) return { text: usage }
    const { span, rows } = r
    if (rows.length === 0) return { text: `Nothing logged ${span.title} yet.` }
    const shown = await shower($, rows.map(row => row.label))

    if (sub === 'csv') {
      const path = await exportCsv($, span, rows, shown)
      return { text: `Wrote ${rows.length} clients for ${span.title} to ${path}` }
    }

    const billing = rows.some(row => row.billable !== null)
    return {
      text: [
        `**Client clock, ${span.title}** (${day(span.from)} to ${span.to > now ? 'now' : day(span.to)})`,
        '',
        ...table(
          ['client', 'you', 'Claude', 'prompts', '5-hour pts', 'weekly pts', 'API-equivalent', 'locked out', 'commits', ...(billing ? ['billable'] : [])],
          rows.map(row => [
            shown(row.label),
            `${formatMs(row.youMs)}${row.addedMs ? ` (${formatMs(row.addedMs)} added)` : ''}`,
            formatMs(row.agentMs),
            row.prompts,
            row.fivePts ? row.fivePts.toFixed(0) : '',
            row.weekPts ? row.weekPts.toFixed(1) : '',
            row.cost ? `$${row.cost.toFixed(2)}` : '',
            row.lockoutMs ? formatMs(row.lockoutMs) : '',
            row.commits || '',
            ...(billing ? [row.billable === null ? '' : `$${row.billable.toFixed(2)}`] : []),
          ]),
        ),
        '',
        `You: the gap before each prompt, up to ${IDLE_CAP_MS / 60000} minutes, plus checking in from your phone while Claude worked, plus /ledger add; overlapping sessions count once. Claude: turn time, which can overlap across sessions. Points are estimates: usage windows are account-wide, so each rise is split by what each client's sessions spent at API prices.`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'clock' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words[0] === 'demo') {
      const enabled = words[1] === 'on' ? true : words[1] === 'off' ? false : !(await isDemo($))
      await $.store.set('demo', enabled)
      void refreshBand($)
      if (dashOpen) void refreshDash($)
      return {
        text: enabled
          ? 'Demo mode on: clients show as client a, client b, ... and folder names are hidden in the band, /clock, /ledger, /client and exports. /clock demo off turns it off.'
          : 'Demo mode off: client names are back.',
      }
    }
    dashOpen = true
    await refreshDash($)
    await $.ui.open({ id: PANE, title: 'Client clock' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const d = await read($, dash)
    const which: ClientClockPeriod = await read($, period)
    const cols = Math.max(32, e.props.bodyColumns)

    const choose = (next: ClientClockPeriod) => async () => {
      await update($, period, () => next)
      await refreshDash($)
    }
    const exportNow = async () => {
      const r = await report($, which, await $.clock.now())
      if (!r || r.rows.length === 0) return void $.ui.toast('Nothing to export yet.')
      $.ui.toast(`Exported to ${await exportCsv($, r.span, r.rows, await shower($, r.rows.map(row => row.label)))}`)
    }
    const buttons = (
      <Box key="buttons" marginTop={1} gap={1} flexWrap="wrap">
        <Button key="p-today" hotkey="1" label="Today" variant={which === 'today' ? 'primary' : undefined} onPress={choose('today')} />
        <Button key="p-week" hotkey="2" label="Week" variant={which === 'week' ? 'primary' : undefined} onPress={choose('week')} />
        <Button key="p-last" hotkey="3" label="Last week" variant={which === 'lastweek' ? 'primary' : undefined} onPress={choose('lastweek')} />
        <Button key="export" hotkey="4" label="Export CSV" onPress={exportNow} />
      </Box>
    )

    if (d === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Loading the client clock...</Text>
        </Box>
      )
    }

    // Usage windows as bars, each with every client's points of it below.
    const barWidth = Math.max(8, Math.min(28, cols - 30))
    const bar = (key: string, name: string, w: ClientClockWindow | null) => {
      if (!w) {
        return (
          <Box key={key}>
            <Box width={8}><Text>{name}</Text></Box>
            <Text dimColor>no reading yet</Text>
          </Box>
        )
      }
      const filled = Math.max(0, Math.min(barWidth, Math.round((w.pct / 100) * barWidth)))
      return (
        <Box key={key}>
          <Box width={8}><Text>{name}</Text></Box>
          <Text color={w.pct >= 90 ? 'red' : undefined}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
          <Box width={7} justifyContent="flex-end"><Text bold>{`${Math.round(w.pct)}%`}</Text></Box>
          <Text dimColor>{w.resetsAt ? `  resets ${resetLabel(w.resetsAt, d.updatedAt)}` : ''}</Text>
        </Box>
      )
    }
    const shares = (key: string, w: ClientClockWindow | null) => {
      const parts = (w?.split ?? []).slice(0, 4).map(x => `${x.label} ${Math.round(x.pts)}`)
      return parts.length ? (
        <Box key={`${key}-split`} marginLeft={8}>
          <Text dimColor wrap="truncate-end">{parts.join(' · ')}</Text>
        </Box>
      ) : null
    }

    // The client table: columns drop out as the pane narrows.
    type Col = { key: string; title: string; width: number; cell: (r: ClientClockRow) => string; warn?: (r: ClientClockRow) => boolean }
    const billing = d.rows.some(r => typeof r.rate === 'number')
    const all: Array<Col & { minCols: number }> = [
      { key: 'you', title: 'you', width: 8, minCols: 0, cell: r => formatMs(r.youMs) },
      { key: 'claude', title: 'Claude', width: 8, minCols: 0, cell: r => formatMs(r.agentMs) },
      { key: 'five', title: '5h pts', width: 7, minCols: 64, cell: r => (r.fivePts ? r.fivePts.toFixed(0) : '') },
      {
        key: 'week',
        title: 'week pts',
        width: 10,
        minCols: 0,
        cell: r => (r.weekPts || r.budget ? `${r.weekPts.toFixed(r.weekPts < 10 ? 1 : 0)}${r.budget ? `/${r.budget}` : ''}` : ''),
        warn: r => r.budget !== null && r.weekPts >= r.budget,
      },
      { key: 'cost', title: 'est. cost', width: 10, minCols: 50, cell: r => (r.cost ? money(r.cost) : '') },
      ...(billing
        ? [{ key: 'bill', title: 'billable', width: 10, minCols: 56, cell: (r: ClientClockRow) => (typeof r.billable === 'number' ? money(r.billable) : '') }]
        : []),
      { key: 'commits', title: 'commits', width: 8, minCols: 72, cell: r => (r.commits ? String(r.commits) : '') },
    ]
    const shown = all.filter(col => cols >= col.minCols)
    const row = (key: string, label: string, cells: Array<{ key: string; text: string; width: number; warn?: boolean }>, dim: boolean) => (
      <Box key={key}>
        <Box flexGrow={1} minWidth={10}>
          <Text dimColor={dim} bold={!dim} wrap="truncate-end">{label}</Text>
        </Box>
        {cells.map(c => (
          <Box key={`${key}-${c.key}`} width={c.width} justifyContent="flex-end">
            <Text dimColor={dim} color={c.warn ? 'red' : undefined}>{c.text}</Text>
          </Box>
        ))}
      </Box>
    )
    const header = row('head', 'client', shown.map(c => ({ key: c.key, text: c.title, width: c.width })), true)
    const lines = d.rows.map(r =>
      row(`row-${r.label}`, r.label, shown.map(c => ({ key: c.key, text: c.cell(r), width: c.width, warn: c.warn?.(r) })), false),
    )
    const locked = d.rows.filter(r => r.lockoutMs > 0)
    const loose = d.loose ?? []
    const updated = (() => {
      try {
        return new Date(d.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      } catch {
        return ''
      }
    })()

    return (
      <Box flexDirection="column">
        <Box key="title" justifyContent="space-between" marginRight={2}>
          <Text bold>{d.demo ? 'CLIENT CLOCK · demo' : 'CLIENT CLOCK'}</Text>
          <Text dimColor>{d.title}</Text>
        </Box>
        <Box key="windows" flexDirection="column" marginTop={1}>
          {bar('five', '5-hour', d.five)}
          {shares('five', d.five)}
          {bar('week', 'Week', d.week)}
          {shares('week', d.week)}
        </Box>
        <Box key="table" flexDirection="column" marginTop={1}>
          {d.rows.length === 0 ? (
            <Text dimColor>{`Nothing logged ${d.title} yet. Label a repo with /client <name>.`}</Text>
          ) : (
            [header, ...lines]
          )}
        </Box>
        {loose.length > 0 ? (
          <Box key="loose" marginTop={1}>
            <Text dimColor wrap="truncate-end">
              {`unassigned: ${loose.map(x => `${x.name} ${formatMs(x.ms)}`).join(', ')}${(d.looseCount ?? 0) > loose.length ? ', ...' : ''} · /ledger unassigned`}
            </Text>
          </Box>
        ) : null}
        {locked.length > 0 ? (
          <Box key="locked" marginTop={1}>
            <Text color="red">{`Locked out: ${locked.map(r => `${r.label} ${formatMs(r.lockoutMs)}`).join(', ')}`}</Text>
          </Box>
        ) : null}
        {buttons}
        <Box key="note" marginTop={1}>
          <Text dimColor wrap="wrap">{`You = gaps before your prompts (up to ${IDLE_CAP_MS / 60000}m) plus checking in from your phone. Points split your account-wide limits by what each client's sessions spent, so they're estimates. Updated ${updated}; /ledger has the full table.`}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const b = await read($, band)
    if (b === null || b.label === PERSONAL) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (b.label === null) {
      // A band kept from an older version holds plain labels.
      const known = (b.known ?? []).map(k => (typeof k === 'string' ? { label: k, shown: k } : k))
      return (
        <Box>
          <Text dimColor>Client clock: which client is this repo? </Text>
          {known.slice(0, 3).map(k => (
            <Button key={`client-${k.label}`} label={k.shown} onPress={() => assign($, k.label)} />
          ))}
          <Button key="client-personal" label="personal" onPress={() => assign($, PERSONAL)} />
          <Text dimColor> or /client name</Text>
        </Box>
      )
    }

    const name = b.shown ?? b.label
    const parts = [`⏱ ${name}`, `you ${formatMs(b.youMs)}`, `Claude ${formatMs(b.agentMs)} today`]
    if (b.five !== null) parts.push(`5h ${Math.round(b.five)}%`)
    if (b.week !== null) parts.push(`week ${Math.round(b.week)}%`)
    if (b.budget !== null) parts.push(`${name} ${Math.round(b.labelWeek)}/${b.budget} pts`)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {parts.join(' · ')}
        </Text>
      </Box>
    )
  })
}
