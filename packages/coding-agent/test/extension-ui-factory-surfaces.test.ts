/**
 * What a `ctx.ui` factory is handed besides its theme — the TUI, the keybindings, the provider an
 * autocomplete factory wraps — is the host's own, and the host keeps using it after the session
 * that was handed it has gone. Each test lets an extension do what it can with what it was handed,
 * disposes or retires its session, and then drives the host the way the next session's user does.
 * The last group checks that a handed context reads every member the host can change when it is
 * asked for, not once when the context was made.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { types } from "node:util";
import { OmpErrors, type as schemaOf } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	copyHostData,
	HOST_DATA_DEPTH_LIMIT,
	handHostModel,
	handHostSchema,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/boundary-data";
import {
	handLocalProtocolOptions,
	handTUI,
	handUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/context-surfaces";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus, extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type AutocompleteProvider, type Component, Container, type OverlayFocusOwner, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { bindInputScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real session in interactive mode, with an extension runner whose `ctx.ui` the test holds. */
async function interactiveSession() {
	resetSettingsForTest();
	const dir = TempDir.createSync("@ui-factory-surfaces-");
	await Settings.init({ inMemory: true, cwd: dir.path() });
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("the bundled catalog has no claude-sonnet-4-5");
	const owner = new ExtensionRuntime();
	const sessionManager = SessionManager.inMemory(dir.path());
	const runner = new ExtensionRunner([], owner, dir.path(), sessionManager, registry);
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	const mode = new InteractiveMode(session, "test");
	// InteractiveMode implements the controller's hooks; its declared context also lists private wiring.
	const controller = new ExtensionUiController(mode as unknown as InteractiveModeContext);
	const hostUI: ExtensionUIContext = {
		...runner.getUIContext(),
		setWidget: controller.setHookWidget.bind(controller),
		setEditorComponent: mode.setEditorComponent.bind(mode),
		addAutocompleteProvider: mode.addAutocompleteProvider.bind(mode),
		custom: controller.showHookCustom.bind(controller),
	};
	const ui = runner.handedUIContext(hostUI);
	cleanups.push(async () => {
		mode.stop();
		await session.dispose();
		auth.close();
		dir.removeSync();
		resetSettingsForTest();
	});
	return { dir, owner, runner, session, mode, ui };
}

/** Three microtask turns: what an overlay dialog's mount takes after `custom()` returns. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 3; turn++) await Promise.resolve();
}

describe("what a ui factory is handed", () => {
	test("the TUI is the session's: a key listener it added hears nothing after the session is disposed", async () => {
		const h = await interactiveSession();
		const seen: string[] = [];
		let handedHost = true;
		let refused = "";
		h.ui.setWidget("listener", tui => {
			handedHost = tui === h.mode.ui;
			tui.addInputListener(key => {
				seen.push(key);
				return undefined;
			});
			try {
				tui.injectDebugInput("forged");
			} catch (error) {
				refused = String(error);
			}
			return { render: () => ["listening"], invalidate() {} };
		});
		await h.session.dispose();
		h.mode.ui.injectDebugInput("after-dispose");

		expect(seen).toEqual([]);
		expect(handedHost).toBe(false);
		expect(refused).toContain("injectDebugInput()");
	});

	test("the keybindings are a copy: an editor factory's change survives in neither the host nor its restored editor", async () => {
		const h = await interactiveSession();
		const refresh = spyOn(h.mode, "refreshSlashCommandState").mockResolvedValue();
		cleanups.push(() => refresh.mockRestore());
		const before = h.mode.keybindings.getKeys("tui.input.submit");
		let handedHost = true;
		h.ui.setEditorComponent((_tui, editorTheme, keybindings) => {
			handedHost = keybindings === h.mode.keybindings;
			keybindings.setUserBindings({ "tui.input.submit": "ctrl+g" });
			return new CustomEditor(editorTheme);
		});
		const whileInstalled = h.mode.keybindings.getKeys("tui.input.submit");
		await h.session.dispose();
		h.mode.ui.renderNow();

		expect(handedHost).toBe(false);
		expect(whileInstalled).toEqual(before);
		expect(h.mode.keybindings.getKeys("tui.input.submit")).toEqual(before);
	});

	test("the provider an autocomplete factory wraps is the session's: the host's fallback stays the host's", async () => {
		const h = await interactiveSession();
		const seen: string[] = [];
		const installed: AutocompleteProvider[] = [];
		const install = h.mode.editor.setAutocompleteProvider.bind(h.mode.editor);
		const spy = spyOn(h.mode.editor, "setAutocompleteProvider").mockImplementation(provider => {
			installed.push(provider);
			install(provider);
		});
		cleanups.push(() => spy.mockRestore());
		await h.mode.refreshSlashCommandState(h.dir.path());
		h.ui.addAutocompleteProvider(base => {
			base.getSuggestions = async lines => {
				seen.push(lines.join("\n"));
				return null;
			};
			return base;
		});
		const active = installed.at(-1);
		if (!active) throw new Error("no autocomplete provider was mounted");
		await h.session.dispose();
		await active.getSuggestions(["next-session-draft"], 0, 18);

		expect(seen).toEqual([]);
	});

	test("an async handleInput a key started is work its session owns until it ends, dispose included", async () => {
		const h = await interactiveSession();
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const pending = h.ui.custom<undefined>(
			() => ({
				render: () => ["async key"],
				invalidate() {},
				async handleInput() {
					started.resolve();
					await proceed.promise;
					finished.resolve();
				},
			}),
			{ overlay: true },
		);
		// The session's retirement closes the dialog as an aborted one: that is its answer here.
		const closed = pending.catch(() => undefined);
		await settle();
		h.mode.ui.injectDebugInput("x");
		await started.promise;
		const whileLive = h.runner.hasPendingHandlerWork();
		// Dispose returns within its window; what is still running is the session's to wait for,
		// and the account pools and the transcript are held until it ends.
		await h.session.dispose();
		const afterDispose = h.runner.hasPendingHandlerWork();
		proceed.resolve();
		await finished.promise;
		await h.runner.waitForPendingHandlerWork();
		await closed;

		expect({ whileLive, afterDispose, ended: h.runner.hasPendingHandlerWork() }).toEqual({
			whileLive: true,
			afterDispose: true,
			ended: false,
		});
	});

	test("a component the session focuses takes keys in its session, as owned work, and none once it has gone", async () => {
		const h = await interactiveSession();
		h.mode.ui.setFocus(h.mode.editor);
		const seen: Array<{ key: string; inside: boolean }> = [];
		const started = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const focusable: Component = {
			render: () => ["focusable"],
			invalidate() {},
			async handleInput(key: string) {
				seen.push({ key, inside: extensionCallbackScope.getStore() === h.owner });
				if (key !== "slow") return;
				started.resolve();
				await proceed.promise;
			},
		};
		h.ui.setWidget("focus", tui => {
			tui.setFocus(focusable);
			return { render: () => ["widget"], invalidate() {} };
		});
		const focusedLive = h.mode.ui.getFocused() === focusable;
		h.mode.ui.injectDebugInput("live");
		h.mode.ui.injectDebugInput("slow");
		await started.promise;
		const owned = h.runner.hasPendingHandlerWork();
		proceed.resolve();
		await h.runner.waitForPendingHandlerWork();
		await h.session.dispose();
		h.mode.ui.injectDebugInput("after-dispose");

		expect({ focusedLive, owned, seen, focusReturned: h.mode.ui.getFocused() === h.mode.editor }).toEqual({
			focusedLive: true,
			owned: true,
			seen: [
				{ key: "live", inside: true },
				{ key: "slow", inside: true },
			],
			focusReturned: true,
		});
	});

	test("giving focus up hands it back to what the session took it from, and to nothing else", async () => {
		const h = await interactiveSession();
		h.mode.ui.setFocus(h.mode.editor);
		const focusable: Component = { render: () => ["focusable"], invalidate() {}, handleInput() {} };
		let handedTUI: TUI | undefined;
		h.ui.setWidget("focus", tui => {
			handedTUI = tui;
			return { render: () => ["widget"], invalidate() {} };
		});
		if (!handedTUI) throw new Error("the widget factory did not run");
		// Focus the session did not take is not the session's to give up.
		handedTUI.setFocus(null);
		const kept = h.mode.ui.getFocused() === h.mode.editor;
		handedTUI.setFocus(focusable);
		handedTUI.setFocus(null);

		expect({ kept, returned: h.mode.ui.getFocused() === h.mode.editor }).toEqual({ kept: true, returned: true });
	});

	test("a session's prompt is read as a copy: editing it, before disposal or after, changes nothing", async () => {
		const h = await interactiveSession();
		await initializeExtensions(h.session, { reportSendError() {}, reportRuntimeError() {} });
		const prompt = h.runner.createContext().getSystemPrompt();
		const aliased = prompt === h.session.agent.state.systemPrompt;
		prompt.push("an extension's edit");
		const before = [...h.session.systemPrompt];
		await h.session.dispose();
		prompt.push("an edit after disposal");

		expect({ aliased, before, after: h.session.systemPrompt }).toEqual({
			aliased: false,
			before: ["Test"],
			after: ["Test"],
		});
	});
});

describe("data the host hands an extension", () => {
	test("a model held in classes is copied by every field its type declares, nested ones included", async () => {
		const h = await interactiveSession();
		const selected = h.session.model;
		if (!selected) throw new Error("the session has no model");
		const host: Model = selected;
		class RateCard {
			readonly #input = 2;
			get input() {
				return this.#input;
			}
			get output() {
				return 8;
			}
			get cacheRead() {
				return 0.2;
			}
			get cacheWrite() {
				return 2.5;
			}
		}
		class Identity {
			get class() {
				return host.identity.class;
			}
			get family() {
				return host.identity.family;
			}
			get revision() {
				return host.identity.revision;
			}
			get effort() {
				return host.identity.effort;
			}
			get thinkingVariant() {
				return host.identity.thinkingVariant;
			}
			get logicalId() {
				return host.identity.logicalId;
			}
		}
		// The type promises these shapes; an SDK caller may implement them with classes.
		const model = { ...host, cost: new RateCard(), identity: new Identity() } as unknown as Model;
		const ctx = h.runner.createContext(model);
		const handed = ctx.model;
		if (!handed) throw new Error("the context hands no model");

		expect(handed.cost).toEqual({ input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(handed.cost).not.toBeInstanceOf(RateCard);
		expect(handed.identity.class).toBe(host.identity.class);
		expect(typeof ctx.models.family(handed)).toBe("string");
	});

	test("a model's open fields held in classes arrive with what their getters answer", async () => {
		const h = await interactiveSession();
		const selected = h.session.model;
		if (!selected) throw new Error("the session has no model");
		const host: Model = selected;
		class Route {
			readonly #path = "/v1/route";
			get path() {
				return this.#path;
			}
			send(): string {
				return this.#path;
			}
		}
		class Metadata {
			readonly tier = "gold";
			get route() {
				return new Route();
			}
		}
		class Compat {
			get supportsStore() {
				return false;
			}
		}
		class Effort {
			get high() {
				return 4096;
			}
		}
		// The type leaves these fields open; an SDK caller may hold them in classes.
		const model = {
			...host,
			compat: new Compat(),
			requestMetadata: new Metadata(),
			headers: new (class {
				get "x-route"() {
					return "r";
				}
			})(),
			thinking: { ...host.thinking, effortBudgets: new Effort() },
		} as unknown as Model;
		const handed = h.runner.createContext(model).model;
		if (!handed) throw new Error("the context hands no model");
		const open: unknown = {
			compat: handed.compat,
			requestMetadata: handed.requestMetadata,
			headers: handed.headers,
			effortBudgets: handed.thinking?.effortBudgets,
		};

		expect(open).toEqual({
			compat: { supportsStore: false },
			requestMetadata: { tier: "gold", route: { path: "/v1/route" } },
			headers: { "x-route": "r" },
			effortBudgets: { high: 4096 },
		});
	});

	test("is copied as data: a URL as a URL, a class instance as its fields, and a function nowhere", () => {
		class Holder {
			readonly #secret = "host state";
			readonly name = "holder";
			readonly read = (): string => this.#secret;
			reveal(): string {
				return this.#secret;
			}
		}
		const holder = new Holder();
		const failure = Object.assign(new Error("host failure"), { retry: holder.read });
		const original = {
			url: new URL("https://example.invalid/path?q=1"),
			holder,
			record: { write: holder.read, kept: 1 },
			list: [holder.read, 2],
			map: new Map<string, unknown>([
				["write", holder.read],
				["kept", 3],
			]),
			set: new Set<unknown>([holder.read, 4]),
			failure,
		};
		const copy = copyHostData(original);

		expect(copy.url).toBeInstanceOf(URL);
		expect(copy.url).not.toBe(original.url);
		expect(copy.url.href).toBe("https://example.invalid/path?q=1");
		// Typed as what it was copied from; it holds only the data.
		const copied: unknown = { ...copy, url: undefined, failure: { ...copy.failure } };
		expect(copied).toEqual({
			url: undefined,
			holder: { name: "holder" },
			record: { kept: 1 },
			list: [undefined, 2],
			map: new Map([["kept", 3]]),
			set: new Set([4]),
			failure: {},
		});
		expect(Object.getPrototypeOf(copy.holder)).toBe(Object.prototype);
		expect(copy.failure).toBeInstanceOf(Error);
		expect(copy.failure.message).toBe("host failure");
		expect("retry" in copy.failure).toBe(false);
	});

	test("an error of a host class is copied onto the language's error class, its prototype's callables left behind", () => {
		class HostState {
			#value = "initial";
			readonly write = (value: string): void => {
				this.#value = value;
			};
			get value(): string {
				return this.#value;
			}
		}
		const state = new HostState();
		class HostFailure extends TypeError {
			get writer(): (value: string) => void {
				return state.write;
			}
			override get name(): string {
				return "HostFailure";
			}
		}
		const copy = copyHostData({ error: new HostFailure("host failed") }).error;
		const writer: unknown = Reflect.get(copy, "writer");
		if (typeof writer === "function") writer("changed");

		expect({
			prototype: Object.getPrototypeOf(copy) === TypeError.prototype,
			isTypeError: copy instanceof TypeError,
			name: copy.name,
			message: copy.message,
			writer: typeof writer,
			hostValue: state.value,
		}).toEqual({
			prototype: true,
			isTypeError: true,
			name: "HostFailure",
			message: "host failed",
			writer: "undefined",
			hostValue: "initial",
		});
	});

	test("an AbortError arrives as a branded DOMException copy, with its name, message and code", () => {
		const original = new DOMException("stopped", "AbortError");
		const copy = copyHostData({ error: original }).error;
		// The platform's accessor checks the brand; a copy built on the prototype alone fails it.
		const nameGetter = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;

		expect({
			distinct: copy !== original,
			isDOMException: copy instanceof DOMException,
			name: copy.name,
			message: copy.message,
			code: copy.code,
			branded: nameGetter?.call(copy),
		}).toEqual({
			distinct: true,
			isDOMException: true,
			name: "AbortError",
			message: "stopped",
			code: 20,
			branded: "AbortError",
		});
	});

	test("an error copy is a built-in error, so copying a copy gives the same error again", () => {
		class HostFailure extends TypeError {
			override get name(): string {
				return "HostFailure";
			}
		}
		const first = copyHostData(
			Object.assign(new HostFailure("validation failed", { cause: { why: "x" } }), { code: "E1" }),
		);
		const second = copyHostData(first);
		const read = (error: Error) => ({
			native: types.isNativeError(error),
			isTypeError: error instanceof TypeError,
			name: error.name,
			message: error.message,
			cause: error.cause,
			code: Reflect.get(error, "code"),
			cloned: structuredClone(error).message,
		});
		const aggregate = copyHostData(copyHostData(new AggregateError([new RangeError("inner")], "outer")));

		expect(read(second)).toEqual(read(first));
		expect(read(second)).toEqual({
			native: true,
			isTypeError: true,
			name: "HostFailure",
			message: "validation failed",
			cause: { why: "x" },
			code: "E1",
			cloned: "validation failed",
		});
		expect({
			isAggregate: aggregate instanceof AggregateError,
			inner: aggregate.errors[0] instanceof RangeError,
			innerMessage: (aggregate.errors[0] as Error).message,
		}).toEqual({ isAggregate: true, inner: true, innerMessage: "inner" });
	});

	test("a model's open fields keep their own accessors, enumerable or not, and a throwing one throws", async () => {
		const h = await interactiveSession();
		const selected = h.session.model;
		if (!selected) throw new Error("the session has no model");
		const host: Model = selected;
		const plain = { ...host.compat };
		Object.defineProperty(plain, "supportsServerCompaction", { get: () => true, enumerable: false });
		class Compat {}
		const classBacked = new Compat();
		Object.defineProperty(classBacked, "supportsServerCompaction", { get: () => true, enumerable: false });
		const read = (compat: object): unknown =>
			Reflect.get(
				h.runner.createContext({ ...host, compat } as unknown as Model).model?.compat ?? {},
				"supportsServerCompaction",
			);
		const throwing = {};
		Object.defineProperty(throwing, "firstPartyProvider", {
			get: () => {
				throw new Error("host compat getter failed");
			},
			enumerable: false,
		});
		let thrown = "";
		try {
			read(throwing);
		} catch (error) {
			thrown = String(error);
		}

		expect({ plain: read(plain), classBacked: read(classBacked), thrown }).toEqual({
			plain: true,
			classBacked: true,
			thrown: "Error: host compat getter failed",
		});
	});

	test("data nested past the bound is refused with a depth error, never handed over shortened", () => {
		interface Link {
			next?: Link;
			leaf?: string;
		}
		const chain = (links: number): Link => {
			let node: Link = { leaf: "needed-leaf" };
			for (let index = 0; index < links; index++) node = { next: node };
			return node;
		};
		const leafOf = (value: Link | undefined): string | undefined => {
			let at = value;
			while (at?.next !== undefined) at = at.next;
			return at?.leaf;
		};
		const refusal = (copy: () => unknown): string => {
			try {
				copy();
				return "copied";
			} catch (error) {
				return error instanceof RangeError ? error.message : `threw ${String(error)}`;
			}
		};
		class Node {
			get child(): Node {
				return new Node();
			}
		}
		const freshEachRead = (): Record<string, unknown> => ({
			get next() {
				return freshEachRead();
			},
		});
		const expected = `Host data handed to an extension nests deeper than ${HOST_DATA_DEPTH_LIMIT} levels; it is not handed over in part`;

		// Within the bound the copy is whole; past it nothing is handed over.
		expect(leafOf(copyHostData(chain(HOST_DATA_DEPTH_LIMIT - 1)))).toBe("needed-leaf");
		expect({
			deepJson: refusal(() => copyHostData(JSON.parse(JSON.stringify(chain(600))))),
			freshEachRead: refusal(() => copyHostData({ root: freshEachRead() })),
			modelOpenField: refusal(() =>
				handHostModel({ id: "m", requestMetadata: { tree: chain(600) } } as unknown as Model),
			),
			modelGetter: refusal(() => handHostModel({ id: "m", kindConfig: new Node() } as unknown as Model)),
			schema: refusal(() => (handHostSchema(schemaOf("unknown")) as (data: unknown) => unknown)(chain(600))),
		}).toEqual({
			deepJson: expected,
			freshEachRead: expected,
			modelOpenField: expected,
			modelGetter: expected,
			schema: expected,
		});
	});

	test("a host schema's JSON Schema fallback is handed copies, and an exception it throws is a copy", () => {
		const defaults = { value: "original" };
		const inner = schemaOf({ config: schemaOf({ value: "string" }).default(() => defaults) }).pipe(data => data);
		const schema = schemaOf({ nested: inner });
		const handed = handHostSchema(schema) as typeof schema;
		let kept: unknown;
		let called = 0;
		handed.toJsonSchema({
			fallback(context) {
				called++;
				kept = Reflect.get(Reflect.get(Reflect.get(context.base, "properties") ?? {}, "config") ?? {}, "default");
				return context.base;
			},
		});
		if (typeof kept === "object" && kept !== null) Reflect.set(kept, "value", "changed by the extension");

		let hostState = "initial";
		const failure = Object.assign(new Error("host schema failed"), {
			retry: () => {
				hostState = "changed by the extension";
			},
		});
		const throwing = handHostSchema(
			Object.assign(
				() => {
					throw failure;
				},
				{
					assert: () => {
						throw failure;
					},
					toJsonSchema: () => {
						throw failure;
					},
				},
			),
		) as unknown as typeof schema;
		const thrown = [() => throwing({}), () => throwing.assert({}), () => throwing.toJsonSchema()].map(call => {
			try {
				call();
				return undefined;
			} catch (error) {
				return error;
			}
		});
		for (const error of thrown) {
			const retry: unknown = error instanceof Error ? Reflect.get(error, "retry") : undefined;
			if (typeof retry === "function") retry();
		}

		expect({ called: called > 0, validated: schema.assert({ nested: {} }) }).toEqual({
			called: true,
			validated: { nested: { config: { value: "original" } } },
		});
		expect(
			thrown.map(error => ({
				isError: error instanceof Error,
				isHostObject: error === failure,
				message: error instanceof Error ? error.message : undefined,
			})),
		).toEqual(Array(3).fill({ isError: true, isHostObject: false, message: "host schema failed" }));
		expect(hostState).toBe("initial");
	});

	test("a host schema's failure reads as the host's does, alternatives included", () => {
		const schema = schemaOf({ a: "string" }).or({ b: "number" });
		const handed = handHostSchema(schema) as typeof schema;
		const messageOf = (call: () => unknown): string => {
			try {
				call();
				return "accepted";
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		};
		const input = { a: 1, b: "x" };
		const host = schema(input);
		const copy = handed(input);

		expect({
			summary: copy instanceof OmpErrors ? copy.summary : "not a failure",
			assert: messageOf(() => handed.assert(input)),
		}).toEqual({
			summary: host instanceof OmpErrors ? host.summary : "host accepted",
			assert: messageOf(() => schema.assert(input)),
		});
	});

	test("a host tool's details reach a hook without the callables they held", async () => {
		class HostState {
			#value = "initial";
			readonly write = (value: string): void => {
				this.#value = value;
			};
			get value(): string {
				return this.#value;
			}
		}
		const host = new HostState();
		const owner = new ExtensionRuntime();
		const release = owner.beginSession();
		cleanups.push(release);
		let details: unknown;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("tool_result", event => {
					details = event.details;
				});
			},
			process.cwd(),
			new EventBus(),
			owner,
			"details-callable",
		);
		const runner = new ExtensionRunner(
			[extension],
			owner,
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		await runner.emitToolResult({
			type: "tool_result",
			toolName: "host_tool",
			toolCallId: "details",
			input: {},
			content: [{ type: "text", text: "ok" }],
			details: { write: host.write, status: "done" },
			isError: false,
		});

		expect(details).toEqual({ status: "done" });
		expect(host.value).toBe("initial");
	});

	test("the callables a surface declares are handed on purpose: a tool's callable schema, a renderer's requestRender", async () => {
		const owner = new ExtensionRuntime();
		const release = owner.beginSession();
		let readTools: (() => ReturnType<ExtensionAPI["getAllTools"]>) | undefined;
		let requestRender: (() => void) | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				readTools = () => pi.getAllTools();
				pi.registerAssistantThinkingRenderer(context => {
					requestRender = context.requestRender;
					context.requestRender();
					return undefined;
				});
			},
			process.cwd(),
			new EventBus(),
			owner,
			"declared-callables",
		);
		const runner = new ExtensionRunner(
			[extension],
			owner,
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		// The host's own callable schema, as a built-in tool keeps it.
		const schema = schemaOf({ value: "string" });
		const hostWire = JSON.stringify(schema.toJsonSchema());
		// A host may keep a tool's row in a class; the schema is read from the field that declares it.
		class ToolRow {
			readonly name = "host_tool";
			readonly description = "a host tool";
			readonly parameters = schema;
			readonly sourceInfo = { path: "<builtin:host_tool>", source: "builtin", scope: "temporary" };
		}
		const [host, context] = actions(() => undefined);
		const withTools = { ...host, getAllTools: () => [new ToolRow()] } as unknown as ExtensionActions;
		runner.initialize(withTools, context, undefined, { ...runner.getUIContext() }, "rpc");
		const tools = readTools?.() ?? [];
		// The schema's declared type is the host's builder type; the test reads what was handed.
		const handed = tools[0]?.parameters as unknown as typeof schema;
		const poisoned = Reflect.set(handed, "toJsonSchema", () => ({ type: "poisoned" }));
		let renders = 0;
		const renderer = runner.getAssistantThinkingRenderers()[0];
		if (!renderer) throw new Error("the thinking renderer was not registered");
		renderer({ contentIndex: 0, thinkingIndex: 0, text: "thinking", requestRender: () => renders++ }, theme);
		const rendersLive = renders;
		release();
		requestRender?.();

		expect({
			isHostObject: (handed as unknown) === schema,
			frozen: Object.isFrozen(handed),
			poisoned,
			sameOnEveryRead: (readTools?.()[0]?.parameters as unknown) === handed,
			hostWireUnchanged: JSON.stringify(schema.toJsonSchema()) === hostWire,
			handedWire: JSON.stringify(handed.toJsonSchema()) === hostWire,
			validates: handed({ value: "ok" }),
			rejects: handed({ value: 1 }) instanceof OmpErrors,
		}).toEqual({
			isHostObject: false,
			frozen: true,
			poisoned: false,
			sameOnEveryRead: true,
			hostWireUnchanged: true,
			handedWire: true,
			validates: { value: "ok" },
			rejects: true,
		});
		expect({ rendersLive, rendersAfter: renders }).toEqual({ rendersLive: 1, rendersAfter: 1 });
	});
});

/** A host with a real TUI and the extension controller, the session's `ctx.ui`, and its release. */
async function controllerHost() {
	const owner = new ExtensionRuntime();
	const release = owner.beginSession();
	// Only the UI surfaces are exercised; nothing here reaches the registry.
	const registry = {} as ModelRegistry;
	const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), registry);
	const tui = new TUI(new VirtualTerminal(80, 24));
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	tui.addChild(editorContainer);
	tui.setFocus(editor);
	// The controller reads only these members of its context.
	const context = {
		ui: tui,
		editor,
		editorContainer,
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		statusRowOccupied: false,
		session: { extensionRunner: runner },
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(context);
	const ui = handUIContext(
		{ ...runner.getUIContext(), custom: controller.showHookCustom.bind(controller) },
		owner,
		runner.rendererScope,
	);
	const inside = (): boolean => extensionCallbackScope.getStore() === owner;
	cleanups.push(() => {
		release();
		tui.stop();
	});
	return { owner, release, runner, tui, editor, ui, inside };
}

/** A TUI with a host component focused, and sessions whose handed TUIs the test drives. */
function focusHost() {
	const tui = new TUI(new VirtualTerminal(80, 24));
	const seen: Array<{ name: string; key: string }> = [];
	const drawn: string[] = [];
	const named = (name: string, extra: Partial<Component & OverlayFocusOwner> = {}): Component & { name: string } => ({
		name,
		render: () => {
			drawn.push(name);
			return [name];
		},
		invalidate() {},
		handleInput(key: string) {
			seen.push({ name, key });
		},
		...extra,
	});
	const host = named("host");
	tui.setFocus(host);
	const releases: Array<() => void> = [];
	const session = () => {
		const owner = new ExtensionRuntime();
		const release = owner.beginSession();
		releases.push(release);
		// Only the TUI surface is exercised; nothing here reaches the registry.
		const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), {} as ModelRegistry);
		/** The next session on the same runtime and runner, as a host reusing them starts it. */
		const next = (): void => {
			releases.push(owner.beginSession());
		};
		return { release, next, tui: handTUI(tui, owner, runner.rendererScope) };
	};
	const focus = (): string | null => {
		const focused = tui.getFocused();
		return focused !== null && "name" in focused ? String(focused.name) : null;
	};
	cleanups.push(() => {
		for (const release of releases) release();
		tui.stop();
	});
	return { tui, seen, drawn, named, host, session, focus };
}

describe("what a session focuses or shows", () => {
	test("a component it focused and then showed comes down with it, and is never drawn again", () => {
		const h = focusHost();
		const a = h.session();
		const reused = h.named("reused");
		a.tui.setFocus(reused);
		a.tui.setFocus(null);
		a.tui.showOverlay(reused);
		h.tui.renderNow();
		const drawnLive = h.drawn.includes("reused");
		a.release();
		h.drawn.length = 0;
		h.tui.renderNow();
		h.tui.injectDebugInput("next");

		expect({
			drawnLive,
			overlays: h.tui.overlayStack.length,
			drawn: h.drawn.includes("reused"),
			focus: h.focus(),
		}).toEqual({ drawnLive: true, overlays: 0, drawn: false, focus: "host" });
		expect(h.seen).toEqual([{ name: "host", key: "next" }]);
	});

	test("nested overlays hand focus back to the host's component, not to the outer one gone with them", () => {
		const h = focusHost();
		const a = h.session();
		a.tui.showOverlay(h.named("outer"));
		a.tui.showOverlay(h.named("inner"));
		h.tui.injectDebugInput("live");
		a.release();
		h.tui.injectDebugInput("next");

		expect({ overlays: h.tui.overlayStack.length, focus: h.focus() }).toEqual({ overlays: 0, focus: "host" });
		expect(h.seen).toEqual([
			{ name: "inner", key: "live" },
			{ name: "host", key: "next" },
		]);
	});

	test("a child its overlay owns goes back to the host's component with the overlay", () => {
		const h = focusHost();
		const a = h.session();
		const child = h.named("child");
		a.tui.showOverlay(h.named("overlay", { ownsOverlayFocusTarget: (target: Component) => target === child }));
		h.tui.setFocus(child);
		a.release();
		h.tui.injectDebugInput("next");

		expect({ overlays: h.tui.overlayStack.length, focus: h.focus() }).toEqual({ overlays: 0, focus: "host" });
	});

	test("a component taken again goes back to what it was last taken from", () => {
		const h = focusHost();
		const a = h.session();
		const taken = h.named("taken");
		a.tui.setFocus(taken);
		a.tui.setFocus(null);
		h.tui.setFocus(h.named("new-host"));
		a.tui.setFocus(taken);
		a.release();
		h.tui.injectDebugInput("next");

		expect(h.focus()).toBe("new-host");
		expect(h.seen).toEqual([{ name: "new-host", key: "next" }]);
	});

	test("giving focus up through a session that has gone reaches what replaced its component", () => {
		const h = focusHost();
		const a = h.session();
		const b = h.session();
		a.tui.setFocus(h.named("a"));
		b.tui.setFocus(h.named("b"));
		a.release();
		h.tui.injectDebugInput("b-live");
		b.tui.setFocus(null);
		h.tui.injectDebugInput("host-next");

		expect(h.focus()).toBe("host");
		expect(h.seen).toEqual([
			{ name: "b", key: "b-live" },
			{ name: "host", key: "host-next" },
		]);
	});

	test("a component it focused and showed with no release between comes down with it", () => {
		const h = focusHost();
		const a = h.session();
		const reused = h.named("reused");
		a.tui.setFocus(reused);
		a.tui.showOverlay(reused);
		a.release();
		h.drawn.length = 0;
		h.tui.renderNow();
		h.tui.injectDebugInput("next");

		expect({ overlays: h.tui.overlayStack.length, drawn: h.drawn.includes("reused"), focus: h.focus() }).toEqual({
			overlays: 0,
			drawn: false,
			focus: "host",
		});
		expect(h.seen).toEqual([{ name: "host", key: "next" }]);
	});

	test("a session that focused two of its components hands the keyboard back to the host's", () => {
		const h = focusHost();
		const a = h.session();
		a.tui.setFocus(h.named("first"));
		a.tui.setFocus(h.named("second"));
		a.release();
		h.tui.renderNow();
		const afterSweep = h.focus();
		h.tui.injectDebugInput("next");

		expect({ afterSweep, focus: h.focus() }).toEqual({ afterSweep: "host", focus: "host" });
		expect(h.seen).toEqual([{ name: "host", key: "next" }]);
	});

	test("a component a gone session left behind takes keys in the session that focuses it next", () => {
		const h = focusHost();
		const a = h.session();
		const b = h.session();
		const shared = h.named("shared");
		a.tui.setFocus(shared);
		a.release();
		h.tui.injectDebugInput("host-key");
		b.tui.setFocus(shared);
		h.tui.injectDebugInput("b-key");
		b.release();
		h.tui.injectDebugInput("host-again");

		expect(h.seen).toEqual([
			{ name: "host", key: "host-key" },
			{ name: "shared", key: "b-key" },
			{ name: "host", key: "host-again" },
		]);
	});

	test("a component a gone session left focused, taken by the next with no key or frame between, hands focus back", () => {
		const h = focusHost();
		const a = h.session();
		const b = h.session();
		const shared = h.named("shared");
		a.tui.setFocus(shared);
		a.release();
		b.tui.setFocus(shared);
		h.tui.injectDebugInput("b-key");
		b.release();
		h.tui.renderNow();
		const afterFrame = h.focus();
		h.tui.injectDebugInput("host-key");

		expect({ afterFrame, focus: h.focus() }).toEqual({ afterFrame: "host", focus: "host" });
		expect(h.seen).toEqual([
			{ name: "shared", key: "b-key" },
			{ name: "host", key: "host-key" },
		]);
	});

	test("an overlay one session shows comes down when the session that owns its component goes", () => {
		const h = focusHost();
		const owner = h.session();
		const shower = h.session();
		const dialog = h.named("dialog");
		owner.tui.setFocus(dialog);
		owner.tui.setFocus(null);
		shower.tui.showOverlay(dialog);
		h.tui.renderNow();
		const upWhileLive = h.tui.overlayStack.length;
		owner.release();
		h.drawn.length = 0;
		h.tui.renderNow();
		h.tui.injectDebugInput("next");

		expect({ upWhileLive, overlays: h.tui.overlayStack.length, drawn: h.drawn, focus: h.focus() }).toEqual({
			upWhileLive: 1,
			overlays: 0,
			drawn: [],
			focus: "host",
		});
		expect(h.seen).toEqual([{ name: "host", key: "next" }]);
	});

	test("an overlay a session left is not revived when its runtime starts the next session before a sweep", () => {
		const h = focusHost();
		const a = h.session();
		const previous = h.named("previous");
		a.tui.showOverlay(previous);
		a.release();
		// The runtime serves the next session before any key or frame has swept the last one.
		a.next();
		h.drawn.length = 0;
		h.tui.renderNow();
		h.tui.injectDebugInput("new-session-key");

		expect({
			overlays: h.tui.overlayStack.length,
			drewPrevious: h.drawn.includes("previous"),
			focus: h.focus(),
		}).toEqual({ overlays: 0, drewPrevious: false, focus: "host" });
		expect(h.seen).toEqual([{ name: "host", key: "new-session-key" }]);
	});

	test("the next session on a reused runtime shows its own overlay, and keeps it", () => {
		const h = focusHost();
		const a = h.session();
		a.tui.showOverlay(h.named("old"));
		a.release();
		a.next();
		a.tui.showOverlay(h.named("new"));
		h.tui.renderNow();
		h.tui.injectDebugInput("key");

		expect(h.tui.overlayStack.map(entry => ("name" in entry.component ? entry.component.name : null))).toEqual([
			"new",
		]);
		expect(h.seen).toEqual([{ name: "new", key: "key" }]);
	});
});

describe("what a session's ctx.ui writes, once the session has gone", () => {
	test("string members reach the host while it is live, and nothing once it has gone", () => {
		const owner = new ExtensionRuntime();
		const release = owner.beginSession();
		cleanups.push(release);
		// Only the UI surface is exercised; nothing here reaches the registry.
		const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), {} as ModelRegistry);
		const writes: string[] = [];
		const host: ExtensionUIContext = {
			...runner.getUIContext(),
			notify: message => void writes.push(`notify:${message}`),
			setStatus: (key, text) => void writes.push(`status:${key}=${text}`),
			setTitle: title => void writes.push(`title:${title}`),
			setWorkingMessage: message => void writes.push(`working:${message}`),
			setEditorText: text => void writes.push(`editor:${text}`),
			pasteToEditor: text => void writes.push(`paste:${text}`),
		};
		const ui = handUIContext(host, owner, runner.rendererScope);
		const writeAll = (label: string): string[] =>
			[
				() => ui.notify(label),
				() => ui.setStatus("key", label),
				() => ui.setTitle(label),
				() => ui.setWorkingMessage(label),
				() => ui.setEditorText(label),
				() => ui.pasteToEditor(label),
			].map(write => {
				try {
					write();
					return "written";
				} catch {
					return "refused";
				}
			});
		const live = writeAll("live");
		const liveWrites = writes.length;
		release();
		const gone = writeAll("PLANTED BY A DISPOSED SESSION");

		expect({ live, liveWrites, gone, goneWrites: writes.length - liveWrites }).toEqual({
			live: Array(6).fill("written"),
			liveWrites: 6,
			gone: Array(6).fill("refused"),
			goneWrites: 0,
		});
	});

	test("an editor factory is handed a copy of the editor theme, so its writes stay its own", async () => {
		const h = await interactiveSession();
		const refresh = spyOn(h.mode, "refreshSlashCommandState").mockResolvedValue();
		cleanups.push(() => refresh.mockRestore());
		const hostFrames = JSON.stringify(Reflect.get(getEditorTheme().symbols ?? {}, "spinnerFrames"));
		let handedHost = true;
		h.ui.setEditorComponent((_tui, editorTheme, _keybindings) => {
			handedHost = editorTheme === getEditorTheme();
			const frames: unknown = Reflect.get(editorTheme.symbols ?? {}, "spinnerFrames");
			if (Array.isArray(frames)) frames[0] = "PWNED";
			return new CustomEditor(editorTheme);
		});
		await h.session.dispose();
		// The host restores its own editor at the next frame; draw it while this test's settings live.
		h.mode.ui.renderNow();

		expect({
			handedHost,
			hostFrames: JSON.stringify(Reflect.get(getEditorTheme().symbols ?? {}, "spinnerFrames")),
		}).toEqual({ handedHost: false, hostFrames });
	});
});

describe("what a session mounted, when its runtime goes on to serve the next session", () => {
	test("a widget its controller mounted stays inert, and sends nothing, at a loopback endpoint", async () => {
		const h = await interactiveSession();
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(request.headers.get("authorization") ?? "");
				return new Response("ok");
			},
		});
		cleanups.push(() => server.stop(true));
		const sent: Promise<unknown>[] = [];
		let draws = 0;
		h.ui.setWidget("prior", () => ({
			render: () => {
				draws++;
				sent.push(fetch(`http://127.0.0.1:${server.port}/draw`, { headers: { authorization: "Bearer canary" } }));
				return ["prior widget"];
			},
			invalidate() {},
		}));
		h.mode.hookWidgetContainerAbove.render(80);
		await Promise.all(sent);
		const whileLive = { draws, requests: requests.length };
		await h.session.dispose();
		const next = new AgentSession({
			agent: new Agent({
				initialState: { model: h.session.model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(h.dir.path()),
			settings: Settings.isolated(),
			modelRegistry: h.session.modelRegistry,
			extensionRunner: h.runner,
		});
		cleanups.push(() => next.dispose());
		const lines = h.mode.hookWidgetContainerAbove.render(80);
		await Promise.all(sent);

		expect({
			whileLive,
			afterReuse: { draws: draws - whileLive.draws, requests: requests.length - whileLive.requests },
		}).toEqual({
			whileLive: { draws: 1, requests: 1 },
			afterReuse: { draws: 0, requests: 0 },
		});
		expect(lines.some(line => line.includes("prior widget"))).toBe(false);
	});

	test("an overlay shown before the first session began ends with that session, not with the runtime", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const seen: string[] = [];
		const host: Component = {
			render: () => ["host"],
			invalidate() {},
			handleInput: key => void seen.push(`host:${key}`),
		};
		tui.setFocus(host);
		const owner = new ExtensionRuntime();
		const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), {} as ModelRegistry);
		let draws = 0;
		handTUI(tui, owner, runner.rendererScope).showOverlay({
			render: () => {
				draws++;
				return ["before start"];
			},
			invalidate() {},
			handleInput: key => void seen.push(`before-start:${key}`),
		});
		const releaseFirst = owner.beginSession();
		releaseFirst();
		// The next session begins on the same runtime before any key or frame has swept the first.
		const releaseNext = owner.beginSession();
		cleanups.push(() => {
			releaseNext();
			tui.stop();
		});
		draws = 0;
		tui.renderNow();
		tui.injectDebugInput("next-session");

		expect({ overlays: tui.overlayStack.length, draws, seen }).toEqual({
			overlays: 0,
			draws: 0,
			seen: ["host:next-session"],
		});
	});
});

describe("an overlay holding another session's component, measured at a loopback endpoint", () => {
	test("once the component's session has gone, it draws nothing and sends nothing", async () => {
		const h = focusHost();
		const owner = h.session();
		const shower = h.session();
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(request.headers.get("authorization") ?? "");
				return new Response("ok");
			},
		});
		cleanups.push(() => server.stop(true));
		const sent: Promise<unknown>[] = [];
		const dialog = h.named("dialog", {
			render: () => {
				sent.push(fetch(`http://127.0.0.1:${server.port}/draw`, { headers: { authorization: "Bearer canary" } }));
				return ["dialog"];
			},
		});
		owner.tui.setFocus(dialog);
		owner.tui.setFocus(null);
		shower.tui.showOverlay(dialog);
		h.tui.renderNow();
		await Promise.all(sent);
		const whileLive = requests.length;
		owner.release();
		h.tui.renderNow();
		h.tui.injectDebugInput("x");
		h.tui.renderNow();
		await Promise.all(sent);

		expect({
			drewWhileLive: whileLive > 0,
			afterOwnerGone: requests.length - whileLive,
			stillUp: h.tui.overlayStack.length,
		}).toEqual({ drewWhileLive: true, afterOwnerGone: 0, stillUp: 0 });
	});
});

describe("a component a session shows, measured at a loopback endpoint", () => {
	test("focused and then shown through a real session, it sends nothing once dispose has returned", async () => {
		const h = await interactiveSession();
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(request.headers.get("authorization") ?? "");
				return new Response("ok");
			},
		});
		cleanups.push(() => server.stop(true));
		const reused: Component = {
			render: () => {
				void fetch(`http://127.0.0.1:${server.port}/draw`, { headers: { authorization: "Bearer canary" } });
				return ["reused"];
			},
			invalidate() {},
			handleInput() {},
		};
		h.ui.setWidget("reuse", tui => {
			tui.setFocus(reused);
			tui.showOverlay(reused);
			return { render: () => ["widget"], invalidate() {} };
		});
		h.mode.ui.renderNow();
		const upWhileLive = h.mode.ui.overlayStack.some(entry => entry.component === reused);
		await h.session.dispose();
		await Bun.sleep(20);
		const before = requests.length;
		h.mode.ui.renderNow();
		h.mode.ui.injectDebugInput("x");
		h.mode.ui.renderNow();
		await Bun.sleep(50);

		expect({
			upWhileLive,
			drewWhileLive: before > 0,
			requestsAfterDispose: requests.length - before,
			stillUp: h.mode.ui.overlayStack.some(entry => entry.component === reused),
		}).toEqual({ upWhileLive: true, drewWhileLive: true, requestsAfterDispose: 0, stillUp: false });
	});
});

describe("a key an extension's dialog takes", () => {
	test("is not handled by a dialog that closed itself while reserving it", async () => {
		const h = await controllerHost();
		const seen: string[] = [];
		let disposed = false;
		const pending = h.ui.custom<string>(
			(_tui, _theme, _keybindings, done) => ({
				render: () => ["dialog"],
				invalidate() {},
				dispose() {
					disposed = true;
				},
				capturesInput() {
					done("closed");
					return true;
				},
				handleInput(key: string) {
					seen.push(`${disposed}:${key}`);
				},
			}),
			{ overlay: true },
		);
		await settle();
		h.tui.injectDebugInput("x");

		expect(await pending).toBe("closed");
		expect(disposed).toBe(true);
		expect(seen).toEqual([]);
	});

	test("is not handled by a component whose session ended while it was reserving it", async () => {
		const h = await controllerHost();
		const seen: string[] = [];
		const child: Component = {
			render: () => ["child"],
			invalidate() {},
			capturesInput() {
				h.release();
				return true;
			},
			handleInput(key: string) {
				seen.push(`${h.owner.isRetired}:${key}`);
			},
		};
		bindInputScope(child, h.runner.rendererScope, () => {
			h.tui.setFocus(h.editor);
			return h.editor;
		});
		h.tui.setFocus(child);
		h.tui.injectDebugInput("x");

		expect(seen).toEqual([]);
	});

	test("reaches a focus target the dialog owns inside the dialog's session, and nothing once it has gone", async () => {
		const h = await controllerHost();
		const seen: Array<[string, boolean]> = [];
		const child: Component = {
			render: () => ["child"],
			invalidate() {},
			capturesInput() {
				seen.push(["capture", h.inside()]);
				return false;
			},
			handleInput(key: string) {
				seen.push([key, h.inside()]);
			},
		};
		const pending = h.ui.custom(
			() => ({
				render: () => ["parent"],
				invalidate() {},
				handleInput() {},
				ownsOverlayFocusTarget: (target: Component) => target === child,
			}),
			{ overlay: true },
		);
		await settle();
		h.tui.setFocus(child);
		h.tui.injectDebugInput("live-child");
		h.release();
		h.tui.injectDebugInput("retired-child");
		await pending.catch(() => undefined);

		expect(seen).toEqual([
			["capture", true],
			["live-child", true],
		]);
	});
});

/** The actions a runner is initialized with: only what these tests read is real. */
function actions(getModel: () => Model | undefined): [ExtensionActions, ExtensionContextActions] {
	// The runner stores these and calls only the members a test exercises.
	const host = {
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setLabel() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel() {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	} as unknown as ExtensionActions;
	const context = {
		getModel,
		isIdle: () => true,
		abort() {},
		hasPendingMessages: () => false,
		shutdown() {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	} as unknown as ExtensionContextActions;
	return [host, context];
}

describe("a handed context reads what the host can change when it is asked for", () => {
	test("a handler's ui offers a dialog the host enabled after the handler started", async () => {
		const owner = new ExtensionRuntime();
		cleanups.push(owner.beginSession());
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		let handlerUI: ExtensionUIContext | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", async (_event, ctx) => {
					handlerUI = ctx.ui;
					entered.resolve();
					await proceed.promise;
				});
			},
			process.cwd(),
			new EventBus(),
			owner,
			"late-dialog",
		);
		const runner = new ExtensionRunner(
			[extension],
			owner,
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		const ui: ExtensionUIContext = { ...runner.getUIContext() };
		const [host, context] = actions(() => undefined);
		runner.initialize(host, context, undefined, ui, "rpc");
		const dispatched = runner.emit({ type: "session_start" });
		await entered.promise;
		ui.askDialog = async () => ({ kind: "chat" }) as never;
		ui.approve = async () => "once";
		const seen = { askDialog: typeof handlerUI?.askDialog, approve: typeof handlerUI?.approve };
		proceed.resolve();
		await dispatched;

		expect(seen).toEqual({ askDialog: "function", approve: "function" });
	});

	test("`local://` options follow a host that replaces an answer", () => {
		const options = { getArtifactsDir: () => "/old-artifacts", getSessionId: () => "old-id" };
		const handed = handLocalProtocolOptions(options);
		options.getArtifactsDir = () => "/new-artifacts";
		options.getSessionId = () => "new-id";

		expect(handed.getArtifactsDir?.()).toBe("/new-artifacts");
		expect(handed.getSessionId?.()).toBe("new-id");
	});

	test("a saved context sees the ui, the mode and the model the host has now", async () => {
		const owner = new ExtensionRuntime();
		cleanups.push(owner.beginSession());
		const registry = new ModelRegistry(await AuthStorage.create(":memory:"));
		const [first, second] = registry.getAll();
		if (!first || !second) throw new Error("the bundled catalog has fewer than two models");
		let current: Model = first;
		const runner = new ExtensionRunner([], owner, process.cwd(), SessionManager.inMemory(), registry);
		const [host, context] = actions(() => current);
		const printUI: ExtensionUIContext = { ...runner.getUIContext() };
		runner.initialize(host, context, undefined, printUI, "rpc");
		const saved = runner.createContext();
		const command = runner.createCommandContext();
		const tuiUI: ExtensionUIContext = { ...runner.getUIContext(), notify() {} };
		runner.initialize(host, context, undefined, tuiUI, "tui");
		current = second;

		expect(saved.mode).toBe("tui");
		expect(saved.ui).toBe(runner.handedUIContext(tuiUI));
		expect(saved.model?.id).toBe(second.id);
		expect(command.model?.id).toBe(second.id);
	});
});
