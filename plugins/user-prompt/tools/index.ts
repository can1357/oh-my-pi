/**
 * User Prompt Tool - Ask questions to the user during execution
 *
 * Use this tool when you need to ask the user questions during execution.
 * This allows you to:
 *   1. Gather user preferences or requirements
 *   2. Clarify ambiguous instructions
 *   3. Get decisions on implementation choices as you work
 *   4. Offer choices to the user about what direction to take
 *
 * Usage notes:
 *   - Users will always be able to select "Other" to provide custom text input
 *   - Use multi: true to allow multiple answers to be selected for a question
 *   - If you recommend a specific option, make that the first option in the list
 *     and add "(Recommended)" at the end of the label
 */

import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

// =============================================================================
// Tool Definition
// =============================================================================

const OTHER_OPTION = 'Other (type your own)'

const OptionItem = Type.Object({
   label: Type.String({ description: 'Display label for this option' }),
})

const UserPromptParams = Type.Object({
   question: Type.String({ description: 'The question to ask the user' }),
   options: Type.Array(OptionItem, {
      description: 'Available options for the user to choose from.',
      minItems: 1,
   }),
   multi: Type.Optional(
      Type.Boolean({
         description: 'Allow multiple options to be selected (default: false)',
         default: false,
      })
   ),
})

interface UserPromptDetails {
   question: string
   options: string[]
   multi: boolean
   selectedOptions: string[]
   customInput?: string
}

const DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multi: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Example usage:

<example>
assistant: Let me ask which features you want to include.
assistant: Uses the user_prompt tool:
{
  "question": "Which features should I implement?",
  "options": [
    {"label": "Authentication"},
    {"label": "API endpoints"},
    {"label": "Database models"},
    {"label": "Unit tests"},
    {"label": "Documentation"}
  ],
  "multi": true
}
</example>`

const factory: CustomToolFactory = (pi: ToolAPI) => {
   const tool: CustomAgentTool<typeof UserPromptParams, UserPromptDetails> = {
      name: 'user_prompt',
      label: 'User Prompt',
      description: DESCRIPTION,
      parameters: UserPromptParams,

      async execute(_toolCallId, params, _signal, _onUpdate) {
         const { question, options, multi = false } = params
         const optionLabels = options.map(o => o.label)

         if (!pi.hasUI) {
            return {
               content: [
                  {
                     type: 'text',
                     text: 'Error: User prompt requires interactive mode',
                  },
               ],
               details: {
                  question,
                  options: optionLabels,
                  multi,
                  selectedOptions: [],
               },
            }
         }

         let selectedOptions: string[] = []
         let customInput: string | undefined

         if (multi) {
            // Multi-select: show checkboxes in the label to indicate selection state
            const DONE = '✓ Done selecting'
            const selected = new Set<string>()

            while (true) {
               // Build options with checkbox indicators
               const opts: string[] = []

               // Add "Done" option if any selected
               if (selected.size > 0) {
                  opts.push(DONE)
               }

               // Add all options with [X] or [ ] prefix
               for (const opt of optionLabels) {
                  const checkbox = selected.has(opt) ? '[X]' : '[ ]'
                  opts.push(`${checkbox} ${opt}`)
               }

               // Add "Other" option
               opts.push(OTHER_OPTION)

               const prefix = selected.size > 0 ? `(${selected.size} selected) ` : ''
               const choice = await pi.ui.select(`${prefix}${question}`, opts)

               if (choice === null || choice === DONE) break

               if (choice === OTHER_OPTION) {
                  const input = await pi.ui.input('Enter your response:')
                  if (input) customInput = input
                  break
               }

               // Toggle selection - extract the actual option name
               const optMatch = choice.match(/^\[.\] (.+)$/)
               if (optMatch) {
                  const opt = optMatch[1]
                  if (selected.has(opt)) {
                     selected.delete(opt)
                  } else {
                     selected.add(opt)
                  }
               }
            }
            selectedOptions = Array.from(selected)
         } else {
            // Single select with "Other" option
            const choice = await pi.ui.select(question, [...optionLabels, OTHER_OPTION])
            if (choice === OTHER_OPTION) {
               const input = await pi.ui.input('Enter your response:')
               if (input) customInput = input
            } else if (choice) {
               selectedOptions = [choice]
            }
         }

         const details: UserPromptDetails = {
            question,
            options: optionLabels,
            multi,
            selectedOptions,
            customInput,
         }

         let responseText: string
         if (customInput) {
            responseText = `User provided custom input: ${customInput}`
         } else if (selectedOptions.length > 0) {
            responseText = multi ? `User selected: ${selectedOptions.join(', ')}` : `User selected: ${selectedOptions[0]}`
         } else {
            responseText = 'User cancelled the selection'
         }

         return { content: [{ type: 'text', text: responseText }], details }
      },

      renderCall(args, t) {
         if (!args.question) {
            return new Text(t.fg('error', 'user_prompt: no question provided'), 0, 0)
         }

         const multiTag = args.multi ? t.fg('muted', ' [multi-select]') : ''
         let text = t.fg('toolTitle', '? ') + t.fg('accent', args.question) + multiTag

         if (args.options?.length) {
            for (const opt of args.options) {
               text += `\n${t.fg('dim', '  ○ ')}${t.fg('muted', opt.label)}`
            }
            text += `\n${t.fg('dim', '  ○ ')}${t.fg('muted', 'Other (custom input)')}`
         }

         return new Text(text, 0, 0)
      },

      renderResult(result, _opts, t) {
         const { details } = result
         if (!details) {
            const txt = result.content[0]
            return new Text(txt?.type === 'text' ? txt.text : '', 0, 0)
         }

         let text = t.fg('toolTitle', '? ') + t.fg('accent', details.question)

         if (details.customInput) {
            // Custom input provided
            text += `\n${t.fg('dim', '  ⎿ ')}${t.fg('success', details.customInput)}`
         } else if (details.selectedOptions.length > 0) {
            // Show only selected options
            const selected = details.selectedOptions
            if (selected.length === 1) {
               text += `\n${t.fg('dim', '  ⎿ ')}${t.fg('success', selected[0])}`
            } else {
               // Multiple selections
               for (let i = 0; i < selected.length; i++) {
                  const isLast = i === selected.length - 1
                  const branch = isLast ? '└─' : '├─'
                  text += `\n${t.fg('dim', `  ${branch} `)}${t.fg('success', selected[i])}`
               }
            }
         } else {
            text += `\n${t.fg('dim', '  ⎿ ')}${t.fg('warning', 'Cancelled')}`
         }

         return new Text(text, 0, 0)
      },
   }

   return tool
}

export default factory
