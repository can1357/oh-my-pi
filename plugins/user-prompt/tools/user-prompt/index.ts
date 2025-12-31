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
 *   - Use multiSelect: true to allow multiple answers to be selected for a question
 *   - If you recommend a specific option, make that the first option in the list
 *     and add "(Recommended)" at the end of the label
 *
 * Parameters:
 *   - question: The question to ask the user
 *   - options: Array of {label} options for the user to choose from
 *   - multiSelect: (optional) Allow multiple selections (default: false)
 */

import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { CustomAgentTool, CustomToolFactory, ToolAPI } from "@mariozechner/pi-coding-agent";

const OTHER_OPTION = "Other (provide custom input)";

const OptionItem = Type.Object({
   label: Type.String({ description: "Display label for this option" }),
});

const UserPromptParams = Type.Object({
   question: Type.String({ description: "The question to ask the user" }),
   options: Type.Array(OptionItem, {
      description: "Available options for the user to choose from. Users can always select 'Other' to provide custom text input.",
      minItems: 1,
   }),
   multiSelect: Type.Optional(Type.Boolean({
      description: "Allow multiple options to be selected (default: false)",
      default: false,
   })),
});

interface UserPromptDetails {
   question: string;
   options: string[];
   multiSelect: boolean;
   selectedOptions: string[];
   customInput?: string;
}

const DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Example usage:

<example>
assistant: I need to know which database you'd like to use for this project.
assistant: Uses the user_prompt tool:
{
  "question": "Which database would you like to use?",
  "options": [
    {"label": "PostgreSQL (Recommended)"},
    {"label": "MySQL"},
    {"label": "SQLite"},
    {"label": "MongoDB"}
  ]
}
</example>

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
  "multiSelect": true
}
</example>`;

const factory: CustomToolFactory = (pi: ToolAPI) => {
   const tool: CustomAgentTool<typeof UserPromptParams, UserPromptDetails> = {
      name: "user_prompt",
      label: "User Prompt",
      description: DESCRIPTION,
      parameters: UserPromptParams,

      async execute(_toolCallId, params, _signal, _onUpdate) {
         const { question, options, multiSelect = false } = params;

         const optionLabels = options.map((o) => o.label);
         // Add "Other" option for custom input
         const allOptions = [...optionLabels, OTHER_OPTION];

         // Check if UI is available
         if (!pi.hasUI) {
            return {
               content: [{ type: "text", text: "Error: User prompt requires interactive mode (no UI available)" }],
               details: {
                  question,
                  options: optionLabels,
                  multiSelect,
                  selectedOptions: [],
               },
            };
         }

         let selectedOptions: string[] = [];
         let customInput: string | undefined;

         if (multiSelect) {
            // For multi-select, we need to loop until user is done
            // Use a simple approach: show all options and let user select one at a time
            // with a "Done selecting" option
            const DONE_OPTION = "Done selecting";
            const selected = new Set<string>();

            while (true) {
               const remaining = allOptions.filter((o) => !selected.has(o) && o !== OTHER_OPTION);
               const currentOptions = [
                  ...remaining,
                  ...(selected.size > 0 ? [DONE_OPTION] : []),
                  OTHER_OPTION,
               ];

               const selectedLabel = selected.size > 0
                  ? `\n(Selected: ${Array.from(selected).join(", ")})`
                  : "";

               const choice = await pi.ui.select(
                  `${question}${selectedLabel}`,
                  currentOptions
               );

               if (choice === null || choice === DONE_OPTION) {
                  break;
               }

               if (choice === OTHER_OPTION) {
                  const input = await pi.ui.input("Enter your custom response:", "Type here...");
                  if (input) {
                     customInput = input;
                  }
                  break;
               }

               selected.add(choice);
            }

            selectedOptions = Array.from(selected);
         } else {
            // Single select: use the select UI
            const choice = await pi.ui.select(question, allOptions);

            if (choice === OTHER_OPTION) {
               const input = await pi.ui.input("Enter your custom response:", "Type here...");
               if (input) {
                  customInput = input;
               }
            } else if (choice !== null) {
               selectedOptions = [choice];
            }
         }

         const details: UserPromptDetails = {
            question,
            options: optionLabels,
            multiSelect,
            selectedOptions,
            customInput,
         };

         // Format the response
         let responseText: string;
         if (customInput) {
            responseText = `User provided custom input: ${customInput}`;
         } else if (selectedOptions.length > 0) {
            if (multiSelect) {
               responseText = `User selected: ${selectedOptions.join(", ")}`;
            } else {
               responseText = `User selected: ${selectedOptions[0]}`;
            }
         } else {
            responseText = "User cancelled the selection";
         }

         return {
            content: [{ type: "text", text: responseText }],
            details,
         };
      },

      renderCall(args, theme) {
         if (!args.question) {
            return new Text(theme.fg("error", "user_prompt: no question provided"), 0, 0);
         }

         const multiTag = args.multiSelect ? theme.fg("muted", " [multi-select]") : "";
         let text = theme.fg("toolTitle", "? ") + theme.fg("accent", args.question) + multiTag;

         if (args.options && args.options.length > 0) {
            for (let i = 0; i < args.options.length; i++) {
               const opt = args.options[i];
               const bullet = theme.fg("dim", "  ○ ");
               text += "\n" + bullet + theme.fg("muted", opt.label);
            }
            text += "\n" + theme.fg("dim", "  ○ ") + theme.fg("muted", "Other (custom input)");
         }

         return new Text(text, 0, 0);
      },

      renderResult(result, { expanded }, theme) {
         const { details } = result;

         if (!details) {
            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "", 0, 0);
         }

         let text = theme.fg("toolTitle", "? ") + theme.fg("accent", details.question);

         if (details.customInput) {
            text += "\n" + theme.fg("dim", "  └─ ") + theme.fg("success", "✓ ") + theme.fg("fg", details.customInput);
         } else if (details.selectedOptions.length > 0) {
            for (let i = 0; i < details.options.length; i++) {
               const opt = details.options[i];
               const isSelected = details.selectedOptions.includes(opt);
               const isLast = i === details.options.length - 1 && !details.customInput;
               const branch = isLast ? "└─" : "├─";

               if (isSelected) {
                  text += "\n" + theme.fg("dim", `  ${branch} `) + theme.fg("success", "✓ ") + theme.fg("fg", opt);
               } else if (expanded) {
                  text += "\n" + theme.fg("dim", `  ${branch} ○ `) + theme.fg("muted", opt);
               }
            }
         } else {
            text += "\n" + theme.fg("dim", "  └─ ") + theme.fg("warning", "No response");
         }

         return new Text(text, 0, 0);
      },
   };

   return tool;
};

export default factory;
