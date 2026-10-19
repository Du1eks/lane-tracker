import { expect, mock, test } from 'claude-code/testing'

import type { Project, SessionInfo } from '../types'
import { FRAME_MS, barSvg, iconSvg, motionOf, shimmer, spinner } from '../hooks/motion'
import { fakeEngine } from './fake'

const S = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  lane: 'A',
  id: 'local_a',
  role: 'Backend',
  model: 'Opus 5.5',
  effort: 'high',
  isRunning: true,
  isWorking: true,
  percent: 40,
  tokens: 400000,
  window: 1000000,
  isLive: true,
  ...over,
})

test('each session row gets one motion: needs you beats working, idle stays still, 80% and up is hot', async () => {
  expect(motionOf(S(), false)).toEqual({ state: 'working', hot: false })
  expect(motionOf(S(), true)).toEqual({ state: 'needs', hot: false })
  expect(motionOf(S({ isWorking: false }), false)).toEqual({ state: 'idle', hot: false })
  expect(motionOf(S({ isWorking: false, percent: 86 }), false)).toEqual({ state: 'idle', hot: true })
  // Numbers last seen on an idle session are not a live warning.
  expect(motionOf(S({ isWorking: false, percent: 86, isLive: false }), false).hot).toBe(false)
})

test('the terminal frames: a turning spinner and a light that walks the bar, then rests', async () => {
  expect(spinner(0)).not.toBe(spinner(1))
  expect(spinner(10)).toBe(spinner(0))
  expect(shimmer('▰▰▱▱', 0)).toEqual(['', '▰', '▰▱▱'])
  expect(shimmer('▰▰▱▱', 2)).toEqual(['▰▰', '▱', '▱'])
  expect(shimmer('▰▰▱▱', 5)).toEqual(['▰▰▱▱', '', ''])
})

test('the desktop SVG animates only what the state asks for', async () => {
  const working = barSvg(40, 'green', { state: 'working', hot: false })
  expect(working).toMatch(/attributeName="x"/) // the sweeping light
  expect(working).not.toMatch(/stroke="#EF9F27"/)
  const needs = barSvg(58, 'yellow', { state: 'needs', hot: false })
  expect(needs).toMatch(/stroke="#EF9F27"[^>]*opacity="0"/) // the pulsing ring
  expect(needs).not.toMatch(/attributeName="x"/)
  expect(barSvg(86, 'red', { state: 'idle', hot: true })).toMatch(/values="1;0.3;1"/)
  expect(barSvg(30, 'gray', { state: 'idle', hot: false })).not.toMatch(/<animate/)
  expect(iconSvg({ state: 'working', hot: false }, true)).toMatch(/animateTransform/)
  expect(iconSvg({ state: 'idle', hot: false }, false)).not.toMatch(/<animate/)
})

const SHOP: Project = {
  id: 'shop',
  name: 'Shop',
  root: 'C:\\work\\shop',
  board: 'C:\\work\\shop-LANES.md',
  handoffDir: 'C:\\work\\shop-handoffs',
  orchestratorHandoff: 'C:\\work\\shop-handoffs\\HANDOFF-orchestrator.md',
  rules: '',
  orchestratorId: 'local_orch',
  lanes: [
    { letter: 'A', name: 'Backend', sessionId: 'local_a' },
    { letter: 'B', name: 'Frontend', sessionId: 'local_b' },
  ],
  createdAt: 0,
}
const BOARD = ['@lane A | Backend | API | Working: auth | Tests | 10-15', "@lane B | Frontend | Pages | Paused | Landing (needs the user's decision) | 10-15"].join('\n')
const PANE = (surface: 'terminal' | 'desktop') => ({ plugin: 'lane-tracker', surface, component: 'Pane', requestId: 'lanes', props: { title: 'Lanes' } as never }) as const
const SPIN = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] in work$/

test('terminal: a working lane card spins, a lane waiting for the user pulses its flag, the Sessions rows stay calm', async ($, on) => {
  mock.store(on, { projects: [SHOP] })
  const clock = mock.clock(on, { now: 1_000_000 })
  const fake = fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Orchestrator', cwd: 'C:\\work\\shop', isRunning: false },
    others: [
      { sessionId: 'local_a', title: 'A', tokens: 400000 },
      { sessionId: 'local_b', title: 'B', tokens: 200000, isRunning: false },
    ],
    files: { [SHOP.board]: BOARD },
    now: () => clock.now(),
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE('terminal'))

  // A's card corner spins, B's card flag waits for the user.
  const first = (await ui.find({ type: 'Text', text: SPIN }))?.text
  expect(first).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^⚑ you$/ })).toBeDefined()
  // The Sessions rows name the session and its context only: no spinner, flag or state words there.
  expect(await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /· (working|needs you)/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^● A  / })).toBeDefined()
  await clock.advance(FRAME_MS)
  expect((await ui.find({ type: 'Text', text: SPIN }))?.text).not.toEqual(first) // the spinner turned

  // Lane A's turn ends: the quick check sees it within seconds and the spinner stops.
  const a = fake.sessions.find(s => s.sessionId === 'local_a')
  if (a) a.isRunning = false
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: SPIN })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^● in work$/ })).toBeDefined() // A's card is still again
  await ui.unmount()
})

test('desktop: each session row draws its animated bar, the cards draw the working and waiting icons', async ($, on) => {
  mock.store(on, { projects: [SHOP] })
  mock.clock(on, { now: 1_000_000 })
  fakeEngine(on, {
    self: { sessionId: 'local_orch', title: 'Orchestrator', cwd: 'C:\\work\\shop', isRunning: false },
    others: [
      { sessionId: 'local_a', title: 'A', tokens: 400000 },
      { sessionId: 'local_b', title: 'B', tokens: 200000, isRunning: false },
    ],
    files: { [SHOP.board]: BOARD },
  })
  await $.command.run({ command: 'lanes' } as never)
  const ui = await $.ui.mount(PANE('desktop'))
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(5) // a bar for the orchestrator, A and B; A's card spinner; B's card flag
  expect(svgs.filter(x => x.props.alt === 'working')).toHaveLength(1)
  expect(svgs.filter(x => x.props.alt === 'needs you')).toHaveLength(1)
  // The bars take the pane's width rather than a fixed one, so a narrow pane does not stretch the rows.
  expect(svgs.filter(x => /^context/.test(String(x.props.alt))).every(x => x.props.width === undefined)).toBe(true)
  const sources = svgs.map(x => String(x.props.source))
  expect(sources.some(x => /attributeName="x"/.test(x))).toBe(true) // A works: its bar shimmers
  expect(sources.some(x => /stroke="#EF9F27"/.test(x))).toBe(true) // B needs you: its bar has the ring
  expect(svgs.every(x => x.props.isInteractive === true)).toBe(true)
  await ui.unmount()
})
