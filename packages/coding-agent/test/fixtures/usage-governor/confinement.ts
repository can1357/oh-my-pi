import * as os from "node:os";
import { CHILD_PROBE, type GovernorProof } from "./harness";

interface ProbeResult {
	status?: number;
	error?: string;
	code?: string;
	errno?: number;
	names?: string[];
	cause?: { code?: string; errno?: number; message?: string };
	sockets: number[];
}

export function sandboxCommand(proof: GovernorProof, command: readonly string[]): string[] {
	const fakePort = new URL(proof.fake.url).port;
	const tripwirePort = new URL(proof.tripwire.url).port;
	const profile = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote tcp "localhost:${fakePort}"))(allow network-outbound (remote tcp "localhost:${tripwirePort}"))`;
	return [
		"/usr/bin/env",
		"-i",
		...Object.entries(proof.env).map(([key, value]) => `${key}=${value}`),
		"/usr/bin/sandbox-exec",
		"-p",
		profile,
		...command,
	];
}

export async function runProbe(
	proof: GovernorProof,
	mode: string,
	target?: string,
	bearer?: string,
): Promise<ProbeResult> {
	const child = Bun.spawn(
		sandboxCommand(proof, [
			process.execPath,
			CHILD_PROBE,
			mode,
			...(target ? [target] : []),
			...(bearer ? [bearer] : []),
		]),
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {} },
	);
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exit !== 0) throw new Error(`sandbox probe failed ${exit}: ${stderr}`);
	return JSON.parse(stdout) as ProbeResult;
}

export async function checkConfinement(proof: GovernorProof): Promise<void> {
	const environment = await runProbe(proof, "env");
	const actualNames = [...(environment.names ?? [])].sort();
	const expectedNames = Object.keys(proof.env).sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames) || environment.sockets.length !== 0)
		throw new Error(`sandbox child environment or socket control failed: ${JSON.stringify(environment)}`);
	const controls: Array<{ host: string; reason: string }> = [{ host: "127.0.0.1", reason: "other loopback port" }];
	const address = Object.values(os.networkInterfaces())
		.flat()
		.find(info => info && info.family === "IPv4" && !info.internal)?.address;
	if (address) controls.push({ host: address, reason: "non-loopback IPv4" });
	else console.log("sandbox control: non-loopback IPv4 skipped: no non-internal IPv4 interface");
	for (const { host, reason } of controls) {
		const markers: string[] = [];
		const server = Bun.serve({
			hostname: host,
			port: 0,
			fetch(req) {
				markers.push(new URL(req.url).pathname);
				return new Response("control");
			},
		});
		try {
			const marker = `/positive-${crypto.randomUUID()}`;
			const positive = await fetch(`http://${host}:${server.port}${marker}`, { proxy: "" });
			if (!positive.ok || markers.length !== 1 || markers[0] !== marker)
				throw new Error(`${reason} positive control failed`);
			const blocked = await runProbe(proof, "fetch", `http://${host}:${server.port}/blocked-${crypto.randomUUID()}`);
			console.log(`sandbox control ${reason}: positive=${positive.status} blocked=${JSON.stringify(blocked)}`);
			if (blocked.code !== "EPERM" || markers.length !== 1)
				throw new Error(`${reason} sandbox denial not proven: ${JSON.stringify(blocked)}`);
		} finally {
			server.stop(true);
		}
	}
	const named = await runProbe(proof, "fetch", "https://example.com/");
	const namedCodes = [named.code, named.cause?.code];
	if (namedCodes.includes("ENOTFOUND")) {
		console.log(`sandbox control external name: DNS unresolved (no socket denial claimed): ${JSON.stringify(named)}`);
	} else if (namedCodes.includes("EPERM")) {
		console.log(`sandbox control external name: request refused with EPERM: ${JSON.stringify(named)}`);
	} else {
		throw new Error(`external name neither denied nor unresolved: ${JSON.stringify(named)}`);
	}
	const numeric = await runProbe(proof, "fetch", "https://192.0.2.1:443/");
	console.log(`sandbox control TEST-NET socket: ${JSON.stringify(numeric)}`);
	if (![numeric.code, numeric.cause?.code].includes("EPERM"))
		throw new Error(`TEST-NET socket denial not proven: ${JSON.stringify(numeric)}`);
	const account = proof.specs[0];
	if (!account) throw new Error("sandbox control requires a fake account");
	const before = proof.fake.records.length;
	const fake = await runProbe(proof, "fetch", `${proof.fake.url}/${account.provider}/usage`, account.bearer);
	console.log(`sandbox control fake: ${JSON.stringify(fake)}`);
	if (fake.status !== 200 || proof.fake.records.length !== before + 1) throw new Error("sandbox fake control failed");
	if ([...proof.tripwire.records].length !== 0)
		throw new Error(
			`unexpected proxy traffic before tripwire positive control: ${JSON.stringify(proof.tripwire.records)}`,
		);
	const proxy = await runProbe(proof, "egress", "https://example.invalid/");
	console.log(`sandbox control tripwire: ${JSON.stringify(proxy)} records=${JSON.stringify(proof.tripwire.records)}`);
	if (
		proof.tripwire.records.length !== 1 ||
		proof.tripwire.records[0].requestLine !== "CONNECT example.invalid:443 HTTP/1.1" ||
		!JSON.stringify(proxy).includes("502")
	)
		throw new Error("sandbox proxy control failed");
	// The positive control is separate from the scenario's zero-egress assertion.
	proof.tripwire.clearRecords();
	if ([...proof.tripwire.records].length !== 0) throw new Error("sandbox tripwire did not reset");
}
