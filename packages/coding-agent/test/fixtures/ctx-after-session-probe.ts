/**
 * Child-process probe for what a `ctx` call does when it meets the end of its
 * session, by the shape the extension wrote. omp observes only the promise the
 * boundary hands back; every promise derived from it — `then`, `finally`,
 * `Promise.all`, an async function awaiting it — belongs to the extension, and
 * one whose rejection it drops ends the process through the handler
 * `@oh-my-pi/pi-utils/postmortem` installs on import. The parent test
 * (`ctx-after-session.test.ts`) reads the exit code, the fatal report on
 * stderr and these JSON lines; only a separate process can show a fatal
 * unhandled rejection.
 *
 * Each shape is one row of the table in `docs/extensions.md`, "A `ctx` call
 * across the end of its session", named in its "Gate shape" column. The
 * `after-end-*` shapes call after the session has ended; the others end it
 * while one `compact()` is in flight, except `stored-fulfilled`, which lets the
 * call finish first.
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
runner.initialize(
	{} as unknown as ExtensionActions,
	{
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
	} as unknown as ExtensionContextActions,
);
const endSession = runtime.beginSession();
const ctx = runner.createContext();
const say = (what: string, detail?: unknown): void => {
	process.stdout.write(`${JSON.stringify({ shape, what, detail, hostCalls })}\n`);
};
/** Macrotask turns: an unobserved rejection is reported once the microtask queue has drained. */
const turns = async (count: number): Promise<void> => {
	for (let turn = 0; turn < count; turn++) {
		const next = Promise.withResolvers<void>();
		setImmediate(next.resolve);
		await next.promise;
	}
};
/** The session ends while the host's compaction is in flight, then the host finishes it. */
const endWhileInFlight = (): void => {
	endSession();
	hostCompaction.resolve();
};
const awaitCaught = async (call: Promise<unknown>): Promise<void> => {
	try {
		await call;
		say("fulfilled");
	} catch (error) {
		say("caught", String(error));
	}
};

switch (shape) {
	// At the call: the member throws before it returns a promise.
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
	case "after-end-drop": {
		endSession();
		// In a callback of its own, as an extension's timer or listener would: the throw is the
		// process's, not this module's.
		setImmediate(() => {
			void ctx.compact();
			say("call returned");
		});
		break;
	}
	case "after-end-catch": {
		endSession();
		setImmediate(() => {
			void ctx.compact().catch(error => say("caught", String(error)));
			say("call returned");
		});
		break;
	}
	// On the way back: the promise the boundary handed back settles after the session has ended.
	case "dropped-original": {
		// Held without a handler, only to read afterwards how it settled: dropped, as far as the
		// runtime's rejection tracking is concerned.
		const original = ctx.compact();
		endWhileInFlight();
		await turns(5);
		say("original", { status: Bun.peek.status(original), reason: String(Bun.peek(original)) });
		break;
	}
	case "stored-pending": {
		const stored = ctx.compact();
		endWhileInFlight();
		await turns(5);
		await awaitCaught(stored);
		break;
	}
	case "stored-fulfilled": {
		const stored = ctx.compact();
		hostCompaction.resolve();
		await turns(5);
		endSession();
		await awaitCaught(stored);
		break;
	}
	// Derived: every promise made from the one handed back is the extension's to observe.
	case "derived-then": {
		void ctx.compact().then(() => say("then"));
		endWhileInFlight();
		break;
	}
	case "derived-then-catch": {
		void ctx
			.compact()
			.then(() => say("then"))
			.catch(error => say("caught", String(error)));
		endWhileInFlight();
		break;
	}
	case "derived-then-handler": {
		void ctx.compact().then(
			() => say("then"),
			error => say("caught", String(error)),
		);
		endWhileInFlight();
		break;
	}
	case "derived-finally": {
		void ctx.compact().finally(() => say("finally"));
		endWhileInFlight();
		break;
	}
	case "derived-try-finally": {
		try {
			void ctx.compact().then(() => say("then"));
		} finally {
			say("finally");
		}
		endWhileInFlight();
		break;
	}
	case "derived-try-catch": {
		try {
			void ctx.compact().then(() => say("then"));
		} catch (error) {
			say("caught", String(error));
		}
		endWhileInFlight();
		break;
	}
	case "derived-all-awaited": {
		// oxlint-disable-next-line unicorn/no-single-promise-in-promise-methods -- the aggregate is the shape under test
		const all = Promise.all([ctx.compact()]);
		endWhileInFlight();
		await awaitCaught(all);
		break;
	}
	case "derived-all": {
		// oxlint-disable-next-line unicorn/no-single-promise-in-promise-methods -- the aggregate is the shape under test
		void Promise.all([ctx.compact()]);
		endWhileInFlight();
		break;
	}
	case "derived-async-all": {
		void (async () => {
			// oxlint-disable-next-line unicorn/no-single-promise-in-promise-methods -- the aggregate is the shape under test
			await Promise.all([ctx.compact()]);
			say("fulfilled");
		})();
		endWhileInFlight();
		break;
	}
	case "derived-async": {
		void (async () => {
			await ctx.compact();
			say("fulfilled");
		})();
		endWhileInFlight();
		break;
	}
	case "derived-async-try": {
		void (async () => awaitCaught(ctx.compact()))();
		endWhileInFlight();
		break;
	}
	default:
		throw new Error(`unknown shape: ${shape}`);
}

await turns(5);
say("survived");
auth.close();
dir.removeSync();
