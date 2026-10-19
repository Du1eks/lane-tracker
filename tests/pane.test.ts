import { expect, mock, test } from 'claude-code/testing'

import type { Project } from '../types'
import { fakeEngine } from './fake'

const PROJECT: Project = {
  id: 'shop',
  name: 'Shop',
  root: 'C:\\work\\shop',
  board: 'C:\\work\\shop-LANES.md',
  handoffDir: 'C:\\work\\shop-handoffs',
  orchestratorHandoff: 'C:\\work\\shop-handoffs\\HANDOFF-orchestrator.md',
  rules: '',
  orchestratorId: 'local_orch',
  lanes: [
    { letter: 'A', name: 'Data & platform', sessionId: 'local_aaaa' },
    { letter: 'D', name: 'UI & builder', sessionId: 'local_dddd' },
  ],
  createdAt: 0,
}

const BOARD = [
  '@lane A | Data & platform | JSON loading | Working: schema | Phase 3 backend | 10-06',
  "@lane D | UI & builder | Phase 2 done: builder, rooms, look, windows, decor | Idle: Phase 2 finished | Landing page (needs the user's decisions) | 10-06",
].join('\n')

const OTHERS = [
  { sessionId: 'local_aaaa', title: 'A', tokens: 98302 },
  { sessionId: 'local_dddd', title: 'D', model: 'claude-opus-5-5', effort: 'medium', isRunning: false },
  { sessionId: 'local_unrelated', title: 'Site design', cwd: 'C:\\personal\\site' },
]

test('the orchestrator sees its project: cards with bullets and a sessions section, on terminal and desktop', async ($, on) => {
  mock.store(on, { projects: [PROJECT] })
  const fake = fakeEngine(on, { self: { sessionId: 'local_orch', title: 'Orchestrator', cwd: 'C:\\work\\shop', tokens: 610000 }, others: OTHERS, files: { [PROJECT.board]: BOARD } })
  await $.command.run({ command: 'lanes' } as never) // origin and presentation are the engine's to stamp
  expect(fake.statuses.at(-1)).toBe('Lanes ●A ✓D')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'lane-tracker', surface, component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })
    expect(await ui.find({ type: 'Text', text: /^Shop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● 1 in work/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^A Data & platform$/ }))?.props.color).toBe('blue')
    expect((await ui.find({ type: 'Text', text: /JSON loading · schema/ }))?.props.color).toBe('yellow')
    expect((await ui.find({ type: 'Text', text: /→ Phase 3 backend/ }))?.props.color).toBe('green')
    // D's work as bullets: three shown, the rest counted.
    expect(await ui.find({ type: 'Text', text: /^✓ builder$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+2 more/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs the user/ })).toBeUndefined()
    // Sessions: this one as the orchestrator, then the lanes; never the unrelated session.
    expect(await ui.find({ type: 'Text', text: /★ Orchestrator/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /61% · 610k of 1M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /10% · 98k of 1M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no context data yet/ })).toBeDefined()
    expect(await ui.find({ key: 'edit-lanes' })).toBeDefined()
    await ui.unmount()
  }
})

test('a session outside every project sees no lanes, no status line, only the ways in', async ($, on) => {
  mock.store(on, { projects: [PROJECT] })
  const fake = fakeEngine(on, { self: { sessionId: 'local_unrelated', title: 'Site design', cwd: 'C:\\personal\\site' }, others: OTHERS, files: { [PROJECT.board]: BOARD } })
  await $.command.run({ command: 'lanes' } as never)
  expect(fake.statuses.every(s => s === undefined)).toBe(true)
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })
  expect(await ui.find({ type: 'Text', text: /not part of a lanes project/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /JSON loading/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Sessions/ })).toBeUndefined()
  expect(await ui.find({ key: 'new-project' })).toBeDefined()
  expect(await ui.find({ key: 'add-lane-shop' })).toBeDefined()
  expect(await ui.find({ key: 'join-shop-A' })).toBeUndefined() // only new lanes and new projects, no taking over
  await ui.unmount()
})
