import { expect, mock, test } from 'claude-code/testing'

import type { Project } from '../types'
import { freeId, newProject } from '../hooks/project'
import { fakeEngine, fileAt } from './fake'

const PANE = { plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never } as const

const shop = (over: Partial<Project> = {}): Project => ({
  id: 'shop',
  name: 'Shop',
  root: 'C:\\work\\shop',
  board: 'C:\\work\\shop-LANES.md',
  handoffDir: 'C:\\work\\shop-handoffs',
  orchestratorHandoff: 'C:\\work\\shop-handoffs\\HANDOFF-orchestrator.md',
  rules: '',
  orchestratorId: 'local_orch',
  lanes: [{ letter: 'A', name: 'Backend', sessionId: 'local_back' }],
  createdAt: 0,
  ...over,
})

test('the new-project form offers only sessions working in this folder or its worktrees', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Shop orchestrator', cwd: 'C:\\work\\shop' },
    others: [
      { sessionId: 'local_back', title: 'Backend work', cwd: 'C:\\work\\shop' },
      { sessionId: 'local_tree', title: 'Worktree', cwd: 'C:\\work\\shop-perf' },
      { sessionId: 'local_other', title: 'Something else', cwd: 'C:\\personal\\x' },
    ],
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'new-project' })
  const values = ((await ui.find({ key: 'lane-session-0' }))?.props.options as Array<{ value: string }>).map(o => o.value)
  expect(values).toEqual(['', 'local_back', 'local_tree'])
  expect(await ui.find({ type: 'Text', text: /Sessions listed: those working in shop/ })).toBeDefined()
  await ui.unmount()
})

test('with no other session in the folder, the form says to start them there first', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'orchestrator', cwd: 'C:\\work\\shop' },
    others: [{ sessionId: 'local_other', title: 'Something else', cwd: 'C:\\personal\\x' }],
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'new-project' })
  expect(((await ui.find({ key: 'lane-session-0' }))?.props.options as unknown[]).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /No other sessions work in shop yet/ })).toBeDefined()
  await ui.unmount()
})

test('pressing Create twice makes one project', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, { self: { sessionId: 'local_orch', title: 'orchestrator', cwd: 'C:\\work\\shop' }, others: [] })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'new-project' })
  await Promise.all([ui.press({ key: 'create' }), ui.press({ key: 'create' })])
  expect(await ui.find({ type: 'Text', text: /you orchestrate/ })).toBeDefined()
  // One project made: this session is briefed as its orchestrator once.
  expect(fake.prompts.filter(t => /You are the orchestrator/.test(t))).toHaveLength(1)
  await ui.unmount()
})

test('any session can delete a project from the list, after a yes', async ($, on) => {
  mock.store(on, { projects: [shop(), shop({ id: 'shop-2', name: 'Shop copy' })], 'reset:shop-2:A': { lane: 'A' } })
  mock.clock(on, { now: 1_000_000 })
  fakeEngine(on, { self: { sessionId: 'local_new', title: 'new', cwd: 'C:\\personal\\x' }, others: [] })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'delete-shop-2' })
  expect(await ui.find({ type: 'Text', text: /Delete "Shop copy"\?/ })).toBeDefined()
  expect(await ui.find({ key: 'add-lane-shop-2' })).toBeUndefined() // the yes replaces the buttons
  await ui.press({ key: 'delete-no-shop-2' })
  expect(await ui.find({ key: 'add-lane-shop-2' })).toBeDefined()

  await ui.press({ key: 'delete-shop-2' })
  await ui.press({ key: 'delete-yes-shop-2' })
  expect(await ui.find({ key: 'add-lane-shop-2' })).toBeUndefined()
  expect(await ui.find({ key: 'add-lane-shop' })).toBeDefined() // the other project stays
  await ui.unmount()
})

test('joining a project from another folder moves the session to the project folder', async ($, on) => {
  mock.store(on, { projects: [shop()] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_new', title: 'new', cwd: 'C:\\personal\\x' },
    others: [{ sessionId: 'local_orch', title: 'Shop orchestrator' }],
    files: { 'C:\\work\\shop-LANES.md': '@lane A | Backend | API | Working: auth | Tests | 10-14\n' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'add-lane-shop' })
  expect(await ui.find({ type: 'Text', text: /joining moves it to C:\\work\\shop/ })).toBeDefined()
  await ui.input({ key: 'new-lane-name', text: 'Docs', kind: 'change' })
  await ui.press({ key: 'add-lane-yes' })
  expect(fake.moves).toEqual(['C:\\work\\shop'])
  expect(fake.prompts.at(-1)).toMatch(/This session moves to C:\\work\\shop when this turn ends/)
  await ui.unmount()
})

test('a session already in the project folder is not moved', async ($, on) => {
  mock.store(on, { projects: [shop()] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_new', title: 'new', cwd: 'C:\\work\\shop-docs' },
    others: [{ sessionId: 'local_orch', title: 'Shop orchestrator' }],
    files: { 'C:\\work\\shop-LANES.md': '' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'add-lane-shop' })
  await ui.press({ key: 'add-lane-yes' })
  expect(fake.moves).toEqual([])
  expect(fake.prompts.at(-1)).not.toMatch(/moves to/)
  await ui.unmount()
})

test('a project right under a drive root keeps its board inside, not in the drive root', async () => {
  const p = newProject({ name: 'PracticeF', root: 'C:\\PracticeF', orchestratorId: 'local_o', lanes: [], now: 5 })
  expect(p.board).toBe('C:\\PracticeF\\.lanes\\practicef-LANES.md')
  expect(p.handoffDir).toBe('C:\\PracticeF\\.lanes\\practicef-handoffs')
  expect(freeId('shop', ['shop'])).toBe('shop-2')
  expect(freeId('shop', ['shop', 'shop-2'])).toBe('shop-3')
})

test('sessions are renamed after their role: the orchestrator and each lane', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'new session', cwd: 'C:\work\shop' },
    others: [{ sessionId: 'local_back', title: 'Backend work', cwd: 'C:\work\shop' }],
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'new-project' })
  await ui.input({ key: 'project-name', text: 'Shop', kind: 'change' })
  await ui.input({ key: 'lane-name-0', text: 'Backend', kind: 'change' })
  await ui.select({ key: 'lane-session-0', value: 'local_back' })
  await ui.press({ key: 'create' })
  expect(fake.titles).toEqual({ local_back: 'A · Backend (Shop)', self: 'Orchestrator (Shop)' })
  await ui.unmount()
})

test('a session that joins as a lane is renamed after it', async ($, on) => {
  mock.store(on, { projects: [shop()] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_new', title: 'new', cwd: 'C:\work\shop' },
    others: [{ sessionId: 'local_orch', title: 'Shop orchestrator' }],
    files: { 'C:\work\shop-LANES.md': '' },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'add-lane-shop' })
  await ui.input({ key: 'new-lane-name', text: 'Docs', kind: 'change' })
  await ui.press({ key: 'add-lane-yes' })
  expect(fake.titles.self).toBe('B · Docs (Shop)')
  await ui.unmount()
})

test('a project at a home folder keeps its board inside when /home takes no files, and is made once', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, { self: { sessionId: 'local_orch', title: 'orchestrator', cwd: '/home/me' }, others: [], readOnly: ['/home'] })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'new-project' })
  await ui.press({ key: 'create' })
  expect(fileAt(fake, '/home/me/.lanes/me-LANES.md')).toMatch(/^@lane A \|/m)
  expect(fileAt(fake, '/home/me-LANES.md')).toBeUndefined()
  expect(fake.prompts.at(-1)).toMatch(/\/home\/me\/\.lanes\/me-LANES\.md/)
  expect(await ui.find({ type: 'Text', text: /Cannot read the board/ })).toBeUndefined()
  await ui.unmount()
})

test('a project whose board cannot be written anywhere is not saved, so Create cannot pile up copies', async ($, on) => {
  mock.store(on, { projects: [] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, { self: { sessionId: 'local_orch', title: 'orchestrator', cwd: '/home/me' }, others: [], readOnly: ['/home', '/home/me/.lanes'] })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'new-project' })
  await ui.press({ key: 'create' })
  expect(await ui.find({ type: 'Text', text: /the project was not created/ })).toBeDefined()
  expect(fake.prompts.some(t => /You are the orchestrator/.test(t))).toBe(false)
  expect(await ui.find({ key: 'add-lane-me' })).toBeUndefined()
  await ui.unmount()
})

test('an existing project with an unwritable board moves it inside on its next refresh', async ($, on) => {
  const home: Project = { ...shop(), id: 'me', name: 'me', root: '/home/me', board: '/home/me-LANES.md', handoffDir: '/home/me-handoffs', orchestratorHandoff: '/home/me-handoffs/HANDOFF-orchestrator.md', orchestratorId: 'local_orch' }
  mock.store(on, { projects: [home] })
  mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, { self: { sessionId: 'local_orch', title: 'orchestrator', cwd: '/home/me' }, others: [], readOnly: ['/home'] })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE)
  expect(fileAt(fake, '/home/me/.lanes/me-LANES.md')).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cannot read the board/ })).toBeUndefined()
  await ui.unmount()
})
