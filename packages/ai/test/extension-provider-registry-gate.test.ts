import { afterEach, describe, expect, test } from "bun:test";
import { clearCustomApis, getCustomApi, registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import type { ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import {
	getOAuthCredentialProvider,
	getOAuthProviderEntry,
	getOAuthProviders,
	registerOAuthProvider,
	unregisterOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

interface TestGate extends ProviderCallGate {
	retired: boolean;
	readonly inside: boolean;
	readonly runs: number;
}

function makeGate(): TestGate {
	let depth = 0;
	let runs = 0;
	const gate: TestGate = {
		retired: false,
		run<R>(call: () => R): R {
			if (gate.retired) throw new Error("gate retired");
			runs++;
			depth++;
			try {
				return call();
			} finally {
				depth--;
			}
		},
		get inside() {
			return depth > 0;
		},
		get runs() {
			return runs;
		},
	};
	return gate;
}

const SOURCE = "registry-gate-scratch";
/** A genuine stream: a session's registration refuses, at production, one that reports no completion. */
const stream = () => new AssistantMessageEventStream();

afterEach(() => {
	clearCustomApis();
	unregisterOAuthProviders(SOURCE);
	unregisterOAuthProviders("other-source");
});

describe("custom API registry", () => {
	test("host registration returns the same record and the registered functions unchanged", () => {
		const simple = stream;
		const full = () => stream();
		registerCustomApi("scratch-host", simple, SOURCE, full);
		const first = getCustomApi("scratch-host");
		expect(first).toBe(getCustomApi("scratch-host"));
		expect(first?.streamSimple).toBe(simple);
		expect(first?.stream).toBe(full);
		expect(first?.sourceId).toBe(SOURCE);
		// Host re-registration still replaces.
		const other = () => stream();
		registerCustomApi("scratch-host", other, "other-source");
		expect(getCustomApi("scratch-host")?.streamSimple).toBe(other);
		unregisterCustomApis(SOURCE);
		expect(getCustomApi("scratch-host")?.streamSimple).toBe(other);
		unregisterCustomApis("other-source");
		expect(getCustomApi("scratch-host")).toBeUndefined();
	});

	test("host receiver is the returned record", () => {
		let receiver: unknown;
		registerCustomApi("scratch-receiver", function (this: unknown) {
			receiver = this;
			return stream();
		});
		const record = getCustomApi("scratch-receiver");
		record?.streamSimple({} as never, {} as never);
		expect(receiver).toBe(record);
	});

	test("a retired child's registration stops being selected and the parent's answers", () => {
		const parent = makeGate();
		const child = makeGate();
		const calls: string[] = [];
		const childReceivers: unknown[] = [];
		const parentFn = () => {
			calls.push(`parent:${parent.inside}`);
			return stream();
		};
		const childFn = function (this: unknown) {
			childReceivers.push(this);
			calls.push(`child:${child.inside}`);
			return stream();
		};
		registerCustomApi("scratch-shared", parentFn, SOURCE, undefined, parent);
		registerCustomApi("scratch-shared", childFn, SOURCE, undefined, child);

		const childView = getCustomApi("scratch-shared");
		expect(childView).toBe(getCustomApi("scratch-shared"));
		expect(childView?.streamSimple).not.toBe(childFn);
		childView?.streamSimple({} as never, {} as never);
		childView?.stream({} as never, {} as never);
		expect(calls).toEqual(["child:true", "child:true"]);
		expect(child.runs).toBe(2);
		// streamSimple is called on the registered record; the default `stream` calls it detached, as before.
		const [simpleReceiver, streamReceiver] = childReceivers;
		expect(simpleReceiver && typeof simpleReceiver === "object" && "streamSimple" in simpleReceiver).toBe(true);
		if (simpleReceiver && typeof simpleReceiver === "object" && "streamSimple" in simpleReceiver) {
			expect(simpleReceiver.streamSimple).toBe(childFn);
		}
		expect(streamReceiver).toBeUndefined();

		child.retired = true;
		const parentView = getCustomApi("scratch-shared");
		parentView?.streamSimple({} as never, {} as never);
		expect(calls).toEqual(["child:true", "child:true", "parent:true"]);
		// The child's captured view refuses through its gate; its function never runs.
		expect(() => childView?.streamSimple({} as never, {} as never)).toThrow("gate retired");
		expect(calls.length).toBe(3);

		parent.retired = true;
		expect(getCustomApi("scratch-shared")).toBeUndefined();
	});

	test("same-gate re-registration replaces in place; gate-scoped unregister leaves other sessions", () => {
		const parent = makeGate();
		const child = makeGate();
		const a = () => stream();
		const b = () => stream();
		const c = () => stream();
		registerCustomApi("scratch-scope", a, SOURCE, undefined, parent);
		registerCustomApi("scratch-scope", b, SOURCE, undefined, child);
		registerCustomApi("scratch-scope", c, SOURCE, undefined, parent);
		getCustomApi("scratch-scope")?.streamSimple({} as never, {} as never);
		expect(child.runs).toBe(1); // child still newest
		unregisterCustomApis(SOURCE, child);
		getCustomApi("scratch-scope")?.streamSimple({} as never, {} as never);
		expect(parent.runs).toBe(1);
		unregisterCustomApis(SOURCE);
		expect(getCustomApi("scratch-scope")).toBeUndefined();
	});
});

describe("custom OAuth provider registry", () => {
	test("one-argument host form: same object, listed once, unregistered by its source", () => {
		const provider = {
			id: "scratch-host-oauth",
			name: "Scratch Host",
			sourceId: SOURCE,
			login: async () => "key",
		};
		registerOAuthProvider(provider);
		expect(getOAuthProviderEntry("scratch-host-oauth")?.provider).toBe(provider);
		expect(getOAuthProviderEntry("scratch-host-oauth")).toMatchObject({ provider, gate: undefined });
		expect(getOAuthProviders().filter(info => info.id === "scratch-host-oauth")).toEqual([
			{ id: "scratch-host-oauth", name: "Scratch Host", available: true, storeCredentialsAs: undefined },
		]);
		const replacement = { ...provider, name: "Replaced" };
		registerOAuthProvider(replacement);
		expect(getOAuthProviderEntry("scratch-host-oauth")?.provider).toBe(replacement);
		expect(getOAuthProviders().filter(info => info.id === "scratch-host-oauth")).toHaveLength(1);
		unregisterOAuthProviders(SOURCE);
		expect(getOAuthProviderEntry("scratch-host-oauth")?.provider).toBeUndefined();
	});

	test("the author's object is stored as given and never read at registration when options name it", () => {
		const reads: string[] = [];
		class Authored {
			#secret = "private";
			get name() {
				reads.push("name");
				return "Authored";
			}
			get id(): string {
				reads.push("id");
				return "wrong";
			}
			get sourceId(): string {
				reads.push("sourceId");
				return "wrong";
			}
			async login(_callbacks: OAuthLoginCallbacks) {
				return this.#secret;
			}
		}
		const provider = Object.freeze(new Authored());
		const gate = makeGate();
		registerOAuthProvider(provider, { id: "scratch-authored", sourceId: SOURCE, gate });
		expect(reads).toEqual([]);
		const entry = getOAuthProviderEntry("scratch-authored");
		expect(entry?.provider).toBe(provider);
		// The registration's name is this registry's, and it is reachable without reading the
		// author's `id` getter — which says something else entirely, and is the author's to say.
		expect(entry?.id).toBe("scratch-authored");
		expect(entry?.sourceId).toBe(SOURCE);
		expect(reads).toEqual([]);
		expect(getOAuthProviderEntry("wrong")?.provider).toBeUndefined();
		unregisterOAuthProviders(SOURCE);
		expect(getOAuthProviderEntry("scratch-authored")?.provider).toBeUndefined();
	});

	test("a provider without id or sourceId registers under the ids options give", () => {
		const provider = { name: "No Id", login: async () => "key" };
		registerOAuthProvider(provider, { id: "scratch-no-id", sourceId: SOURCE });
		expect(getOAuthProviderEntry("scratch-no-id")?.provider).toBe(provider);
		expect(provider).toEqual({ name: "No Id", login: provider.login });
		unregisterOAuthProviders(SOURCE);
		expect(getOAuthProviderEntry("scratch-no-id")?.provider).toBeUndefined();
	});

	test("property reads for the info list happen through the gate; a retired session's getters never run", () => {
		const parent = makeGate();
		const child = makeGate();
		const reads: string[] = [];
		const authored = (label: string, gate: TestGate) => ({
			get name() {
				reads.push(`${label}.name:${gate.inside}`);
				return label;
			},
			get storeCredentialsAs() {
				reads.push(`${label}.storeCredentialsAs:${gate.inside}`);
				return `${label}-store`;
			},
			login: async () => "key",
		});
		const parentProvider = authored("parent", parent);
		const childProvider = authored("child", child);
		registerOAuthProvider(parentProvider, { id: "scratch-shared-oauth", sourceId: SOURCE, gate: parent });
		registerOAuthProvider(childProvider, { id: "scratch-shared-oauth", sourceId: SOURCE, gate: child });

		expect(getOAuthProviderEntry("scratch-shared-oauth")?.provider).toBe(childProvider);
		expect(getOAuthProviders().filter(info => info.id === "scratch-shared-oauth")).toEqual([
			{ id: "scratch-shared-oauth", name: "child", available: true, storeCredentialsAs: "child-store" },
		]);
		expect(getOAuthCredentialProvider("scratch-shared-oauth")).toBe("child-store");
		expect(reads).toEqual(["child.name:true", "child.storeCredentialsAs:true", "child.storeCredentialsAs:true"]);

		reads.length = 0;
		child.retired = true;
		expect(getOAuthProviderEntry("scratch-shared-oauth")?.provider).toBe(parentProvider);
		expect(getOAuthProviderEntry("scratch-shared-oauth")?.gate).toBe(parent);
		expect(getOAuthProviders().filter(info => info.id === "scratch-shared-oauth")).toEqual([
			{ id: "scratch-shared-oauth", name: "parent", available: true, storeCredentialsAs: "parent-store" },
		]);
		expect(reads.every(read => read.startsWith("parent.") && read.endsWith(":true"))).toBe(true);

		parent.retired = true;
		expect(getOAuthProviderEntry("scratch-shared-oauth")?.provider).toBeUndefined();
		expect(getOAuthProviders().some(info => info.id === "scratch-shared-oauth")).toBe(false);
		expect(getOAuthCredentialProvider("scratch-shared-oauth")).toBe("scratch-shared-oauth");
	});

	test("gate-scoped unregister removes only that session's registration", () => {
		const parent = makeGate();
		const child = makeGate();
		const parentProvider = { name: "parent", login: async () => "key" };
		const childProvider = { name: "child", login: async () => "key" };
		registerOAuthProvider(parentProvider, { id: "scratch-scoped", sourceId: SOURCE, gate: parent });
		registerOAuthProvider(childProvider, { id: "scratch-scoped", sourceId: SOURCE, gate: child });
		unregisterOAuthProvider("scratch-scoped", child);
		expect(getOAuthProviderEntry("scratch-scoped")?.provider).toBe(parentProvider);
		registerOAuthProvider(childProvider, { id: "scratch-scoped", sourceId: SOURCE, gate: child });
		unregisterOAuthProviders(SOURCE, child);
		expect(getOAuthProviderEntry("scratch-scoped")?.provider).toBe(parentProvider);
		unregisterOAuthProvider("scratch-scoped");
		expect(getOAuthProviderEntry("scratch-scoped")?.provider).toBeUndefined();
	});

	test("retirement never removes an entry; same-gate re-registration replaces in place", () => {
		const parent = makeGate();
		const child = makeGate();
		const first = { name: "first", login: async () => "key" };
		const second = { name: "second", login: async () => "key" };
		const childProvider = { name: "child", login: async () => "key" };
		registerOAuthProvider(first, { id: "scratch-order", sourceId: SOURCE, gate: parent });
		registerOAuthProvider(childProvider, { id: "scratch-order", sourceId: SOURCE, gate: child });
		registerOAuthProvider(second, { id: "scratch-order", sourceId: SOURCE, gate: parent });
		expect(getOAuthProviderEntry("scratch-order")?.provider).toBe(childProvider);
		child.retired = true;
		expect(getOAuthProviderEntry("scratch-order")?.provider).toBe(second);
		child.retired = false; // test-only: the retired entry is still present
		expect(getOAuthProviderEntry("scratch-order")?.provider).toBe(childProvider);
	});
});
