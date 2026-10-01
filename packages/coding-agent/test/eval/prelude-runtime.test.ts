import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const IMAGE_DATA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

function definition(version: string, calls: unknown[]): EvalPreludeDefinition {
	return {
		name: "fixture",
		documentation: `fixture ${version}`,
		javascript: `{
			globalThis.fixture = {
				version: ${JSON.stringify(version)},
				invoke: parameters => __omp_prelude__("fixture", parameters),
			};
		}`,
		python: `class _FixturePrelude:
    version = ${JSON.stringify(version)}

    async def invoke(self, **parameters):
        return await _omp_prelude("fixture", parameters)

fixture = _FixturePrelude()
del _FixturePrelude`,
		exports: ["fixture"],
		codeModeDeclarations: `declare const fixture: { version: ${JSON.stringify(version)} };`,
		async invoke(parameters, context) {
			calls.push({ parameters, session: context.session, toolCallId: context.toolCallId });
			return {
				content: [
					{ type: "text", text: `host-${version}` },
					{ type: "image", mimeType: "image/png", data: IMAGE_DATA },
				],
				details: { version },
			};
		},
	};
}

function session(getPreludes: () => readonly EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getEvalPreludes: getPreludes,
	};
}

describe("eval prelude runtime", () => {
	afterAll(async () => {
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	it("synchronizes JavaScript definitions, preserves cell state, and gates captured handles", async () => {
		const calls: unknown[] = [];
		let current: readonly EvalPreludeDefinition[] = [definition("v1", calls)];
		const toolSession = session(() => current);
		const options = { sessionId: "prelude-runtime-js", session: toolSession, cwd: process.cwd() };

		const first = await executeJs(
			"globalThis.savedFixtureInvoke = fixture.invoke; await fixture.invoke({ value: 1 })",
			options,
		);
		expect(first.exitCode).toBe(0);
		expect(first.displayOutputs).toContainEqual({ type: "image", mimeType: "image/png", data: IMAGE_DATA });
		expect(first.displayOutputs).toContainEqual({
			type: "json",
			data: { text: "host-v1", details: { version: "v1" }, images: "(1 image displayed)" },
		});
		expect(calls).toHaveLength(1);

		const retained = await executeJs("fixture.invoke === globalThis.savedFixtureInvoke", options);
		expect(retained.output.trim()).toBe("true");

		current = [definition("v2", calls)];
		const replacedVersion = await executeJs("fixture.version", options);
		expect(replacedVersion.output.trim()).toBe("v2");
		const replaced = await executeJs("await fixture.invoke({ value: 3 })", options);
		expect(replaced.displayOutputs).toContainEqual({
			type: "json",
			data: { text: "host-v2", details: { version: "v2" }, images: "(1 image displayed)" },
		});
		expect(calls).toHaveLength(2);

		current = [];
		const removed = await executeJs("typeof fixture", options);
		expect(removed.output.trim()).toBe("undefined");
		const captured = await executeJs("await globalThis.savedFixtureInvoke({ value: 2 })", options);
		expect(captured.exitCode).toBe(1);
		expect(captured.output).toContain('Eval prelude "fixture" is not enabled');
		expect(calls).toHaveLength(2);

		const missing = await executeJs("await __omp_prelude__('missing', {})", options);
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('Eval prelude "missing" is not enabled');
	});

	it("synchronizes Python definitions, preserves cell state, and gates captured handles", async () => {
		const calls: unknown[] = [];
		let current: readonly EvalPreludeDefinition[] = [definition("v1", calls)];
		const toolSession = session(() => current);
		const options = {
			sessionId: "prelude-runtime-python",
			toolSession,
			cwd: process.cwd(),
		};

		const first = await executePython(
			"saved_fixture = fixture\nsaved_fixture_invoke = fixture.invoke\nvalue = await fixture.invoke(value=1)\nprint(value['details']['version'])",
			options,
		);
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("v1");
		expect(first.displayOutputs).toContainEqual({ type: "image", mimeType: "image/png", data: IMAGE_DATA });
		expect(calls).toHaveLength(1);
		const retained = await executePython("print(fixture is saved_fixture)", options);
		expect(retained.output.trim()).toBe("True");

		current = [definition("v2", calls)];
		const replaced = await executePython(
			"value = await fixture.invoke(value=3)\nprint(fixture.version, value['details']['version'])",
			options,
		);
		expect(replaced.exitCode).toBe(0);
		expect(replaced.output.trim()).toBe("v2 v2");
		expect(calls).toHaveLength(2);

		current = [];
		const removed = await executePython("print('fixture' in globals(), callable(saved_fixture_invoke))", options);
		expect(removed.exitCode).toBe(0);
		expect(removed.output.trim()).toBe("False True");
		const captured = await executePython("await saved_fixture_invoke(value=2)", options);
		expect(captured.exitCode).toBe(1);
		expect(captured.output).toContain('Eval prelude "fixture" is not enabled');
		expect(calls).toHaveLength(2);

		const missing = await executePython("await _omp_prelude('missing', {})", options);
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toContain('Eval prelude "missing" is not enabled');
	});
});
