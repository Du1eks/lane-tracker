import type { Project, ProjectLane } from '../types'

/** `C:\Projects\X\` → `c:/projects/x`, for comparing folders. */
export const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The folder above `p`, written as given (`C:\work\shop` → `C:\work`). */
export function parentOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut > 0 ? trimmed.slice(0, cut) : trimmed
}

/** The separator a path is written with: `\` for a Windows path (`C:\work`), `/` otherwise (`/home/me/work`, WSL). */
export const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/')

/** The last folder name of `p`. */
export const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** `My Shop API` → `my-shop-api`. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * Projects this copy starts with: `seed-projects.json` next to the plugin's manifest, taken in the first time (each
 * only where its board exists). It holds one PC's teams from before projects existed and is never shared.
 */
export const SEED_FILE = 'seed-projects.json'

/** Does a stored id (full, or a `local_…` prefix as the old board wrote it) name this session? */
export const sameSession = (stored: string, id: string) => stored !== '' && id !== '' && id.startsWith(stored)

/** Is `cwd` the project's folder, inside it, or a sibling worktree named after it (`shop-perf-fx`)? */
export function inProjectFolder(p: Pick<Project, 'root'>, cwd: string): boolean {
  const root = norm(p.root)
  const here = norm(cwd)
  return here === root || here.startsWith(`${root}/`) || here.startsWith(`${root}-`)
}

/** Is `cwd` the project's own folder or a sibling worktree named after it, not just somewhere inside it? */
export function atProjectRoot(p: Pick<Project, 'root'>, cwd: string): boolean {
  const root = norm(p.root)
  const here = norm(cwd)
  return here === root || here.startsWith(`${root}-`)
}

export type Membership = { project: Project; role: 'orchestrator' | 'lane'; letter: string }

/**
 * Which project this session works on, and as what. By session id first (the lane and orchestrator sessions the
 * project names); then a session titled "orchestrator" in the project's folder; with no session tools (a plain
 * terminal), any session in the project's folder, as its orchestrator. Anything else is not part of a project.
 */
export function membership(projects: Project[], self: { id: string; title: string; cwd: string }): Membership | null {
  for (const p of projects) {
    const lane = p.lanes.find(l => sameSession(l.sessionId, self.id))
    if (lane) return { project: p, role: 'lane', letter: lane.letter }
    if (sameSession(p.orchestratorId, self.id)) return { project: p, role: 'orchestrator', letter: '★' }
  }
  for (const p of projects) {
    if (!atProjectRoot(p, self.cwd)) continue
    if (self.id === '' || (p.orchestratorId === '' && /orchestrat/i.test(self.title))) return { project: p, role: 'orchestrator', letter: '★' }
  }
  return null
}

/** Is `p` a drive or file-system root (`C:`, `C:\`, `/`), where a plain user may not write files? */
export const isDriveRoot = (p: string) => /^[A-Za-z]:[\\/]?$/.test(p) || /^[\\/]*$/.test(p)

/** `shop` taken → `shop-2`, then `shop-3`, … */
export function freeId(id: string, taken: string[]): string {
  if (!taken.includes(id)) return id
  let n = 2
  while (taken.includes(`${id}-${n}`)) n++
  return `${id}-${n}`
}

/**
 * The project with its board and handoffs inside its own folder, in `.lanes`: where they go when the folder beside it
 * takes no files (a drive root, `/home`, a folder the user may not write).
 */
export function boardInside(p: Project): Project {
  const s = sepOf(p.root)
  const home = `${p.root.replace(/[\/]+$/, '')}${s}.lanes`
  return { ...p, board: `${home}${s}${p.id}-LANES.md`, handoffDir: `${home}${s}${p.id}-handoffs`, orchestratorHandoff: `${home}${s}${p.id}-handoffs${s}HANDOFF-orchestrator.md` }
}

/** A new project run from `root`, with this session as its orchestrator and one lane per name. */
export function newProject(input: { name: string; root: string; orchestratorId: string; lanes: Array<{ name: string; sessionId: string }>; now: number }): Project {
  const id = slug(input.name)
  const s = sepOf(input.root)
  // The board sits next to the project folder so its worktrees share it; a folder right under a drive root
  // (`C:\shop`) keeps it inside, in `.lanes`, since the drive root takes no files.
  const parent = parentOf(input.root)
  const home = isDriveRoot(parent) ? `${input.root.replace(/[\\/]+$/, '')}${s}.lanes` : parent
  return {
    id,
    name: input.name.trim() || folderName(input.root),
    root: input.root,
    board: `${home}${s}${id}-LANES.md`,
    handoffDir: `${home}${s}${id}-handoffs`,
    orchestratorHandoff: `${home}${s}${id}-handoffs${s}HANDOFF-orchestrator.md`,
    rules: '',
    orchestratorId: input.orchestratorId,
    lanes: input.lanes.map((l, i) => ({ letter: LETTERS[i] ?? `L${i + 1}`, name: l.name.trim() || `Lane ${LETTERS[i] ?? i + 1}`, sessionId: l.sessionId })),
    createdAt: input.now,
  }
}

/** One board line in the format the pane reads. */
export const boardLine = (l: ProjectLane, date: string) => `@lane ${l.letter} | ${l.name} | — | Idle: not started | — | ${date}`

/** The board file a new project starts with. */
export function boardTemplate(p: Project, date: string): string {
  return [
    `# Lanes board: ${p.name}`,
    '',
    `Read live by the /lanes pane of every session in this project (orchestrator: ${p.root}). One line per lane; each lane keeps its own line current, the orchestrator keeps them all.`,
    '',
    'Format: `@lane X | Role | Feature / work item | Status | Next job | Updated`',
    'Status starts with one of: Working, Ready to merge, Blocked, Done, Idle, Paused. Put "(needs the user\'s decision)" in the next job while you wait for the user.',
    '',
    ...p.lanes.map(l => boardLine(l, date)),
    '',
  ].join('\n')
}

/** Lines to add to a board for lanes it does not have yet. */
export function missingBoardLines(board: string, p: Project, date: string): string[] {
  return p.lanes.filter(l => !new RegExp(`^@lane\\s+${l.letter}\\s*\\|`, 'm').test(board)).map(l => boardLine(l, date))
}

/** The sidebar title of a lane's session: `A · Backend (Shop)`. */
export const laneTitle = (p: Project, l: ProjectLane) => `${l.letter} · ${l.name} (${p.name})`

/** The sidebar title of the orchestrator's session: `Orchestrator (Shop)`. */
export const orchestratorTitle = (p: Project) => `Orchestrator (${p.name})`

/**
 * A lane's own git worktree and branch: a folder beside the project's (`shop-a`, which still counts as the project's
 * folder) on the branch `lane-a`, so lanes never edit the same working copy.
 */
export const laneWorktree = (p: Project, l: ProjectLane) => ({ folder: `${p.root.replace(/[\\/]+$/, '')}-${l.letter.toLowerCase()}`, branch: `lane-${l.letter.toLowerCase()}` })

/** What a lane is told when it is given its lane. */
export function laneBrief(p: Project, l: ProjectLane, moved = false): string {
  const tree = laneWorktree(p, l)
  return [
    `You are lane ${l.letter} (${l.name}) of the project "${p.name}". The orchestrator works in ${p.root}; this was set up from the Lanes pane.`,
    ...(moved ? [`This session moves to ${p.root} when this turn ends (the project's folder); until then use absolute paths.`] : []),
    '',
    `Keep your line in ${p.board} current whenever your work changes (the /lanes pane of the orchestrator and every lane reads it live):`,
    `  @lane ${l.letter} | ${l.name} | <feature / work item> | <status> | <next job> | <MM-DD>`,
    'Status starts with Working, Ready to merge, Blocked, Done, Idle or Paused. Write "(needs the user\'s decision)" in the next job while you wait for the user.',
    `Handoffs go to ${p.handoffDir}${sepOf(p.handoffDir)}HANDOFF-${l.letter}.md when the pane asks for one.${p.rules ? ` ${p.rules}` : ''}`,
    // A project with its own rules (p.rules) has its own git workflow; the others get one branch per lane.
    ...(p.rules
      ? []
      : [
          `Git: never edit files in ${p.root}, the orchestrator's folder. If it is a git repository, work in your own worktree and branch: once, run \`git -C "${p.root}" worktree add "${tree.folder}" -b ${tree.branch}\` (if it already exists, use it), then move this session to ${tree.folder} and work only there. Commit only on ${tree.branch}. When a piece of work is finished and committed, set your status to Ready to merge and stop: the orchestrator merges it. After a merge, run \`git merge\` with the main branch in your folder to stay current.`,
        ]),
    '',
    'Reply with one line confirming, then wait for your first task.',
  ].join('\n')
}

/** What the orchestrator is told when the project is created or it joins. */
export function orchestratorBrief(p: Project): string {
  const lanes = p.lanes.map(l => `${l.letter} (${l.name})`).join(', ')
  return [
    `You are the orchestrator of the project "${p.name}" (lanes: ${lanes}), set up from the Lanes pane.`,
    '',
    `The board is ${p.board}: one \`@lane\` line per lane, which the /lanes pane reads live. Keep every line current when you hand out, merge, pause or resume work (feature, status starting with Working / Ready to merge / Blocked / Done / Idle / Paused, next job, date).`,
    `Your own handoff file is ${p.orchestratorHandoff}.${p.rules ? ` ${p.rules}` : ''}`,
    ...(p.rules
      ? []
      : [
          `Git: each lane works in its own worktree and branch (${p.lanes.map(l => `${l.letter}: ${laneWorktree(p, l).folder} on ${laneWorktree(p, l).branch}`).join(', ')}), never in ${p.root}. You keep ${p.root} on the main branch and are the only one who merges: when a lane's status says Ready to merge, merge its branch into the main branch, then tell the other lanes to merge the main branch into theirs.`,
        ]),
    '',
    'Reply with one line confirming.',
  ].join('\n')
}
