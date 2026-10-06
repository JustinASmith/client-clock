import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const NOW = Date.parse('2026-10-05T16:00:00Z')
const M = 60 * 1000
const FIVE = '2026-10-05T17:40:00.000Z'
const WEEK = '2026-10-11T03:00:00.000Z'
const LEDGER =
  [
    { t: NOW - 50 * M, kind: 'start', root: '/r/acme', cost: 10 },
    { t: NOW - 49 * M, kind: 'limits', limits: [{ k: 'five_hour', p: 10, r: FIVE }, { k: 'seven_day', p: 30, r: WEEK }] },
    { t: NOW - 45 * M, kind: 'prompt', root: '/r/acme', origin: 'composer' },
    { t: NOW - 40 * M, kind: 'turn', root: '/r/acme', ms: 5 * M, tok: 1000, cost: 11.5 },
    { t: NOW - 39 * M, kind: 'limits', limits: [{ k: 'five_hour', p: 14, r: FIVE }, { k: 'seven_day', p: 31, r: WEEK }] },
  ]
    .map(r => JSON.stringify(r))
    .join('\n') + '\n'

function setUp(on: Parameters<TestBody>[1], store: Record<string, unknown>) {
  mock.clock(on, { now: NOW })
  mock.store(on, store)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.cwd', () => ({ value: '/r/acme' }) as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: NOW - 60 * M,
        context: {},
        rateLimits: [
          { kind: 'five_hour', percentUsed: 14, resetsAt: FIVE },
          { kind: 'seven_day', percentUsed: 31, resetsAt: WEEK },
        ],
        cost: { usd: 11.5 },
      },
    }) as never,
  )
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.list', () => ({ value: [{ name: 'sess-1.jsonl', kind: 'file', size: LEDGER.length, mtimeMs: NOW, isLink: false }] }) as never)
  on('fs.read', () => ({ value: LEDGER }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'abc123\n', stderr: '' } }) as never)
  on('ui.open', () => ({ value: {} }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
}

const mount = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'client-clock',
    surface,
    component: 'Pane',
    requestId: 'client-clock',
    props: { title: 'Client clock', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
  } as never)

test('the /clock pane draws the windows, who used them, and a client row on terminal and desktop', async ($, on) => {
  setUp(on, { clients: { '/r/acme': 'ACME' }, budgets: { ACME: 25 } })
  await $.command.run({ command: 'clock', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: /CLIENT CLOCK/ } as never)).toBeTruthy()
    expect(await ui.find({ text: /ACME/ } as never)).toBeTruthy()
    expect(await ui.find({ text: /31%/ } as never)).toBeTruthy()
    // the window opened before the clock started, so its first 10 points are "before tracking"
    expect(await ui.find({ text: /before tracking 10 · ACME 4/ } as never)).toBeTruthy()
    await ui.unmount()
  }
})

test('in demo mode the pane says so and shows the client as a letter', async ($, on) => {
  setUp(on, { clients: { '/r/acme': 'ACME' }, demo: true })
  await $.command.run({ command: 'clock', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ text: /CLIENT CLOCK · demo/ } as never)).toBeTruthy()
    expect(await ui.find({ text: /client a/ } as never)).toBeTruthy()
    expect(await ui.find({ text: /ACME/ } as never)).toBeFalsy()
    await ui.unmount()
  }
})
