import * as path from "node:path";
import { CliUsageError } from "../../cli/usage-error";

export const REQUIRED_EXTENSION_RECEIPT_SCHEMA = "omp.required-extension-load.v1" as const;

export interface RequiredExtensionSpec {
	readonly path: string;
	readonly sha256: string;
}

export interface RequiredExtensionOptionsInput {
	requiredExtensions?: readonly string[];
	requiredExtensionSha256?: readonly string[];
	extensionLoadReceipt?: string;
	extensions?: readonly string[];
	hooks?: readonly string[];
	trustedExtensions?: readonly string[];
}

export interface RequiredExtensionOptions {
	readonly requiredExtensions: readonly RequiredExtensionSpec[];
	readonly extensionLoadReceipt?: string;
	/** Internal in-process source snapshots captured during verified loading. */
	readonly sourceSnapshots?: ReadonlyMap<string, string>;
}

export type RequiredExtensionValidationCode =
	| "count-mismatch"
	| "invalid-path"
	| "invalid-digest"
	| "duplicate-path"
	| "receipt-without-required"
	| "conflicting-extension";

export class RequiredExtensionValidationError extends CliUsageError {
	constructor(
		readonly code: RequiredExtensionValidationCode,
		message: string,
	) {
		super(message);
	}
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Validate and pair the repeatable required-extension CLI values. This is
 * shared by argv parsing and the session loader so callers cannot bypass the
 * required-mode invariants by constructing session options directly.
 */
export function validateRequiredExtensionOptions(
	input: RequiredExtensionOptionsInput,
): RequiredExtensionOptions | undefined {
	const paths = input.requiredExtensions ?? [];
	const digests = input.requiredExtensionSha256 ?? [];
	const hasRequiredValues = paths.length > 0 || digests.length > 0;

	if (paths.length !== digests.length) {
		throw new RequiredExtensionValidationError(
			"count-mismatch",
			`--required-extension and --required-extension-sha256 must be supplied the same number of times (got ${paths.length} and ${digests.length})`,
		);
	}
	if (input.extensionLoadReceipt !== undefined && !hasRequiredValues) {
		throw new RequiredExtensionValidationError(
			"receipt-without-required",
			"--extension-load-receipt requires at least one --required-extension",
		);
	}
	if (
		hasRequiredValues &&
		((input.extensions?.length ?? 0) > 0 ||
			(input.hooks?.length ?? 0) > 0 ||
			(input.trustedExtensions?.length ?? 0) > 0)
	) {
		throw new RequiredExtensionValidationError(
			"conflicting-extension",
			"--required-extension mode cannot be combined with --extension, --hook, or --trusted-extension",
		);
	}
	if (!hasRequiredValues) return undefined;

	const seen = new Set<string>();
	const requiredExtensions: RequiredExtensionSpec[] = [];
	for (let index = 0; index < paths.length; index++) {
		const extensionPath = paths[index];
		if (!path.isAbsolute(extensionPath)) {
			throw new RequiredExtensionValidationError(
				"invalid-path",
				`--required-extension paths must be absolute: ${extensionPath}`,
			);
		}
		if (seen.has(extensionPath)) {
			throw new RequiredExtensionValidationError(
				"duplicate-path",
				`--required-extension path was supplied more than once: ${extensionPath}`,
			);
		}
		seen.add(extensionPath);
		const sha256 = digests[index].toLowerCase();
		if (!SHA256_RE.test(sha256)) {
			throw new RequiredExtensionValidationError(
				"invalid-digest",
				`--required-extension-sha256 must be exactly 64 hexadecimal characters: ${digests[index]}`,
			);
		}
		requiredExtensions.push({ path: extensionPath, sha256 });
	}

	return {
		requiredExtensions,
		extensionLoadReceipt: input.extensionLoadReceipt,
	};
}
