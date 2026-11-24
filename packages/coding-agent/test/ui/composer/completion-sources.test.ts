import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { createRoot, effect, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import type { TspItemProps } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createModelMentionSource } from "../../../src/autocomplete/model-mention";
import { PromptActionAutocompleteProvider } from "../../../src/autocomplete/prompt-actions";
import { getDocFilenames } from "../../../src/internal-urls/docs-index";
import { createModelBrowserSource } from "../../../src/modes/model-browser-source";
import { Settings } from "../../../src/config/settings";
import { buildArgumentCompletions } from "../../../src/slash-commands/builtin-completions";
import { Composer, inCompletionContext } from "../../../src/ui/composer";
import { getTestModel } from "../../helpers/model-fixtures";
import { key, sendKey, sendPaste, settle } from "./harness";

function type(composer: Composer, text: string): void {
	for (const char of text) sendKey(composer.node, composer.field, key(char));
}

/** Keys the actual popup offers; no acceptance or keyboard routing in the assertion. */
function offers(node: UiNode, value: string): boolean {
	return node.kind === "item" ? node.key() === value : node.children().some(child => offers(child, value));
}

/** Wait for reactive publication, not a fixed delay for the filesystem or a number of render turns. */
function offered(composer: Composer, value: string): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const stop = createRoot(dispose => {
		effect(() => {
			if (offers(composer.node, value)) ready.resolve();
		});
		return dispose;
	});
	return ready.promise.finally(stop);
}

describe("composer completion sources", () => {
	test("renders slash icons once, aligns mixed glyph widths and accepts the undecorated command", async () => {
		const composer = new Composer({
			autocomplete: new PromptActionAutocompleteProvider(
				[
					{ name: "usage", icon: "◴", iconName: "gauge", description: "Limits" },
					{ name: "upload", icon: "\x1b[32m箱\x1b[0m", description: "Send" },
					{ name: "undo", description: "Revert" },
					{ name: "unmute", iconName: "volume", description: "Enable" },
				],
				process.cwd(),
				[],
			),
		});
		type(composer, "/u");
		await offered(composer, "usage");
		const popup = composer.node.children().find(child => child.kind === "overlay")!;
		const list = popup.children()[0]!.children()[0]!;
		expect(
			list.children().map(item => {
				const { icon, label } = item.props() as TspItemProps;
				return [item.key(), icon, label];
			}),
		).toEqual([
			["usage", "gauge", [{ s: "mark", t: "u" }, { t: "sage" }]],
			["upload", undefined, [{ s: "muted", t: "箱 " }, { s: "mark", t: "u" }, { t: "pload" }]],
			["undo", undefined, [{ s: "mark", t: "u" }, { t: "ndo" }]],
			["unmute", "volume", [{ s: "mark", t: "u" }, { t: "nmute" }]],
		]);

		const env = corpusEnvironment("dark");
		expect(plainRows(paintNode(env, popup, 60).rows)).toEqual([
			"❯ ◴  usage       Limits",
			"  箱 upload      Send",
			"     undo        Revert",
			"     unmute      Enable",
		]);
		expect(plainRows(paintNode(env, popup, 10).rows)).toEqual(["❯ ◴  usa", "  箱 upl", "     und", "     unm"]);
		sendKey(composer.node, composer.field, key("\x1b[B"));
		type(composer, "\t");
		expect(composer.text()).toBe("/upload ");
	});

	test("sends Tern a live `Label: state` description as detail and value, keeping the terminal row", async () => {
		const composer = new Composer({
			autocomplete: new PromptActionAutocompleteProvider(
				[
					{
						name: "model",
						description: "Switch model",
						getAutocompleteDescription: () => "Model: parity/alpha",
					},
					{ name: "mode", description: "Pick a mode" },
				],
				process.cwd(),
				[],
			),
		});
		type(composer, "/mode");
		await offered(composer, "model");
		const popup = composer.node.children().find(child => child.kind === "overlay")!;
		const items = popup.children()[0]!.children()[0]!.children();
		expect(
			items.map(item => {
				const { label, detail, value } = item.props() as TspItemProps;
				return [item.key(), label, detail, value];
			}),
		).toEqual([
			// The whole label typed: one marked span, no empty tail.
			["mode", [{ s: "mark", t: "mode" }], [{ s: "muted", t: "Pick a mode" }], undefined],
			[
				"model",
				[{ s: "mark", t: "mode" }, { t: "l" }],
				[{ s: "muted", t: "Switch model" }],
				[{ s: "muted", t: "parity/alpha" }],
			],
		]);
		expect(plainRows(paintNode(corpusEnvironment("dark"), popup, 60).rows)).toEqual([
			"❯ mode        Pick a mode",
			"  model       Model: parity/alpha",
		]);
	});

	test("sends an emoji proposal's label with one space after its glyph", async () => {
		const composer = new Composer({ autocomplete: new PromptActionAutocompleteProvider([], process.cwd(), []) });
		type(composer, ":rock");
		await offered(composer, "🚀");
		const popup = composer.node.children().find(child => child.kind === "overlay")!;
		const rocket = popup
			.children()[0]!
			.children()[0]!
			.children()
			.find(item => item.key() === "🚀")!;
		const label = (rocket.props() as TspItemProps).label;
		expect(typeof label === "string" ? label : label?.map(span => span.t).join("")).toBe("🚀 :rocket:");
	});

	test("offers submitted commands and their arguments but only skills after prompt text", async () => {
		const provider = new PromptActionAutocompleteProvider(
			[
				{
					name: "switch",
					getArgumentCompletions: buildArgumentCompletions([{ name: "list", description: "Available targets" }]),
				},
				{ name: "skill:security-review", description: "Review a change" },
			],
			process.cwd(),
			[],
		);
		const composer = new Composer();
		// The welcome frame already accepts input before interactive mode binds its provider.
		sendPaste(composer.node, composer.field, " \n  /s");
		type(composer, "w");
		expect(composer.completing()).toBe(false);
		composer.setAutocomplete(provider);
		expect(offers(composer.node, "switch")).toBe(true);
		type(composer, "itch ");
		await offered(composer, "list ");
		type(composer, "lx");
		await settle();
		expect(composer.completing()).toBe(false);
		type(composer, "\x7f");
		await offered(composer, "list ");
		composer.setText("review this\n");
		type(composer, "/sec");
		await offered(composer, "skill:security-review");
		expect(offers(composer.node, "switch")).toBe(false);
	});

	test("dispatches emoji, hash actions, GitHub references and internal URLs from the live token", async () => {
		const composer = new Composer();
		composer.setAutocomplete(
			new PromptActionAutocompleteProvider([], process.cwd(), [
				{
					id: "clear",
					label: "Clear draft",
					keywords: ["clear"],
					description: "Remove the prompt",
					execute: () => composer.clearDraft(),
				},
			]),
		);
		type(composer, "ok (:joy");
		await offered(composer, "😂");
		type(composer, ":");
		expect(composer.text()).toBe("ok (😂");
		expect(composer.completing()).toBe(false);
		type(composer, "this#cle");
		await offered(composer, "Clear draft");
		type(composer, " issue #24");
		await offered(composer, "issue://24");
		expect(offers(composer.node, "pr://24")).toBe(false);
		const doc = getDocFilenames()[0]!;
		type(composer, ` (omp:/${doc}`);
		await offered(composer, `omp://${doc}`);
	});

	test("respects the live emoji preference for suggestions and inline expansion", async () => {
		let enabled = false;
		const provider = new PromptActionAutocompleteProvider(
			[],
			process.cwd(),
			[],
			undefined,
			undefined,
			undefined,
			() => enabled,
		);
		const composer = new Composer({ autocomplete: provider });
		type(composer, ":joy");
		await settle();
		expect(composer.completing()).toBe(false);
		type(composer, ":");
		expect(composer.text()).toBe(":joy:");
		enabled = true;
		type(composer, " :joy");
		await offered(composer, "😂");
		type(composer, ":");
		expect(composer.text()).toBe(":joy: 😂");
	});

	test("narrows @ files immediately, handles quoted paths and lists bare relative files only on Tab", async () => {
		using dir = TempDir.createSync("omp-composer-files-");
		await Promise.all(
			["alpha.txt", "beta.txt", "two words.txt"].map(name => Bun.write(path.join(dir.path(), name), "")),
		);
		const composer = new Composer({ autocomplete: new PromptActionAutocompleteProvider([], dir.path(), []) });
		type(composer, "read @");
		await offered(composer, "@beta.txt");
		type(composer, "alp");
		expect(offers(composer.node, "@alpha.txt")).toBe(true);
		expect(offers(composer.node, "@beta.txt")).toBe(false);
		composer.clearDraft({ recall: false });
		sendPaste(composer.node, composer.field, 'path=@"two w');
		await offered(composer, '@"two words.txt"');
		composer.clearDraft({ recall: false });
		type(composer, "use ./alp");
		await offered(composer, "./alpha.txt");
		composer.clearDraft({ recall: false });
		type(composer, "use bet");
		await settle();
		expect(composer.completing()).toBe(false);
		type(composer, "\t");
		await offered(composer, "beta.txt");
	});

	test("refreshes model mentions when discovery supplies the first match and narrows effort rows synchronously", async () => {
		const model = getTestModel("anthropic", candidate => getSupportedEfforts(candidate).length > 0);
		const selector = `${model.provider}/${model.id}`;
		const discovery = Promise.withResolvers<void>();
		let discovered = false;
		const candidates = createModelMentionSource({
			source: createModelBrowserSource(Settings.isolated()),
			registry: {
				getAll: () => [model],
				getAvailable: () => (discovered ? [model] : []),
				getError: () => undefined,
				retryUnavailableDiscovery: () => (discovered ? undefined : discovery.promise),
			},
			scopedModels: () => [],
		});
		const provider = new PromptActionAutocompleteProvider([], process.cwd(), [], undefined, undefined, candidates);
		const composer = new Composer({ autocomplete: provider });
		type(composer, "compare ^");
		expect(composer.completing()).toBe(false);
		discovered = true;
		discovery.resolve();
		await offered(composer, selector);
		const effort = getSupportedEfforts(model)[0]!;
		type(composer, `${selector}:${effort}`);
		expect(offers(composer.node, `${selector}:${effort}`)).toBe(true);
		type(composer, " ");
		expect(composer.completing()).toBe(false);
	});

	test("coalesces consecutive edits, publishes partial proposals and discards retired results", async () => {
		const provider = new PromptActionAutocompleteProvider([], process.cwd(), []);
		const queries: string[] = [];
		const release = Promise.withResolvers<void>();
		const composer = new Composer({
			autocomplete: {
				async getSuggestions(lines, line, col, signal, onPartial) {
					const query = lines[line]!.slice(0, col);
					queries.push(query);
					const result = await provider.getSuggestions(lines, line, col, signal);
					if (query !== ":jo" || !result) return result;
					onPartial?.({ ...result, items: result.items.slice(0, 1) });
					await release.promise;
					// An extension might not observe abort until its work finishes.
					onPartial?.(result);
					return result;
				},
				applyCompletion: provider.applyCompletion.bind(provider),
			},
		});
		type(composer, ":jo");
		const forJo = await provider.getSuggestions([":jo"], 0, 3);
		await offered(composer, forJo!.items[0]!.value);
		expect(queries).toEqual([":jo"]);
		type(composer, " ");
		release.resolve();
		await settle();
		expect(composer.completing()).toBe(false);
		expect(queries).toEqual([":jo"]);
	});

	test("does not resurrect pending argument rows after a caret move or clearing the draft", async () => {
		for (const leave of ["navigate", "clear"] as const) {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const args = buildArgumentCompletions([{ name: "list", description: "Available targets" }]);
			const provider = new PromptActionAutocompleteProvider(
				[
					{
						name: "switch",
						async getArgumentCompletions(prefix) {
							started.resolve();
							await release.promise;
							return args(prefix);
						},
					},
				],
				process.cwd(),
				[],
			);
			const composer = new Composer({ autocomplete: provider });
			type(composer, "/switch l");
			await started.promise;
			if (leave === "clear") composer.clearDraft({ recall: false });
			else sendKey(composer.node, composer.field, key("\x1b[D"));
			release.resolve();
			await settle();
			expect(composer.completing()).toBe(false);
		}
	});

	test("does not probe completion sources on empty text, finished tokens, or unrelated prose", () => {
		for (const before of [
			"",
			"plain",
			"two words",
			":",
			"note:joy",
			"x@y",
			"math^two",
			"x/y",
			"@one ",
			"#one two",
			"skill:",
			'said "hello there',
		]) {
			expect(inCompletionContext(before, [before], 0), before).toBe(false);
		}
	});
});
