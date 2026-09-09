/**
 * ASCII Rendering Validation Utilities
 *
 * Provides validation functions for ASCII diagram output,
 * including diagonal line detection to ensure orthogonal-only routing.
 */

/**
 * Characters that represent diagonal lines in ASCII and Unicode modes.
 * These should never appear in properly rendered diagrams.
 */
export const DIAGONAL_CHARS = {
  ascii: ['/', '\\'],
  unicode: ['\u2571', '\u2572'], // ╱ ╲
  all: ['/', '\\', '\u2571', '\u2572'],
} as const

/**
 * Position of a diagonal character in ASCII output.
 */
export interface DiagonalPosition {
  line: number
  col: number
  char: string
}

/**
 * Check if ASCII output contains any diagonal line characters.
 * Returns true if diagonals are found (which is an error condition).
 *
 * @param asciiOutput - The rendered ASCII diagram string
 * @returns true if diagonal characters are present, false otherwise
 */
export function hasDiagonalLines(asciiOutput: string): boolean {
  return DIAGONAL_CHARS.all.some((char) => asciiOutput.includes(char))
}

/**
 * Find all diagonal line character positions in ASCII output.
 * Useful for debugging when diagonals are detected.
 *
 * Skips diagonal characters that appear inside node labels (between box borders).
 * This prevents false positives from labels like "feature/auth" or "release/1.0".
 *
 * @param asciiOutput - The rendered ASCII diagram string
 * @returns Array of positions where diagonal characters were found
 */
export function findDiagonalLines(asciiOutput: string): DiagonalPosition[] {
  const positions: DiagonalPosition[] = []
  const lines = asciiOutput.split('\n')

  // Box-drawing characters that indicate node boundaries
  const boxBorders = new Set(['│', '┤', '├', '║', '┃', '|'])

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]!

    // Find all box border positions in this line
    const borderPositions: number[] = []
    for (let col = 0; col < line.length; col++) {
      if (boxBorders.has(line[col]!)) {
        borderPositions.push(col)
      }
    }

    for (let col = 0; col < line.length; col++) {
      const char = line[col]!
      if (DIAGONAL_CHARS.all.includes(char as '/' | '\\' | '╱' | '╲')) {
        // Check if this position is inside a node (between two box borders)
        // Find the nearest borders before and after this position
        let insideNode = false
        for (let i = 0; i < borderPositions.length - 1; i++) {
          const leftBorder = borderPositions[i]!
          const rightBorder = borderPositions[i + 1]!
          if (col > leftBorder && col < rightBorder) {
            // This diagonal char is between two borders - likely inside a node label
            insideNode = true
            break
          }
        }

        if (!insideNode) {
          positions.push({
            line: lineNum + 1, // 1-indexed for human readability
            col: col + 1,
            char,
          })
        }
      }
    }
  }

  return positions
}

/**
 * Assert that ASCII output contains no diagonal lines.
 * Throws an error with detailed position information if diagonals are found.
 *
 * @param asciiOutput - The rendered ASCII diagram string
 * @param context - Optional context string for error message (e.g., diagram name)
 * @throws Error if diagonal characters are present
 */
export function assertNoDiagonals(asciiOutput: string, context?: string): void {
  if (!hasDiagonalLines(asciiOutput)) {
    return
  }

  const positions = findDiagonalLines(asciiOutput)
  const contextStr = context ? ` in "${context}"` : ''
  const positionStr = positions
    .map((p) => `  Line ${p.line}, Col ${p.col}: '${p.char}'`)
    .join('\n')

  throw new Error(
    `Diagonal lines detected${contextStr}. ` +
      `Edges must use orthogonal Manhattan routing (90° bends only).\n` +
      `Found ${positions.length} diagonal character(s):\n${positionStr}`
  )
}
