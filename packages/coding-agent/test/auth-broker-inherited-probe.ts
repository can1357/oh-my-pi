/**
 * Inherited-broker probe, run as a subprocess by auth-broker-inherited.test.ts. The
 * parent serves a stand-in for a developer's own auth broker and passes it down in
 * OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN, as the developer's shell would. The
 * probe discovers auth storage the way an SDK test does, reads the provider the broker
 * holds, saves a credential of its own, and prints what it observed as one JSON line.
 * With `declare` it first declares that broker as one it set up itself.
 */

import { allowAuthBrokerForTests } from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const brokerUrl = process.env.OMP_AUTH_BROKER_URL;
if (!agentDir || !brokerUrl) throw new Error("PROBE: PI_CODING_AGENT_DIR and OMP_AUTH_BROKER_URL are required");

if (process.argv[2] === "declare") allowAuthBrokerForTests(brokerUrl);
const storage = await discoverAuthStorage(agentDir);
const loaded = (await storage.keys.get("inherited-broker-provider")) ?? null;
await storage.credentials.set("probe-provider", { type: "api_key", key: "probe-written-key" });
storage.close();

console.log(`PROBE: ${JSON.stringify({ testRuntime: isBunTestRuntime(), loaded })}`);
process.exit(0);
