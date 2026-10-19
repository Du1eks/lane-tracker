export type Lane = {
  lane: string
  role: string
  feature: string
  status: string
  next: string
  updated: string
}

/** One Claude session behind a lane (or the orchestrator): its model and how full its context window is. */
export type SessionInfo = {
  /** `A`..`D`, or `★` for the orchestrator. */
  lane: string
  /** The desktop session id (`local_…`), or `self` for the session this mod runs in. */
  id: string
  role: string
  model: string
  effort: string
  isRunning: boolean
  /** The app reports a turn running in it right now (this session too, unlike `isRunning`). */
  isWorking: boolean
  /** Context window use; null when the session has never been seen running. */
  percent: number | null
  tokens: number | null
  window: number | null
  /** False when the numbers are the last ones seen, because the session is idle now. */
  isLive: boolean
}

/**
 * A context reset in flight, kept in the store so it survives the clear:
 * asked (handoff requested) → written (handoff file saved) → done (told to read it), or failed.
 */
export type Reset = {
  lane: string
  id: string
  role: string
  file: string
  phase: 'asked' | 'written' | 'done' | 'failed'
  /** The session that pressed the button; only it moves the reset on. */
  owner: string
  askedAt: number
  writtenAt: number
  doneAt: number
  /** Context in use when the reset was asked for; a live reading under half of it means the clear happened. */
  tokensAtAsk: number | null
  /** No handoff within RESET_TIMEOUT_MS: the row warns, the reset keeps waiting. */
  late: boolean
}

/** Every session sent to bed by the Sleep button: each saves a handoff and stops until Wake up. */
export type Sleep = {
  at: number
  sessions: Array<{ lane: string; id: string; role: string; file: string; sent: boolean; saved: boolean }>
}

export type ProjectLane = {
  letter: string
  name: string
  /** The desktop session running the lane (`local_…`, or a prefix of it); '' while nobody has joined. */
  sessionId: string
}

/** A team of Claude sessions on one project: an orchestrator, its lanes, and the board they keep. */
export type Project = {
  id: string
  name: string
  /** The orchestrator's folder; sibling worktrees named after it count as the project's too. */
  root: string
  /** The board file of `@lane` lines the pane reads. */
  board: string
  handoffDir: string
  orchestratorHandoff: string
  /** Extra instructions every message to the sessions ends with (the project's own lane rules). */
  rules: string
  /** The orchestrator's desktop session; '' until one joins. */
  orchestratorId: string
  lanes: ProjectLane[]
  createdAt: number
}

/** This session's place: which project, and as orchestrator or as which lane. */
export type Me = { projectId: string; role: 'orchestrator' | 'lane'; letter: string }

/**
 * The setup form of /lanes in a session that is not part of a project (a new project, or joining one as a new
 * lane), or the orchestrator's lane editor.
 */
export type Setup = {
  mode: 'choose' | 'new' | 'edit' | 'add'
  /** For 'add': the project the new lane joins. */
  projectId?: string
  name: string
  count: number
  names: string[]
  sessions: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'lane-tracker': {
      projects: Project[]
      me: Me | null
      setup: Setup | null
      /** Sessions a lane can be given to, as the setup form's choices. */
      candidates: Array<{ value: string; label: string }>
      lanes: Lane[]
      sessions: SessionInfo[]
      resets: Record<string, Reset>
      sleep: Sleep | null
      /** The lane whose reset waits for a yes, or ''. */
      confirm: string
      readAt: string
      error: string
      /** The terminal's animation frame, counted up every FRAME_MS while something in the Sessions box moves. */
      frame: number
    }
  }
}
