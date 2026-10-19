import { expect, mock, test } from 'claude-code/testing'

import { LEGACY } from './legacy'
import { fakeEngine } from './fake'

test('Sleep sends every session of the project to bed, counts the saved handoffs, and Wake up resumes them', async ($, on) => {
  mock.store(on, { projects: [LEGACY] })
  const clock = mock.clock(on, { now: 2_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Orchestrator handoff', cwd: 'C:\\projects\\atlas' },
    others: [
      { sessionId: 'local_1111aaaa-1', title: 'A' },
      { sessionId: 'local_2222bbbb-2', title: 'B' },
      { sessionId: 'local_unrelated', title: 'Site design', cwd: 'C:\\personal\\site' },
    ],
    files: { [LEGACY.board]: '@lane A | Data | JSON | Working: schema | Backend | 10-06\n@lane B | Assets | Recipes | Working: statues | Generation | 10-06' },
    now: () => clock.now(),
  })
  const refresh = () => $.command.run({ command: 'lanes' } as never)

  await refresh()
  const ui = await $.ui.mount({ plugin: 'lane-tracker', surface: 'desktop', component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never })

  // The button sits at the top and asks first.
  await ui.press({ key: 'sleep' })
  expect(fake.sent).toEqual([])
  await ui.press({ key: 'sleep-yes' })

  // A and B (never the unrelated session) get the good-night message; this session, the orchestrator, gets it as its own prompt, last.
  expect(fake.sent.map(s => s.to)).toEqual(['local_1111aaaa-1', 'local_2222bbbb-2'])
  expect(fake.sent[0]?.text).toMatch(/^Good night/)
  expect(fake.sent[0]?.text).toMatch(/C:\\projects\\handoffs\\HANDOFF-A\.md/)
  expect(fake.sent[0]?.text).toMatch(/Do not clear the session/)
  expect(fake.prompts[0]).toMatch(/You are the orchestrator of "Atlas"/)
  expect(fake.prompts[0]).toMatch(/C:\\projects\\atlas\\HANDOFF\.md/)
  expect(await ui.find({ type: 'Text', text: /Sleeping since/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^0\/3$/ })).toBeDefined()

  // Two of three save their handoffs.
  await clock.advance(60_000)
  fake.mtimes['C:\\projects\\handoffs\\HANDOFF-A.md'] = clock.now()
  fake.mtimes['C:\\projects\\atlas\\HANDOFF.md'] = clock.now()
  await refresh()
  expect(await ui.find({ type: 'Text', text: /^2\/3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓A $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^…B $/ })).toBeDefined()

  // Morning.
  await ui.press({ key: 'wake' })
  expect(fake.sent.slice(2).map(s => s.to)).toEqual(['local_1111aaaa-1', 'local_2222bbbb-2'])
  expect(fake.sent[2]?.text).toMatch(/^Good morning.*Read C:\\projects\\handoffs\\HANDOFF-A\.md/)
  expect(fake.prompts[1]).toMatch(/^Good morning\. Read C:\\projects\\atlas\\HANDOFF\.md and take over as orchestrator/)
  expect(await ui.find({ key: 'sleep' })).toBeDefined()
  await ui.unmount()
})
