import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Lane, Me, Project, Reset, SessionInfo, Setup, Sleep } from '../types'
import {
  MARK,
  RESET_AT,
  RESET_GIVE_UP_MS,
  RESET_TIMEOUT_MS,
  RESUME_AFTER_MS,
  WORD,
  bar,
  bullets,
  counts,
  handoffFile,
  handoffRequest,
  looksCleared,
  modelName,
  parseBoard,
  resumeMessage,
  sleepMessage,
  soloHandoffRequest,
  soloResumeMessage,
  summary,
  tokens,
  view,
  wakeMessage,
} from './parse'
import type { Tone } from './parse'
import { FRAME_MS, barSvg, iconSvg, isMoving, motionOf, pulseOn, shimmer, spinner } from './motion'
import type { BarTone } from './motion'
import {
  LETTERS,
  SEED_FILE,
  boardTemplate,
  folderName,
  freeId,
  boardInside,
  inProjectFolder,
  laneBrief,
  laneTitle,
  membership,
  missingBoardLines,
  newProject,
  norm,
  orchestratorBrief,
  orchestratorTitle,
  sepOf,
} from './project'
import type { Membership } from './project'

const PANE = 'lanes'
const REFRESH_MS = 15000 // how often the board and the sessions are re-read
const RUNNING_MS = 5000 // how often each session is asked whether it is working, for the spinners
const SESSIONS_SERVER = 'ccd_session_mgmt' // the desktop app's session tools; absent in a plain terminal
const DIRECTORY_SERVER = 'ccd_directory' // the desktop app's tool that moves a session to another folder
const PROJECTS = 'projects' // store key of every project's team
const resetKey = (projectId: string, lane: string) => `reset:${projectId}:${lane}`
const sleepKey = (projectId: string) => `sleep:${projectId}`
const SLEEP = 'sleep' // the confirm value while the Sleep button waits for a yes
const DELETE = 'delete' // the confirm value while Delete project waits for a yes
const MAX_LANES = 8

const projects = atom({ plugin: 'lane-tracker', key: 'projects' } as const, [] as Project[])
const me = atom({ plugin: 'lane-tracker', key: 'me' } as const, null as Me | null)
const setup = atom({ plugin: 'lane-tracker', key: 'setup' } as const, null as Setup | null)
const candidates = atom({ plugin: 'lane-tracker', key: 'candidates' } as const, [] as Array<{ value: string; label: string }>)
const lanes = atom({ plugin: 'lane-tracker', key: 'lanes' } as const, [] as Lane[])
const sessions = atom({ plugin: 'lane-tracker', key: 'sessions' } as const, [] as SessionInfo[])
const resets = atom({ plugin: 'lane-tracker', key: 'resets' } as const, {} as Record<string, Reset>)
const confirm = atom({ plugin: 'lane-tracker', key: 'confirm' } as const, '') // a lane letter, or SLEEP
const sleep = atom({ plugin: 'lane-tracker', key: 'sleep' } as const, null as Sleep | null)
const readAt = atom({ plugin: 'lane-tracker', key: 'readAt' } as const, '')
const error = atom({ plugin: 'lane-tracker', key: 'error' } as const, '')
const frame = atom({ plugin: 'lane-tracker', key: 'frame' } as const, 0)

// Each row of a card has its own colour: the lane's general area, what it works on now, and its next job.
const ROW = { area: 'blue', now: 'yellow', next: 'green' } as const
// State marks; done is cyan so it is not mistaken for a green "next".
const COLOR: Record<Tone, string> = { working: 'yellow', blocked: 'red', ready: 'magenta', done: 'cyan', idle: 'gray' }

const today = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Calls one of the desktop app's session tools (no permission prompt for a plugin) and returns its text answer. */
async function sessionCall($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await $.mcp.call(SESSIONS_SERVER, tool, args)
  const text = result.content.find(b => b.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(text)
  return text
}

async function sessionTool($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await sessionCall($, tool, args)) as Record<string, unknown>
}

/** Every project's team; the first time, the seed file's projects are taken in, each only where its board exists. */
async function loadProjects($: EngineInterface): Promise<Project[]> {
  const stored = await $.store.get(PROJECTS).catch(() => undefined)
  if (Array.isArray(stored)) return stored as Project[]
  const offered = await $.fs.read(`${$.plugin.root}/${SEED_FILE}`).then(t => JSON.parse(t) as Project[]).catch(() => [] as Project[])
  const seed: Project[] = []
  for (const p of offered) if (await $.fs.stat(p.board).catch(() => undefined)) seed.push(p)
  await $.store.set(PROJECTS, seed).catch(() => undefined)
  return seed
}

async function saveProjects($: EngineInterface, list: Project[]) {
  await $.store.set(PROJECTS, list)
  await update($, projects, () => list)
}

/** This session: its desktop id and title ('' in a plain terminal) and its folder. */
async function whoAmI($: EngineInterface) {
  const meta = await sessionTool($, 'get_session', { session_id: 'self' }).catch(() => ({}) as Record<string, unknown>)
  return { id: String(meta.sessionId ?? ''), title: String(meta.title ?? ''), cwd: await $.session.cwd() }
}

/** Which project this session belongs to, read fresh. */
async function context($: EngineInterface): Promise<Membership | null> {
  return membership(await loadProjects($), await whoAmI($))
}

/** Sends a message to a session: another one through the app, this one as a prompt of its own. */
async function tell($: EngineInterface, id: string, text: string) {
  if (id === 'self') await $.prompt.submit({ text, asUser: true })
  else await sessionCall($, 'send_message', { session_id: id, message: text })
}

/**
 * Renames a session in the app's sidebar after its role (`A · Backend (Shop)`, `Orchestrator (Shop)`). The app asks
 * the user first when they named the session themselves; a refusal or a plain terminal leaves the title as it was.
 */
async function nameSession($: EngineInterface, id: string, title: string) {
  await sessionCall($, 'set_session_title', { session_id: id, title }).catch(() => undefined)
}

/** Model and context window of one session; the last numbers seen are kept in the store for when it is idle. */
async function sessionInfo($: EngineInterface, lane: string, role: string, id: string): Promise<SessionInfo> {
  const [meta, usage] = await Promise.all([sessionTool($, 'get_session', { session_id: id }), sessionTool($, 'get_usage', { session_id: id })])
  const ctx = (usage.context ?? {}) as Record<string, unknown>
  const key = `context:${String(meta.sessionId ?? id)}`
  let seen = { percent: null as number | null, tokens: null as number | null, window: null as number | null }
  const isLive = ctx.status === 'ok'
  if (isLive) {
    seen = { percent: Number(ctx.percentUsed), tokens: Number(ctx.tokensUsed), window: Number(ctx.contextWindow) }
    await $.store.set(key, seen).catch(() => undefined)
  } else {
    const kept = (await $.store.get(key).catch(() => undefined)) as typeof seen | undefined
    if (kept) seen = kept
  }
  return {
    lane,
    id,
    role,
    model: modelName(String(meta.model ?? '')),
    effort: String(meta.effort ?? ''),
    isRunning: meta.isRunning === true || id === 'self',
    isWorking: meta.isRunning === true,
    ...seen,
    isLive,
  }
}

/** The project's orchestrator and lane sessions, this one as `self`; ids stored as prefixes are matched to full ones. */
async function refreshSessions($: EngineInterface, m: Membership): Promise<SessionInfo[]> {
  const p = m.project
  try {
    const all = (await sessionTool($, 'list_sessions', { limit: 50 })) as unknown as Array<{ sessionId: string; title: string; cwd?: string }>
    const full = (stored: string) => all.find(s => stored !== '' && s.sessionId.startsWith(stored))?.sessionId
    const wanted: Array<{ lane: string; role: string; id: string }> = []
    if (m.role === 'orchestrator') wanted.push({ lane: '★', role: 'orchestrator', id: 'self' })
    else {
      const orch = full(p.orchestratorId) ?? (p.orchestratorId === '' ? all.find(s => /orchestrat/i.test(s.title))?.sessionId : undefined)
      if (orch) wanted.push({ lane: '★', role: 'orchestrator', id: orch })
    }
    for (const l of p.lanes) {
      if (m.role === 'lane' && m.letter === l.letter) wanted.push({ lane: l.letter, role: l.name, id: 'self' })
      else {
        const id = full(l.sessionId)
        if (id) wanted.push({ lane: l.letter, role: l.name, id })
      }
    }
    const infos = (await Promise.all(wanted.map(w => sessionInfo($, w.lane, w.role, w.id).catch(() => undefined)))).filter(
      (i): i is SessionInfo => i !== undefined,
    )
    await update($, sessions, () => infos)
    return infos
  } catch {
    await update($, sessions, () => []) // no session tools here (a plain terminal): the section is left out
    return []
  }
}

async function allResets($: EngineInterface, projectId: string): Promise<Reset[]> {
  const keys = (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith(`reset:${projectId}:`))
  const out = await Promise.all(keys.map(k => $.store.get(k).catch(() => undefined)))
  return out.filter((r): r is Reset => typeof r === 'object' && r !== null)
}

async function saveReset($: EngineInterface, projectId: string, r: Reset) {
  await $.store.set(resetKey(projectId, r.lane), r)
  await update($, resets, all => ({ ...all, [r.lane]: r }))
}

async function dropReset($: EngineInterface, projectId: string, lane: string) {
  await $.store.delete(resetKey(projectId, lane))
  await update($, resets, all => Object.fromEntries(Object.entries(all).filter(([k]) => k !== lane)))
}

/** Has the handoff file been written since the reset was asked for? */
async function handoffWritten($: EngineInterface, r: Reset): Promise<boolean> {
  const stat = await $.fs.stat(r.file).catch(() => undefined)
  return stat !== undefined && stat.mtimeMs > r.askedAt
}

/** The reset button: ask the session to write its handoff and clear itself. */
async function startReset($: EngineInterface, s: SessionInfo) {
  const m = await context($)
  if (!m) return
  const r: Reset = {
    lane: s.lane,
    id: s.id,
    role: s.role,
    file: handoffFile(m.project, s.lane),
    phase: 'asked',
    owner: await $.session.id(),
    askedAt: await $.clock.now(),
    writtenAt: 0,
    doneAt: 0,
    tokensAtAsk: s.isLive ? s.tokens : null,
    late: false,
  }
  await update($, confirm, () => '')
  await saveReset($, m.project.id, r)
  try {
    await tell($, s.id, handoffRequest(m.project, s.lane, s.role, r.file))
  } catch {
    await saveReset($, m.project.id, { ...r, phase: 'failed' })
  }
}

/**
 * Moves each reset on: asked → written once the handoff file appears → done once the cleared session is told to read
 * it, which happens as soon as its context is seen to drop, else RESUME_AFTER_MS after the handoff.
 */
async function advanceResets($: EngineInterface, p: Project, people: SessionInfo[]) {
  const mine = await $.session.id()
  const now = await $.clock.now()
  const shown: Record<string, Reset> = {}
  for (const r of await allResets($, p.id)) {
    if ((r.phase === 'done' && now - r.doneAt > 10 * 60_000) || (r.phase === 'failed' && now - r.askedAt > RESET_GIVE_UP_MS + 10 * 60_000)) {
      await dropReset($, p.id, r.lane)
      continue
    }
    // Only the session that pressed the button drives a reset; a cleared "self" is picked up at its SessionStart instead.
    if (r.owner === mine && r.id !== 'self') {
      if (r.phase === 'asked' && (await handoffWritten($, r))) r.phase = 'written', (r.writtenAt = now)
      else if (r.phase === 'asked' && now - r.askedAt > RESET_GIVE_UP_MS) r.phase = 'failed'
      else if (r.phase === 'asked' && now - r.askedAt > RESET_TIMEOUT_MS) r.late = true
      const cleared = looksCleared(r.tokensAtAsk ?? null, people.find(x => x.lane === r.lane))
      if (r.phase === 'written' && (cleared || now - r.writtenAt > RESUME_AFTER_MS)) {
        try {
          await tell($, r.id, resumeMessage(p, r.lane, r.role, r.file))
          r.phase = 'done'
          r.doneAt = now
        } catch {
          r.phase = 'failed'
        }
      }
      await $.store.set(resetKey(p.id, r.lane), r)
    }
    shown[r.lane] = r
  }
  await update($, resets, () => shown)
}

/** A /clear_context outside any project, kept per folder; older than this, it is dropped rather than resumed. */
const soloKey = (cwd: string) => `reset:solo:${norm(cwd)}`
const SOLO_MAX_AGE_MS = 2 * 60 * 60_000

/**
 * /clear_context: this session writes its handoff and clears itself; resumeSelf then has the fresh session read it.
 * In a lanes project the handoff is its usual file; anywhere else, HANDOFF.md in the session's folder.
 */
async function clearContext($: EngineInterface): Promise<{ file: string; request: string }> {
  const m = await context($)
  const base = { id: 'self', phase: 'asked' as const, owner: await $.session.id(), askedAt: await $.clock.now(), writtenAt: 0, doneAt: 0, tokensAtAsk: null, late: false }
  if (m) {
    const role = m.letter === '★' ? 'orchestrator' : (m.project.lanes.find(l => l.letter === m.letter)?.name ?? m.letter)
    const file = handoffFile(m.project, m.letter)
    await saveReset($, m.project.id, { ...base, lane: m.letter, role, file })
    return { file, request: handoffRequest(m.project, m.letter, role, file) }
  }
  const cwd = await $.session.cwd()
  const file = `${cwd.replace(/[\\/]+$/, '')}${sepOf(cwd)}HANDOFF.md`
  const solo: Reset = { ...base, lane: 'solo', role: '', file }
  await $.store.set(soloKey(cwd), solo)
  return { file, request: soloHandoffRequest(file) }
}

// A command may not submit a prompt itself (it would wait on the turn it holds), so the request goes out just after.
const SUBMIT_AFTER_MS = 300

/** After this session cleared itself (Handoff & restart, or /clear_context), its first prompt tells it to read the handoff. */
async function resumeSelf($: EngineInterface) {
  const m = await context($)
  if (m) {
    for (const r of await allResets($, m.project.id)) {
      if (r.id !== 'self' || (r.phase !== 'asked' && r.phase !== 'written') || !(await handoffWritten($, r))) continue
      const now = await $.clock.now()
      await saveReset($, m.project.id, { ...r, phase: 'done', writtenAt: r.writtenAt || now, doneAt: now })
      await $.prompt.submit({ text: resumeMessage(m.project, r.lane, r.role, r.file), asUser: true })
    }
    return
  }
  const cwd = await $.session.cwd()
  const solo = (await $.store.get(soloKey(cwd)).catch(() => undefined)) as Reset | undefined
  if (!solo) return
  if ((await $.clock.now()) - solo.askedAt > SOLO_MAX_AGE_MS) return $.store.delete(soloKey(cwd))
  if (!(await handoffWritten($, solo))) return
  await $.store.delete(soloKey(cwd))
  await $.prompt.submit({ text: soloResumeMessage(solo.file), asUser: true })
}

/** Sleep: every session of the project finishes its step, saves a handoff and stops; this session last. */
async function goToSleep($: EngineInterface, people: SessionInfo[]) {
  await update($, confirm, () => '')
  const m = await context($)
  if (!m) return
  const night: Sleep = { at: await $.clock.now(), sessions: [] }
  const ordered = [...people.filter(x => x.id !== 'self'), ...people.filter(x => x.id === 'self')]
  for (const x of ordered) {
    const file = handoffFile(m.project, x.lane)
    const sent = await tell($, x.id, sleepMessage(m.project, x.lane, x.role, file)).then(
      () => true,
      () => false,
    )
    night.sessions.push({ lane: x.lane, id: x.id, role: x.role, file, sent, saved: false })
  }
  await $.store.set(sleepKey(m.project.id), night)
  await update($, sleep, () => night)
}

/** Which sleeping sessions have saved their handoff since the Sleep button. */
async function checkSleep($: EngineInterface, p: Project) {
  const night = (await $.store.get(sleepKey(p.id)).catch(() => undefined)) as Sleep | undefined
  if (!night) return update($, sleep, () => null)
  for (const s of night.sessions) {
    if (s.saved) continue
    const stat = await $.fs.stat(s.file).catch(() => undefined)
    s.saved = stat !== undefined && stat.mtimeMs > night.at
  }
  await $.store.set(sleepKey(p.id), night)
  await update($, sleep, () => night)
}

/**
 * Delete project, from its orchestrator's pane or from the project list of a session outside it: the team is
 * forgotten in every session; its board and handoffs stay on disk.
 */
async function deleteProject($: EngineInterface, id: string) {
  await update($, confirm, () => '')
  const list = await loadProjects($)
  const gone = list.find(p => p.id === id)
  if (!gone) return
  await saveProjects(
    $,
    list.filter(p => p.id !== id),
  )
  // Its resets and its night: nothing else in the store belongs to it. The board and handoffs stay on disk.
  for (const key of await $.store.keys().catch(() => [] as string[])) {
    if (key.startsWith(`reset:${id}:`) || key === sleepKey(id)) await $.store.delete(key).catch(() => undefined)
  }
  $.ui.toast(`Project "${gone.name}" deleted`)
  await refresh($)
}

/** Wake up: each session that slept reads its handoff and carries on. */
async function wakeUp($: EngineInterface) {
  const m = await context($)
  if (!m) return
  const night = (await $.store.get(sleepKey(m.project.id)).catch(() => undefined)) as Sleep | undefined
  await $.store.delete(sleepKey(m.project.id))
  await update($, sleep, () => null)
  if (!night) return
  const ordered = [...night.sessions.filter(s => s.id !== 'self'), ...night.sessions.filter(s => s.id === 'self')]
  let woke = 0
  for (const s of ordered) {
    const ok = await tell($, s.id, wakeMessage(m.project, s.lane, s.role, s.file)).then(
      () => true,
      () => false,
    )
    if (ok) woke++
  }
  $.ui.toast(`☀ Woke ${woke} session${woke === 1 ? '' : 's'}`)
}

/**
 * The sessions a lane can be given to, newest first, for the setup form: only those working in the project's folder
 * (or a worktree beside it). Sessions a lane already has stay listed so the form shows them.
 */
async function loadCandidates($: EngineInterface, root: string, keep: string[] = []): Promise<string[]> {
  const all = (await sessionTool($, 'list_sessions', { limit: 50 }).catch(() => [])) as unknown as Array<{ sessionId: string; title: string; cwd?: string }>
  const here = all.filter(s => inProjectFolder({ root }, s.cwd ?? '') || keep.some(k => k !== '' && s.sessionId.startsWith(k)))
  await update($, candidates, () => here.map(s => ({ value: s.sessionId, label: `${s.title || 'untitled'} · ${folderName(s.cwd ?? '')}` })))
  return here.map(s => s.sessionId)
}

/** Opens the setup form: a new project, or (for the orchestrator) its lanes to edit. */
async function openSetup($: EngineInterface, mode: 'new' | 'edit') {
  const m = await context($)
  if (mode === 'edit' && m) {
    const p = m.project
    // Ids the board stored as prefixes are shown as the full id the picker knows.
    const known = await loadCandidates($, p.root, p.lanes.map(l => l.sessionId))
    const full = (id: string) => (id === '' ? '' : (known.find(k => k.startsWith(id)) ?? id))
    return update($, setup, () => ({ mode, name: p.name, count: p.lanes.length, names: p.lanes.map(l => l.name), sessions: p.lanes.map(l => full(l.sessionId)) }))
  }
  const cwd = await $.session.cwd()
  await loadCandidates($, cwd)
  await update($, setup, () => ({ mode: 'new', name: folderName(cwd), count: 2, names: ['', ''], sessions: ['', ''] }))
}

/** Writes the board, or adds the lines it lacks. */
async function writeBoard($: EngineInterface, p: Project, now: number) {
  const existing = await $.fs.read(p.board).catch(() => undefined)
  if (existing === undefined) return $.fs.write(p.board, boardTemplate(p, today(now)))
  const extra = missingBoardLines(existing, p, today(now))
  if (extra.length > 0) await $.fs.write(p.board, `${existing.replace(/\s*$/, '')}\n${extra.join('\n')}\n`)
}

/**
 * Writes the board where the project keeps it; where that folder takes no files (`/home` for a project at a home
 * folder), the board and handoffs move inside the project, to `.lanes`. Returns the project as placed; throws when
 * neither place can be written.
 */
async function ensureBoard($: EngineInterface, p: Project, now: number): Promise<Project> {
  try {
    await writeBoard($, p, now)
    return p
  } catch {
    const moved = boardInside(p)
    if (moved.board === p.board) throw new Error(`Cannot write the board ${p.board}`)
    await writeBoard($, moved, now)
    return moved
  }
}

/** ensureBoard for a project already saved: a board that had to move is saved with its new place. */
async function placeBoard($: EngineInterface, p: Project, now: number): Promise<Project> {
  const placed = await ensureBoard($, p, now)
  if (placed.board !== p.board) await saveProjects($, (await loadProjects($)).map(x => (x.id === p.id ? placed : x)))
  return placed
}

/** Set while Create runs, so a second press (a double click) does not make the project twice. */
let creating = false

/** Create: the project, its board, and a brief for every lane that has a session and for this session as orchestrator. */
async function createProject($: EngineInterface, form: Setup) {
  if (creating) return
  creating = true
  try {
    await update($, setup, () => null)
    await makeProject($, form)
  } finally {
    creating = false
  }
}

async function makeProject($: EngineInterface, form: Setup) {
  const self = await whoAmI($)
  const list = await loadProjects($)
  // A session orchestrates one project: one it already runs is not made again.
  if (self.id !== '' && list.some(x => x.orchestratorId !== '' && self.id.startsWith(x.orchestratorId))) return refresh($)
  const now = await $.clock.now()
  const p = newProject({
    name: form.name,
    root: self.cwd,
    orchestratorId: self.id,
    lanes: form.names.slice(0, form.count).map((name, i) => ({ name, sessionId: form.sessions[i] ?? '' })),
    now,
  })
  p.id = freeId(p.id, list.map(x => x.id))
  let placed: Project
  try {
    placed = await ensureBoard($, p, now)
  } catch {
    // Nothing is saved: pressing Create again must not pile up copies of a project that has no board.
    return update($, error, () => `Cannot write the board ${p.board} or inside ${p.root}; the project was not created.`)
  }
  await saveProjects($, [...list, placed])
  await briefNewProject($, placed)
}

/** Briefs the new project's lanes and this session as its orchestrator. */
async function briefNewProject($: EngineInterface, p: Project) {
  for (const l of p.lanes) {
    if (l.sessionId === '') continue
    await nameSession($, l.sessionId, laneTitle(p, l))
    await tell($, l.sessionId, laneBrief(p, l)).catch(() => undefined)
  }
  await nameSession($, 'self', orchestratorTitle(p))
  await refresh($)
  await $.prompt.submit({ text: orchestratorBrief(p), asUser: true })
}

/** Save the orchestrator's lane edits; lanes whose session changed are briefed. */
async function saveLanes($: EngineInterface, form: Setup) {
  const m = await context($)
  if (!m) return
  const before = m.project
  const p: Project = {
    ...before,
    name: form.name.trim() || before.name,
    lanes: form.names.slice(0, form.count).map((name, i) => ({
      letter: LETTERS[i] ?? `L${i + 1}`,
      name: name.trim() || before.lanes[i]?.name || `Lane ${LETTERS[i]}`,
      sessionId: form.sessions[i] ?? '',
    })),
  }
  const list = await loadProjects($)
  await saveProjects($, list.map(x => (x.id === p.id ? p : x)))
  await placeBoard($, p, await $.clock.now()).catch(() => undefined)
  await update($, setup, () => null)
  for (const l of p.lanes) {
    const old = before.lanes.find(x => x.letter === l.letter)
    const same = old !== undefined && old.sessionId !== '' && l.sessionId.startsWith(old.sessionId)
    if (l.sessionId !== '' && (!same || old?.name !== l.name || before.name !== p.name)) await nameSession($, l.sessionId, laneTitle(p, l))
    if (l.sessionId !== '' && !same) await tell($, l.sessionId, laneBrief(p, l)).catch(() => undefined)
  }
  if (before.name !== p.name) await nameSession($, 'self', orchestratorTitle(p))
  await refresh($)
}

/** The first letter no lane of the project uses. */
const nextLetter = (p: Project) => [...LETTERS].find(c => !p.lanes.some(l => l.letter === c)) ?? `L${p.lanes.length + 1}`

/** Join an existing project as a lane of its own: added to the project and the board, and the orchestrator is told. */
async function addLane($: EngineInterface, projectId: string, name: string) {
  const list = await loadProjects($)
  const p = list.find(x => x.id === projectId)
  if (!p) return
  const letter = nextLetter(p)
  const grown: Project = { ...p, lanes: [...p.lanes, { letter, name: name.trim() || `Lane ${letter}`, sessionId: '' }] }
  await saveProjects($, list.map(x => (x.id === projectId ? grown : x)))
  await placeBoard($, grown, await $.clock.now()).catch(() => undefined)
  await update($, setup, () => null)
  await join($, projectId, letter)
  await tellOrchestrator($, grown, letter, 'A new lane joined')
}

/** Take a lane the orchestrator set up with no session yet ("None yet"); the orchestrator is told. */
async function takeLane($: EngineInterface, projectId: string, letter: string) {
  await update($, setup, () => null)
  await join($, projectId, letter)
  const p = (await loadProjects($)).find(x => x.id === projectId)
  if (p) await tellOrchestrator($, p, letter, 'A session took its lane in')
}

/** Tells the project's orchestrator which lane a session now runs. */
async function tellOrchestrator($: EngineInterface, p: Project, letter: string, what: string) {
  const listed = (await sessionTool($, 'list_sessions', { limit: 50 }).catch(() => [])) as unknown as Array<{ sessionId: string }>
  const orchId = p.orchestratorId !== '' ? listed.find(s => s.sessionId.startsWith(p.orchestratorId))?.sessionId : undefined
  const lane = p.lanes.find(l => l.letter === letter)
  if (orchId && lane) {
    await tell($, orchId, `${what} "${p.name}" from the Lanes pane: lane ${letter} (${lane.name}). Its line is on ${p.board}; give it its first task when you are ready.`).catch(() => undefined)
  }
}

/** Join an existing project as its orchestrator, or as one of its lanes. */
async function join($: EngineInterface, projectId: string, letter: string) {
  const self = await whoAmI($)
  if (self.id === '') return update($, error, () => 'Joining needs the desktop app (its session tools name this session).')
  const list = await loadProjects($)
  // A session is in one project at a time: drop it from anything it held before.
  const cleaned = list.map(p => ({
    ...p,
    orchestratorId: p.orchestratorId !== '' && self.id.startsWith(p.orchestratorId) ? '' : p.orchestratorId,
    lanes: p.lanes.map(l => (l.sessionId !== '' && self.id.startsWith(l.sessionId) ? { ...l, sessionId: '' } : l)),
  }))
  const next = cleaned.map(p =>
    p.id !== projectId
      ? p
      : letter === '★'
        ? { ...p, orchestratorId: self.id }
        : { ...p, lanes: p.lanes.map(l => (l.letter === letter ? { ...l, sessionId: self.id } : l)) },
  )
  await saveProjects($, next)
  const p = next.find(x => x.id === projectId)
  await refresh($)
  if (!p) return
  const moved = await moveTo($, p, self.cwd)
  const lane = p.lanes.find(l => l.letter === letter)
  await nameSession($, 'self', letter === '★' || !lane ? orchestratorTitle(p) : laneTitle(p, lane))
  await $.prompt.submit({ text: letter === '★' || !lane ? orchestratorBrief(p) : laneBrief(p, lane, moved), asUser: true })
}

/**
 * A session that joins a project from another folder moves to the project's folder (the desktop app asks the user to
 * approve it, and the move happens when the turn ends). Says whether it is moving.
 */
async function moveTo($: EngineInterface, p: Project, cwd: string): Promise<boolean> {
  if (inProjectFolder(p, cwd)) return false
  const result = await $.mcp.call(DIRECTORY_SERVER, 'change_directory', { path: p.root }).catch(() => undefined)
  if (!result || result.isError) {
    $.ui.toast(`Could not move this session to ${p.root}; open a session there to work in the project's folder.`)
    return false
  }
  return true
}

/** Re-reads everything for this session's project; outside any project nothing is shown. */
async function refresh($: EngineInterface): Promise<Membership | null> {
  const list = await loadProjects($)
  await update($, projects, () => list)
  const m = membership(list, await whoAmI($))
  await update($, me, () => (m ? { projectId: m.project.id, role: m.role, letter: m.letter } : null))
  await update($, readAt, () => new Date(Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  if (!m) {
    $.ui.status(undefined)
    await update($, error, () => '')
    await update($, lanes, () => [])
    await update($, sessions, () => [])
    await update($, sleep, () => null)
    await update($, resets, () => ({}))
    shown = { people: [], lanes: [] }
    syncFrames($)
    return null
  }
  let p = m.project
  let text = await $.fs.read(p.board).catch(() => undefined)
  // A board that cannot be read is written, and moved inside the project when the folder beside it takes no files.
  if (text === undefined) {
    p = await placeBoard($, p, await $.clock.now()).catch(() => p)
    text = await $.fs.read(p.board).catch(() => undefined)
  }
  await update($, error, () => (text === undefined ? `Cannot read the board ${p.board}` : ''))
  const parsed = text === undefined ? [] : parseBoard(text)
  const byLetter = new Map(parsed.map(l => [l.lane, l]))
  const merged: Lane[] = [
    ...p.lanes.map(l => byLetter.get(l.letter) ?? { lane: l.letter, role: l.name, feature: '', status: 'Idle: no update yet', next: '', updated: '' }),
    ...parsed.filter(l => !p.lanes.some(x => x.letter === l.lane)),
  ]
  await update($, lanes, () => merged)
  $.ui.status(merged.length > 0 ? summary(merged) : undefined)
  const people = await refreshSessions($, m)
  shown = { people, lanes: merged }
  syncFrames($)
  await advanceResets($, p, people).catch(() => undefined)
  await checkSleep($, p).catch(() => undefined)
  return m
}

/** What the Sessions box shows now; the module's own, for the frame clock and the quick working check. */
let shown: { people: SessionInfo[]; lanes: Lane[] } = { people: [], lanes: [] }
let ticker: { cancel: () => void } | undefined
let poller: { cancel: () => void } | undefined

/** Does lane `letter`'s board line say it waits for the user? */
const needsYou = (lanes: Lane[], letter: string) => {
  const l = lanes.find(x => x.lane === letter)
  return l !== undefined && view(l).needsYou
}

/**
 * The terminal's frame clock runs only while some session row moves; the quick working check only while the Sessions
 * box shows anyone (so a session outside every project never polls).
 */
function syncFrames($: EngineInterface) {
  const watching = shown.people.length > 0
  if (watching && !poller) poller = $.clock.every(RUNNING_MS, () => void pollWorking($).catch(() => undefined))
  if (!watching && poller) {
    poller.cancel()
    poller = undefined
  }
  const moving = shown.people.some(s => isMoving(motionOf(s, needsYou(shown.lanes, s.lane)))) || shown.lanes.some(l => view(l).needsYou)
  if (moving && !ticker) ticker = $.clock.every(FRAME_MS, () => void update($, frame, n => n + 1).catch(() => undefined))
  if (!moving && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

/** Between the full refreshes, asks each session of the box whether it works now, so spinners start and stop quickly. */
async function pollWorking($: EngineInterface) {
  if (shown.people.length === 0) return
  const fresh = await Promise.all(
    shown.people.map(async s => {
      const meta = await sessionTool($, 'get_session', { session_id: s.id }).catch(() => undefined)
      if (!meta) return s
      const isWorking = meta.isRunning === true
      return isWorking === s.isWorking ? s : { ...s, isWorking, isRunning: isWorking || s.id === 'self' }
    }),
  )
  if (fresh.every((s, i) => s === shown.people[i])) return
  shown = { ...shown, people: fresh }
  await update($, sessions, () => fresh)
  syncFrames($)
}

const TONE: Record<string, BarTone> = { gray: 'gray', red: 'red', yellow: 'yellow', green: 'green' }

const fill = (s: SessionInfo) => (!s.isLive ? 'gray' : (s.percent ?? 0) >= 80 ? 'red' : (s.percent ?? 0) >= 50 ? 'yellow' : 'green')

const RESET_WORDS: Record<Reset['phase'], string> = {
  asked: '↺ writing handoff…',
  written: '↺ handoff saved, clearing…',
  done: '✓ restarted from handoff',
  failed: '✖ reset did not finish',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lanes', description: "Your project's lanes: what each session works on and its next job; or set up a project" })
    await $.command.register({ name: 'clear_context', description: 'Write a handoff, clear this session, and start it again from the handoff' })
    // In the background: the session (and /lanes) must not wait for the session tools to answer.
    void refresh($)
      .then(m => (m?.role === 'orchestrator' ? $.ui.open({ id: PANE, title: `Lanes · ${m.project.name}` }) : undefined))
      .catch(() => undefined)
    $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await resumeSelf($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'clear_context' }, async $ => {
    const job = await clearContext($)
    $.clock.after(SUBMIT_AFTER_MS, () => void $.prompt.submit({ text: job.request, asUser: true }))
    return { text: `Writing the handoff to ${job.file}; then this session clears itself and starts again from it.` }
  })

  on('command.run', { command: 'lanes' }, async $ => {
    const m = await refresh($)
    await $.ui.open({ id: PANE, title: m ? `Lanes · ${m.project.name}` : 'Lanes' })
    return { text: m ? `Lanes of "${m.project.name}" opened (refreshes every 15 s).` : 'This session is not part of a lanes project: set one up or join one in the pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile has no text fields or pickers: the setup form is for the desktop app or a terminal.
    const Input = 'Input' in elements ? elements.Input : undefined
    const Select = 'Select' in elements ? elements.Select : undefined
    // The desktop app (and the editor, and mobile) animate an SVG themselves; the terminal is redrawn frame by frame.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const whoami = await read($, me)
    const all = await read($, projects)
    const form = await read($, setup)
    const project = whoami ? all.find(p => p.id === whoami.projectId) : undefined
    const problem = await read($, error)

    // Joining a project as a new lane: only its name is asked.
    if (form !== null && form.mode === 'add') {
      if (!Input) return <Text wrap="wrap">Join from the desktop app or a terminal; this screen has no text fields.</Text>
      const target = all.find(p => p.id === form.projectId)
      if (!target) return <Text dimColor>That project is gone.</Text>
      const letter = nextLetter(target)
      // Lanes the orchestrator set up with "None yet" wait here for a session.
      const waiting = target.lanes.filter(l => l.sessionId === '')
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>
            Join <Text color={ROW.area}>{target.name}</Text>
          </Text>
          {waiting.length > 0 && (
            <Box flexDirection="column">
              <Text>Lanes waiting for a session:</Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {waiting.map(l => (
                  <Button key={`take-${l.letter}`} label={`${l.letter} · ${l.name}`} variant="primary" onPress={() => void takeLane($, target.id, l.letter)} />
                ))}
              </Box>
              <Text dimColor>or a new lane of its own:</Text>
            </Box>
          )}
          <Text dimColor wrap="wrap">
            This session becomes lane {letter}. It gets a line on the board, a brief on how to keep it, and the orchestrator is told.
          </Text>
          {!inProjectFolder(target, await $.session.cwd()) && (
            <Text color="yellow" wrap="wrap">
              This session works in another folder: joining moves it to {target.root} (the app asks you to allow it).
            </Text>
          )}
          <Input
            key="new-lane-name"
            label={`Lane ${letter} name`}
            placeholder="e.g. Testing, Docs, Mobile"
            value={form.name}
            onInput={v => void update($, setup, f => (f ? { ...f, name: v } : f))}
            onSubmit={v => void addLane($, target.id, v)}
          />
          <Box flexDirection="row" gap={1}>
            <Button key="add-lane-yes" label={`Join as lane ${letter}`} variant="primary" onPress={() => void addLane($, target.id, form.name)} />
            <Button key="cancel-setup" label="Cancel" onPress={() => void update($, setup, () => null)} />
          </Box>
        </Box>
      )
    }

    // The setup form: a new project, or the orchestrator's lane editor.
    if (form !== null && (form.mode === 'new' || form.mode === 'edit')) {
      if (!Input || !Select) return <Text wrap="wrap">Set up lanes from the desktop app or a terminal; this screen has no text fields.</Text>
      const choices = await read($, candidates)
      const folder = form.mode === 'edit' && project ? project.root : await $.session.cwd()
      const options = [{ value: '', label: 'None yet: that session joins with /lanes' }, ...choices]
      const setForm = (fn: (f: Setup) => Setup) => void update($, setup, f => (f ? fn(f) : f))
      const setCount = (n: number) =>
        setForm(f => ({
          ...f,
          count: n,
          names: Array.from({ length: n }, (_, i) => f.names[i] ?? ''),
          sessions: Array.from({ length: n }, (_, i) => f.sessions[i] ?? ''),
        }))
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{form.mode === 'new' ? 'New lanes project' : `Edit the lanes of "${project?.name ?? form.name}"`}</Text>
          {form.mode === 'new' && <Text dimColor wrap="wrap">This session becomes its orchestrator. Only the orchestrator and the lanes below will see this project.</Text>}
          <Text dimColor wrap="wrap">
            {choices.length === 0
              ? `No other sessions work in ${folderName(folder)} yet. Start them in ${folder} first and reopen this form, or leave the lanes on "None yet" and have each session join with /lanes.`
              : `Sessions listed: those working in ${folderName(folder)}. Start more there to pick them, or leave a lane on "None yet" and that session joins with /lanes.`}
          </Text>
          <Input
            key="project-name"
            label="Project name"
            value={form.name}
            onInput={v => setForm(f => ({ ...f, name: v }))}
            onSubmit={v => setForm(f => ({ ...f, name: v }))}
          />
          <Box flexDirection="column">
            <Text>How many lanes?</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {Array.from({ length: MAX_LANES }, (_, i) => i + 1).map(n => (
                <Button key={`count-${n}`} label={String(n)} variant={form.count === n ? 'primary' : undefined} onPress={() => setCount(n)} />
              ))}
            </Box>
          </Box>
          {form.names.slice(0, form.count).map((name, i) => (
            <Box key={`lane-${i}`} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
              <Text bold color={ROW.area}>
                Lane {LETTERS[i]}
              </Text>
              <Input
                key={`lane-name-${i}`}
                label="Name"
                placeholder="e.g. Backend, UI, Data"
                value={name}
                onInput={v => setForm(f => ({ ...f, names: f.names.map((x, j) => (j === i ? v : x)) }))}
                onSubmit={v => setForm(f => ({ ...f, names: f.names.map((x, j) => (j === i ? v : x)) }))}
              />
              <Select
                key={`lane-session-${i}`}
                label="Session"
                options={options}
                value={form.sessions[i] ?? ''}
                onSelect={v => setForm(f => ({ ...f, sessions: f.sessions.map((x, j) => (j === i ? v : x)) }))}
              />
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            {form.mode === 'new' ? (
              <Button key="create" label="Create & brief the lanes" variant="primary" onPress={() => void createProject($, form)} />
            ) : (
              <Button key="save-lanes" label="Save & brief new lanes" variant="primary" onPress={() => void saveLanes($, form)} />
            )}
            <Button key="cancel-setup" label="Cancel" onPress={() => void update($, setup, () => null)} />
          </Box>
        </Box>
      )
    }

    // Not part of any project: nothing about any team is shown, only the ways in.
    if (!whoami || !project) {
      const asking = await read($, confirm)
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Lanes</Text>
          <Text dimColor wrap="wrap">This session is not part of a lanes project, so no project's work is shown here.</Text>
          {problem !== '' && <Text color="red" wrap="wrap">✖ {problem}</Text>}
          <Button key="new-project" label="＋ New project (this session orchestrates)" variant="primary" onPress={() => void openSetup($, 'new')} />
          {all.length > 0 && <Text bold>Or add a lane to a project</Text>}
          {all.map(p => (
            <Box key={`project-${p.id}`} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
              <Text bold color={ROW.area} wrap="truncate-end">
                {p.name}
              </Text>
              <Text dimColor wrap="truncate-end">
                {p.root} · {p.lanes.length} lane{p.lanes.length === 1 ? '' : 's'}
              </Text>
              {asking !== `${DELETE}:${p.id}` ? (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Button
                    key={`add-lane-${p.id}`}
                    label={
                      p.lanes.some(l => l.sessionId === '')
                        ? `＋ Join a lane (${p.lanes.filter(l => l.sessionId === '').map(l => l.letter).join(', ')} waiting)`
                        : `＋ Join as a new lane (${nextLetter(p)})`
                    }
                    variant="primary"
                    onPress={() => void update($, setup, (): Setup => ({ mode: 'add', projectId: p.id, name: '', count: 0, names: [], sessions: [] }))}
                  />
                  <Button key={`delete-${p.id}`} label="✖ Delete" dimColor onPress={() => void update($, confirm, () => `${DELETE}:${p.id}`)} />
                </Box>
              ) : (
                <Box flexDirection="column">
                  <Text color="red" wrap="wrap">
                    Delete "{p.name}"? Its orchestrator and lanes stop being a team. The board and handoff files stay on disk.
                  </Text>
                  <Box flexDirection="row" gap={1}>
                    <Button key={`delete-yes-${p.id}`} label="Yes, delete" variant="primary" onPress={() => void deleteProject($, p.id)} />
                    <Button key={`delete-no-${p.id}`} label="Cancel" onPress={() => void update($, confirm, () => '')} />
                  </Box>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )
    }

    const list = await read($, lanes)
    const people = await read($, sessions)
    const inFlight = await read($, resets)
    const asking = await read($, confirm)
    const night = await read($, sleep)
    const when = await read($, readAt)
    const saved = night?.sessions.filter(s => s.saved).length ?? 0
    // Only the terminal reads the frame, so only it is redrawn as the frame clock ticks.
    const tick = Svg ? 0 : await read($, frame)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold color={ROW.area} wrap="truncate-end">
            {project.name}
            <Text dimColor> · {whoami.role === 'orchestrator' ? 'you orchestrate' : `you are lane ${whoami.letter}`}</Text>
          </Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {whoami.role === 'orchestrator' && <Button key="edit-lanes" label="⚙ Lanes" dimColor onPress={() => void openSetup($, 'edit')} />}
            {night === null && asking !== SLEEP && people.length > 0 && <Button key="sleep" label="☾ Sleep all" onPress={() => void update($, confirm, () => SLEEP)} />}
          </Box>
        </Box>
        {night === null && asking === SLEEP && (
          <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
            <Text color="magenta" wrap="wrap">
              ☾ Send every session of this project to bed? Each finishes its current step, commits to its own branch, saves a handoff and stops until you wake them.
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="sleep-yes" label="Yes, sleep" variant="primary" onPress={() => void goToSleep($, people)} />
              <Button key="sleep-no" label="Cancel" onPress={() => void update($, confirm, () => '')} />
            </Box>
          </Box>
        )}
        {night !== null && (
          <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text color="magenta" bold wrap="truncate-end">
                ☾ Sleeping since {new Date(night.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
              <Button key="wake" label="☀ Wake up" variant="primary" onPress={() => void wakeUp($)} />
            </Box>
            <Text wrap="truncate-end">
              <Text dimColor>handoffs saved </Text>
              <Text color={saved === night.sessions.length ? 'green' : 'yellow'}>
                {saved}/{night.sessions.length}
              </Text>
              <Text>  </Text>
              {night.sessions.map(s => (
                <Text color={s.saved ? 'green' : s.sent ? 'yellow' : 'red'}>{`${s.saved ? '✓' : s.sent ? '…' : '✖'}${s.lane} `}</Text>
              ))}
            </Text>
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={2}>
            {counts(list).map(c => (
              <Text color={COLOR[c.tone]}>
                {MARK[c.tone]} {c.n} {WORD[c.tone]}
              </Text>
            ))}
          </Box>
          <Text dimColor>{when === '' ? '' : `↻ ${when}`}</Text>
        </Box>

        {problem !== '' && <Text color="red" wrap="truncate-end">✖ {problem}</Text>}
        {list.length === 0 && problem === '' && <Text dimColor>No lanes on the board yet.</Text>}

        {list.map(lane => {
          const v = view(lane)
          const b = bullets(v.now)
          // The card's corner moves like its session's row: it spins while the session runs a turn, pulses while the lane
          // waits for the user, and stays still otherwise.
          const person = people.find(p => p.lane === v.lane)
          const m = person ? motionOf(person, v.needsYou) : { state: v.needsYou ? ('needs' as const) : ('idle' as const), hot: false }
          return (
            <Box key={v.lane} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text bold color={ROW.area} wrap="truncate-end">
                  {v.lane} {v.role}
                </Text>
                <Box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
                  {v.needsYou &&
                    (Svg ? (
                      <Box flexDirection="row" gap={1} alignItems="center">
                        <Svg key={`card-flag-${v.lane}`} source={iconSvg({ state: 'needs', hot: false }, false)} alt="needs you" width={14} height={14} isInteractive />
                        <Text color="yellow">you</Text>
                      </Box>
                    ) : (
                      <Text color="yellow" dimColor={!pulseOn(tick)}>
                        ⚑ you
                      </Text>
                    ))}
                  {m.state === 'working' ? (
                    Svg ? (
                      <Box flexDirection="row" gap={1} alignItems="center">
                        <Svg key={`card-spin-${v.lane}`} source={iconSvg(m, true)} alt="working" width={14} height={14} isInteractive />
                        <Text color={COLOR[v.tone]}>{WORD[v.tone]}</Text>
                      </Box>
                    ) : (
                      <Text color={COLOR[v.tone]}>
                        {spinner(tick)} {WORD[v.tone]}
                      </Text>
                    )
                  ) : (
                    <Text color={COLOR[v.tone]}>
                      {MARK[v.tone]} {WORD[v.tone]}
                    </Text>
                  )}
                </Box>
              </Box>
              {b.items.map(item => (
                <Text color={ROW.now} wrap="truncate-end">
                  {MARK[v.tone]} {item}
                </Text>
              ))}
              {b.more > 0 && <Text dimColor>  +{b.more} more</Text>}
              {v.next !== '' && (
                <Text color={ROW.next} wrap="truncate-end">
                  → {v.next}
                </Text>
              )}
            </Box>
          )
        })}

        {people.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
            <Text bold>Sessions</Text>
            {people.map(s => {
              const reset = inFlight[s.lane]
              const busy = reset !== undefined && (reset.phase === 'asked' || reset.phase === 'written')
              const urgent = (s.percent ?? 0) >= RESET_AT
              const m = motionOf(s, needsYou(list, s.lane))
              // The row says which session it is and how full its context is; whether it works or waits for the user is
              // shown on the lane cards above, so only the bar moves here.
              const name = (
                <Text wrap="truncate-end">
                  <Text color={s.isRunning ? 'green' : 'gray'}>{s.isRunning ? '● ' : '○ '}</Text>
                  <Text bold color={ROW.area}>{s.lane === '★' ? '★ Orchestrator' : s.lane}</Text>
                  <Text>  {s.model}</Text>
                  {s.effort !== '' && <Text dimColor> · {s.effort}</Text>}
                </Text>
              )
              const numbers =
                s.percent === null ? (
                  <Text dimColor>idle · no context data yet</Text>
                ) : (
                  <Text dimColor={!s.isLive} color={m.hot ? 'red' : undefined}>
                    {s.percent}% · {tokens(s.tokens ?? 0)} of {tokens(s.window ?? 0)}
                    {s.isLive ? '' : ' · last seen'}
                  </Text>
                )
              const [before, lit, after] = m.state === 'working' ? shimmer(bar(s.percent ?? 0), tick) : [bar(s.percent ?? 0), '', '']
              const barColor = m.hot && !pulseOn(tick) ? undefined : fill(s)
              return (
                <Box key={s.lane} flexDirection="column" marginTop={1}>
                  {name}
                  {/* The bar has a line of its own and the numbers go under it, so a narrow pane never squeezes them. */}
                  {Svg ? (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Svg key={`bar-${s.lane}-${m.state}-${m.hot}-${s.percent}`} source={barSvg(s.percent ?? 0, TONE[fill(s)] ?? 'gray', m)} alt={`context ${s.percent ?? 0}%`} isInteractive />
                      <Text wrap="truncate-end">{numbers}</Text>
                    </Box>
                  ) : (
                    <Text wrap="truncate-end">
                      <Text>  </Text>
                      <Text color={barColor} dimColor={barColor === undefined}>{before}</Text>
                      {lit !== '' && <Text color="white" bold>{lit}</Text>}
                      {after !== '' && <Text color={barColor} dimColor={barColor === undefined}>{after}</Text>}
                      <Text> </Text>
                      {numbers}
                    </Text>
                  )}
                  {reset !== undefined && (
                    <Text color={reset.phase === 'failed' || (reset.late && reset.phase === 'asked') ? 'red' : reset.phase === 'done' ? 'cyan' : 'yellow'} wrap="truncate-end">
                      {'  '}
                      {reset.late && reset.phase === 'asked' ? '⚠ no handoff after 2 min, still waiting…' : RESET_WORDS[reset.phase]}
                    </Text>
                  )}
                  {!busy && asking !== s.lane && (
                    <Box flexDirection="row" gap={1} marginLeft={2}>
                      <Button
                        key={`reset-${s.lane}`}
                        label={urgent ? '↺ Handoff & restart (recommended)' : '↺ Handoff & restart'}
                        variant={urgent ? 'primary' : undefined}
                        dimColor={!urgent}
                        onPress={() => void update($, confirm, () => s.lane)}
                      />
                    </Box>
                  )}
                  {!busy && asking === s.lane && (
                    <Box flexDirection="column" marginLeft={2}>
                      <Text color="yellow" wrap="wrap">
                        Write {folderName(handoffFile(project, s.lane))}, clear the session, then start it again from the file?
                      </Text>
                      <Box flexDirection="row" gap={1}>
                        <Button key={`yes-${s.lane}`} label="Yes, reset" variant="primary" onPress={() => void startReset($, s)} />
                        <Button key={`no-${s.lane}`} label="Cancel" onPress={() => void update($, confirm, () => '')} />
                      </Box>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Text color={ROW.area}>■ area</Text>
          <Text color={ROW.now}>● current work</Text>
          <Text color={ROW.next}>→ next</Text>
          <Text dimColor>◆ ready  ✓ done  ✖ blocked  ⚑ needs you</Text>
        </Box>

        {/* Only the orchestrator can end the project, and only after a yes. */}
        {whoami.role === 'orchestrator' && asking !== DELETE && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="delete-project" label="✖ Delete project" dimColor onPress={() => void update($, confirm, () => DELETE)} />
          </Box>
        )}
        {whoami.role === 'orchestrator' && asking === DELETE && (
          <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red" wrap="wrap">
              Delete the project "{project.name}"? Its orchestrator and lanes stop being a team: the pane and the status line go away in every one of its sessions. The board ({project.board}) and the handoff files stay on disk.
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="delete-yes" label="Yes, delete" variant="primary" onPress={() => void deleteProject($, project.id)} />
              <Button key="delete-no" label="Cancel" onPress={() => void update($, confirm, () => '')} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
