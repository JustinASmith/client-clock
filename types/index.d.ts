/** What the band above the prompt shows for this session's repo. */
export type ClientClockBand = {
  /** The repo's client label; null while the repo has none yet. */
  label: string | null
  /** Labels already used in other repos, offered as one-press choices. */
  known: string[]
  /** Your time today on this client, in ms. */
  youMs: number
  /** Claude's working time today on this client, in ms (turns can overlap). */
  agentMs: number
  /** Latest 5-hour and weekly window readings, in percent; null before the first. */
  five: number | null
  week: number | null
  /** This client's estimated share of the current weekly window, in points. */
  labelWeek: number
  /** This client's weekly budget in points, when one is set. */
  budget: number | null
}

/** Which stretch of time the dashboard shows. */
export type ClientClockPeriod = 'today' | 'week' | 'lastweek'

/** One client's line on the dashboard and in /ledger. */
export type ClientClockRow = {
  label: string
  /** Your time in ms, including /ledger add entries. */
  youMs: number
  /** The /ledger add part of youMs, in ms. */
  addedMs: number
  agentMs: number
  prompts: number
  turns: number
  fivePts: number
  weekPts: number
  /** Estimated cost at API prices, in USD. */
  cost: number
  lockoutMs: number
  commits: number
  /** Weekly budget in points, when set. */
  budget: number | null
}

/** A usage window as the dashboard shows it. */
export type ClientClockWindow = { pct: number; resetsAt: string | null }

/** Everything the /clock pane draws. */
export type ClientClockDash = {
  period: ClientClockPeriod
  title: string
  from: number
  to: number
  five: ClientClockWindow | null
  week: ClientClockWindow | null
  rows: ClientClockRow[]
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'client-clock': { band: ClientClockBand | null; dash: ClientClockDash | null; period: ClientClockPeriod }
  }
}
