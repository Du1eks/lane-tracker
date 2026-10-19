import { expect, test } from 'claude-code/testing'

import { bar, bullets, counts, looksCleared, modelName, parseBoard, sessionIds, summary, tokens, tone, view } from '../hooks/parse'

const BOARD = [
  '| **A** | Data (local_ab12) | wt-a | old table text | Working | 10-01 |',
  '',
  '## Lane tracker',
  '@lane A | Data & platform | JSON loading | Working: schema | Phase 3 backend | 10-06',
  '@lane B | Assets & Blender | Recipes | Blocked: tests fail | Statues | 10-06',
  '@lane C | Scene | Presets | Ready to merge | New environments | 10-06',
  "@lane D | UI & builder | Phase 2 done: builder, rooms | Idle: Phase 2 finished | Landing page (needs the user's decisions) | 10-06",
].join('\r\n')

test('reads the @lane lines and gives each lane one state and mark', async () => {
  const lanes = parseBoard(BOARD)
  expect(lanes.map(l => l.lane)).toEqual(['A', 'B', 'C', 'D'])
  expect(summary(lanes)).toBe('Lanes ●A ✖B ◆C ✓D')
  expect(counts(lanes)).toEqual([
    { tone: 'working', n: 1 },
    { tone: 'blocked', n: 1 },
    { tone: 'ready', n: 1 },
    { tone: 'done', n: 1 },
  ])
})

test('the view drops the long lead-ins and flags what needs the user', async () => {
  const [a, , , d] = parseBoard(BOARD).map(view)
  expect(a).toEqual({ lane: 'A', role: 'Data & platform', tone: 'working', now: 'JSON loading · schema', next: 'Phase 3 backend', needsYou: false, updated: '10-06' })
  expect(d?.now).toBe('builder, rooms')
  expect(d?.next).toBe('Landing page')
  expect(d?.needsYou).toBe(true)
})

test('state words are read in the right order', async () => {
  expect(tone('Working: done with tests')).toBe('working')
  expect(tone('Ready to merge')).toBe('ready')
  expect(tone('Merged into main')).toBe('done')
  expect(tone('Paused')).toBe('idle')
})

test('helpers for bullets, session ids, model names and context bars', async () => {
  expect(bullets('JSON loading, sources, schema, examples, and reference split')).toEqual({ items: ['JSON loading', 'sources', 'schema'], more: 2 })
  expect(sessionIds('| **B** | **Assets** (`local_2222bbbb`) | x | y | z | 10-06 |')).toEqual({ B: 'local_2222bbbb' })
  expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(bar(10)).toBe('▰▱▱▱▱▱▱▱▱▱')
  expect(bar(61)).toBe('▰▰▰▰▰▰▱▱▱▱')
  expect(tokens(98302)).toBe('98k')
  expect(tokens(1000000)).toBe('1M')
})

test('a session counts as cleared once its live context is under half of what it was', async () => {
  expect(looksCleared(700000, { isLive: true, tokens: 90000 })).toBe(true)
  expect(looksCleared(700000, { isLive: true, tokens: 650000 })).toBe(false)
  expect(looksCleared(700000, { isLive: false, tokens: 90000 })).toBe(false) // an old reading proves nothing
  expect(looksCleared(null, { isLive: true, tokens: 90000 })).toBe(false) // unknown before: fall back to the timer
})

test('falls back to the board table when there are no @lane lines', async () => {
  const lanes = parseBoard('| **B** | Assets (local_9f) | wt-b | Recipes, then statues | Working | 10-02 |')
  expect(lanes).toEqual([{ lane: 'B', role: 'Assets', feature: 'Recipes, then statues', status: 'Working', next: 'statues', updated: '10-02' }])
})
