import { describe, expect, it } from "bun:test";
import * as constants from "@oh-my-pi/pi-coding-agent/memory-fabric/security/constants";
import * as security from "@oh-my-pi/pi-coding-agent/memory-fabric/security/resilience";
import type {
	DurableStorePort,
	RedactionPort,
	SecretDetectorPort,
	SecurityEvent,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/security/types";

// Obviously-fake credentials shaped to match the built-in patterns. None of
// these are valid keys; they exist only to exercise the redactor.
const FAKE_ANTHROPIC_KEY = "sk-ant-EXAMPLEEXAMPLEEXAMPLE";
const FAKE_OPENAI_KEY = "sk-proj-EXAMPLEEXAMPLEEXAMPLE";
const FAKE_GITHUB_TOKEN = "ghp_EXAMPLEEXAMPLEEXAMPLE0";
const FAKE_AWS_KEY = "AKIAZZZZZZZZZZZZZZZZ";
/** 24 chars of alternating letters and digits — no pattern matches it. */
const HIGH_ENTROPY_SAMPLE = "a1b2c3d4e5f6g7h8i9j0k1l2";
const CLEAN_TEXT = "just some ordinary notes about the parser";

// --- Fault-injection doubles -----------------------------------------------
// These live in the test rather than in `src` so the shipped module exposes no
// deliberately-broken ports.

/** A redaction port that throws on every call after the first `throwAfter` calls. */
function faultyRedactionPort(opts: { throwAfter?: number; error?: string } = {}): RedactionPort {
	const throwAfter = opts.throwAfter ?? 0;
	let calls = 0;
	return {
		redact(text: string) {
			calls += 1;
			if (calls > throwAfter) throw new Error(opts.error ?? "injected redactor fault");
			return security.builtinRedact(text);
		},
	};
}

/** A redaction port that silently does nothing, simulating a broken redactor. */
const noopRedactionPort: RedactionPort = { redact: (text: string) => ({ redacted: text, hadSecrets: false }) };

/** A detector that insists every payload is still dirty. */
const alwaysDirty: SecretDetectorPort = { containsSecrets: () => true };

/** A detector that faults. */
const throwingDetector: SecretDetectorPort = {
	containsSecrets() {
		throw new Error("injected detector fault");
	},
};

/** A durable store that records what it was handed, and can be forced to throw. */
function recordingStore<T>(opts: { throwOnWrite?: boolean } = {}): DurableStorePort<T> & { written: T[] } {
	const written: T[] = [];
	return {
		written,
		write(record: T) {
			if (opts.throwOnWrite) throw new Error("injected store fault");
			written.push(record);
		},
	};
}

describe("builtinRedact", () => {
	it("redacts an OpenAI-style key and reports that it found one", () => {
		const result = security.builtinRedact(`key ${FAKE_OPENAI_KEY} here`);
		expect(result.hadSecrets).toBe(true);
		expect(result.redacted).toContain("[REDACTED:OPENAI_KEY]");
		expect(result.redacted).not.toContain("EXAMPLEEXAMPLE");
	});

	it("labels an Anthropic key correctly even though the OpenAI pattern also matches it", () => {
		// `sk-ant-…` is a strict subset of the broader `sk-…` pattern, so the
		// specific pattern has to be tried first or the audit label lies.
		const result = security.builtinRedact(FAKE_ANTHROPIC_KEY);
		expect(result.redacted).toBe("[REDACTED:ANTHROPIC_KEY]");
	});

	it("redacts several distinct secret classes in a single pass", () => {
		const result = security.builtinRedact(`${FAKE_GITHUB_TOKEN} and ${FAKE_AWS_KEY}`);
		expect(result.hadSecrets).toBe(true);
		expect(result.redacted).toContain("[REDACTED:GITHUB_TOKEN]");
		expect(result.redacted).toContain("[REDACTED:AWS_ACCESS_KEY]");
	});

	it("leaves ordinary prose untouched", () => {
		const result = security.builtinRedact(CLEAN_TEXT);
		expect(result.hadSecrets).toBe(false);
		expect(result.redacted).toBe(CLEAN_TEXT);
	});

	it("is stateless across repeated calls despite sharing global regexes", () => {
		const input = `${FAKE_GITHUB_TOKEN} and ${FAKE_AWS_KEY}`;
		const first = security.builtinRedact(input);
		expect(security.builtinRedact(input)).toEqual(first);
		expect(security.builtinRedact(input)).toEqual(first);
	});
});

describe("builtinContainsSecrets", () => {
	it("detects a known secret shape", () => {
		expect(security.builtinContainsSecrets(`x ${FAKE_GITHUB_TOKEN} y`)).toBe(true);
	});

	it("detects a high-entropy run that no pattern matches", () => {
		expect(security.builtinContainsSecrets(`token ${HIGH_ENTROPY_SAMPLE} end`)).toBe(true);
	});

	it("does not flag a long identifier that has no digits", () => {
		expect(security.builtinContainsSecrets("MEMORY_FABRIC_CONTEXT_HYGIENE_PIPELINE")).toBe(false);
	});

	it("returns false for clean prose", () => {
		expect(security.builtinContainsSecrets(CLEAN_TEXT)).toBe(false);
	});

	it("is stateless across repeated calls", () => {
		const input = `x ${FAKE_GITHUB_TOKEN} y`;
		expect(security.builtinContainsSecrets(input)).toBe(true);
		expect(security.builtinContainsSecrets(input)).toBe(true);
		expect(security.builtinContainsSecrets(input)).toBe(true);
	});
});

describe("panicRedact", () => {
	it("strips a high-entropy run that the pattern list misses", () => {
		const result = security.panicRedact(`token ${HIGH_ENTROPY_SAMPLE} end`);
		expect(result).toContain("[REDACTED:HIGH_ENTROPY]");
		expect(result).not.toContain(HIGH_ENTROPY_SAMPLE);
	});

	it("produces output the default detector considers clean", () => {
		const dirty = `${FAKE_GITHUB_TOKEN} ${HIGH_ENTROPY_SAMPLE} ${FAKE_AWS_KEY}`;
		expect(security.builtinContainsSecrets(security.panicRedact(dirty))).toBe(false);
	});
});

describe("withResilience", () => {
	it("passes the value through on success", () => {
		const result = security.withResilience(() => 42, 0);
		expect(result.ok).toBe(true);
		expect(result.value).toBe(42);
		expect(result.failedOpen).toBe(false);
	});

	it("contains a throw and returns the fallback", () => {
		const result = security.withResilience<number>(() => {
			throw new Error("boom");
		}, -1);
		expect(result.ok).toBe(false);
		expect(result.value).toBe(-1);
		expect(result.failedOpen).toBe(true);
		expect(result.error).toBe("boom");
	});

	it("stringifies a thrown value that is not an Error", () => {
		const thrown: unknown = { toString: () => "not-an-error" };
		const result = security.withResilience(() => {
			throw thrown;
		}, "fallback");
		expect(result.value).toBe("fallback");
		expect(result.error).toBe("not-an-error");
	});
});

describe("guardText — clean and redactable input", () => {
	it("stores clean text unchanged", () => {
		const outcome = security.guardText(CLEAN_TEXT);
		expect(outcome.action).toBe("store");
		expect(outcome.safeText).toBe(CLEAN_TEXT);
		expect(outcome.hadSecrets).toBe(false);
		expect(outcome.reason).toBe("no-secrets-detected");
	});

	it("redacts before storing and says so", () => {
		const outcome = security.guardText(`key ${FAKE_ANTHROPIC_KEY} end`);
		expect(outcome.action).toBe("store");
		expect(outcome.hadSecrets).toBe(true);
		expect(outcome.redactedApplied).toBe(true);
		expect(outcome.reason).toBe("redacted-clean");
		expect(outcome.safeText).toContain("[REDACTED:ANTHROPIC_KEY]");
	});

	it("defaults to observe mode", () => {
		expect(security.guardText(CLEAN_TEXT).mode).toBe("observe");
	});
});

describe("guardText — residual secrets", () => {
	it("escalates to the conservative pass when the primary redactor misses one", () => {
		const outcome = security.guardText(`x ${FAKE_GITHUB_TOKEN} y`, { redactionPort: noopRedactionPort });
		expect(outcome.action).toBe("store");
		expect(outcome.residualSuspected).toBe(true);
		expect(outcome.reason).toBe("primary-residual-cleaned-by-fallback");
		expect(outcome.safeText).not.toContain(FAKE_GITHUB_TOKEN);
	});

	it("blocks when even the conservative pass cannot prove the payload clean", () => {
		const outcome = security.guardText(CLEAN_TEXT, { detector: alwaysDirty });
		expect(outcome.action).toBe("block");
		expect(outcome.residualSuspected).toBe(true);
		expect(outcome.reason).toBe("residual-secret-after-fallback");
	});

	it("treats a faulting detector as dirty, so it fails safe rather than open", () => {
		const outcome = security.guardText(CLEAN_TEXT, { detector: throwingDetector });
		expect(outcome.action).toBe("block");
		expect(outcome.reason).toBe("residual-secret-after-fallback");
	});
});

describe("guardText — redactor faults", () => {
	it("stores the conservative fallback in observe mode", () => {
		const outcome = security.guardText(`x ${FAKE_GITHUB_TOKEN} y`, { redactionPort: faultyRedactionPort() });
		expect(outcome.action).toBe("store");
		expect(outcome.failedOpen).toBe(true);
		expect(outcome.faultInjected).toBe(true);
		expect(outcome.reason).toBe("redactor-fault-panic-redacted");
		expect(outcome.safeText).not.toContain(FAKE_GITHUB_TOKEN);
	});

	it("blocks the same payload in enforce mode", () => {
		const outcome = security.guardText(`x ${FAKE_GITHUB_TOKEN} y`, {
			mode: "enforce",
			redactionPort: faultyRedactionPort(),
		});
		expect(outcome.action).toBe("block");
		expect(outcome.failedOpen).toBe(true);
		expect(outcome.reason).toBe("redactor-fault-fail-closed");
	});

	it("blocks in either mode when the fallback output still looks dirty", () => {
		const outcome = security.guardText(CLEAN_TEXT, {
			detector: alwaysDirty,
			redactionPort: faultyRedactionPort(),
		});
		expect(outcome.action).toBe("block");
		expect(outcome.failedOpen).toBe(true);
		expect(outcome.reason).toBe("redactor-fault-residual-blocked");
	});

	it("honours throwAfter so the first call can succeed", () => {
		const port = faultyRedactionPort({ throwAfter: 1 });
		expect(security.guardText(CLEAN_TEXT, { redactionPort: port }).failedOpen).toBe(false);
		expect(security.guardText(CLEAN_TEXT, { redactionPort: port }).failedOpen).toBe(true);
	});
});

describe("guardText — telemetry", () => {
	it("emits one event per payload using the injected clock", () => {
		const events: SecurityEvent[] = [];
		security.guardText(CLEAN_TEXT, {
			now: () => 4242,
			telemetrySink: event => {
				events.push(event);
			},
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe(constants.SECURITY_GUARD_NAME);
		expect(events[0]?.version).toBe(constants.SECURITY_GUARD_VERSION);
		expect(events[0]?.action).toBe("store");
		expect(events[0]?.timestamp).toBe(4242);
	});

	it("survives a telemetry sink that throws", () => {
		const outcome = security.guardText(CLEAN_TEXT, {
			telemetrySink: () => {
				throw new Error("injected sink fault");
			},
		});
		expect(outcome.action).toBe("store");
	});

	it("falls back to timestamp 0 when the clock throws", () => {
		const events: SecurityEvent[] = [];
		security.guardText(CLEAN_TEXT, {
			now: () => {
				throw new Error("injected clock fault");
			},
			telemetrySink: event => {
				events.push(event);
			},
		});
		expect(events[0]?.timestamp).toBe(0);
	});
});

describe("makeSecureStore", () => {
	it("hands the store the redacted record and never the raw one", () => {
		const store = recordingStore<{ id: string; content: string }>();
		const result = security.makeSecureStore(store).write({ id: "r1", content: `see ${FAKE_GITHUB_TOKEN}` });

		expect(result.stored).toBe(true);
		expect(store.written).toHaveLength(1);
		expect(store.written[0]?.content).toContain("[REDACTED:GITHUB_TOKEN]");
		expect(store.written[0]?.content).not.toContain(FAKE_GITHUB_TOKEN);
	});

	it("handles a bare string record through the default accessors", () => {
		const store = recordingStore<string>();
		const result = security.makeSecureStore(store).write(`see ${FAKE_GITHUB_TOKEN}`);

		expect(result.stored).toBe(true);
		expect(store.written[0]).toContain("[REDACTED:GITHUB_TOKEN]");
	});

	it("never reaches the store for a blocked payload", () => {
		const store = recordingStore<string>();
		const result = security.makeSecureStore(store, { detector: alwaysDirty }).write("anything");

		expect(result.stored).toBe(false);
		expect(result.blocked).toBe(true);
		expect(store.written).toHaveLength(0);
	});

	it("contains a store fault instead of propagating it", () => {
		// The guarantee is that `write` never throws, so calling it unguarded is
		// itself the assertion — a propagated fault would fail this test.
		const store = recordingStore<string>({ throwOnWrite: true });
		const result = security.makeSecureStore(store).write("clean payload");

		expect(result.stored).toBe(false);
		expect(result.blocked).toBe(false);
		expect(result.failedOpen).toBe(true);
		expect(result.error).toContain("injected store fault");
	});

	it("honours custom getText and withText accessors", () => {
		const store = recordingStore<{ id: string; body: string }>();
		const secure = security.makeSecureStore(store, {
			getText: note => note.body,
			withText: (note, redacted) => ({ ...note, body: redacted }),
		});
		const result = secure.write({ id: "n1", body: `see ${FAKE_GITHUB_TOKEN}` });

		expect(result.stored).toBe(true);
		expect(store.written[0]?.body).toContain("[REDACTED:GITHUB_TOKEN]");
		expect(store.written[0]?.id).toBe("n1");
	});
});

describe("secureWrite", () => {
	it("is a one-shot equivalent of makeSecureStore().write", () => {
		const store = recordingStore<string>();
		const result = security.secureWrite(store, `see ${FAKE_GITHUB_TOKEN}`);

		expect(result.stored).toBe(true);
		expect(store.written).toHaveLength(1);
		expect(store.written[0]).toContain("[REDACTED:GITHUB_TOKEN]");
	});
});
