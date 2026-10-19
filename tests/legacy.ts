import type { Project } from '../types'

/** A team in the shape of a project from the seed file (the tests' fixture). */
export const LEGACY: Project = {
  id: 'atlas',
  name: 'Atlas',
  root: 'C:\\projects\\atlas',
  board: 'C:\\projects\\BOARD.md',
  handoffDir: 'C:\\projects\\handoffs',
  orchestratorHandoff: 'C:\\projects\\atlas\\HANDOFF.md',
  rules: 'Follow CONTRIBUTING.md.',
  orchestratorId: '',
  lanes: [
    { letter: 'A', name: 'Data & platform', sessionId: 'local_1111aaaa' },
    { letter: 'B', name: 'Assets & Blender', sessionId: 'local_2222bbbb' },
    { letter: 'C', name: 'Scene & environments', sessionId: 'local_3333cccc' },
    { letter: 'D', name: 'UI & builder', sessionId: 'local_4444dddd' },
  ],
  createdAt: 0,
}
