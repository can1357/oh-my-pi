import * as os from "node:os";
import { CHILD_PROBE, type GovernorProof } from "./harness";

interface ProbeResult {
	status?: number;
	error?: string;
	code?: string;
	errno?: number;
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
	for (const target of ["https://example.com/", "https://192.0.2.1:443/"]) {
		const start = Date.now();
		const result = await runProbe(proof, "fetch", target);
		console.log(`sandbox control ${target}: elapsed=${Date.now() - start}ms result=${JSON.stringify(result)}`);
		if (result.code !== "EPERM") throw new Error(`external sandbox denial not proven: ${JSON.stringify(result)}`);
	}
	const account = proof.specs[0];
	if (!account) throw new Error("sandbox control requires a fake account");
	const before = proof.fake.records.length;
	const fake = await runProbe(proof, "fetch", `${proof.fake.url}/${account.provider}/usage`, account.bearer);
	console.log(`sandbox control fake: ${JSON.stringify(fake)}`);
	if (fake.status !== 200 || proof.fake.records.length !== before + 1) throw new Error("sandbox fake control failed");
	const proxy = await runProbe(proof, "egress", "https://example.invalid/");
	console.log(`sandbox control tripwire: ${JSON.stringify(proxy)} records=${JSON.stringify(proof.tripwire.records)}`);
	if (
		proof.tripwire.records.length !== 1 ||
		proof.tripwire.records[0].requestLine !== "CONNECT example.invalid:443 HTTP/1.1" ||
		!JSON.stringify(proxy).includes("502")
	)
		throw new Error("sandbox proxy control failed");
}
