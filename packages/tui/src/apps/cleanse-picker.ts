/**
 * Standalone TUI pickers for `omp cleanse`.
 *
 * One-shot {@link selectStandaloneItem} and {@link promptStandaloneText}
 * prompts, resolved on select/submit/cancel so the command can keep writing
 * plain stdout afterwards.
 */
import { type SelectItem } from "../components/select-list";
import { promptStandaloneText, selectStandaloneItem } from "./standalone-picker";

/** Checker metadata presented by the target picker. */
export interface CleanseCheckerChoice {
	id: string;
	label: string;
	language: string;
	command: string;
}

/** Selected checker scope or free-form repair request. */
export type CleanseTargetChoice =
	| { kind: "all" }
	| { kind: "checker"; id: string }
	| { kind: "request"; request: string }
	| { kind: "cancel" };

/** Pick between running every discovered checker, one specific checker, or a free-form request. */
export async function pickCleanseTarget(checkers: readonly CleanseCheckerChoice[]): Promise<CleanseTargetChoice> {
	const items: SelectItem[] = [
		{
			value: "all",
			label: `Run all ${checkers.length} discovered checker${checkers.length === 1 ? "" : "s"}`,
		},
		...checkers.map(checker => ({
			value: `checker:${checker.id}`,
			label: checker.label,
			description: `${checker.language} — ${checker.command}`,
		})),
		{
			value: "request",
			label: "Describe what to fix…",
			description: "A discovery agent figures out the command to run",
		},
	];
	const selection = await selectStandaloneItem("Select what to cleanse:", items, { maxVisible: 12 });
	if (selection === null) return { kind: "cancel" };
	if (selection === "all") return { kind: "all" };
	if (selection === "request") {
		const request = await promptCleanseRequest();
		return request === null ? { kind: "cancel" } : { kind: "request", request };
	}
	return { kind: "checker", id: selection.slice("checker:".length) };
}

/** One-shot text prompt for a free-form cleanse request; `null` when cancelled or left empty. */
export async function promptCleanseRequest(): Promise<string | null> {
	return promptStandaloneText('Describe what to detect and fix (e.g. "ts errors"):');
}
