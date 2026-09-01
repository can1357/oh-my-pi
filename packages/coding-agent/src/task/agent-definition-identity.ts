import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { AgentDefinitionIdentity, AgentDefinitionOriginIdentity, AgentDefinitionOriginKind } from "./types";

const ORIGIN_DOMAIN = "omp-agent-origin-v1";
const DEFINITION_DOMAIN = "omp-agent-definition-v1";

function opaqueId(domain: string, parts: readonly string[]): string {
	const hash = new Bun.CryptoHasher("sha256");
	const encoder = new TextEncoder();
	for (const part of [domain, ...parts]) {
		const encoded = encoder.encode(part);
		hash.update(`${encoded.byteLength}:`);
		hash.update(encoded);
	}
	return `sha256:${hash.digest("hex")}`;
}

async function canonicalLocation(location: string): Promise<string> {
	try {
		return await fs.realpath(location);
	} catch (error) {
		if (isEnoent(error)) return path.resolve(location);
		throw error;
	}
}

function freezeOrigin(originKind: AgentDefinitionOriginKind, canonicalRoot: string): AgentDefinitionOriginIdentity {
	return Object.freeze({
		schemaVersion: 1,
		originKind,
		originId: opaqueId(ORIGIN_DOMAIN, [originKind, canonicalRoot]),
	});
}

function freezeDefinition(
	origin: AgentDefinitionOriginIdentity,
	canonicalDefinition: string,
	definitionContent: string,
): AgentDefinitionIdentity {
	return Object.freeze({
		...origin,
		definitionId: opaqueId(DEFINITION_DOMAIN, [origin.originId, canonicalDefinition, definitionContent]),
	});
}

/** Create an opaque host-owned origin identity from a host-canonical location. */
export async function createAgentDefinitionOriginIdentity(
	originKind: AgentDefinitionOriginKind,
	originRoot: string,
): Promise<AgentDefinitionOriginIdentity> {
	return freezeOrigin(originKind, await canonicalLocation(originRoot));
}

/** Create an immutable definition identity from an already-canonicalised directory origin. */
export async function createAgentDefinitionIdentityFromOrigin(
	origin: AgentDefinitionOriginIdentity,
	definitionLocation: string,
	definitionContent: string,
): Promise<AgentDefinitionIdentity> {
	return freezeDefinition(origin, await canonicalLocation(definitionLocation), definitionContent);
}

/** Create an immutable identity for one filesystem-backed definition and the exact content OMP parsed. */
export async function createAgentDefinitionIdentity(
	originKind: AgentDefinitionOriginKind,
	originRoot: string,
	definitionLocation: string,
	definitionContent: string,
): Promise<AgentDefinitionIdentity> {
	const [origin, canonicalDefinition] = await Promise.all([
		createAgentDefinitionOriginIdentity(originKind, originRoot),
		canonicalLocation(definitionLocation),
	]);
	return freezeDefinition(origin, canonicalDefinition, definitionContent);
}

/** Create an immutable identity for a host-embedded definition and the exact content OMP parsed. */
export function createEmbeddedAgentDefinitionIdentity(
	definitionLocation: string,
	definitionContent: string,
): AgentDefinitionIdentity {
	const origin = freezeOrigin("bundled", "@oh-my-pi/pi-coding-agent");
	return freezeDefinition(origin, definitionLocation, definitionContent);
}
