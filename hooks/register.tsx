// client-clock: logs your time, Claude's time and your 5-hour/weekly usage per client.
//
// Every session appends its own events to ~/.claude/client-clock/ledger/<session>.jsonl
// (one file per session, so parallel sessions never write the same file). Reports read
// the files back and work out, per client:
//   you     the gap before each prompt you send, up to IDLE_CAP_MS, plus time a phone or
//           web client watched Claude work, plus /ledger add entries; overlapping
//           sessions count once, split evenly between the clients active at that moment
//   Claude  the wall-clock length of Claude's turns (parallel sessions can overlap)
//   usage   each rise in the 5-hour and weekly windows between two readings, split by the
//           tokens each client's turns used in that stretch (the windows are account-wide)
//   lockout time spent at 100% of a window until it reset, split the same way
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClientClockBand, ClientClockDash, ClientClockPeriod, ClientClockRow, ClientClockWindow } from '../types'

type $T = EngineInterface

const band = atom({ plugin: 'client-clock', key: 'band' } as const, null)
const dash = atom({ plugin: 'client-clock', key: 'dash' } as const, null)
const period = atom({ plugin: 'client-clock', key: 'period' } as const, 'week')
const PANE = 'client-clock'

const IDLE_CAP_MS = 10 * 60 * 1000
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const PERSONAL = 'personal'
const UNASSIGNED = 'unassigned'
const OTHER = 'other (outside Claude Code)'
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

let ctx: { session: string; root: string; dir: string } | null = null

async function context($: $T) {
  if (ctx) return ctx
  const [session, repo, cwd, home] = await Promise.all([
    $.session.id(),
    $.session.repo(),
    $.session.cwd(),
    $.env.get('HOME'),
  ])
  ctx = { session, root: repo?.root ?? cwd, dir: `${home ?? '.'}/.claude/client-clock` }
  return ctx
}

async function mapping($: $T): Promise<Record<string, string>> {
  return ((await $.store.get('clients')) ?? {}) as Record<string, string>
}

async function budgets($: $T): Promise<Record<string, number>> {
  return ((await $.store.get('budgets')) ?? {}) as Record<string, number>
}

// Appends one event to this session's ledger file, one write at a time.
let chain: Promise<unknown> = Promise.resolve()

function append($: $T, rec: Rec): Promise<unknown> {
  chain = chain
    .then(async () => {
      const c = await context($)
      const path = `${c.dir}/ledger/${c.session}.jsonl`
      const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
      await $.fs.write(path, `${before}${JSON.stringify(rec)}\n`)
    })
    .catch(err => $.ui.log(`client-clock: could not write the ledger (${String(err).slice(0, 80)})`))
  return chain
}

async function loadSince($: $T, since: number): Promise<Rec[]> {
  const c = await context($)
  const dir = `${c.dir}/ledger`
  if (!(await $.fs.exists(dir))) return []
  const out: Rec[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < since) continue
    const session = f.name.slice(0, -'.jsonl'.length)
    const text = String(await $.fs.read(`${dir}/${f.name}`))
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push({ ...(JSON.parse(line) as Rec), session })
      } catch {
        // a line cut short by a crash: skip it
      }
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// ---------- the arithmetic ----------

export function summarize(recs: Rec[], map: Record<string, string>, from: number, to: number, now: number) {
  const totals = new Map<string, Totals>()
  const get = (label: string) => {
    let t = totals.get(label)
    if (!t) totals.set(label, (t = emptyTotals()))
    return t
  }
  const labelOf = (r: Rec) => (r.root && map[r.root]) || r.label || UNASSIGNED
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

  for (const list of bySession.values()) {
    let last: number | null = null
    let lastCost: number | null = null // the session's running cost total; null until a baseline
    let sessionLabel = UNASSIGNED
    const watching: Array<{ a: number; b: number }> = []
    const working: Array<{ a: number; b: number }> = []
    const attached = new Map<string, number>()
    for (const r of list) {
      if (r.root) sessionLabel = labelOf(r)
      if (r.kind === 'start') {
        last = r.t
        if (typeof r.cost === 'number') lastCost = r.cost
      } else if (r.kind === 'prompt') {
        if (!HUMAN_ORIGINS.has(r.origin ?? '')) continue
        const label = labelOf(r)
        const gap = last === null ? 0 : Math.min(r.t - last, IDLE_CAP_MS)
        if (gap > 0) spans.push({ a: r.t - gap, b: r.t, label })
        last = r.t
        if (inRange(r.t)) get(label).prompts += 1
      } else if (r.kind === 'turn') {
        const label = labelOf(r)
        // cost is the session's running total: spend is the rise since the last reading,
        // and a first reading with no baseline (a session already running) counts as 0
        const cost = typeof r.cost === 'number' ? r.cost : null
        const spent = cost !== null && lastCost !== null ? Math.max(0, cost - lastCost) : 0
        if (cost !== null) lastCost = cost
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
      } else if (r.kind === 'attach') {
        if (r.client && r.surface !== 'terminal') attached.set(r.client, r.t)
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
    for (const since of attached.values()) watching.push({ a: since, b: now })
    // A phone or web client counts as you only while Claude was working.
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

  // Usage: split each rise between two readings by the tokens each client's turns used then.
  // A turn's tokens are spread over the time it ran, so a long turn shares in the rises
  // it caused while running, not only the first reading after it ends.
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
      const used = turns.map(x => ({ label: x.label, tok: weight(x, startT, r.t) })).filter(x => x.tok > 0)
      const sum = used.reduce((n, x) => n + x.tok, 0)
      const split = shares.get(id) ?? new Map<string, number>()
      if (sum === 0) split.set(OTHER, (split.get(OTHER) ?? 0) + rise)
      else for (const x of used) split.set(x.label, (split.get(x.label) ?? 0) + (rise * x.tok) / sum)
      shares.set(id, split)
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

// ---------- the band ----------

let refreshing = false

async function refreshBand($: $T) {
  if (refreshing) return
  refreshing = true
  try {
    const c = await context($)
    const now = await $.clock.now()
    const map = await mapping($)
    const label = map[c.root] ?? null
    const usage = await $.session.usage()
    const five = usage.rateLimits.find(l => l.kind === 'five_hour')
    const week = usage.rateLimits.find(l => l.kind === 'seven_day')
    const dayFrom = startOfDay(now)
    const weekFrom = week?.resetsAt ? Date.parse(week.resetsAt) - WEEK_MS : startOfWeek(now)
    const fiveFrom = five?.resetsAt ? Date.parse(five.resetsAt) - FIVE_MS : now - FIVE_MS
    const recs = await loadSince($, Math.min(dayFrom, weekFrom, fiveFrom))
    const today = summarize(recs, map, dayFrom, now + 1, now)
    const thisWeek = summarize(recs, map, weekFrom, now + 1, now)
    const thisFive = summarize(recs, map, fiveFrom, now + 1, now)
    const budget = label ? (await budgets($))[label] ?? null : null
    const value: ClientClockBand = {
      label,
      known: [...new Set(Object.values(map))].filter(l => l !== PERSONAL).sort(),
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
        `${label} has used about ${Math.round(value.labelWeek)} points of your weekly limit (budget ${budget}).`,
      ])
    }
    const fiveAll = [...thisFive.values()].reduce((n, t) => n + t.fivePts, 0)
    const fiveMine = thisFive.get(label)?.fivePts ?? 0
    if (five && five.percentUsed >= 80 && fiveAll > 0 && fiveMine / fiveAll >= 0.5) {
      warnings.push([
        `five:${label}:${five.resetsAt ?? fiveFrom}`,
        `${label} is ${Math.round((100 * fiveMine) / fiveAll)}% of this 5-hour window (${Math.round(five.percentUsed)}% used, resets ${clockTime(five.resetsAt)}).`,
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
  const c = await context($)
  await $.store.set('clients', { ...(await mapping($)), [c.root]: label })
  $.ui.toast(label === PERSONAL ? 'This repo is personal: not billed.' : `This repo now counts as ${label}.`)
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

// Your commits on any local branch, so work on a branch or in a worktree counts;
// worktrees of one repo share their commits, so each counts once.
export async function commitsIn($: $T, roots: Set<string>, from: number, to: number) {
  const seen = new Set<string>()
  for (const root of roots) {
    const email = await $.process.run(['git', '-C', root, 'config', 'user.email'], { timeoutMs: 5000 }).catch(() => null)
    const author = email && email.exitCode === 0 ? email.stdout.trim() : ''
    const run = await $.process
      .run(
        [
          'git', '-C', root, 'log', '--branches', '--no-merges', '--pretty=%H',
          ...(author ? ['--fixed-strings', `--author=${author}`] : []),
          `--since=${new Date(from).toISOString()}`, `--until=${new Date(to).toISOString()}`,
        ],
        { timeoutMs: 10000 },
      )
      .catch(() => null)
    if (run && run.exitCode === 0) for (const hash of run.stdout.split('\n')) if (hash) seen.add(hash)
  }
  return seen.size
}

// One row per client for a period: what /ledger prints and the /clock pane draws.
async function report($: $T, which: string, now: number) {
  const span = periodOf(which, now)
  if (!span) return null
  const map = await mapping($)
  const b = await budgets($)
  const recs = await loadSince($, minusDays(span.from, 7))
  const totals = summarize(recs, map, span.from, span.to, now)
  const rows: ClientClockRow[] = []
  for (const [label, t] of totals) {
    if (t.youMs + t.manualMs + t.agentMs + t.fivePts + t.weekPts <= 0) continue
    rows.push({
      label,
      youMs: t.youMs + t.manualMs,
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
    })
  }
  rows.sort((x, y) => y.youMs + y.agentMs - (x.youMs + x.agentMs))
  return { span, rows }
}

async function exportCsv($: $T, span: { from: number; to: number }, rows: ClientClockRow[]) {
  const c = await context($)
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const path = `${c.dir}/exports/ledger-${stamp(span.from)}-to-${stamp(span.to)}.csv`
  const header = 'client,you_hours,added_hours,claude_hours,prompts,turns,five_hour_points,weekly_points,api_equivalent_usd,lockout_hours,commits'
  const lines = rows.map(r =>
    [
      `"${r.label.replace(/"/g, '""')}"`,
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
    ].join(','),
  )
  await $.fs.write(path, `${header}\n${lines.join('\n')}\n`)
  return path
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
    const usage = await $.session.usage()
    const windowOf = (kind: string): ClientClockWindow | null => {
      const l = usage.rateLimits.find(x => x.kind === kind)
      return l ? { pct: l.percentUsed, resetsAt: l.resetsAt ?? null } : null
    }
    const value: ClientClockDash = {
      period: which,
      title: r.span.title,
      from: r.span.from,
      to: r.span.to,
      five: windowOf('five_hour'),
      week: windowOf('seven_day'),
      rows: r.rows,
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

// ---------- hooks ----------

let timer: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    ctx = null
    const c = await context($)
    const map = await mapping($)
    const usage = await $.session.usage()
    await append($, { t: await $.clock.now(), kind: 'start', root: c.root, label: map[c.root] ?? null, cost: usage.cost?.usd })
    await $.command.register({
      name: 'client',
      description: "Client clock: set or show this repo's client",
      argumentHint: '[name | personal | budget <points>]',
    })
    await $.command.register({
      name: 'ledger',
      description: 'Client clock: your time, Claude time and usage per client',
      argumentHint: '[today | week | lastweek | csv | add 30m note]',
    })
    await $.command.register({ name: 'clock', description: 'Client clock: open the dashboard' })
    dashOpen = (await read($, dash)) !== null
    if (usage.rateLimits.length) {
      await append($, {
        t: await $.clock.now(),
        kind: 'limits',
        limits: usage.rateLimits.map(l => ({ k: l.kind, p: l.percentUsed, r: l.resetsAt })),
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
      root: c.root,
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
      root: c.root,
      ms: e.durationMs,
      agent: e.agentId !== undefined,
      tok: Math.round(tok),
      cost: usage.cost?.usd,
    })
    void refreshBand($)
    if (dashOpen) void refreshDash($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length) {
      void append($, {
        t: await $.clock.now(),
        kind: 'limits',
        limits: e.rateLimits.map(l => ({ k: l.kind, p: l.percentUsed, r: l.resetsAt })),
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
    if (!args) {
      const b = await budgets($)
      const known = [...new Set(Object.values(map))].sort()
      const label = map[c.root]
      return {
        text: [
          `This repo (${c.root}) is ${label ? label : 'not assigned to a client yet'}.`,
          known.length ? `Clients so far: ${known.map(l => (b[l] ? `${l} (budget ${b[l]} pts/week)` : l)).join(', ')}.` : '',
          'Set it with /client <name>, /client personal, or /client budget <points of your weekly limit>.',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }
    const [first, second] = args.split(/\s+/)
    if (first === 'budget') {
      const label = map[c.root]
      const points = Number(second)
      if (!label || label === PERSONAL) return { text: 'Assign this repo to a client first: /client <name>.' }
      if (!Number.isFinite(points) || points <= 0 || points > 100) {
        return { text: 'Give the budget in points of your weekly limit, 1 to 100: /client budget 25' }
      }
      await $.store.set('budgets', { ...(await budgets($)), [label]: points })
      void refreshBand($)
      return { text: `${label}: budget of ${points} points of your weekly limit. You'll get a heads-up when it's reached.` }
    }
    const label = args.slice(0, 32)
    await $.store.set('clients', { ...map, [c.root]: label })
    void refreshBand($)
    return {
      text:
        label === PERSONAL
          ? 'This repo is personal: logged, not billed.'
          : `This repo now counts as ${label}. Earlier work in it counts as ${label} too.`,
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
      const label = (await mapping($))[c.root]
      if (!label || label === PERSONAL) return { text: 'Assign this repo to a client first: /client <name>.' }
      await append($, { t: now, kind: 'manual', root: c.root, label, minutes, note: m[3] || undefined })
      void refreshBand($)
      return { text: `Added ${formatMs(minutes * 60000)} to ${label}${m[3] ? `: ${m[3]}` : ''}.` }
    }

    const words = args.split(/\s+/).filter(Boolean)
    const isCsv = words[0] === 'csv'
    const which = (isCsv ? words[1] : words[0]) ?? 'week'
    const r = await report($, which, now)
    if (!r) return { text: 'Try /ledger today, /ledger week, /ledger lastweek, /ledger csv week, or /ledger add 30m note.' }
    const { span, rows } = r
    if (rows.length === 0) return { text: `Nothing logged ${span.title} yet.` }

    if (isCsv) {
      const path = await exportCsv($, span, rows)
      return { text: `Wrote ${rows.length} clients for ${span.title} to ${path}` }
    }

    const table = [
      `**Client clock, ${span.title}** (${day(span.from)} to ${span.to > now ? 'now' : day(span.to)})`,
      '',
      '| client | you | Claude | prompts | 5-hour pts | weekly pts | API-equivalent | locked out | commits |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...rows.map(row =>
        [
          '',
          row.label,
          `${formatMs(row.youMs)}${row.addedMs ? ` (${formatMs(row.addedMs)} added)` : ''}`,
          formatMs(row.agentMs),
          row.prompts,
          row.fivePts ? row.fivePts.toFixed(0) : '',
          row.weekPts ? row.weekPts.toFixed(1) : '',
          row.cost ? `$${row.cost.toFixed(2)}` : '',
          row.lockoutMs ? formatMs(row.lockoutMs) : '',
          row.commits || '',
          '',
        ].join(' | ').trim(),
      ),
      '',
      `You: the gap before each prompt, up to ${IDLE_CAP_MS / 60000} minutes, plus phone or web watching while Claude worked, plus /ledger add; overlapping sessions count once. Claude: turn time, which can overlap across sessions. Points are estimates: usage windows are account-wide, so each rise is split by the tokens each client used.`,
    ]
    return { text: table.join('\n') }
  })

  on('command.run', { command: 'clock' }, async $ => {
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
      $.ui.toast(`Exported to ${await exportCsv($, r.span, r.rows)}`)
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

    // Usage windows as bars.
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

    // The client table: columns drop out as the pane narrows.
    type Col = { key: string; title: string; width: number; cell: (r: ClientClockRow) => string; warn?: (r: ClientClockRow) => boolean }
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
      { key: 'cost', title: 'est. cost', width: 10, minCols: 50, cell: r => (r.cost ? `$${r.cost.toFixed(r.cost < 100 ? 2 : 0)}` : '') },
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
          <Text bold>CLIENT CLOCK</Text>
          <Text dimColor>{d.title}</Text>
        </Box>
        <Box key="windows" flexDirection="column" marginTop={1}>
          {bar('five', '5-hour', d.five)}
          {bar('week', 'Week', d.week)}
        </Box>
        <Box key="table" flexDirection="column" marginTop={1}>
          {d.rows.length === 0 ? (
            <Text dimColor>{`Nothing logged ${d.title} yet. Label a repo with /client <name>.`}</Text>
          ) : (
            [header, ...lines]
          )}
        </Box>
        {locked.length > 0 ? (
          <Box key="locked" marginTop={1}>
            <Text color="red">{`Locked out: ${locked.map(r => `${r.label} ${formatMs(r.lockoutMs)}`).join(', ')}`}</Text>
          </Box>
        ) : null}
        {buttons}
        <Box key="note" marginTop={1}>
          <Text dimColor wrap="wrap">{`You = gaps before your prompts (up to ${IDLE_CAP_MS / 60000}m) plus watching Claude work. Points split your account-wide limits by each client's tokens, so they're estimates. Updated ${updated}; /ledger has the full table.`}</Text>
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
      return (
        <Box>
          <Text dimColor>Client clock: which client is this repo? </Text>
          {b.known.slice(0, 3).map(label => (
            <Button key={`client-${label}`} label={label} onPress={() => assign($, label)} />
          ))}
          <Button key="client-personal" label="personal" onPress={() => assign($, PERSONAL)} />
          <Text dimColor> or /client name</Text>
        </Box>
      )
    }

    const parts = [`⏱ ${b.label}`, `you ${formatMs(b.youMs)}`, `Claude ${formatMs(b.agentMs)} today`]
    if (b.five !== null) parts.push(`5h ${Math.round(b.five)}%`)
    if (b.week !== null) parts.push(`week ${Math.round(b.week)}%`)
    if (b.budget !== null) parts.push(`${b.label} ${Math.round(b.labelWeek)}/${b.budget} pts`)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {parts.join(' · ')}
        </Text>
      </Box>
    )
  })
}
