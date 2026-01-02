/**
 * Ask Tool - Interactive user prompting during execution
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

import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";

// =============================================================================
// Types
// =============================================================================

const OptionItem = Type.Object({
	label: Type.String({ description: "Display label for this option" }),
});

const askSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionItem, {
		description: "Available options for the user to choose from.",
		minItems: 1,
	}),
	multi: Type.Optional(
		Type.Boolean({
			description: "Allow multiple options to be selected (default: false)",
			default: false,
		}),
	),
});

export interface AskToolDetails {
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

// =============================================================================
// Constants
// =============================================================================

const OTHER_OPTION = "Other (type your own)";
const DONE_OPTION = "✓ Done selecting";

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
assistant: Uses the ask tool:
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
</example>`;

// =============================================================================
// Tool Implementation
// =============================================================================

export function createAskTool(_cwd: string): AgentTool<typeof askSchema, AskToolDetails> {
	return {
		name: "ask",
		label: "Ask",
		description: DESCRIPTION,
		parameters: askSchema,

		async execute(
			_toolCallId: string,
			params: { question: string; options: Array<{ label: string }>; multi?: boolean },
			_signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
			context?: AgentToolContext,
		) {
			const { question, options, multi = false } = params;
			const optionLabels = options.map((o) => o.label);

			// Headless fallback - return error if no UI available
			if (!context?.hasUI || !context.ui) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: User prompt requires interactive mode",
						},
					],
					details: {
						question,
						options: optionLabels,
						multi,
						selectedOptions: [],
					},
				};
			}

			const { ui } = context;
			let selectedOptions: string[] = [];
			let customInput: string | undefined;

			if (multi) {
				// Multi-select: show checkboxes in the label to indicate selection state
				const selected = new Set<string>();

				while (true) {
					// Build options with checkbox indicators
					const opts: string[] = [];

					// Add "Done" option if any selected
					if (selected.size > 0) {
						opts.push(DONE_OPTION);
					}

					// Add all options with [X] or [ ] prefix
					for (const opt of optionLabels) {
						const checkbox = selected.has(opt) ? "[X]" : "[ ]";
						opts.push(`${checkbox} ${opt}`);
					}

					// Add "Other" option
					opts.push(OTHER_OPTION);

					const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
					const choice = await ui.select(`${prefix}${question}`, opts);

					if (choice === undefined || choice === DONE_OPTION) break;

					if (choice === OTHER_OPTION) {
						const input = await ui.input("Enter your response:");
						if (input) customInput = input;
						break;
					}

					// Toggle selection - extract the actual option name
					const optMatch = choice.match(/^\[.\] (.+)$/);
					if (optMatch) {
						const opt = optMatch[1];
						if (selected.has(opt)) {
							selected.delete(opt);
						} else {
							selected.add(opt);
						}
					}
				}
				selectedOptions = Array.from(selected);
			} else {
				// Single select with "Other" option
				const choice = await ui.select(question, [...optionLabels, OTHER_OPTION]);
				if (choice === OTHER_OPTION) {
					const input = await ui.input("Enter your response:");
					if (input) customInput = input;
				} else if (choice) {
					selectedOptions = [choice];
				}
			}

			const details: AskToolDetails = {
				question,
				options: optionLabels,
				multi,
				selectedOptions,
				customInput,
			};

			let responseText: string;
			if (customInput) {
				responseText = `User provided custom input: ${customInput}`;
			} else if (selectedOptions.length > 0) {
				responseText = multi
					? `User selected: ${selectedOptions.join(", ")}`
					: `User selected: ${selectedOptions[0]}`;
			} else {
				responseText = "User cancelled the selection";
			}

			return { content: [{ type: "text" as const, text: responseText }], details };
		},
	};
}

/** Default ask tool using process.cwd() - for backwards compatibility (no UI) */
export const askTool = createAskTool(process.cwd());
