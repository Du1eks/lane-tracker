import { expect, mock, test } from 'claude-code/testing'

import type { Project } from '../types'
import { fakeEngine } from './fake'

test('/clear_context outside any project: HANDOFF.md in the folder, clear, then the fresh session reads it', async ($, on) => {
  mock.store(on, { projects: [] })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('classic.SessionStart', async () => ({}) as never) // what the engine answers beneath the plugin
  const fake = fakeEngine(on, { self: { sessionId: 'local_solo', title: 'Notes', cwd: 'C:\\work\\notes' }, others: [], now: () => clock.now() })

  const ran = await $.command.run({ command: 'clear_context' } as never)
  await clock.advance(1000) // the request goes out just after the command
  expect(ran.text).toMatch(/C:\\work\\notes\\HANDOFF\.md/)
  expect(fake.prompts[0]).toMatch(/^Context reset, requested with \/clear_context/)
  expect(fake.prompts[0]).toMatch(/Write C:\\work\\notes\\HANDOFF\.md/)
  expect(fake.prompts[0]).toMatch(/clear_session with session_id "self"/)

  // A clear before the handoff exists resumes nothing.
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(fake.prompts).toHaveLength(1)

  // The session wrote its handoff and cleared itself: the fresh session is told to read it, once.
  await clock.advance(30_000)
  fake.mtimes['C:\\work\\notes\\HANDOFF.md'] = clock.now()
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(fake.prompts[1]).toBe('Fresh start after /clear_context. Read C:\\work\\notes\\HANDOFF.md and carry on from its next step.')
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(fake.prompts).toHaveLength(2)
})

test("/clear_context in a project's orchestrator uses its own handoff file and the project's resume message", async ($, on) => {
  const shop: Project = {
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
  }
  mock.store(on, { projects: [shop] })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('classic.SessionStart', async () => ({}) as never) // what the engine answers beneath the plugin
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Shop orchestrator', cwd: 'C:\\work\\shop' },
    others: [{ sessionId: 'local_back', title: 'A' }],
    files: { [shop.board]: '@lane A | Backend | API | Working: auth | Tests | 10-14\n' },
    now: () => clock.now(),
  })

  await $.command.run({ command: 'clear_context' } as never)
  await clock.advance(1000)
  expect(fake.prompts[0]).toMatch(/You are the orchestrator of "Shop"/)
  expect(fake.prompts[0]).toMatch(/Write C:\\work\\shop-handoffs\\HANDOFF-orchestrator\.md/)

  await clock.advance(30_000)
  fake.mtimes['C:\\work\\shop-handoffs\\HANDOFF-orchestrator.md'] = clock.now()
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(fake.prompts[1]).toMatch(/^Read C:\\work\\shop-handoffs\\HANDOFF-orchestrator\.md and take over as orchestrator of "Shop"/)
})
