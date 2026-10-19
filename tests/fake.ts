import type { On } from 'claude-code'

export type FakeSession = { sessionId: string; title: string; cwd?: string; model?: string; effort?: string; isRunning?: boolean; tokens?: number }

/** What the plugin did through the fake engine. */
export type Fake = {
  sent: Array<{ to: string; text: string }>
  prompts: string[]
  statuses: Array<string | undefined>
  files: Record<string, string>
  mtimes: Record<string, number>
  sessions: FakeSession[]
  /** Folders this session was moved to (the desktop app's change_directory). */
  moves: string[]
  /** Sidebar titles set, by session id (`self` for this one). */
  titles: Record<string, string>
}

/** A path as the tests write it: the engine running on Windows reads `/home/x` as `C:\home\x`. */
export const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

/** The file at `path` among those the fake engine holds, whichever way the engine spelled it. */
export const fileAt = (fake: Fake, path: string) => Object.entries(fake.files).find(([k]) => posix(k) === path)?.[1]

/**
 * The engine and the desktop app's session tools as the plugin sees them: files in memory, a list of sessions
 * (`self` among them, which list_sessions leaves out as the app does), and every message and prompt recorded.
 */
export function fakeEngine(on: On, opts: { self: FakeSession; others: FakeSession[]; files?: Record<string, string>; now?: () => number; readOnly?: string[]; locked?: string[] }): Fake {
  const fake: Fake = { sent: [], prompts: [], statuses: [], files: { ...(opts.files ?? {}) }, mtimes: {}, sessions: [opts.self, ...opts.others], moves: [], titles: {} }
  const now = opts.now ?? (() => Date.now())
  const reply = (x: unknown) => ({ value: { content: [{ type: 'text', text: typeof x === 'string' ? x : JSON.stringify(x) }], isError: false } })
  const meta = (s: FakeSession) => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd ?? 'C:\\projects\\x', model: s.model ?? 'claude-sonnet-5-5', effort: s.effort ?? 'high', isRunning: s.isRunning ?? true })
  const find = (id: unknown) => (id === 'self' ? opts.self : fake.sessions.find(s => s.sessionId === id))

  // A locked file exists but cannot be read, as on Windows while another program holds it.
  on('fs.read', async (_$, e) => (e.path in fake.files && !(opts.locked ?? []).includes(e.path) ? { value: fake.files[e.path] as string } : { deny: 'no such file' }))
  on('fs.exists', async (_$, e) => ({ value: e.path in fake.files }))
  on('fs.write', async (_$, e) => {
    // A folder the user may not write (`/home`): only files directly in it are refused, not its subfolders' files.
    const path = posix(e.path)
    if ((opts.readOnly ?? []).some(dir => path.slice(0, path.lastIndexOf('/')) === dir)) return { deny: 'permission denied' }
    fake.files[e.path] = e.text
    fake.mtimes[e.path] = now()
    return { value: undefined }
  })
  on('fs.stat', async (_$, e) => (fake.mtimes[e.path] === undefined ? { deny: 'no such file' } : { value: { kind: 'file' as const, size: 1, mtimeMs: fake.mtimes[e.path] } as never }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.status', async (_$, e) => {
    fake.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: opts.self.cwd ?? 'C:\\projects\\x' }))
  on('session.id', async () => ({ value: `cli-${opts.self.sessionId}` }))
  on('prompt.submit', async (_$, e) => {
    fake.prompts.push(e.text)
    return { text: e.text }
  })
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'set_session_title') {
      fake.titles[String(e.args.session_id)] = String(e.args.title)
      return reply('renamed')
    }
    if (e.tool === 'change_directory') {
      fake.moves.push(String(e.args.path))
      return reply('moved when the turn ends')
    }
    if (e.tool === 'list_sessions') return reply(fake.sessions.filter(s => s !== opts.self).map(meta))
    if (e.tool === 'get_session') {
      const s = find(e.args.session_id)
      return s ? reply(meta(s)) : { value: { content: [{ type: 'text', text: 'no such session' }], isError: true } }
    }
    if (e.tool === 'get_usage') {
      const s = find(e.args.session_id)
      return reply({ context: s?.tokens === undefined ? { status: 'unavailable' } : { status: 'ok', tokensUsed: s.tokens, contextWindow: 1000000, percentUsed: Math.round(s.tokens / 10000) } })
    }
    fake.sent.push({ to: String(e.args.session_id), text: String(e.args.message) })
    return reply('delivered (delivery: delivered; message_id: m1)')
  })
  return fake
}
