import { expect, test } from 'claude-code/testing'

import { commitsIn, summarize } from '../hooks/register.tsx'
import type { Rec } from '../hooks/register.tsx'

const M = 60 * 1000
const H = 60 * M
const t0 = Date.parse('2026-10-05T14:00:00Z')
const map = { '/r/acme': 'acme', '/r/globex': 'globex' }
const mins = (ms: number) => Math.round(ms / M)

test('your time is the gap before each prompt, capped at 10 minutes', async () => {
  const recs: Rec[] = [
    { t: t0, kind: 'start', session: 'a', root: '/r/acme' },
    { t: t0 + 3 * M, kind: 'prompt', session: 'a', root: '/r/acme', origin: 'composer' },
    { t: t0 + 8 * M, kind: 'turn', session: 'a', root: '/r/acme', ms: 5 * M, tok: 1000 },
    { t: t0 + 38 * M, kind: 'prompt', session: 'a', root: '/r/acme', origin: 'composer' },
    { t: t0 + 40 * M, kind: 'prompt', session: 'a', root: '/r/acme', origin: 'task-notification' },
  ]
  const acme = summarize(recs, map, t0, t0 + H, t0 + H).get('acme')
  expect(mins(acme?.youMs ?? 0)).toBe(13)
  expect(mins(acme?.agentMs ?? 0)).toBe(5)
  expect(acme?.prompts).toBe(2)
})

test('overlapping sessions count your time once, split between the clients', async () => {
  const recs: Rec[] = [
    { t: t0, kind: 'start', session: 'a', root: '/r/acme' },
    { t: t0, kind: 'start', session: 'b', root: '/r/globex' },
    { t: t0 + 10 * M, kind: 'prompt', session: 'a', root: '/r/acme', origin: 'composer' },
    { t: t0 + 10 * M, kind: 'prompt', session: 'b', root: '/r/globex', origin: 'composer' },
  ]
  const totals = summarize(recs, map, t0, t0 + H, t0 + H)
  expect(mins(totals.get('acme')?.youMs ?? 0)).toBe(5)
  expect(mins(totals.get('globex')?.youMs ?? 0)).toBe(5)
})

test('a rise in the 5-hour window splits by the tokens each client used', async () => {
  const resets = new Date(t0 + 3 * H).toISOString()
  const recs: Rec[] = [
    { t: t0, kind: 'limits', session: 'a', limits: [{ k: 'five_hour', p: 10, r: resets }] },
    { t: t0 + 10 * M, kind: 'turn', session: 'a', root: '/r/acme', ms: M, tok: 3000 },
    { t: t0 + 12 * M, kind: 'turn', session: 'b', root: '/r/globex', ms: M, tok: 1000 },
    { t: t0 + 15 * M, kind: 'limits', session: 'b', limits: [{ k: 'five_hour', p: 30, r: resets }] },
  ]
  const totals = summarize(recs, map, t0, t0 + H, t0 + H)
  expect(Math.round(totals.get('acme')?.fivePts ?? 0)).toBe(15)
  expect(Math.round(totals.get('globex')?.fivePts ?? 0)).toBe(5)
})

test('a long turn gets the rises it causes while it runs, not other', async () => {
  const resets = new Date(t0 + 3 * H).toISOString()
  const recs: Rec[] = [
    { t: t0, kind: 'limits', session: 'a', limits: [{ k: 'five_hour', p: 10, r: resets }] },
    { t: t0 + 20 * M, kind: 'limits', session: 'a', limits: [{ k: 'five_hour', p: 20, r: resets }] },
    { t: t0 + 40 * M, kind: 'limits', session: 'a', limits: [{ k: 'five_hour', p: 30, r: resets }] },
    // ran from t0 + 5m to t0 + 65m, so 25 of its 60 minutes fall after the t0 + 40m reading
    { t: t0 + 65 * M, kind: 'turn', session: 'a', root: '/r/acme', ms: 60 * M, tok: 6000 },
    { t: t0 + 68 * M, kind: 'turn', session: 'b', root: '/r/globex', ms: M, tok: 2500 },
    { t: t0 + 70 * M, kind: 'limits', session: 'b', limits: [{ k: 'five_hour', p: 36, r: resets }] },
  ]
  const totals = summarize(recs, map, t0, t0 + 2 * H, t0 + 2 * H)
  expect(Math.round(totals.get('acme')?.fivePts ?? 0)).toBe(23)
  expect(Math.round(totals.get('globex')?.fivePts ?? 0)).toBe(3)
  // only the 10 already used before t0 has no logged turn behind it
  expect(Math.round(totals.get('other (outside Claude Code)')?.fivePts ?? 0)).toBe(10)
})

test('time locked out at 100% splits by each client share of that window', async () => {
  const resets = new Date(t0 + 2 * H).toISOString()
  const recs: Rec[] = [
    { t: t0, kind: 'limits', session: 'a', limits: [{ k: 'five_hour', p: 50, r: resets }] },
    { t: t0 + 10 * M, kind: 'turn', session: 'a', root: '/r/acme', ms: M, tok: 1000 },
    { t: t0 + 20 * M, kind: 'limits', session: 'a', limits: [{ k: 'five_hour', p: 100, r: resets }] },
  ]
  const totals = summarize(recs, map, t0, t0 + 3 * H, t0 + 3 * H)
  // half of that window was used before any logged turn, so half the lockout is 'other'
  expect(mins(totals.get('acme')?.lockoutMs ?? 0)).toBe(50)
  expect(mins(totals.get('other (outside Claude Code)')?.lockoutMs ?? 0)).toBe(50)
})

test('cost counts from the session start, not from before the clock was running', async () => {
  const recs: Rec[] = [
    { t: t0, kind: 'start', session: 'a', root: '/r/acme', cost: 100 },
    { t: t0 + M, kind: 'turn', session: 'a', root: '/r/acme', ms: M, tok: 10, cost: 101.5 },
    { t: t0, kind: 'start', session: 'b', root: '/r/globex' },
    { t: t0 + M, kind: 'turn', session: 'b', root: '/r/globex', ms: M, tok: 10, cost: 345.5 },
    { t: t0 + 2 * M, kind: 'turn', session: 'b', root: '/r/globex', ms: M, tok: 10, cost: 347.1 },
  ]
  const totals = summarize(recs, map, t0, t0 + H, t0 + H)
  expect(Math.round((totals.get('acme')?.cost ?? 0) * 100)).toBe(150)
  expect(Math.round((totals.get('globex')?.cost ?? 0) * 100)).toBe(160)
})

test('commits are yours on any local branch, counted once across worktrees', async () => {
  const calls: string[][] = []
  const $ = {
    process: {
      run: async (argv: readonly string[]) => {
        calls.push([...argv])
        if (argv.includes('config')) return { exitCode: 0, stdout: 'me@example.com\n', stderr: '' }
        // a checkout and a worktree of the same repo list the same commits
        return { exitCode: 0, stdout: argv[2] === '/r/acme' ? 'aaa\nbbb\n' : 'bbb\nccc\n', stderr: '' }
      },
    },
  }
  expect(await commitsIn($ as never, new Set(['/r/acme', '/r/acme-worktree']), t0, t0 + H)).toBe(3)
  const log = calls.find(argv => argv.includes('log')) ?? []
  expect(log).toContain('--branches')
  expect(log).toContain('--author=me@example.com')
})
