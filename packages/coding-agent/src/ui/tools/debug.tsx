/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Debug (DAP): `Debug launch ./a.out` for calls; results show the session
 * snapshot (adapter, status, stop reason, location) and the debuggee's
 * output.
 *
 * Terminal look: `debug` (`src/ui/styles/tools/debug.ts`): one line while
 * pending, then a card with Session and Output sections.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** Debug args. */
export interface DebugArgs {
	readonly action?: string;
	readonly program?: string;
	readonly file?: string;
	readonly line?: number;
	readonly expression?: string;
	readonly command?: string;
}

/** A debug session snapshot. */
export interface DebugSnapshot {
	readonly id?: string;
	readonly adapter?: string;
	readonly status?: string;
	readonly cwd?: string;
	readonly program?: string;
	readonly stopReason?: string;
	readonly frameName?: string;
	readonly instructionPointerReference?: string;
	readonly source?: { readonly path?: string };
	readonly line?: number;
	readonly column?: number;
	readonly exitCode?: number | null;
}

/** Debug result details. */
export interface DebugDetails {
	readonly action?: string;
	readonly snapshot?: DebugSnapshot;
}

/** Terminal facts of the `debug` look. */
export type DebugTerm = {
	readonly look: "debug";
	readonly result?: boolean;
	/** `launch ./a.out`. */
	readonly description: string;
	/** The action alone (card head). */
	readonly action: string;
	readonly session?: readonly {
		readonly label: string;
		readonly value: string;
	}[];
	readonly output?: string;
};

/** Body rows shown while collapsed. */
const OUTPUT_PREVIEW = 12;
const EMPTY_PREVIEW = 3;

function clean(text: string): string {
	return replaceTabs(stripControl(text));
}

function detail(args: DebugArgs | undefined): string | undefined {
	if (!args) return undefined;
	if (args.program) return clean(args.program);
	if (args.file) return `${clean(args.file)}${args.line !== undefined ? `:${args.line}` : ""}`;
	if (args.expression) return clean(args.expression);
	if (args.command) return clean(args.command);
	return undefined;
}

function head(action: string, extra: string | undefined): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: "Debug" }, { t: " " }, { s: "muted", t: action }];
	if (extra) spans.push({ t: " " }, { s: "muted", t: extra });
	return spans;
}

function actionLabel(action: string): string {
	return action.replace(/_/g, " ");
}

function sessionFacts(snapshot: DebugSnapshot): { label: string; value: string }[] {
	const facts: { label: string; value: string }[] = [];
	const add = (label: string, value: string | number | null | undefined) => {
		if (value !== undefined && value !== null && value !== "") facts.push({ label, value: clean(String(value)) });
	};
	add("Session", snapshot.id);
	add("Adapter", snapshot.adapter);
	add("Status", snapshot.status);
	add("CWD", snapshot.cwd);
	add("Program", snapshot.program);
	add("Stop reason", snapshot.stopReason);
	add("Frame", snapshot.frameName);
	add("Instruction pointer", snapshot.instructionPointerReference);
	if (snapshot.source?.path) {
		let location = snapshot.source.path;
		if (snapshot.line !== undefined) location += `:${snapshot.line}`;
		if (snapshot.line !== undefined && snapshot.column !== undefined) location += `:${snapshot.column}`;
		add("Location", location);
	}
	add("Exit code", snapshot.exitCode);
	return facts;
}

export const debugPresenter: ToolPresenter<DebugArgs, DebugDetails> = {
	merge: true,
	call(args) {
		const action = actionLabel(args?.action ?? "request");
		const extra = detail(args);
		return {
			label: head(action, extra),
			term: {
				look: "debug",
				action,
				description: extra ? `${action} ${extra}` : action,
			} satisfies DebugTerm,
		};
	},
	result(result, _state, args): ToolView {
		const action = actionLabel(result.details?.action ?? args?.action ?? "debug");
		const extra = detail(args);
		const label = head(action, extra);
		const description = extra ? `${action} ${extra}` : action;
		const text = resultText(result);
		if (result.isError) {
			const message = text.trim() || "Debug failed";
			return {
				label,
				tone: "error",
				body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
				term: {
					look: "debug",
					result: true,
					action,
					description,
					output: message,
				} satisfies DebugTerm,
			};
		}
		const snapshot = result.details?.snapshot;
		const session = snapshot ? sessionFacts(snapshot) : undefined;
		const output = text.trimEnd();
		return {
			label,
			preview: { lines: output ? OUTPUT_PREVIEW : EMPTY_PREVIEW },
			body: [
				session && session.length > 0 ? (
					<kv
						items={session.map(fact => ({
							k: [{ s: "muted", t: fact.label }],
							v: fact.value,
						}))}
					/>
				) : undefined,
				output ? <ansi text={output} /> : <text spans={[{ s: "muted", t: "No output" }]} wrap="word" />,
			],
			term: {
				look: "debug",
				result: true,
				action,
				description,
				session,
				output,
			} satisfies DebugTerm,
		};
	},
};

registerToolPresenter("debug", debugPresenter);
