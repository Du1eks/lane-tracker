import { expect, mock, test } from 'claude-code/testing'

import { LEGACY } from './legacy'
import { fakeEngine } from './fake'

test('the reset button asks for a handoff, waits for the file, then tells the cleared session to read it', async ($, on) => {
  mock.store(on, { projects: [{ ...LEGACY, orchestratorId: 'local_orch' }] })
  const clock = mock.clock(on, { now: 1_000_000 })
  const laneA = { sessionId: 'local_1111aaaa-9a60', title: 'A', tokens: 700000 }
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Orchestrator', cwd: 'C:\\projects\\atlas' },
    others: [laneA],
    files: { [LEGACY.board]: '@lane A | Data & platform | JSON loading | Working: schema | Phase 3 backend | 10-06' },
    now: () => clock.now(),
  })
  const refresh = () => $.command.run({ command: 'lanes' } as never)

  await refresh()
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })

  // 70% full: the button is the recommended action; pressing it asks before doing anything.
  expect((await ui.find({ key: 'reset-A' }))?.props.label).toMatch(/recommended/)
  await ui.press({ key: 'reset-A' })
  expect(fake.sent).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Write HANDOFF-A\.md, clear the session/ })).toBeDefined()

  await ui.press({ key: 'yes-A' })
  expect(fake.sent).toHaveLength(1)
  expect(fake.sent[0]?.to).toBe('local_1111aaaa-9a60')
  expect(fake.sent[0]?.text).toMatch(/C:\\projects\\handoffs\\HANDOFF-A\.md/)
  expect(fake.sent[0]?.text).toMatch(/@lane A` line in C:\\projects\\BOARD\.md/)
  expect(fake.sent[0]?.text).toMatch(/clear_session with session_id "self"/)
  expect(await ui.find({ type: 'Text', text: /writing handoff/ })).toBeDefined()

  // No handoff after 2 minutes: the row warns but keeps waiting.
  await clock.advance(150_000)
  await refresh()
  expect(await ui.find({ type: 'Text', text: /no handoff after 2 min/ })).toBeDefined()

  // The handoff turns up late; the session has not cleared yet, so nothing is sent.
  fake.mtimes['C:\\projects\\handoffs\\HANDOFF-A.md'] = clock.now()
  await refresh()
  expect(await ui.find({ type: 'Text', text: /handoff saved/ })).toBeDefined()
  expect(fake.sent).toHaveLength(1)

  // Its context drops (the clear happened): the resume goes out at the next refresh, without the 75 s fallback wait.
  laneA.tokens = 90000
  await clock.advance(15_000)
  await refresh()
  expect(fake.sent).toHaveLength(2)
  expect(fake.sent[1]?.text).toMatch(/^Fresh start after a context reset\. You are lane A \(Data & platform\) of "Atlas"\. Read C:\\projects\\handoffs\\HANDOFF-A\.md/)
  expect(fake.sent[1]?.text).toMatch(/Follow CONTRIBUTING.md/)
  expect(await ui.find({ type: 'Text', text: /restarted from handoff/ })).toBeDefined()
  await ui.unmount()
})
