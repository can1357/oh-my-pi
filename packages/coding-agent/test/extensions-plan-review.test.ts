import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionAPI,
	ExtensionError,
	ExtensionUIDialogOptions,
	PlanReviewEvent,
	PlanReviewEventResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const HANDLER_BUDGET_MS = 25;

describe("ExtensionRunner plan_review", () => {
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	let runtime: ExtensionRuntime;
	let sessionManager: SessionManager;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-plan-review-runner-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-review-runner-");
		runtime = new ExtensionRuntime();
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		vi.useRealTimers();
		tempDir.removeSync();
	});

	async function createRunner(...factories: Array<(pi: ExtensionAPI) => void>): Promise<ExtensionRunner> {
		const extensions: Extension[] = [];
		for (const [index, factory] of factories.entries()) {
			extensions.push(
				await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, `ext-${index}.ts`),
			);
		}
		return new ExtensionRunner(extensions, runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	function planEvent(signal: AbortSignal): PlanReviewEvent {
		return {
			type: "plan_review",
			planFilePath: "local://PLAN.md",
			resolvedPlanPath: path.join(tempDir.path(), "PLAN.md"),
			title: "PLAN",
			planContent: "# Plan\n\nbody",
			signal,
		};
	}

	it("stops at the first extension that decides", async () => {
		const consulted: string[] = [];
		const runner = await createRunner(
			pi =>
				pi.on("plan_review", () => {
					consulted.push("first");
					return { action: "dismiss" };
				}),
			pi =>
				pi.on("plan_review", () => {
					consulted.push("second");
					return { action: "approve" };
				}),
		);
		const started: string[] = [];

		const result = await runner.emitPlanReview(planEvent(new AbortController().signal), {
			onHandlerStart: extensionPath => started.push(path.basename(extensionPath)),
		});

		expect(result).toEqual({ action: "dismiss" });
		expect(consulted).toEqual(["first"]);
		// The waiting UI names the extension actually holding the decision, so it
		// must only be told about handlers that really run.
		expect(started).toEqual(["ext-0.ts"]);
	});

	it("passes an abstaining extension's turn to the next one", async () => {
		const runner = await createRunner(
			pi => pi.on("plan_review", () => undefined),
			pi => pi.on("plan_review", () => ({ action: "refine", feedback: "tighten step 3" })),
		);

		const result = await runner.emitPlanReview(planEvent(new AbortController().signal));

		expect(result).toEqual({ action: "refine", feedback: "tighten step 3" });
	});

	it("reports an invalid decision once and reports no decision to the host", async () => {
		const runner = await createRunner(pi =>
			pi.on("plan_review", () => ({ action: "approve", context: "half" }) as unknown as PlanReviewEventResult),
		);
		const errors: ExtensionError[] = [];
		runner.onError(error => errors.push(error));

		const result = await runner.emitPlanReview(planEvent(new AbortController().signal));

		expect(result).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.event).toBe("plan_review");
		expect(errors[0]?.extensionPath).toContain("ext-0.ts");
	});

	it("never expires a review, however long the reviewer takes", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<PlanReviewEventResult>();
		const runner = await createRunner(pi =>
			pi.on("plan_review", async () => {
				entered.resolve();
				return await release.promise;
			}),
		);
		testSetExtensionHandlerTimeoutMs(HANDLER_BUDGET_MS);
		vi.useFakeTimers();

		const pending = runner.emitPlanReview(planEvent(new AbortController().signal));
		await entered.promise;
		// Ten minutes of scheduler time: any armed budget would have fired long ago.
		vi.advanceTimersByTime(600_000);
		for (let flush = 0; flush < 5; flush++) await Promise.resolve();
		release.resolve({ action: "approve", context: "compact" });

		expect(await pending).toEqual({ action: "approve", context: "compact" });
	});

	it("keeps a reviewer's own dialog open until the host cancels it", async () => {
		// A handler that parks on `ctx.ui` must not be killed by a budget either,
		// and the host's cancellation has to reach the open dialog.
		const entered = Promise.withResolvers<void>();
		let dialogSignal: AbortSignal | undefined;
		let selectResult: string | undefined = "unset";
		const runner = await createRunner(pi =>
			pi.on("plan_review", async (_event, ctx) => {
				entered.resolve();
				selectResult = await ctx.ui.select("Approve?", ["yes", "no"]);
				return undefined;
			}),
		);
		const select = async (
			_title: string,
			_options: string[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> => {
			dialogSignal = dialogOptions?.signal;
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			return await promise;
		};
		// Only `ctx.ui.select` is exercised here; the action surfaces stay
		// unimplemented so an accidental dependency on them fails loudly.
		runner.initialize({} as never, {} as never, undefined, { select } as never);
		testSetExtensionHandlerTimeoutMs(HANDLER_BUDGET_MS);
		vi.useFakeTimers();
		const controller = new AbortController();

		const pending = runner.emitPlanReview(planEvent(controller.signal), { signal: controller.signal });
		await entered.promise;
		vi.advanceTimersByTime(600_000);
		for (let flush = 0; flush < 5; flush++) await Promise.resolve();
		expect(dialogSignal?.aborted).toBe(false);
		expect(selectResult).toBe("unset");

		controller.abort("esc");

		expect(await pending).toBeUndefined();
		expect(dialogSignal?.aborted).toBe(true);
	});

	it("abandons a pending review when the host cancels it", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<PlanReviewEventResult>();
		let handlerSawSignal: AbortSignal | undefined;
		const runner = await createRunner(pi =>
			pi.on("plan_review", async event => {
				handlerSawSignal = event.signal;
				entered.resolve();
				return await release.promise;
			}),
		);
		const controller = new AbortController();

		const pending = runner.emitPlanReview(planEvent(controller.signal), { signal: controller.signal });
		await entered.promise;
		controller.abort("esc");
		// A decision that lands after cancellation must not become the result.
		release.resolve({ action: "approve" });

		expect(await pending).toBeUndefined();
		expect(handlerSawSignal?.aborted).toBe(true);
	});
});
