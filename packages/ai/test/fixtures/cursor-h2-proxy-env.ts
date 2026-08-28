import { acquireCursorH2, disposeCursorH2Pool } from "../../src/providers/cursor/h2-pool";

// Isolated replica of the unreachable-proxy tunnel-classification scenario:
// the proxy env vars are process-global, so the mutation happens in this
// child process instead of the parent test runner (pattern:
// cursor-proxy-env.ts). A fresh process also starts from a cold proxy cache,
// so no in-process cache reset is needed. The observed acquisition result is
// printed for the parent test to assert.
const RUN_PATH = "/agent.v1.AgentService/Run";
const provider = "cursor-h2-proxy-test";
const envKey = `PI_PROXY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

Bun.env[envKey] = "http://127.0.0.1:1";
Bun.env.NO_PROXY = "";
Bun.env.no_proxy = "";

try {
	const result = await acquireCursorH2({
		baseUrl: "https://cursor.example.invalid",
		requestPath: RUN_PATH,
		headers: {},
		provider,
	});
	const payload = { ok: result.ok, reason: result.ok ? undefined : result.unavailable.reason };
	process.stdout.write(`${JSON.stringify(payload)}\n`);
} finally {
	await disposeCursorH2Pool();
}
