import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { $which } from "@oh-my-pi/pi-utils";

/** Run one cell with the same builtin injection and prelude initialization as eval. */
export async function runPrelude(code: string, env: Record<string, string>): Promise<string> {
	const interpreter = Bun.env.PYTHON ? ($which(Bun.env.PYTHON) ?? Bun.env.PYTHON) : undefined;
	const kernel = await PythonKernel.start({ cwd: process.cwd(), env, interpreter });
	try {
		let output = "";
		const result = await kernel.execute(code, {
			id: "run",
			timeoutMs: 10_000,
			onChunk: chunk => {
				output += chunk;
			},
		});
		if (result.status !== "ok") throw new Error(result.error?.traceback.join("\n") || output || "Python cell failed");
		return output;
	} finally {
		await kernel.shutdown();
	}
}
