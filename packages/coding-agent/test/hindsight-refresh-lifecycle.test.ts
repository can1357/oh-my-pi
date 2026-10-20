import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getKeybindings } from "../../tui/src/keybindings";
import { BorderedLoader } from "../../tui/src/overlays/bordered-loader";
import { getThemeByName, setThemeInstance } from "../../tui/src/theme";
import { Settings } from "../src/config/settings";
import {
	HindsightApi,
	type HindsightApiOptions,
	type HindsightOperationStatus,
	type MentalModelSummary,
	type MentalModelTrigger,
} from "../src/hindsight/client";
import { loadHindsightConfig } from "../src/hindsight/config";
import { mentalModelRefreshState, summarizeMentalModel } from "../src/hindsight/mental-models";
import { HindsightSessionState } from "../src/hindsight/state";
import { CommandController } from "../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../src/modes/types";

const BANK = "bank";
const OLD = "old guidance";
const REFRESHED = "refreshed guidance";
const CRON: MentalModelTrigger = {
	mode: "full",
	refresh_cron: "0 */4 * * *",
	exclude_mental_models: true,
	refresh_after_consolidation: false,
};

interface OperationStep {
	status: HindsightOperationStatus;
	error_message?: string;
}

const PENDING: OperationStep = { status: "pending" };
const PROCESSING: OperationStep = { status: "processing" };
const COMPLETED: OperationStep = { status: "completed" };

function model(id: string, overrides: Partial<MentalModelSummary> = {}): MentalModelSummary {
	return {
		id,
		bank_id: BANK,
		name: id,
		content: `${id} guidance`,
		last_refreshed_at: "2026-10-10T00:00:00Z",
		last_memory_seen_at: "2026-10-10T00:00:00Z",
		last_refresh_failed_at: null,
		is_stale: false,
		...overrides,
	};
}

/** The list endpoint omits config and content at `detail=metadata`; staleness fields are always present. */
function atDetail(item: MentalModelSummary, detail: string | null): MentalModelSummary {
	if (detail !== "metadata") return item;
	const metadata = { ...item };
	for (const field of ["trigger", "content", "source_query", "max_tokens"]) {
		delete metadata[field];
	}
	return metadata;
}

interface ServerOptions {
	models: MentalModelSummary[];
	operations?: Record<string, OperationStep[]>;
	omitOperationId?: boolean;
	onPoll?: () => void;
}

function serveHindsight(options: ServerOptions): string[] {
	const requests: string[] = [];
	const polls = new Map<string, number>();
	const prefix = `/v1/default/banks/${BANK}/`;
	const fetchMock = Object.assign(
		async (input: string | Request | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const route = `${init?.method ?? "GET"} ${url.pathname.slice(prefix.length)}`;
			requests.push(route);

			const refresh = /^POST mental-models\/(.+)\/refresh$/.exec(route);
			if (refresh) {
				return Response.json(options.omitOperationId ? {} : { operation_id: `op-${refresh[1]}` });
			}

			const operation = /^GET operations\/op-(.+)$/.exec(route);
			if (operation) {
				const id = operation[1];
				const script = options.operations?.[id] ?? [COMPLETED];
				const index = Math.min(polls.get(id) ?? 0, script.length - 1);
				polls.set(id, index + 1);
				const step = script[index];
				if (step.status === "completed") {
					Object.assign(options.models.find(candidate => candidate.id === id) ?? {}, {
						content: REFRESHED,
						is_stale: false,
						last_refresh_failed_at: null,
						last_memory_seen_at: "2026-10-11T00:00:00Z",
					});
				}
				options.onPoll?.();
				return Response.json({ operation_id: `op-${id}`, ...step });
			}

			if (route === "GET mental-models") {
				const detail = url.searchParams.get("detail");
				return Response.json({
					items: options.models.map(item => atDetail(item, detail)),
				});
			}
			return new Response("unexpected route", { status: 404 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return requests;
}

function listReads(requests: readonly string[]): number {
	return requests.filter(route => route === "GET mental-models").length;
}

interface Notice {
	level: string;
	message: string;
	source?: string;
}

const states: HindsightSessionState[] = [];

function messages(mock: { mock: { calls: unknown[][] } }): string[] {
	return mock.mock.calls.map(([message]) => String(message));
}

function harness(api: HindsightApi) {
	const notices: Notice[] = [];
	const session = {
		getHindsightSessionState: () => state,
		refreshBaseSystemPrompt: async () => {},
		emitNotice: (level: string, message: string, source?: string) => {
			notices.push({ level, message, source });
		},
		sessionManager: { getEntries: () => [] },
		subscribe: () => () => {},
	};
	const state = new HindsightSessionState({
		sessionId: "refresh-lifecycle",
		client: api,
		bankId: BANK,
		config: {
			...loadHindsightConfig(Settings.isolated()),
			mentalModelsEnabled: true,
			mentalModelAutoSeed: false,
		},
		session: session as never,
		banksSet: new Set([BANK]),
	});
	states.push(state);

	const editor = { name: "editor" };
	const editorContainer = {
		children: [editor] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const ui = {
		setFocus: vi.fn(),
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
	};
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showError = vi.fn();
	const ctx = {
		settings: Settings.isolated({ "memory.backend": "hindsight" }),
		session,
		editor,
		editorContainer,
		ui,
		showStatus,
		showWarning,
		showError,
	} as unknown as InteractiveModeContext;
	return {
		state,
		notices,
		editor,
		editorContainer,
		ui,
		controller: new CommandController(ctx),
		statuses: () => messages(showStatus),
		warnings: () => messages(showWarning),
		errors: () => messages(showError),
	};
}

function client(options: Partial<HindsightApiOptions> = {}) {
	return new HindsightApi({
		baseUrl: "https://hindsight.invalid",
		operationPollIntervalMs: 1,
		...options,
	});
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const state of states.splice(0)) state.dispose();
});

describe("/memory mm refresh <id>", () => {
	it("reloads the cached guidance once, only after the operation completes", async () => {
		const failing = model("project-conventions", {
			content: OLD,
			is_stale: true,
			last_refresh_failed_at: "2026-10-01T00:00:00Z",
			trigger: CRON,
		});
		const requests = serveHindsight({
			models: [failing],
			operations: { "project-conventions": [PENDING, PROCESSING, COMPLETED] },
		});
		const h = harness(client());
		await h.state.reloadMentalModels();
		expect(h.state.mentalModelsSnippet).toContain(OLD);
		requests.length = 0;
		h.notices.length = 0;

		await h.controller.handleMemoryCommand("/memory mm refresh project-conventions");

		expect(requests).toEqual([
			"POST mental-models/project-conventions/refresh",
			"GET operations/op-project-conventions",
			"GET operations/op-project-conventions",
			"GET operations/op-project-conventions",
			"GET mental-models",
		]);
		expect(h.state.mentalModelsSnippet).toContain(REFRESHED);
		expect(h.state.mentalModelsSnippet).not.toContain(OLD);
		expect(h.notices).toEqual([]);
		expect(h.errors()).toEqual([]);
		expect(h.statuses().at(-1)).toContain("cache reloaded");
		expect(h.editorContainer.children).toEqual([h.editor]);
		expect(h.ui.setFocus).toHaveBeenLastCalledWith(h.editor);
	});

	for (const step of [
		{ status: "failed", error_message: "reflect wall timeout" },
		{ status: "cancelled" },
		{ status: "not_found" },
	] satisfies OperationStep[]) {
		it(`leaves the cached guidance alone when the operation ends ${step.status}`, async () => {
			const requests = serveHindsight({
				models: [model("project-conventions", { content: OLD })],
				operations: { "project-conventions": [PENDING, step] },
			});
			const h = harness(client());
			await h.state.reloadMentalModels();
			requests.length = 0;

			await h.controller.handleMemoryCommand("/memory mm refresh project-conventions");

			expect(listReads(requests)).toBe(0);
			expect(h.state.mentalModelsSnippet).toContain(OLD);
			expect(h.statuses()).toEqual([]);
			const [error] = h.errors();
			expect(error).toContain("not reloaded");
			expect(error).toContain(step.status);
			if (step.error_message) expect(error).toContain(step.error_message);
			expect(h.editorContainer.children).toEqual([h.editor]);
		});
	}

	it("reports a timeout and does not reload while the operation never finishes", async () => {
		const requests = serveHindsight({
			models: [model("project-conventions", { content: OLD })],
			operations: { "project-conventions": [PROCESSING] },
		});
		const h = harness(client({ timeouts: { reflect: 40 } }));
		await h.state.reloadMentalModels();
		requests.length = 0;

		await h.controller.handleMemoryCommand("/memory mm refresh project-conventions");

		expect(requests.at(0)).toBe("POST mental-models/project-conventions/refresh");
		expect(listReads(requests)).toBe(0);
		expect(h.state.mentalModelsSnippet).toContain(OLD);
		expect(h.errors().join("\n")).toMatch(/timed out/);
		expect(h.editorContainer.children).toEqual([h.editor]);
	});

	it("does not reload when the server returns no operation to wait on", async () => {
		const requests = serveHindsight({
			models: [model("project-conventions", { content: OLD })],
			omitOperationId: true,
		});
		const h = harness(client());
		await h.state.reloadMentalModels();
		requests.length = 0;

		await h.controller.handleMemoryCommand("/memory mm refresh project-conventions");

		expect(requests).toEqual(["POST mental-models/project-conventions/refresh"]);
		expect(h.errors().join("\n")).toContain("no operation ID");
		expect(h.state.mentalModelsSnippet).toContain(OLD);
	});

	it("cancels from the loader, interrupting the poll wait, without reloading", async () => {
		const polled = Promise.withResolvers<void>();
		const requests = serveHindsight({
			models: [model("project-conventions", { content: OLD })],
			operations: { "project-conventions": [PROCESSING] },
			onPoll: () => polled.resolve(),
		});
		const h = harness(
			client({
				operationPollIntervalMs: 60_000,
				timeouts: { reflect: 120_000 },
			}),
		);
		await h.state.reloadMentalModels();
		requests.length = 0;

		const command = h.controller.handleMemoryCommand("/memory mm refresh project-conventions");
		await polled.promise;
		const loader = h.editorContainer.children[0];
		expect(loader).toBeInstanceOf(BorderedLoader);
		vi.spyOn(getKeybindings(), "matches").mockReturnValue(true);
		(loader as BorderedLoader).handleInput("\u001b");
		await command;

		expect(listReads(requests)).toBe(0);
		expect(h.state.mentalModelsSnippet).toContain(OLD);
		expect(h.statuses().join("\n")).toContain("cancelled");
		expect(h.statuses().join("\n")).not.toContain("cache reloaded");
		expect(h.errors()).toEqual([]);
		expect(h.editorContainer.children).toEqual([h.editor]);
	});
});

describe("/memory mm refresh (bank-wide)", () => {
	const catalog = () => [
		model("consolidated", {
			content: OLD,
			trigger: { refresh_after_consolidation: true },
		}),
		model("cron", { content: OLD, trigger: CRON }),
		model("manual", {
			content: OLD,
			trigger: { refresh_after_consolidation: false },
		}),
		model("operator-written", { content: OLD }),
		model("blank-cron", { content: OLD, trigger: { refresh_cron: "" } }),
	];

	it("refreshes cron and consolidation managed models and leaves manual-only ones alone", async () => {
		const requests = serveHindsight({
			models: catalog(),
			operations: {
				consolidated: [PENDING, COMPLETED],
				cron: [PROCESSING, COMPLETED],
			},
		});
		const h = harness(client());

		await h.controller.handleMemoryCommand("/memory mm refresh");

		expect(requests.filter(route => route.startsWith("POST ")).sort()).toEqual([
			"POST mental-models/consolidated/refresh",
			"POST mental-models/cron/refresh",
		]);
		expect(requests.at(0)).toBe("GET mental-models");
		const lastPoll = requests.findLastIndex(route => route.startsWith("GET operations/"));
		expect(requests.indexOf("GET mental-models", 1)).toBeGreaterThan(lastPoll);
		expect(listReads(requests)).toBe(2);
		expect(h.state.mentalModelsSnippet).toContain(REFRESHED);
		expect(h.state.mentalModelsSnippet).toContain("# manual");
		expect(h.statuses().at(-1)).toContain("Refreshed 2/2");
		expect(h.statuses().at(-1)).toContain("skipped 3 manual-only");
	});

	it("reloads once for the models that completed and warns about the one that failed", async () => {
		const requests = serveHindsight({
			models: catalog(),
			operations: {
				consolidated: [PENDING, { status: "failed", error_message: "no quota" }],
				cron: [PROCESSING, COMPLETED],
			},
		});
		const h = harness(client());

		await h.controller.handleMemoryCommand("/memory mm refresh");

		expect(listReads(requests)).toBe(2);
		expect(h.warnings().join("\n")).toContain("consolidated");
		expect(h.warnings().join("\n")).toContain("no quota");
		expect(h.statuses().at(-1)).toContain("Refreshed 1/2");
	});

	it("does not reload when every refresh fails", async () => {
		const requests = serveHindsight({
			models: catalog(),
			operations: {
				consolidated: [{ status: "failed", error_message: "no quota" }],
				cron: [{ status: "cancelled" }],
			},
		});
		const h = harness(client());

		await h.controller.handleMemoryCommand("/memory mm refresh");

		expect(listReads(requests)).toBe(1);
		expect(h.errors().join("\n")).toContain("not reloaded");
		expect(h.statuses()).toEqual([]);
	});

	it("refreshes nothing when every model is manual-only", async () => {
		const requests = serveHindsight({
			models: [model("manual"), model("operator-written", { trigger: {} })],
		});
		const h = harness(client());

		await h.controller.handleMemoryCommand("/memory mm refresh");

		expect(requests).toEqual(["GET mental-models"]);
		expect(h.statuses().join("\n")).toContain("manual-only");
	});
});

describe("mental-model refresh state", () => {
	const inventory = () => [
		model("current"),
		model("behind", { is_stale: true }),
		model("failing", { last_refresh_failed_at: "2026-10-09T00:00:00Z" }),
		model("failing-and-behind", {
			is_stale: true,
			last_refresh_failed_at: "2026-10-09T00:00:00Z",
		}),
		model("placeholder", {
			content: "Generating content...",
			last_memory_seen_at: null,
		}),
	];

	it("classifies the metadata the server returns instead of presenting every model as fresh", async () => {
		serveHindsight({ models: inventory() });

		const { items } = await client().listMentalModels(BANK, {
			detail: "metadata",
		});
		const lines = new Map(items.map(item => [item.id, summarizeMentalModel(item)]));

		expect(Object.fromEntries(items.map(item => [item.id, mentalModelRefreshState(item)]))).toEqual({
			current: "fresh",
			behind: "stale",
			failing: "paused",
			"failing-and-behind": "paused",
			placeholder: "unsourced",
		});
		expect(lines.get("current")).toContain("(fresh;");
		expect(lines.get("behind")).toContain("(stale:");
		expect(lines.get("failing")).toContain("(paused:");
		expect(lines.get("failing")).toContain("2026-10-09T00:00:00Z");
		expect(lines.get("placeholder")).not.toContain("(fresh;");
		expect(lines.get("placeholder")).toContain("no source memories");
	});

	it("warns once per load about models that will not recover on their own", async () => {
		serveHindsight({
			models: [
				model("current"),
				model("scheduled-behind", { is_stale: true, trigger: CRON }),
				model("manual-behind", { is_stale: true }),
				model("failing", {
					last_refresh_failed_at: "2026-10-09T00:00:00Z",
					trigger: CRON,
				}),
			],
		});
		const h = harness(client());

		await h.state.reloadMentalModels();

		expect(h.notices).toHaveLength(1);
		const [notice] = h.notices;
		expect(notice.level).toBe("warning");
		expect(notice.source).toBe("Hindsight");
		expect(notice.message).toContain("failing");
		expect(notice.message).toContain("manual-behind");
		expect(notice.message).not.toContain("scheduled-behind");
		expect(notice.message).not.toContain("current");
	});

	it("stays quiet when every model is current or scheduled to refresh", async () => {
		serveHindsight({
			models: [model("current"), model("scheduled-behind", { is_stale: true, trigger: CRON })],
		});
		const h = harness(client());

		await h.state.reloadMentalModels();

		expect(h.notices).toEqual([]);
	});

	it("neither changes the prompt block nor drops operator-written models because of refresh status", async () => {
		const operatorWritten = model("operator-written", {
			content: "Operator guidance",
			last_memory_seen_at: null,
		});
		serveHindsight({ models: [model("current"), operatorWritten] });
		const healthy = harness(client());
		await healthy.state.reloadMentalModels();

		vi.restoreAllMocks();
		serveHindsight({
			models: [
				model("current", {
					is_stale: true,
					last_refresh_failed_at: "2026-10-09T00:00:00Z",
				}),
				operatorWritten,
			],
		});
		const degraded = harness(client());
		await degraded.state.reloadMentalModels();

		expect(degraded.state.mentalModelsSnippet).toBe(healthy.state.mentalModelsSnippet);
		expect(degraded.state.mentalModelsSnippet).toContain("Operator guidance");
		expect(degraded.notices).toHaveLength(1);
		expect(healthy.notices).toEqual([]);
	});
});
