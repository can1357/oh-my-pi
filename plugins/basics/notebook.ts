/**
 * Jupyter Notebook Edit Tool
 *
 * Provides cell-level editing for .ipynb files:
 *   - replace: Update cell contents
 *   - insert: Add new cells
 *   - delete: Remove cells
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { StringEnum } from '@mariozechner/pi-ai'
import type { CustomAgentTool, CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

const NotebookEditParams = Type.Object({
   notebook_path: Type.String({ description: 'Absolute path to the .ipynb file' }),
   cell_number: Type.Number({ description: '0-indexed cell number' }),
   edit_mode: Type.Optional(StringEnum(['replace', 'insert', 'delete'] as const, { description: 'Operation mode', default: 'replace' })),
   new_source: Type.Optional(Type.String({ description: 'New cell content (required for replace/insert)' })),
   cell_type: Type.Optional(StringEnum(['code', 'markdown'] as const, { description: 'Cell type for insert', default: 'code' })),
})

interface NotebookCell {
   cell_type: 'code' | 'markdown' | 'raw'
   source: string | string[]
   metadata: Record<string, unknown>
   execution_count?: number | null
   outputs?: unknown[]
}

interface NotebookStructure {
   cells: NotebookCell[]
   metadata: Record<string, unknown>
   nbformat: number
   nbformat_minor: number
}

interface NotebookEditDetails {
   path: string
   mode: 'replace' | 'insert' | 'delete'
   cellNumber: number
   cellType?: string
   totalCells: number
   error?: string
}

const factory: CustomToolFactory = _pi => {
   const tool: CustomAgentTool<typeof NotebookEditParams, NotebookEditDetails> = {
      name: 'notebook_edit',
      label: 'Notebook Edit',
      description:
         'Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.',
      parameters: NotebookEditParams,

      async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
         const { notebook_path, cell_number, new_source } = params
         const edit_mode = params.edit_mode ?? 'replace'
         const cell_type = params.cell_type ?? 'code'

         // Validate path is absolute
         if (!path.isAbsolute(notebook_path)) {
            return {
               content: [{ type: 'text', text: `Error: notebook_path must be absolute. Got: ${notebook_path}` }],
               details: { path: notebook_path, mode: edit_mode, cellNumber: cell_number, totalCells: 0, error: 'Path must be absolute' },
            }
         }

         // Read notebook
         let content: string
         try {
            content = await fs.readFile(notebook_path, 'utf-8')
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
               content: [{ type: 'text', text: `Error reading notebook: ${msg}` }],
               details: { path: notebook_path, mode: edit_mode, cellNumber: cell_number, totalCells: 0, error: msg },
            }
         }

         // Parse JSON
         let notebook: NotebookStructure
         try {
            notebook = JSON.parse(content)
         } catch (_err) {
            return {
               content: [{ type: 'text', text: 'Error: Invalid JSON in notebook file' }],
               details: { path: notebook_path, mode: edit_mode, cellNumber: cell_number, totalCells: 0, error: 'Invalid JSON' },
            }
         }

         // Validate notebook structure
         if (!notebook.cells || !Array.isArray(notebook.cells)) {
            return {
               content: [{ type: 'text', text: 'Error: Invalid notebook structure (missing cells array)' }],
               details: { path: notebook_path, mode: edit_mode, cellNumber: cell_number, totalCells: 0, error: 'Missing cells array' },
            }
         }

         const cellCount = notebook.cells.length

         // Validate cell_number based on mode
         if (edit_mode === 'insert') {
            if (cell_number < 0 || cell_number > cellCount) {
               return {
                  content: [{ type: 'text', text: `Error: cell_number ${cell_number} out of range for insert (0-${cellCount})` }],
                  details: {
                     path: notebook_path,
                     mode: edit_mode,
                     cellNumber: cell_number,
                     totalCells: cellCount,
                     error: 'Cell number out of range',
                  },
               }
            }
         } else {
            if (cell_number < 0 || cell_number >= cellCount) {
               return {
                  content: [{ type: 'text', text: `Error: cell_number ${cell_number} out of range (0-${cellCount - 1})` }],
                  details: {
                     path: notebook_path,
                     mode: edit_mode,
                     cellNumber: cell_number,
                     totalCells: cellCount,
                     error: 'Cell number out of range',
                  },
               }
            }
         }

         // Validate new_source for replace/insert
         if ((edit_mode === 'replace' || edit_mode === 'insert') && new_source === undefined) {
            return {
               content: [{ type: 'text', text: `Error: new_source is required for ${edit_mode} mode` }],
               details: {
                  path: notebook_path,
                  mode: edit_mode,
                  cellNumber: cell_number,
                  totalCells: cellCount,
                  error: 'new_source required',
               },
            }
         }

         // Perform the edit
         let resultMessage: string
         let finalCellType: string | undefined

         switch (edit_mode) {
            case 'replace': {
               const sourceLines = new_source!.split('\n').map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line))
               notebook.cells[cell_number].source = sourceLines
               finalCellType = notebook.cells[cell_number].cell_type
               resultMessage = `Replaced cell ${cell_number} (${finalCellType})`
               break
            }
            case 'insert': {
               const sourceLines = new_source!.split('\n').map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line))
               const newCell: NotebookCell = {
                  cell_type: cell_type,
                  source: sourceLines,
                  metadata: {},
               }
               if (cell_type === 'code') {
                  newCell.execution_count = null
                  newCell.outputs = []
               }
               notebook.cells.splice(cell_number, 0, newCell)
               finalCellType = cell_type
               resultMessage = `Inserted ${cell_type} cell at position ${cell_number}`
               break
            }
            case 'delete': {
               finalCellType = notebook.cells[cell_number].cell_type
               notebook.cells.splice(cell_number, 1)
               resultMessage = `Deleted cell ${cell_number} (${finalCellType})`
               break
            }
         }

         // Write back
         try {
            await fs.writeFile(notebook_path, JSON.stringify(notebook, null, 1), 'utf-8')
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
               content: [{ type: 'text', text: `Error writing notebook: ${msg}` }],
               details: { path: notebook_path, mode: edit_mode, cellNumber: cell_number, totalCells: cellCount, error: msg },
            }
         }

         const newCellCount = notebook.cells.length
         return {
            content: [{ type: 'text', text: `${resultMessage}. Notebook now has ${newCellCount} cells.` }],
            details: {
               path: notebook_path,
               mode: edit_mode,
               cellNumber: cell_number,
               cellType: finalCellType,
               totalCells: newCellCount,
            },
         }
      },

      renderCall(args, theme) {
         const mode = args.edit_mode ?? 'replace'
         const modeColor = mode === 'delete' ? 'error' : mode === 'insert' ? 'success' : 'accent'
         const pathDisplay = args.notebook_path ? path.basename(args.notebook_path) : '?'

         let text = theme.fg('toolTitle', theme.bold('notebook_edit '))
         text += theme.fg(modeColor, mode)
         text += theme.fg('dim', ' cell ')
         text += theme.fg('accent', String(args.cell_number ?? '?'))
         text += theme.fg('dim', ' in ')
         text += theme.fg('muted', pathDisplay)

         return new Text(text, 0, 0)
      },

      renderResult(result, _opts, theme) {
         const { details } = result

         if (details?.error) {
            return new Text(theme.fg('error', '✗ ') + theme.fg('error', details.error), 0, 0)
         }

         const icon = theme.fg('success', '✓')
         const modeLabel = details?.mode === 'delete' ? 'Deleted' : details?.mode === 'insert' ? 'Inserted' : 'Replaced'
         const cellInfo = details?.cellType ? theme.fg('muted', ` (${details.cellType})`) : ''
         const countInfo = theme.fg('dim', ` • ${details?.totalCells ?? 0} cells`)

         return new Text(`${icon} ${modeLabel} cell ${details?.cellNumber ?? '?'}${cellInfo}${countInfo}`, 0, 0)
      },
   }

   return tool
}

export default factory
