import { expect, mock, test } from 'claude-code/testing'

import type { Project } from '../types'
import { fakeEngine } from './fake'

test('/lanes in a new session sets up a project: lanes, names, sessions, board and briefs', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Shop orchestrator', cwd: 'C:\\work\\shop' },
    others: [
      { sessionId: 'local_back', title: 'Backend work', cwd: 'C:\\work\\shop' },
      { sessionId: 'local_other', title: 'Something else', cwd: 'C:\\personal\\x' },
    ],
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })

  await ui.press({ key: 'new-project' })
  expect((await ui.find({ key: 'project-name' }))?.props.value).toBe('shop')
  await ui.input({ key: 'project-name', text: 'Shop', kind: 'change' })
  await ui.press({ key: 'count-3' })
  await ui.input({ key: 'lane-name-0', text: 'Backend', kind: 'change' })
  await ui.input({ key: 'lane-name-1', text: 'Frontend', kind: 'change' })
  await ui.select({ key: 'lane-session-0', value: 'local_back' })
  await ui.press({ key: 'create' })

  // The board, with one line per lane.
  const board = fake.files['C:\\work\\shop-LANES.md'] ?? ''
  expect(board).toMatch(/^@lane A \| Backend \| — \| Idle: not started/m)
  expect(board).toMatch(/^@lane B \| Frontend \|/m)
  expect(board).toMatch(/^@lane C \| Lane C \|/m)
  // The lane with a session is briefed; this session is briefed as orchestrator.
  expect(fake.sent).toHaveLength(1)
  expect(fake.sent[0]?.to).toBe('local_back')
  expect(fake.sent[0]?.text).toMatch(/You are lane A \(Backend\) of the project "Shop"/)
  expect(fake.sent[0]?.text).toMatch(/C:\\work\\shop-LANES\.md/)
  expect(fake.prompts.at(-1)).toMatch(/You are the orchestrator of the project "Shop"/)
  // Each lane gets its own worktree and branch beside the project folder; only the orchestrator merges.
  expect(fake.sent[0]?.text).toMatch(/git -C "C:\\work\\shop" worktree add "C:\\work\\shop-a" -b lane-a/)
  expect(fake.sent[0]?.text).toMatch(/Commit only on lane-a/)
  expect(fake.prompts.at(-1)).toMatch(/A: C:\\work\\shop-a on lane-a, B: C:\\work\\shop-b on lane-b/)
  expect(fake.prompts.at(-1)).toMatch(/You keep C:\\work\\shop on the main branch and are the only one who merges/)
  // Now this session shows the project.
  expect(await ui.find({ type: 'Text', text: /^Shop/ })).toBeDefined()
  expect(fake.statuses.at(-1)).toBe('Lanes ○A ○B ○C')
  await ui.unmount()
})

test('a new session joins a project as a new lane: next letter, board line, brief, and the orchestrator is told', async ($, on) => {
  const shop: Project = {
    id: 'shop',
    name: 'Shop',
    root: 'C:\\work\\shop',
    board: 'C:\\work\\shop-LANES.md',
    handoffDir: 'C:\\work\\shop-handoffs',
    orchestratorHandoff: 'C:\\work\\shop-handoffs\\HANDOFF-orchestrator.md',
    rules: '',
    orchestratorId: 'local_orch',
    lanes: [
      { letter: 'A', name: 'Backend', sessionId: 'local_back' },
      { letter: 'B', name: 'Frontend', sessionId: 'local_front' },
    ],
    createdAt: 0,
  }
  mock.store(on, { projects: [shop] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_tests', title: 'new', cwd: 'C:\\work\\shop' },
    others: [{ sessionId: 'local_orch', title: 'Shop orchestrator' }, { sessionId: 'local_back', title: 'A' }, { sessionId: 'local_front', title: 'B' }],
    files: { [shop.board]: '@lane A | Backend | API | Working: auth | Tests | 10-09\n@lane B | Frontend | Pages | Working: cart | Checkout | 10-09\n' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })

  expect((await ui.find({ key: 'add-lane-shop' }))?.props.label).toMatch(/new lane \(C\)/)
  await ui.press({ key: 'add-lane-shop' })
  await ui.input({ key: 'new-lane-name', text: 'Testing', kind: 'change' })
  await ui.press({ key: 'add-lane-yes' })

  expect(fake.files[shop.board]).toMatch(/^@lane C \| Testing \| — \| Idle: not started/m)
  expect(fake.prompts.at(-1)).toMatch(/You are lane C \(Testing\) of the project "Shop"/)
  expect(fake.sent.at(-1)?.to).toBe('local_orch')
  expect(fake.sent.at(-1)?.text).toMatch(/A new lane joined "Shop".*lane C \(Testing\)/)
  expect(await ui.find({ type: 'Text', text: /you are lane C/ })).toBeDefined()
  expect(fake.statuses.at(-1)).toBe('Lanes ●A ●B ○C')
  await ui.unmount()
})

test('a lane set up with "None yet" waits for a session, and a new session in the folder takes it', async ($, on) => {
  const shop: Project = {
    id: 'shop',
    name: 'Shop',
    root: 'C:\work\shop',
    board: 'C:\work\shop-LANES.md',
    handoffDir: 'C:\work\shop-handoffs',
    orchestratorHandoff: 'C:\work\shop-handoffs\HANDOFF-orchestrator.md',
    rules: '',
    orchestratorId: 'local_orch',
    lanes: [{ letter: 'A', name: 'Backend', sessionId: '' }],
    createdAt: 0,
  }
  mock.store(on, { projects: [shop] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_second', title: 'new', cwd: 'C:\work\shop' },
    others: [{ sessionId: 'local_orch', title: 'Shop orchestrator' }],
    files: { [shop.board]: '@lane A | Backend | — | Idle: not started | — | 10-14\n' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })

  expect((await ui.find({ key: 'add-lane-shop' }))?.props.label).toBe('＋ Join a lane (A waiting)')
  await ui.press({ key: 'add-lane-shop' })
  expect(await ui.find({ type: 'Text', text: /Lanes waiting for a session/ })).toBeDefined()
  await ui.press({ key: 'take-A' })

  expect(fake.prompts.at(-1)).toMatch(/You are lane A \(Backend\) of the project "Shop"/)
  expect(fake.sent.at(-1)?.to).toBe('local_orch')
  expect(fake.sent.at(-1)?.text).toMatch(/A session took its lane in "Shop".*lane A \(Backend\)/)
  expect(await ui.find({ type: 'Text', text: /you are lane A/ })).toBeDefined()
  expect(fake.statuses.at(-1)).toBe('Lanes ○A')
  await ui.unmount()
})

const SHOP: Project = {
  id: 'shop',
  name: 'Shop',
  root: 'C:\work\shop',
  board: 'C:\work\shop-LANES.md',
  handoffDir: 'C:\work\shop-handoffs',
  orchestratorHandoff: 'C:\work\shop-handoffs\HANDOFF-orchestrator.md',
  rules: '',
  orchestratorId: 'local_orch',
  lanes: [{ letter: 'A', name: 'Backend', sessionId: 'local_back' }],
  createdAt: 0,
}

test('only the orchestrator can delete the project, after a yes; the board file stays', async ($, on) => {
  mock.store(on, { projects: [SHOP], 'reset:shop:A': { lane: 'A' }, 'sleep:shop': { at: 1, sessions: [] } })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Shop orchestrator', cwd: 'C:\work\shop' },
    others: [{ sessionId: 'local_back', title: 'A' }],
    files: { [SHOP.board]: '@lane A | Backend | API | Working: auth | Tests | 10-14\n' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })

  await ui.press({ key: 'delete-project' })
  expect(await ui.find({ type: 'Text', text: /Delete the project "Shop"\?/ })).toBeDefined()
  await ui.press({ key: 'delete-no' }) // nothing happens on Cancel
  expect(await ui.find({ type: 'Text', text: /^Shop/ })).toBeDefined()

  await ui.press({ key: 'delete-project' })
  await ui.press({ key: 'delete-yes' })
  expect(await ui.find({ type: 'Text', text: /not part of a lanes project/ })).toBeDefined()
  expect(await ui.find({ key: 'add-lane-shop' })).toBeUndefined() // gone from the list too
  expect(fake.statuses.at(-1)).toBeUndefined()
  expect(fake.files[SHOP.board]).toMatch(/@lane A/) // the board file is kept
  await ui.unmount()
})

test('a lane never sees the delete button', async ($, on) => {
  mock.store(on, { projects: [SHOP] })
  mock.clock(on, { now: 1_000_000 })
  fakeEngine(on, {
    self: { sessionId: 'local_back', title: 'A', cwd: 'C:\work\shop' },
    others: [{ sessionId: 'local_orch', title: 'Shop orchestrator' }],
    files: { [SHOP.board]: '@lane A | Backend | API | Working: auth | Tests | 10-14\n' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })
  expect(await ui.find({ type: 'Text', text: /you are lane A/ })).toBeDefined()
  expect(await ui.find({ key: 'delete-project' })).toBeUndefined()
  await ui.unmount()
})
