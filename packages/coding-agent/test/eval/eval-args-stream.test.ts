import { describe, expect, it } from "bun:test";
import { EvalArgsStreamDecoder, MAX_EVAL_STREAM_ARGUMENT_BYTES } from "../../src/eval/speculation/eval-args-stream";

function snapshotsForUtf8Split(raw: string, boundary: number) {
	const bytes = new TextEncoder().encode(raw);
	const text = new TextDecoder();
	const decoder = new EvalArgsStreamDecoder();
	let cumulative = text.decode(bytes.slice(0, boundary), { stream: true });
	const first = decoder.update(cumulative);
	cumulative += text.decode(bytes.slice(boundary));
	const final = decoder.update(cumulative);
	return { first, final };
}

describe("EvalArgsStreamDecoder", () => {
	it("decodes the same escaped code across every UTF-8 byte boundary", () => {
		const args = {
			language: "js",
			reset: false,
			timeout: 12,
			code: 'const quote = "x";\nconst slash = "\\\\";\nconst face = "😀";',
		};
		const raw = JSON.stringify(args);
		const byteLength = new TextEncoder().encode(raw).byteLength;
		for (let boundary = 0; boundary <= byteLength; boundary++) {
			const { first, final } = snapshotsForUtf8Split(raw, boundary);
			expect(first.kind).toBe("snapshot");
			expect(final).toEqual({
				kind: "snapshot",
				snapshot: {
					revision: 2,
					language: "js",
					codePrefix: args.code,
					reset: false,
					timeout: 12,
					complete: true,
					restart: false,
				},
			});
			if (first.kind === "snapshot") expect(args.code.startsWith(first.snapshot.codePrefix)).toBe(true);
		}
	});

	it("holds split Unicode escapes until a complete surrogate pair is available", () => {
		const raw = '{"code":"before \\uD83D\\uDE00 after","language":"js"}';
		for (let offset = 0; offset <= raw.length; offset++) {
			const decoder = new EvalArgsStreamDecoder();
			const partial = decoder.update(raw.slice(0, offset));
			expect(partial.kind).toBe("snapshot");
			if (partial.kind === "snapshot") expect("before 😀 after".startsWith(partial.snapshot.codePrefix)).toBe(true);
			const final = decoder.update(raw);
			expect(final.kind).toBe("snapshot");
			if (final.kind === "snapshot") expect(final.snapshot.codePrefix).toBe("before 😀 after");
		}
	});

	it("recovers reordered fields while keeping incomplete prefixes languageless", () => {
		const decoder = new EvalArgsStreamDecoder();
		const partial = decoder.update('{"code":"display(1)","reset":false');
		expect(partial).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 1,
				codePrefix: "display(1)",
				reset: false,
				complete: false,
				restart: false,
			},
		});
		const complete = decoder.update('{"code":"display(1)","reset":false,"language":"js"}');
		expect(complete).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 2,
				language: "js",
				codePrefix: "display(1)",
				reset: false,
				complete: true,
				restart: false,
			},
		});
	});

	it("marks provider snapshot replacement and rejects final source disagreement", () => {
		const decoder = new EvalArgsStreamDecoder();
		expect(decoder.update('{"language":"py","code":"print(1')).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 1,
				language: "py",
				codePrefix: "print(1",
				complete: false,
				restart: false,
			},
		});
		const replacement = decoder.update('{"language":"py","code":"print(2');
		expect(replacement.kind).toBe("snapshot");
		if (replacement.kind === "snapshot") expect(replacement.snapshot.restart).toBe(true);
		expect(decoder.matchesFinal({ language: "py", code: "print(3)" })).toBe(false);
		expect(decoder.matchesFinal({ language: "py", code: "print(2)" })).toBe(true);
	});

	it("disables malformed and oversized streams without repairing bytes", () => {
		const malformed = new EvalArgsStreamDecoder().update('{"code":"bad\\q');
		expect(malformed).toEqual({ kind: "disabled", reason: "invalid JSON string escape", restart: false });
		const oversized = new EvalArgsStreamDecoder().update(`{"code":"${"x".repeat(MAX_EVAL_STREAM_ARGUMENT_BYTES)}"}`);
		expect(oversized).toEqual({
			kind: "disabled",
			reason: "eval argument stream exceeds speculation limit",
			restart: false,
		});
	});
	it("disables streams that repeat the reset control field instead of last-wins", () => {
		const decoder = new EvalArgsStreamDecoder();
		const first = decoder.update('{"reset":false,"code":"display(1)"');
		expect(first.kind).toBe("snapshot");
		expect(decoder.update('{"reset":false,"code":"display(1)","reset":true}')).toEqual({
			kind: "disabled",
			reason: "duplicate eval reset",
			restart: false,
		});
	});

	it("disables a repeated reset key before its second value completes", () => {
		const decoder = new EvalArgsStreamDecoder();
		expect(decoder.update('{"reset":false,"code":"display(1)"').kind).toBe("snapshot");
		expect(decoder.update('{"reset":false,"code":"display(1)","reset":tru')).toEqual({
			kind: "disabled",
			reason: "duplicate eval reset",
			restart: false,
		});
	});

	it("keeps single reset, language, and timeout buffers plannable", () => {
		expect(new EvalArgsStreamDecoder().update('{"language":"js","reset":true,"code":"display(1)"}')).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 1,
				language: "js",
				codePrefix: "display(1)",
				reset: true,
				timeout: undefined,
				complete: true,
				restart: false,
			},
		});
		expect(new EvalArgsStreamDecoder().update('{"language":"py","timeout":5,"code":"print(1)"}')).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 1,
				language: "py",
				codePrefix: "print(1)",
				reset: undefined,
				timeout: 5,
				complete: true,
				restart: false,
			},
		});
	});

	it("disables streams that repeat the language or timeout control fields", () => {
		expect(new EvalArgsStreamDecoder().update('{"language":"py","code":"print(1)","language":"js"}')).toEqual({
			kind: "disabled",
			reason: "duplicate eval language",
			restart: false,
		});
		expect(new EvalArgsStreamDecoder().update('{"timeout":5,"code":"print(1)","timeout":6}')).toEqual({
			kind: "disabled",
			reason: "duplicate eval timeout",
			restart: false,
		});
	});

	it("disables streams that repeat the code field instead of last-wins", () => {
		expect(
			new EvalArgsStreamDecoder().update(
				`{"language":"js","reset":false,"code":"await tool.read({path:'secret.txt'})","code":"display('safe')"}`,
			),
		).toEqual({
			kind: "disabled",
			reason: "duplicate eval code",
			restart: false,
		});
	});

	it("disables a repeated code key before its second value completes", () => {
		const decoder = new EvalArgsStreamDecoder();
		expect(decoder.update('{"language":"js","reset":false,"code":"display(1)"').kind).toBe("snapshot");
		expect(decoder.update('{"language":"js","reset":false,"code":"display(1)","code":"display(')).toEqual({
			kind: "disabled",
			reason: "duplicate eval code",
			restart: false,
		});
	});

	it("keeps a lone code value inside a string from disabling the stream", () => {
		const first = new EvalArgsStreamDecoder().update('{"language":"js","code":"display(1)"');
		expect(first.kind).toBe("snapshot");
		const result = new EvalArgsStreamDecoder().update('{"language":"js","code":"a \\"code\\" b"}');
		expect(result.kind).toBe("snapshot");
	});
	it("disables a complete object without language instead of planning a default-language read", () => {
		expect(new EvalArgsStreamDecoder().update('{"code":"await tool.read({path:\'secret.txt\'})"}')).toEqual({
			kind: "disabled",
			reason: "missing eval language",
			restart: false,
		});
	});

	it("keeps complete objects with language plannable and incomplete prefixes languageless", () => {
		expect(new EvalArgsStreamDecoder().update('{"language":"js","code":"display(1)"}')).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 1,
				language: "js",
				codePrefix: "display(1)",
				reset: undefined,
				timeout: undefined,
				complete: true,
				restart: false,
			},
		});
		expect(new EvalArgsStreamDecoder().update('{"code":"display(1)"')).toEqual({
			kind: "snapshot",
			snapshot: {
				revision: 1,
				codePrefix: "display(1)",
				complete: false,
				restart: false,
			},
		});
	});

	it("disables buffers with a non-string title instead of planning them", () => {
		expect(
			new EvalArgsStreamDecoder().update(
				'{"language":"js","reset":false,"code":"await tool.read({path:\'secret.txt\'})","title":123}',
			),
		).toEqual({ kind: "disabled", reason: "eval title must be a string", restart: false });
	});

	it("keeps string titles plannable", () => {
		const decoded = new EvalArgsStreamDecoder().update(
			'{"language":"js","reset":false,"code":"display(1)","title":"load config"}',
		);
		expect(decoded.kind).toBe("snapshot");
		if (decoded.kind === "snapshot") expect(decoded.snapshot.complete).toBe(true);
	});
});
