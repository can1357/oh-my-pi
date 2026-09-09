// ============================================================================
// XY Chart — shared color palette
//
// Generates monochromatic shades from the theme accent color.
// Series 0 = accent (or blue fallback). Series 1+ are darker/lighter
// shades of the same hue with subtle hue drift to stay in the same
// color family (like navy ↔ cyan from blue).
//
// Used by both the SVG and ASCII renderers.
// ============================================================================

/** Default accent for charts when the theme doesn't provide one. */
export const CHART_ACCENT_FALLBACK = '#3b82f6' // blue-500

// ---------------------------------------------------------------------------
// HSL ↔ Hex conversion
// ---------------------------------------------------------------------------

function hexToHsl(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const ri = parseInt(h.substring(0, 2), 16) / 255
  const gi = parseInt(h.substring(2, 4), 16) / 255
  const bi = parseInt(h.substring(4, 6), 16) / 255

  const max = Math.max(ri, gi, bi)
  const min = Math.min(ri, gi, bi)
  const l = (max + min) / 2

  if (max === min) return [0, 0, l * 100]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let hue: number
  if (max === ri) hue = ((gi - bi) / d + (gi < bi ? 6 : 0)) / 6
  else if (max === gi) hue = ((bi - ri) / d + 2) / 6
  else hue = ((ri - gi) / d + 4) / 6

  return [hue * 360, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  const si = s / 100
  const li = l / 100

  const c = (1 - Math.abs(2 * li - 1)) * si
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = li - c / 2

  let r: number, g: number, b: number
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }

  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// ---------------------------------------------------------------------------
// Hex ↔ RGB conversion
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ]
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check whether a string is a valid 6-digit hex color (e.g. "#3b82f6"). */
export function isValidHex(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color)
}

/**
 * Detect whether a background color is dark (lightness < 50%).
 */
export function isDarkBackground(bgHex: string): boolean {
  return hexToHsl(bgHex)[2] < 50
}

/**
 * Mix two hex colors in RGB space.
 * `ratio` controls how much of `fgHex` shows: 0 = pure bg, 1 = pure fg.
 * Equivalent to alpha-compositing fg over bg at the given opacity.
 */
export function mixHexColors(bgHex: string, fgHex: string, ratio: number): string {
  const [br, bg, bb] = hexToRgb(bgHex)
  const [fr, fg, fb] = hexToRgb(fgHex)
  const inv = 1 - ratio
  return rgbToHex(br * inv + fr * ratio, bg * inv + fg * ratio, bb * inv + fb * ratio)
}

/**
 * Get the hex color for a series index.
 * Index 0 returns the accent color as-is.
 * Index 1+ alternate between darker and lighter shades of the same hue
 * with subtle hue drift (±8-12° per tier) to stay in the same family.
 *
 * When `bgColor` is provided, shade direction adapts to the background:
 *   - Light bg: odd = darker, even = lighter (default)
 *   - Dark bg:  odd = lighter, even = darker (so shades stay visible)
 */
export function getSeriesColor(index: number, accentColor: string, bgColor?: string): string {
  if (index === 0) return accentColor
  // Fall back to defaults when inputs aren't valid hex (e.g. CSS variable refs like "var(--accent)")
  const safeAccent = isValidHex(accentColor) ? accentColor : CHART_ACCENT_FALLBACK
  const safeBg = bgColor && isValidHex(bgColor) ? bgColor : undefined
  const [h, s] = hexToHsl(safeAccent)
  const chartS = Math.max(55, Math.min(85, s))

  const tier = Math.ceil(index / 2)
  const oddIndex = index % 2 === 1

  // On dark backgrounds, flip: odd = lighter, even = darker
  const dark = safeBg && isDarkBackground(safeBg) ? !oddIndex : oddIndex
  const l = dark
    ? Math.max(25, 48 - tier * 13)
    : Math.min(78, 55 + tier * 11)

  // Subtle hue drift: darker shades shift slightly negative, lighter shift positive
  const hShift = (dark ? -8 : 12) * tier
  const newH = ((h + hShift) % 360 + 360) % 360

  return hslToHex(newH, chartS, l)
}
