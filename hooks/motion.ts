import type { SessionInfo } from '../types'

/**
 * How a session row of the Sessions box moves: a working session spins and its bar shimmers, one that needs the user
 * pulses, one whose context is nearly full has a pulsing red bar, an idle one stays still.
 */
export type Motion = { state: 'working' | 'needs' | 'idle'; hot: boolean }

/** Context use from which the bar turns red and pulses. */
export const HOT_AT = 80

/** One frame of the terminal's animation every FRAME_MS; the desktop animates its SVG by itself. */
export const FRAME_MS = 150

export function motionOf(s: SessionInfo, needsYou: boolean): Motion {
  const hot = s.isLive && (s.percent ?? 0) >= HOT_AT
  // Waiting for the user wins over working: it is the one thing the user has to act on.
  return { state: needsYou ? 'needs' : s.isWorking ? 'working' : 'idle', hot }
}

/** Does anything on screen move (so the terminal's frame clock has to run)? */
export const isMoving = (m: Motion) => m.state !== 'idle' || m.hot

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** The terminal spinner's glyph at `frame`. */
export const spinner = (frame: number) => SPINNER[frame % SPINNER.length] as string

/** A slow on/off for pulses in the terminal: about 0.6 s each way. */
export const pulseOn = (frame: number) => Math.floor(frame / 4) % 2 === 0

/**
 * The terminal bar cut in three for the shimmer: the cells before the light, the lit cell, the cells after. The
 * light walks the bar and rests a few frames off its end, as the preview's sweep does.
 */
export function shimmer(bar: string, frame: number): [string, string, string] {
  const cells = [...bar]
  const at = frame % (cells.length + 4)
  if (at >= cells.length) return [bar, '', '']
  return [cells.slice(0, at).join(''), cells[at] as string, cells.slice(at + 1).join('')]
}

// The SVG is drawn isolated from the app's styles, so its colours are fixed mid tones that read in light and dark.
const HEX = { green: '#1D9E75', yellow: '#EF9F27', red: '#E24B4A', gray: '#888780', track: 'rgba(136,135,128,0.28)' } as const
export type BarTone = keyof typeof HEX

const BAR_W = 220
const BAR_H = 8

/**
 * The desktop context bar as SVG with SMIL animation: a light sweeps along it while the session works, the fill
 * pulses when the context is nearly full, and a ring pulses around it while the session waits for the user.
 */
export function barSvg(percent: number, tone: BarTone, m: Motion): string {
  const pad = 3
  const w = BAR_W + pad * 2
  const h = BAR_H + pad * 2
  const fill = Math.max(0, Math.min(BAR_W, Math.round((percent / 100) * BAR_W)))
  const r = BAR_H / 2
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<clipPath id="c"><rect x="${pad}" y="${pad}" width="${BAR_W}" height="${BAR_H}" rx="${r}"/></clipPath>`,
  ]
  if (m.state === 'needs') {
    parts.push(
      `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r + 2}" fill="none" stroke="${HEX.yellow}" stroke-width="2" opacity="0">`,
      `<animate attributeName="opacity" values="0;0.9;0" dur="1.2s" repeatCount="indefinite"/></rect>`,
    )
  }
  parts.push(`<g clip-path="url(#c)">`, `<rect x="${pad}" y="${pad}" width="${BAR_W}" height="${BAR_H}" fill="${HEX.track}"/>`)
  parts.push(`<rect x="${pad}" y="${pad}" width="${fill}" height="${BAR_H}" rx="${r}" fill="${HEX[tone]}">`)
  if (m.hot) parts.push(`<animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite"/>`)
  parts.push('</rect>')
  if (m.state === 'working') {
    parts.push(
      `<rect x="${pad - 40}" y="${pad}" width="40" height="${BAR_H}" fill="#ffffff" opacity="0.45">`,
      `<animate attributeName="x" from="${pad - 40}" to="${pad + BAR_W}" dur="1.8s" repeatCount="indefinite"/></rect>`,
    )
  }
  parts.push('</g></svg>')
  return parts.join('')
}

/** The desktop status icon: a turning arc while working, a pulsing flag while waiting for the user, a still ring idle. */
export function iconSvg(m: Motion, isRunning: boolean): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">'
  if (m.state === 'working') {
    return `${open}<circle cx="7" cy="7" r="5" fill="none" stroke="${HEX.track}" stroke-width="2"/><path d="M7 2 A5 5 0 0 1 12 7" fill="none" stroke="${HEX.yellow}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.8s" repeatCount="indefinite"/></path></svg>`
  }
  if (m.state === 'needs') {
    return `${open}<g fill="${HEX.yellow}"><animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite"/><rect x="3" y="1.5" width="1.6" height="11" rx="0.8"/><path d="M4.6 2 H11.5 L9.6 4.8 L11.5 7.6 H4.6 Z"/></g></svg>`
  }
  return `${open}<circle cx="7" cy="7" r="4.5" fill="${isRunning ? HEX.green : 'none'}" stroke="${isRunning ? HEX.green : HEX.gray}" stroke-width="1.5"/></svg>`
}
