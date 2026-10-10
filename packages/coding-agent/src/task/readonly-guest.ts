import { createInterface } from "node:readline";
import { JsRuntime } from "../eval/js/shared/runtime";

/** Runs only inside the OS sandbox. This protocol has no host tool dispatcher. */
export async function runReadonlyJsGuest(): Promise<void> {
	const write = process.stdout.write.bind(process.stdout);
	const send = (frame: unknown): void => {
		write(JSON.stringify(frame) + "\n");
	};
	const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "readonly-guest" });
	const lines = createInterface({ input: process.stdin });
	for await (const line of lines) {
		let id = "";
		try {
			const request = JSON.parse(line) as { id: string; code: string };
			id = request.id;
			await runtime.run(request.code, `readonly-cell-${id}.js`, {
				onText: text => send({ type: "stdout", id, data: text }),
				onDisplay: value => send({ type: "display", id, value }),
				callTool: async () => {
					throw new Error("READONLY_HOST_BRIDGE_DENIED");
				},
			});
			send({ type: "done", id, status: "ok" });
		} catch (error) {
			send({ type: "error", id, error: String(error) });
			send({ type: "done", id, status: "error" });
		}
	}
}
