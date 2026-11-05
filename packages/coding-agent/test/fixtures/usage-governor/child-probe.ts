/**
 * Runs as a child under the proof's confinement environment. Two modes:
 *
 * - `env`: prints the names of every variable the child inherited, as JSON on stdout.
 * - `egress`: fetches a non-loopback HTTPS URL through the proxy environment. The tripwire must
 *   record the attempt, which proves the control path is live. The probe reports the outcome.
 */
const mode = process.argv[2];

if (mode === "env") {
	process.stdout.write(`${JSON.stringify({ names: Object.keys(process.env).sort() })}\n`);
} else if (mode === "egress") {
	const target = process.argv[3] ?? "https://example.invalid/";
	try {
		const response = await fetch(target, { signal: AbortSignal.timeout(5_000) });
		process.stdout.write(`${JSON.stringify({ status: response.status })}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
	}
} else {
	process.stderr.write(`unknown probe mode ${mode}\n`);
	process.exit(2);
}
