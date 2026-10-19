import type { Lane, Project } from '../types'
import { sepOf } from './project'

const clean = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()

/** The next job when the board has no tracker line: an explicit "Next:" in the state, else what follows "then". */
function guessNext(now: string, state: string): string {
  const explicit = state.match(/next(?: steps?)?\s*[:\-]\s*(.+)$/i)
  if (explicit?.[1]) return explicit[1]
  const then = now.match(/\bthen[:,]?\s+(.+)$/i)
  if (then?.[1]) return then[1]
  return ''
}

/** Lines the orchestrator keeps on the board: `@lane A | Role | Feature / work item | Status | Next job | Updated`. */
function parseTracker(lines: string[]): Lane[] {
  const out: Lane[] = []
  for (const line of lines) {
    const m = line.match(/^@lane\s+([A-Z])\s*\|(.*)$/)
    if (!m) continue
    const c = (m[2] ?? '').split('|').map(clean)
    out.push({ lane: m[1] ?? '', role: c[0] ?? '', feature: c[1] ?? '', status: c[2] ?? '', next: c[3] ?? '', updated: c[4] ?? '' })
  }
  return out
}

/** Fallback: the board table rows `| **A** | role | where | now | state | updated |`. */
function parseTable(lines: string[]): Lane[] {
  const out: Lane[] = []
  for (const line of lines) {
    if (!/^\|\s*\*\*[A-Z]\*\*\s*\|/.test(line)) continue
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split(' | ').map(clean)
    if (cells.length < 5) continue
    const now = cells[3] ?? ''
    const state = cells[4] ?? ''
    out.push({
      lane: cells[0] ?? '',
      role: (cells[1] ?? '').replace(/\(local_[0-9a-f]+\)/, '').trim(),
      feature: now,
      status: state,
      next: guessNext(now, state),
      updated: cells[5] ?? '',
    })
  }
  return out
}

export function parseBoard(markdown: string): Lane[] {
  const lines = markdown.split(/\r?\n/)
  const tracked = parseTracker(lines)
  return tracked.length > 0 ? tracked : parseTable(lines)
}

export type Tone = 'working' | 'blocked' | 'ready' | 'done' | 'idle'

/** Status words to one state. Order matters: "Working: done with X" is still working, "Ready to merge" is not merged. */
export function tone(status: string): Tone {
  if (/block|fail|stuck/i.test(status)) return 'blocked'
  if (/working|in progress|building|running|verifying/i.test(status)) return 'working'
  if (/\bmerged\b|\bdone\b|finished|complete/i.test(status)) return 'done'
  if (/ready|review|merge/i.test(status)) return 'ready'
  return 'idle'
}

export const MARK: Record<Tone, string> = { working: '●', blocked: '✖', ready: '◆', done: '✓', idle: '○' }
export const WORD: Record<Tone, string> = { working: 'in work', blocked: 'blocked', ready: 'ready', done: 'done', idle: 'idle' }

const NEEDS_YOU = /\(?\s*needs? (?:the user'?s?|your|user)\b[^)]*\)?/i

export type LaneView = {
  lane: string
  role: string
  tone: Tone
  /** What the lane works on (or finished), without the "Phase 2 done:" lead-in. */
  now: string
  /** The next job, without the "(needs the user's decisions)" aside, which becomes `needsYou`. */
  next: string
  needsYou: boolean
  updated: string
}

export function view(l: Lane): LaneView {
  const t = tone(l.status)
  const detail = l.status.split(':').slice(1).join(':').trim()
  let now = l.feature.replace(/^phase \d+ (?:done|finished)\s*:\s*/i, '')
  if ((t === 'working' || t === 'blocked') && detail !== '' && !now.toLowerCase().includes(detail.toLowerCase())) now = `${now} · ${detail}`
  const needsYou = NEEDS_YOU.test(l.next) || /needs? (the )?user|needs you|waiting for you/i.test(l.status)
  const next = l.next.replace(NEEDS_YOU, '').replace(/\s+/g, ' ').trim()
  return { lane: l.lane, role: l.role, tone: t, now, next: next === '—' ? '' : next, needsYou, updated: l.updated }
}

/** One short line for the status bar: `Lanes ✓A ●B ◆C ○D`. */
export function summary(lanes: Lane[]): string {
  return 'Lanes ' + lanes.map(l => `${MARK[tone(l.status)]}${l.lane}`).join(' ')
}

/** The work items of a lane as bullets: its "now" text split at commas, at most `max`, with a "+N more" count. */
export function bullets(now: string, max = 3): { items: string[]; more: number } {
  const all = now.split(/\s*[,;]\s*/).map(s => s.replace(/^(and|&)\s+/i, '').trim()).filter(s => s !== '')
  return { items: all.slice(0, max), more: Math.max(0, all.length - max) }
}

/** Which desktop session runs each lane, from the board table: `| **A** | ... (`local_1a2b3c4d`) |`. */
export function sessionIds(markdown: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^\|\s*\*\*([A-Z])\*\*\s*\|.*?\((?:`)?(local_[0-9a-f]+)(?:`)?\)/)
    if (m?.[1] && m[2]) out[m[1]] = m[2]
  }
  return out
}

/** `claude-sonnet-5-5` → `Sonnet 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`. */
export function modelName(id: string): string {
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?/i)
  if (!m?.[1]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

/** A bar of `cells` blocks, filled to `percent`. */
export function bar(percent: number, cells = 10): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

/** 98302 → `98k`, 1000000 → `1M`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** At or above this share of the context window the reset button is shown as the thing to do. */
export const RESET_AT = 60

/** Where a session writes its handoff: the orchestrator to the project's orchestrator file, lanes one file each. */
export function handoffFile(p: Project, lane: string): string {
  return lane === '★' ? p.orchestratorHandoff : `${p.handoffDir}${sepOf(p.handoffDir)}HANDOFF-${lane}.md`
}

const who = (p: Project, lane: string, role: string) => (lane === '★' ? `the orchestrator of "${p.name}"` : `lane ${lane} (${role}) of "${p.name}"`)
const rules = (p: Project) => (p.rules ? ` ${p.rules}` : '')

const HANDOFF_CONTENTS =
  'role; worktree folder and branch; what is done (with commits); what is in progress and exactly where it stands; decisions, constraints and anything the user said not to do; open questions for the user; the next steps in order; the files you have claimed; how to verify the work. Facts and paths, not story; under about 150 lines.'

/** The message that asks a session to hand off and clear itself. */
export function handoffRequest(p: Project, lane: string, role: string, file: string): string {
  return [
    `Context reset, requested from the Lanes pane: your context window is getting full, so hand your work to a fresh copy of yourself. You are ${who(p, lane, role)}.`,
    '',
    lane === '★' ? `1. Bring every \`@lane\` line in ${p.board} up to date.` : `1. Bring your \`@lane ${lane}\` line in ${p.board} up to date.`,
    `2. Write ${file}, replacing what is there. A fresh session with no memory of this conversation must be able to carry on from it alone: ${HANDOFF_CONTENTS}`,
    '3. As your very last action call mcp__ccd_session_mgmt__clear_session with session_id "self", then end your turn with one short line. Start no other work.',
    '',
    'The Lanes mod tells the fresh session to read the handoff once you are cleared.',
  ].join('\n')
}

/** /clear_context in a session outside any lanes project: hand off to its own HANDOFF.md and clear itself. */
export function soloHandoffRequest(file: string): string {
  return [
    'Context reset, requested with /clear_context: hand your work to a fresh copy of yourself.',
    '',
    `1. Write ${file}, replacing what is there. A fresh session with no memory of this conversation must be able to carry on from it alone: ${HANDOFF_CONTENTS}`,
    '2. As your very last action call mcp__ccd_session_mgmt__clear_session with session_id "self", then end your turn with one short line. Start no other work.',
    '',
    'Once you are cleared, the fresh session is told to read the handoff.',
  ].join('\n')
}

/** The first message after a /clear_context outside any lanes project. */
export const soloResumeMessage = (file: string) => `Fresh start after /clear_context. Read ${file} and carry on from its next step.`

/** The first message of the fresh session after the clear. */
export function resumeMessage(p: Project, lane: string, role: string, file: string): string {
  if (lane === '★') return `Read ${file} and take over as orchestrator of "${p.name}".${rules(p)}`
  return `Fresh start after a context reset. You are lane ${lane} (${role}) of "${p.name}". Read ${file}, then ${p.board}, and carry on from the handoff's next step.${rules(p)}`
}

/** The Sleep button's message: wrap up for the day and save where you are. */
export function sleepMessage(p: Project, lane: string, role: string, file: string): string {
  return [
    `Good night, sent from the Lanes pane: the user is stopping for today. You are ${who(p, lane, role)}.`,
    '',
    '1. Finish only the step you are in the middle of if it takes a few minutes; otherwise stop at a safe point. Start nothing new and merge nothing.',
    `2. Commit finished work on your own branch (no merges, no pushes). Leave half-done edits uncommitted and list them in the handoff.${rules(p)}`,
    lane === '★'
      ? `3. Bring every \`@lane\` line in ${p.board} up to date, with the status \`Paused\` and the first job for tomorrow as the next job.`
      : `3. Update your \`@lane ${lane}\` line in ${p.board}: status \`Paused: <where you stopped>\`, next job = what to do first tomorrow.`,
    `4. Write ${file}, replacing what is there, as the handoff for tomorrow. A session with no memory of today must be able to carry on from it alone: ${HANDOFF_CONTENTS}`,
    '5. Reply with one line saying where you stopped, then stop. Do not clear the session.',
  ].join('\n')
}

/** The Wake up button's message. */
export function wakeMessage(p: Project, lane: string, role: string, file: string): string {
  if (lane === '★') return `Good morning. Read ${file} and take over as orchestrator of "${p.name}"; the lanes are resuming from their handoffs.${rules(p)}`
  return `Good morning, sent from the Lanes pane. You are lane ${lane} (${role}) of "${p.name}". Read ${file} and ${p.board}, set your status back to Working, and carry on with the first next step from the handoff.${rules(p)}`
}

/**
 * After the handoff file is written, the lane is told to read it as soon as its context is seen to drop (the clear
 * happened), or after this long when the drop cannot be seen (an idle session reports no context).
 */
export const RESUME_AFTER_MS = 75_000
/** A restart should be done within this; past it the row warns, but still finishes if the handoff turns up. */
export const RESET_TIMEOUT_MS = 2 * 60_000
/** A reset whose handoff never appears is given up after this. */
export const RESET_GIVE_UP_MS = 20 * 60_000

/** Did the session clear? Its live context is under half of what it was when the reset was asked for. */
export function looksCleared(tokensAtAsk: number | null, now: { isLive: boolean; tokens: number | null } | undefined): boolean {
  return tokensAtAsk !== null && now !== undefined && now.isLive && now.tokens !== null && now.tokens < tokensAtAsk / 2
}

/** How many lanes are in each state, in a fixed order, zero counts left out. */
export function counts(lanes: Lane[]): Array<{ tone: Tone; n: number }> {
  const order: Tone[] = ['working', 'blocked', 'ready', 'done', 'idle']
  return order.map(t => ({ tone: t, n: lanes.filter(l => tone(l.status) === t).length })).filter(c => c.n > 0)
}
