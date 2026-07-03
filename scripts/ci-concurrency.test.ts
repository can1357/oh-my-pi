// Regression test for #2564: the CI workflow's `concurrency` block must route
// release runs to a per-sha group with no cancellation, so a later main push
// can't kill the in-flight release and leave the tag unpublished. The block is
// evaluated by GitHub at workflow-scheduling time (before any job can produce
// the signal), so this test re-implements the small subset of GitHub
// expression semantics the block uses and asserts the resolved group / cancel
// flag for every event shape we care about.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

// This fork keeps GitHub workflows parked as `*.yml.disabled` (see
// .github/workflows/README.md). The concurrency contract must hold for the
// file that would be re-enabled, so fall back to the disabled copy when the
// live workflow is absent.
const WORKFLOW_DIR = path.resolve(import.meta.dir, "..", ".github", "workflows");
const LIVE_WORKFLOW_PATH = path.join(WORKFLOW_DIR, "ci.yml");
const DISABLED_WORKFLOW_PATH = path.join(WORKFLOW_DIR, "ci.yml.disabled");
const WORKFLOW_PATH = (await Bun.file(LIVE_WORKFLOW_PATH).exists()) ? LIVE_WORKFLOW_PATH : DISABLED_WORKFLOW_PATH;

type Value = string | boolean | null;

// `github` context fed into the evaluator. Nested objects are walked the same
// way as in real GHA expressions; missing keys resolve to `null`.
interface GhaCtx {
	workflow: string;
	ref: string;
	sha: string;
	event_name: string;
	event: {
		head_commit?: { message?: string };
	};
}

// Single-purpose, hand-rolled evaluator for the operators / functions the
// workflow's `concurrency` block uses: `startsWith`, `format`, `!`, `==`,
// `&&`, `||`, parens, single-quoted strings, dotted property access. Matches
// short-circuit semantics: `&&`/`||` return the underlying value (not a coerced
// bool), missing identifiers resolve to `null`, and `startsWith(null, …)` is
// false because the searchString coerces to `""`.
class GhaEval {
	#pos = 0;

	private constructor(
		private readonly src: string,
		private readonly ctx: { github: GhaCtx },
	) {}

	static run(expr: string, ctx: { github: GhaCtx }): Value {
		const ev = new GhaEval(expr.trim(), ctx);
		const value = ev.#or();
		ev.#skipWs();
		if (ev.#pos !== ev.src.length) {
			throw new Error(`trailing input at offset ${ev.#pos}: ${ev.src.slice(ev.#pos)}`);
		}
		return value;
	}

	// Substitute every `${{ … }}` placeholder in a workflow template string.
	static template(template: string, ctx: { github: GhaCtx }): string {
		let out = "";
		let i = 0;
		while (i < template.length) {
			const start = template.indexOf("${{", i);
			if (start === -1) {
				out += template.slice(i);
				break;
			}
			out += template.slice(i, start);
			const end = template.indexOf("}}", start);
			if (end === -1) throw new Error("unterminated ${{ expression");
			const v = GhaEval.run(template.slice(start + 3, end), ctx);
			out += v === null ? "" : String(v);
			i = end + 2;
		}
		return out;
	}

	#or(): Value {
		let left = this.#and();
		while (this.#consume("||")) {
			const right = this.#and();
			// Truthy left wins; only null/false/"" fall through.
			if (left !== null && left !== false && left !== "") continue;
			left = right;
		}
		return left;
	}

	#and(): Value {
		let left = this.#eq();
		while (this.#consume("&&")) {
			const right = this.#eq();
			// Falsy left short-circuits and is returned verbatim.
			if (left === null || left === false || left === "") continue;
			left = right;
		}
		return left;
	}

	#eq(): Value {
		let left = this.#unary();
		while (true) {
			if (this.#consume("==")) {
				const right = this.#unary();
				left = left === right;
				continue;
			}
			if (this.#consume("!=")) {
				const right = this.#unary();
				left = left !== right;
				continue;
			}
			return left;
		}
	}

	#unary(): Value {
		this.#skipWs();
		if (this.src[this.#pos] === "!") {
			this.#pos++;
			const v = this.#unary();
			return v === null || v === false || v === "";
		}
		return this.#primary();
	}

	#primary(): Value {
		this.#skipWs();
		const ch = this.src[this.#pos];
		if (ch === "(") {
			this.#pos++;
			const v = this.#or();
			this.#skipWs();
			if (this.src[this.#pos] !== ")") throw new Error("expected `)`");
			this.#pos++;
			return v;
		}
		if (ch === "'") return this.#string();
		// Identifier or function call.
		const ident = this.#identifier();
		this.#skipWs();
		if (this.src[this.#pos] === "(") return this.#call(ident);
		return this.#readPath(ident);
	}

	#string(): string {
		// GHA single-quoted: `''` is an escaped quote.
		this.#pos++; // opening quote
		let out = "";
		while (this.#pos < this.src.length) {
			const c = this.src[this.#pos];
			if (c === "'") {
				if (this.src[this.#pos + 1] === "'") {
					out += "'";
					this.#pos += 2;
					continue;
				}
				this.#pos++;
				return out;
			}
			out += c;
			this.#pos++;
		}
		throw new Error("unterminated string literal");
	}

	#identifier(): string {
		const start = this.#pos;
		while (this.#pos < this.src.length && /[A-Za-z0-9_.]/.test(this.src[this.#pos]!)) {
			this.#pos++;
		}
		if (start === this.#pos) throw new Error(`expected identifier at ${this.#pos}`);
		return this.src.slice(start, this.#pos);
	}

	#call(name: string): Value {
		this.#pos++; // opening paren
		const args: Value[] = [];
		this.#skipWs();
		if (this.src[this.#pos] !== ")") {
			for (;;) {
				args.push(this.#or());
				this.#skipWs();
				if (this.src[this.#pos] === ",") {
					this.#pos++;
					continue;
				}
				break;
			}
		}
		this.#skipWs();
		if (this.src[this.#pos] !== ")") throw new Error("expected `)` closing call");
		this.#pos++;
		switch (name) {
			case "startsWith": {
				const hay = args[0] === null || args[0] === false ? "" : String(args[0]);
				const needle = args[1] === null || args[1] === false ? "" : String(args[1]);
				return hay.startsWith(needle);
			}
			case "format": {
				const tmpl = args[0] === null ? "" : String(args[0]);
				return tmpl.replace(/\{(\d+)\}/g, (_, idx) => {
					const v = args[Number(idx) + 1];
					return v === null || v === false ? "" : String(v);
				});
			}
			default:
				throw new Error(`unsupported function: ${name}`);
		}
	}

	#readPath(dotted: string): Value {
		let cur: unknown = this.ctx;
		for (const seg of dotted.split(".")) {
			if (cur == null || typeof cur !== "object") return null;
			cur = (cur as Record<string, unknown>)[seg];
		}
		if (cur === undefined || cur === null) return null;
		if (typeof cur === "object") return null;
		return cur as Value;
	}

	#consume(op: string): boolean {
		this.#skipWs();
		if (this.src.startsWith(op, this.#pos)) {
			this.#pos += op.length;
			return true;
		}
		return false;
	}

	#skipWs(): void {
		while (this.#pos < this.src.length && /\s/.test(this.src[this.#pos]!)) this.#pos++;
	}
}

const workflowYaml = await Bun.file(WORKFLOW_PATH).text();
// The block sits at indent 0 immediately under the top-level `concurrency:`
// key and uses single-line values, so the indented section extract is
// unambiguous. Values are double-quoted in YAML (the GitHub expression contains
// `: ` from the `'chore: bump version to '` literal which would otherwise trip
// plain scalar parsing), so we unwrap the wrapping `"…"` here.
const concurrencySection = /^concurrency:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))+)/m.exec(workflowYaml)?.[1];
const groupRaw = /^\s*group:\s*(\S.*?)\s*$/m.exec(concurrencySection ?? "")?.[1];
const cancelRaw = /^\s*cancel-in-progress:\s*(\S.*?)\s*$/m.exec(concurrencySection ?? "")?.[1];
const groupTemplate = groupRaw?.startsWith('"') && groupRaw.endsWith('"') ? groupRaw.slice(1, -1) : groupRaw;
const cancelTemplate = cancelRaw?.startsWith('"') && cancelRaw.endsWith('"') ? cancelRaw.slice(1, -1) : cancelRaw;
if (!groupTemplate || !cancelTemplate) {
	throw new Error(`could not locate concurrency.group / cancel-in-progress in ${path.basename(WORKFLOW_PATH)}`);
}

const RELEASE_SUBJECT = "chore: bump version to 15.12.6";

const baseCtx = (overrides: Partial<GhaCtx> = {}): { github: GhaCtx } => ({
	github: {
		workflow: "CI",
		ref: "refs/heads/main",
		sha: "deadbeefcafebabe",
		event_name: "push",
		event: {},
		...overrides,
	},
});

describe("ci.yml concurrency", () => {
	it("auto release push: per-sha group, no cancellation (#2564 root cause)", () => {
		const ctx = baseCtx({ event: { head_commit: { message: `${RELEASE_SUBJECT}\n\nbody` } } });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-deadbeefcafebabe");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	it("retry release push (release subject preserved): same per-sha behavior", () => {
		const ctx = baseCtx({
			sha: "feedfacedeadbeef",
			event: { head_commit: { message: `${RELEASE_SUBJECT}\n\nretry: fix sccache 100 exit` } },
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-feedfacedeadbeef");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	it("workflow_dispatch from a `v*` tag ref: per-sha group, no cancellation", () => {
		const ctx = baseCtx({
			ref: "refs/tags/v15.12.6",
			event_name: "workflow_dispatch",
			sha: "abc123",
			event: {},
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-abc123");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	it("workflow_dispatch from tagged main HEAD is isolated before release_metadata can inspect tags", () => {
		const ctx = baseCtx({
			event_name: "workflow_dispatch",
			sha: "taggedmain123",
			event: {},
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-taggedmain123");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	it("regular main push: branch-wide group, cancel-in-progress enabled", () => {
		const ctx = baseCtx({ event: { head_commit: { message: "fix(ux): theme tweak" } } });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/heads/main");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");
	});

	it("pull_request (no head_commit): branch-wide group, cancel enabled", () => {
		const ctx = baseCtx({ ref: "refs/pull/42/merge", event_name: "pull_request", event: {} });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/pull/42/merge");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");
	});

	it("two release commits with distinct shas land in disjoint groups", () => {
		const a = baseCtx({ sha: "aaaa1111", event: { head_commit: { message: RELEASE_SUBJECT } } });
		const b = baseCtx({ sha: "bbbb2222", event: { head_commit: { message: RELEASE_SUBJECT } } });
		expect(GhaEval.template(groupTemplate, a)).not.toBe(GhaEval.template(groupTemplate, b));
	});

	it("benign commit subject that merely contains the release prefix is not a release", () => {
		// startsWith is anchored, so `revert: chore: bump version to 15.12.6` (a
		// follow-up commit) keeps the cancel-on-newer-push behavior — it has no
		// tag to publish.
		const ctx = baseCtx({
			event: { head_commit: { message: `revert: ${RELEASE_SUBJECT}` } },
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/heads/main");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");
	});
});
