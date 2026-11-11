/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import {
	BUILTIN_BLOB_DESTINATIONS,
	type BlobDestinationId,
	type BlobDestinationMetadata,
} from "../blob-broker/destinations";

/**
 * Families whose uploaders replace an object in place at a stable URL and can
 * delete it, which hosted pages need. Backblaze B2 also requires its
 * S3-compatible keys; the publisher rejects native application keys.
 */
const PAGE_FAMILIES: Readonly<Record<string, true>> = { s3: true, "object-storage": true };

const DESTINATIONS: readonly BlobDestinationMetadata<BlobDestinationId>[] = Object.values(BUILTIN_BLOB_DESTINATIONS);

const PUBLISH_BACKEND_CHOICES = DESTINATIONS.filter(destination => PAGE_FAMILIES[destination.family] === true).map(
	destination => ({
		value: destination.id,
		label: destination.label,
		description: destination.reason ?? destination.family,
	}),
);

const DEFAULT_PUBLISH_BACKENDS: BlobDestinationId[] = [];

export const cfgPublishBackends = register({
	id: "publish.backends",
	type: "array",
	default: DEFAULT_PUBLISH_BACKENDS,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Publish Backends",
		description:
			"Ordered object-storage destinations for new pages from the publish tool; empty publishes to claude.ai Artifacts when logged in to Anthropic with OAuth. Options and credentials are shared with Image URL Backends",
		options: PUBLISH_BACKEND_CHOICES,
		ordered: true,
	},
});
