import { expect, test } from 'claude-code/testing'

import { boardTemplate, laneBrief, membership, missingBoardLines, newProject, orchestratorBrief } from '../hooks/project'
import { handoffFile } from '../hooks/parse'
import { LEGACY } from './legacy'

const self = (id: string, title: string, cwd: string) => ({ id, title, cwd })

test('a session belongs to a project only as its orchestrator or one of its lanes', async () => {
  expect(membership([LEGACY], self('local_2222bbbb-eee6', 'B', 'C:\\projects\\atlas'))).toMatchObject({ role: 'lane', letter: 'B' })
  // The orchestrator, found by its title in the project's folder while none is named.
  expect(membership([LEGACY], self('local_b41f', 'Orchestrator handoff', 'C:\\projects\\atlas'))).toMatchObject({ role: 'orchestrator' })
  // Any other session sees nothing, even in the same folder or another project's folder.
  expect(membership([LEGACY], self('local_9999', 'Unrelated work', 'C:\\projects\\atlas'))).toBeNull()
  expect(membership([LEGACY], self('local_8888', 'Site design', 'C:\\personal\\site-example2'))).toBeNull()
  // With no session tools (a plain terminal), the project's folder is all there is to go by.
  expect(membership([LEGACY], self('', '', 'C:\\projects\\atlas-perf-fx'))).toMatchObject({ role: 'orchestrator' })
  expect(membership([LEGACY], self('', '', 'C:\\projects\\other'))).toBeNull()
  // A named orchestrator is the only one.
  const named = { ...LEGACY, orchestratorId: 'local_aaaa' }
  expect(membership([named], self('local_b41f', 'Orchestrator handoff', 'C:\\projects\\atlas'))).toBeNull()
  expect(membership([named], self('local_aaaa', 'x', 'C:\\anywhere'))).toMatchObject({ role: 'orchestrator' })
})

test('a project in a Linux folder (WSL) gets Linux paths, not Windows backslashes', async () => {
  const p = newProject({ name: 'Shop API', root: '/home/me/shop', orchestratorId: 'local_o', lanes: [{ name: 'Backend', sessionId: '' }], now: 5 })
  expect(p.board).toBe('/home/me/shop-api-LANES.md')
  expect(p.handoffDir).toBe('/home/me/shop-api-handoffs')
  expect(p.orchestratorHandoff).toBe('/home/me/shop-api-handoffs/HANDOFF-orchestrator.md')
  expect(handoffFile(p, 'A')).toBe('/home/me/shop-api-handoffs/HANDOFF-A.md')
})

test('a new project gets lettered lanes, a board and handoffs next to its folder', async () => {
  const p = newProject({
    name: 'Shop API',
    root: 'C:\\work\\shop',
    orchestratorId: 'local_o',
    lanes: [
      { name: 'Backend', sessionId: 'local_1' },
      { name: ' ', sessionId: '' },
    ],
    now: 5,
  })
  expect(p).toMatchObject({
    id: 'shop-api',
    board: 'C:\\work\\shop-api-LANES.md',
    handoffDir: 'C:\\work\\shop-api-handoffs',
    orchestratorId: 'local_o',
    lanes: [
      { letter: 'A', name: 'Backend', sessionId: 'local_1' },
      { letter: 'B', name: 'Lane B', sessionId: '' },
    ],
  })
  const board = boardTemplate(p, '10-09')
  expect(board).toMatch(/^@lane A \| Backend \| — \| Idle: not started \| — \| 10-09$/m)
  expect(missingBoardLines(board, p, '10-09')).toEqual([])
  expect(missingBoardLines(board, { ...p, lanes: [...p.lanes, { letter: 'C', name: 'UI', sessionId: '' }] }, '10-10')).toEqual(['@lane C | UI | — | Idle: not started | — | 10-10'])
})

test('with no session id, only the project folder itself (or a sibling worktree) counts, not every folder inside it', async () => {
  const home = newProject({ name: 'me', root: '/home/me', orchestratorId: '', lanes: [], now: 1 })
  expect(membership([home], self('', '', '/home/me'))).toMatchObject({ role: 'orchestrator' })
  expect(membership([home], self('', '', '/home/me/python-projects/llm'))).toBeNull()
  expect(membership([home], self('local_x', 'Orchestrator', '/home/me/other'))).toBeNull()
})

test('a project with its own rules keeps its own git workflow: no per-lane branch rule is added', async () => {
  const lane = LEGACY.lanes[0]
  if (!lane) throw new Error('fixture has no lanes')
  expect(laneBrief(LEGACY, lane)).not.toMatch(/worktree add/)
  expect(orchestratorBrief(LEGACY)).not.toMatch(/only one who merges/)
  expect(laneBrief({ ...LEGACY, rules: '' }, lane)).toMatch(/worktree add .* -b lane-a/)
})
