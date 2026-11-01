/**
 * Child-process probe for what a `ctx` call does when it meets the end of its
 * session, by the shape the extension wrote. omp observes only the promise the
 * boundary hands back; every promise derived from it — `then`, `finally`,
 * `Promise.all`, an async function awaiting it — belongs to the extension, and
 * one whose rejection it drops ends the process through the handler
 * `@oh-my-pi/pi-utils/postmortem` installs on import. The parent test
 * (`ctx-after-session.test.ts`) reads the exit code and these JSON lines; only
 * a separate process can show a fatal unhandled rejection.
 *
 * Each shape ends the session while one `compact()` is in flight, except the
 * `after-end-*` shapes, which call after the end. The documented cases live in
 * `docs/extensions.md`, "A `ctx` call across the end of its session".
 */
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-utils/postmortem";

const shape = process.argv[2];
const dir = TempDir.createSync("@ctx-after-session-probe-");
const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
const registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
const runtime = new ExtensionRuntime();
const runner = new ExtensionRunner([], runtime, dir.path(), SessionManager.inMemory(dir.path()), registry);
/** The host's compaction: in flight until this probe releases it. */
const hostCompaction = Promise.withResolvers<void>();
let hostCalls = 0;
runner.initialize({} as unknown as ExtensionActions, {
	getModel: () => undefined,
	isIdle: () => true,
	abort() {},
	shutdown() {},
	hasPendingMessages: () => false,
	getContextUsage: () => undefined,
	getSystemPrompt: () => [],
	compact: async () => {
		hostCalls++;
		await hostCompaction.promise;
	},
} as unknown as ExtensionContextActions);
const endSession = runtime.beginSession();
const ctx = runner.createContext();
const say = (what: string, detail?: unknown): void => {
	process.stdout.write(`${JSON.stringify({ shape, what, detail, hostCalls })}\n`);
};

switch (shape) {
	// The promise the boundary hands back, dropped: omp observes it, so its refusal ends only it.
	case "dropped-original": {
		void ctx.compact();
		endSession();
		hostCompaction.resolve();
		break;
	}
	// Derived promises: each is the extension's to observe.
	case "derived-then": {
		void ctx.compact().then(() => say("then"));
		endSession();
		hostCompaction.resolve();
		break;
	}
	case "derived-then-handler": {
		void ctx.compact().then(
			() => say("then"),
			error => say("caught", String(error)),
		);
		endSession();
		hostCompaction.resolve();
		break;
	}
	case "derived-finally": {
		void ctx.compact().finally(() => say("finally"));
		endSession();
		hostCompaction.resolve();
		break;
	}
	case "derived-all": {
		void Promise.all([ctx.compact()]);
		endSession();
		hostCompaction.resolve();
		break;
	}
	case "derived-async": {
		void (async () => {
			await ctx.compact();
			say("fulfilled");
		})();
		endSession();
		hostCompaction.resolve();
		break;
	}
	case "derived-async-try": {
		void (async () => {
			try {
				await ctx.compact();
				say("fulfilled");
			} catch (error) {
				say("caught", String(error));
			}
		})();
		endSession();
		hostCompaction.resolve();
		break;
	}
	// Called after the end: the member throws before it returns a promise.
	case "after-end-await-try": {
		endSession();
		let returned = false;
		try {
			const call = ctx.compact();
			returned = true;
			await call;
			say("fulfilled");
		} catch (error) {
			say("caught", { returned, error: String(error) });
		}
		break;
	}
	case "after-end-catch": {
		endSession();
		// In a callback of its own, as an extension's timer or listener would: the throw is the
		// process's, not this module's, so nothing but a `try` around the call could catch it.
		setImmediate(() => {
			void ctx.compact().catch(error => say("caught", String(error)));
			say("call returned");
		});
		break;
	}
	default:
		throw new Error(`unknown shape: ${shape}`);
}

// Macrotask turns: an unobserved rejection is reported once the microtask queue has drained.
for (let turn = 0; turn < 5; turn++) {
	const next = Promise.withResolvers<void>();
	setImmediate(next.resolve);
	await next.promise;
}
say("survived");
auth.close();
dir.removeSync();
