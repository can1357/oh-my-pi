// ============================================================================
// Circle shape renderer — uses corner decorators instead of curves
// ============================================================================

import type { ShapeRenderer } from './types'
import { getBoxDimensions, renderBox, getBoxAttachmentPoint } from './rectangle'
import { getCorners } from './corners'

/**
 * Circle shape renderer.
 * Uses circle markers (◯) at corners to indicate circular shape semantics.
 *
 * Renders as:
 *   ◯─────────◯
 *   │  Label  │
 *   ◯─────────◯
 */
export const circleRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label, dimensions, options) {
    const corners = getCorners('circle', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}
