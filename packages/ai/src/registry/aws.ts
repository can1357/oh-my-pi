import * as fs from "node:fs";
import { $env, $flag } from "@oh-my-pi/pi-utils";
import { hasConfiguredAwsProfile } from "../utils/aws-profile";
import { AUTHENTICATED_SENTINEL } from "./types";

export interface AwsBedrockProviderOptions extends Readonly<Record<string, unknown>> {
	/** AWS region used in the service endpoint and SigV4 credential scope. */
	region?: string;
	/** Named AWS shared-credentials/config profile. */
	profile?: string;
	/** Amazon Bedrock API key sent as a bearer token, ahead of SigV4 credential resolution. */
	bearerToken?: string;
}

function isEc2Host(): boolean {
	// Xen instances tag DMI/hypervisor UUIDs with an `ec2` prefix. Nitro instances
	// (EKS, modern EC2) expose the instance id in board_asset_tag (`i-...`) and
	// "Amazon EC2" in the DMI vendor fields; cover both so Nitro/EKS hosts aren't
	// misread as non-EC2 (product_uuid is often mode 0400 and unreadable there).
	const checks: Array<[path: string, matches: (value: string) => boolean]> = [
		["/sys/hypervisor/uuid", v => v.startsWith("ec2")],
		["/sys/devices/virtual/dmi/id/product_uuid", v => v.startsWith("ec2")],
		["/sys/devices/virtual/dmi/id/board_asset_tag", v => v.startsWith("ec2") || v.startsWith("i-")],
		["/sys/devices/virtual/dmi/id/sys_vendor", v => v.includes("amazon ec2")],
		["/sys/devices/virtual/dmi/id/bios_vendor", v => v.includes("amazon ec2")],
	];
	for (const [candidate, matches] of checks) {
		try {
			const value = fs.readFileSync(candidate, "utf8").trim().toLowerCase();
			if (matches(value)) return true;
		} catch {
			// Missing/unreadable DMI metadata means this probe is inconclusive.
		}
	}
	return false;
}

export function hasAwsCredentialSource(): boolean {
	const hasEcsCredentials = !!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
	const hasProfile = hasConfiguredAwsProfile();
	const hasInstanceRole =
		$env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true" &&
		(!!$env.AWS_EC2_METADATA_SERVICE_ENDPOINT || isEc2Host());
	return !!(
		($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
		$env.AWS_BEARER_TOKEN_BEDROCK ||
		hasWebIdentity ||
		hasProfile ||
		hasEcsCredentials ||
		hasInstanceRole
	);
}

/** Registry key marker for AWS transports that resolve their own bearer/IAM credentials. */
export function resolveAwsRegistryApiKey(options?: { allowSkipAuth?: boolean }): string | undefined {
	if (options?.allowSkipAuth && $flag("AWS_BEDROCK_SKIP_AUTH")) return AUTHENTICATED_SENTINEL;
	return hasAwsCredentialSource() ? AUTHENTICATED_SENTINEL : undefined;
}

/** Resolve a real AWS bearer token while filtering the registry's auth marker. */
export function resolveAwsBearerToken(apiKey?: string, bearerToken?: string): string | undefined {
	const resolvedApiKey = apiKey === AUTHENTICATED_SENTINEL ? undefined : apiKey;
	return bearerToken || resolvedApiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
}
