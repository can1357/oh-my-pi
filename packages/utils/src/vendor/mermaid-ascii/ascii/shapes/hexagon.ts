// ============================================================================
// Hexagon shape renderer — uses corner decorators instead of diagonals
// ============================================================================

import type { ShapeRenderer } from './types'
import { getBoxDimensions, renderBox, getBoxAttachmentPoint } from './rectangle'
import { getCorners } from './corners'

/**
 * Hexagon shape renderer.
 * Uses hexagon markers (⬡) at corners to indicate process node semantics.
 *
 * Renders as:
 *   ⬡─────────⬡
 *   │  Label  │
 *   ⬡─────────⬡
 */
export const hexagonRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label, dimensions, options) {
    const corners = getCorners('hexagon', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}
