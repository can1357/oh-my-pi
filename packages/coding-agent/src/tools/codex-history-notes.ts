import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	CODEX_HISTORY_NOTES_ROUTES,
	type CodexHistoryNotesBackend,
	type CodexHistoryNotesContext,
} from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import { PRIVATE_MODEL_RESULT } from "@oh-my-pi/pi-ai/utils/private-content";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine, WidthAwareText } from "../tui";
import protocol from "./codex-history-notes.protocol.json" with { type: "json" };
import { formatArgsInline } from "./json-tree";
import { formatErrorMessage } from "./render-utils";

const NAMESPACE_TITLES: Record<string, string> = { history: "History", notes: "Notes" };

/** Freezes a JSON schema tree so strict-mode in-place rewrites throw at the offending pass. */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

/**
 * Built-in card for the model-only tools: one status line with the operation
 * and the arguments the model sent. Fields the schema marks `encrypted` arrive
 * as backend ciphertext and are elided; results are always ciphertext, so the
 * card reports only completion or the error.
 */
export function createPrivateToolRenderer(title: string, operation: string | undefined, encryptedKeys: string[] = []) {
	const line = (icon: "pending" | "done" | "error", args: unknown, uiTheme: Theme, spinnerFrame?: number): Component =>
		new WidthAwareText(
			width => {
				const shown = isRecord(args)
					? Object.fromEntries(
							Object.entries(args).map(([key, value]) => [
								key,
								encryptedKeys.includes(key) ? "[encrypted]" : value,
							]),
						)
					: {};
				const header = renderStatusLine(
					{ icon, spinnerFrame, title, titleColor: "toolTitle", description: operation },
					uiTheme,
				);
				const inline = formatArgsInline(shown, Math.max(20, width - Bun.stringWidth(uiTheme.tree.last) - 2));
				return inline ? `${header}\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("dim", inline)}` : header;
			},
			1,
			0,
		);
	return {
		inline: true,
		mergeCallAndResult: true,
		renderCall(args: unknown, options: RenderResultOptions, uiTheme: Theme): Component {
			return line("pending", args, uiTheme, options.spinnerFrame);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
			_options: RenderResultOptions,
			uiTheme: Theme,
			args?: unknown,
		): Component {
			if (!result.isError) return line("done", args, uiTheme);
			const message = result.content.find(block => block.type === "text")?.text;
			return new Text(formatErrorMessage(message, uiTheme), 1, 0);
		},
	};
}

/** Renderers keyed by tool name for the notes/history tool set. */
export const codexHistoryNotesToolRenderers = Object.fromEntries(
	CODEX_HISTORY_NOTES_ROUTES.map(route => {
		const spec = protocol[route];
		const encryptedKeys = Object.entries(spec.parameters.properties)
			.filter(([, property]) => "encrypted" in property && property.encrypted === true)
			.map(([key]) => key);
		return [
			`${spec.namespace}.${spec.name}`,
			createPrivateToolRenderer(
				NAMESPACE_TITLES[spec.namespace] ?? spec.namespace,
				spec.name.replaceAll("_", " "),
				encryptedKeys,
			),
		];
	}),
);

/** Verbatim codex-rs 0.154.0-alpha.3 serialized schemas; JsonSchema omits numeric bounds. */
export function createCodexHistoryNotesTools(
	backend: CodexHistoryNotesBackend,
	context: () => CodexHistoryNotesContext,
): AgentTool[] {
	return CODEX_HISTORY_NOTES_ROUTES.map(route => {
		const spec = protocol[route];
		return {
			name: `${spec.namespace}.${spec.name}`,
			namespace: spec.namespace,
			namespaceDescription: spec.namespaceDescription,
			description: spec.description,
			// The backend validates reserved schemas byte-for-byte and wire
			// post-processing rewrites schemas in place, so each tool gets a
			// deep-frozen copy: the module-level protocol JSON can never be altered,
			// and a serializer that lost the model-only flags throws instead of
			// silently corrupting the bytes on the wire.
			parameters: deepFreeze(structuredClone(spec.parameters)),
			label: `${spec.namespace}.${spec.name}`,
			summary: PRIVATE_MODEL_RESULT,
			modelOnly: true,
			intent: "omit",
			strict: false,
			concurrency:
				route === "alpha/notes/v2/append_to_file" || route === "alpha/notes/v2/write_file" ? "exclusive" : "shared",
			execute: async (_id, args, signal) => {
				if (!isRecord(args)) throw new Error("History tool arguments must be a JSON object");
				return { content: await backend.call(route, args, { ...context(), signal }) };
			},
		};
	});
}
