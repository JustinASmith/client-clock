import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// One client repo with a remote, plus two folders a tool (HyperFrames Studio) ran Claude Code in.
const NOW = Date.parse('2026-10-06T16:00:00Z')
const M = 60 * 1000
const HOME = '/home/test'
const ACME = '/r/acme'
const STUDIO = `${HOME}/.hyperframes-studio`
const FIVE = '2026-10-06T19:00:00.000Z'
const WEEK = '2026-10-11T03:00:00.000Z'
const limits = (five: number, week: number) => [
  { k: 'five_hour', p: five, r: FIVE },
  { k: 'seven_day', p: week, r: WEEK },
]
const FILES: Record<string, object[]> = {
  'sess-1.jsonl': [
    { t: NOW - 120 * M, kind: 'start', root: ACME, cost: 0 },
    { t: NOW - 119 * M, kind: 'limits', limits: limits(2, 30), cost: 0 },
    { t: NOW - 110 * M, kind: 'prompt', root: ACME, origin: 'composer' },
    { t: NOW - 100 * M, kind: 'turn', root: ACME, ms: 10 * M, tok: 1000, cost: 2 },
    { t: NOW - 99 * M, kind: 'limits', limits: limits(6, 31), cost: 2 },
  ],
  'studio-1.jsonl': [
    { t: NOW - 70 * M, kind: 'start', root: `${STUDIO}/AcmeVideo`, cost: 0 },
    { t: NOW - 60 * M, kind: 'prompt', root: `${STUDIO}/AcmeVideo`, origin: 'sdk' },
    { t: NOW - 50 * M, kind: 'turn', root: `${STUDIO}/AcmeVideo`, ms: 5 * M, tok: 500, cost: 1 },
  ],
  'studio-2.jsonl': [
    { t: NOW - 45 * M, kind: 'start', root: `${STUDIO}/Untitled`, cost: 0 },
    { t: NOW - 40 * M, kind: 'prompt', root: `${STUDIO}/Untitled`, origin: 'sdk' },
    { t: NOW - 35 * M, kind: 'turn', root: `${STUDIO}/Untitled`, ms: 3 * M, tok: 300, cost: 0.5 },
  ],
}
const text = (name: string) => `${(FILES[name] ?? []).map(r => JSON.stringify(r)).join('\n')}\n`

function setUp(on: Parameters<TestBody>[1], store: Record<string, unknown>) {
  const writes: Array<{ path: string; text: string }> = []
  mock.clock(on, { now: NOW })
  mock.store(on, store)
  mock.env(on, { HOME })
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('session.repo', () => ({ value: { root: ACME, remote: 'git@github.com:Acme/site.git', internal: false, name: null } }) as never)
  on('session.cwd', () => ({ value: ACME }) as never)
  on('session.usage', () =>
    ({ value: { startedAt: NOW - 120 * M, context: {}, rateLimits: [], cost: { usd: 2 } } }) as never,
  )
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.list', () =>
    ({
      value: Object.keys(FILES).map(name => ({ name, kind: 'file', size: text(name).length, mtimeMs: NOW, isLink: false })),
    }) as never,
  )
  on('fs.read', (_$, e) => ({ value: text(String((e as { path: string }).path).split('/').pop() ?? '') }) as never)
  on('fs.write', (_$, e) => {
    writes.push(e as { path: string; text: string })
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    if (argv.includes('config')) return { value: { exitCode: 0, stdout: 'me@example.com\n', stderr: '' } } as never
    const stdout = argv[2] === ACME ? `abc123\t${Math.round((NOW - 30 * M) / 1000)}\tFix the booking form\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  return writes
}

const run = async ($: Parameters<TestBody>[0], command: string, args = '') =>
  (await $.command.run({ command, args } as never)).text ?? ''

test('a rate shows what your time comes to, and the timesheet lists the day with your commits', async ($, on) => {
  const writes = setUp(on, { clients: { [ACME]: 'ACME' } })
  expect(await run($, 'client', 'rate 95')).toContain('$95/hour')
  const ledger = await run($, 'ledger', 'today')
  expect(ledger).toContain('billable')
  expect(ledger).toContain('$15.83')
  const sheet = await run($, 'ledger', 'timesheet today')
  expect(sheet).toContain('Fix the booking form')
  const csv = writes.find(w => w.path.includes('/exports/timesheet-'))
  expect(csv?.text).toContain('"ACME",0.17,0.17,95,15.83,1,"Fix the booking form"')
})

test('a folder rule gives a tool its client, and /ledger unassigned lists what is left', async ($, on) => {
  setUp(on, { clients: { [ACME]: 'ACME' } })
  const before = await run($, 'ledger', 'unassigned today')
  expect(before).toContain('~/.hyperframes-studio/AcmeVideo (run by a tool)')
  expect(before).toContain('~/.hyperframes-studio/Untitled (run by a tool)')
  expect(await run($, 'client', 'ACME in ~/.hyperframes-studio/Acme*')).toContain('~/.hyperframes-studio/Acme* now counts as ACME')
  const after = await run($, 'ledger', 'unassigned today')
  expect(after).not.toContain('AcmeVideo')
  expect(after).toContain('Untitled')
  // the tool's session now counts for ACME: 10m of yours and 5m of Claude's on top of the repo's 10m and 10m
  expect(await run($, 'ledger', 'today')).toContain('| ACME | 20m | 15m |')
})

test('demo mode shows clients as letters and hides folders', async ($, on) => {
  setUp(on, { clients: { [ACME]: 'ACME' }, demo: true })
  const ledger = await run($, 'ledger', 'today')
  expect(ledger).toContain('client a')
  expect(ledger).not.toContain('ACME')
  const client = await run($, 'client')
  expect(client).toContain('client a')
  expect(client).not.toContain(ACME)
  const loose = await run($, 'ledger', 'unassigned today')
  expect(loose).toContain('folder 1')
  expect(loose).not.toContain('AcmeVideo')
})
