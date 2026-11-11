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
 * Families whose uploads cannot hold an HTML page: image/video hosts reject or
 * transcode it, messaging targets yield no stable page URL, and serving/tunnel
 * destinations stop answering when omp exits.
 */
const NON_PAGE_FAMILIES: Readonly<Record<string, true>> = {
	"image-host": true,
	"video-host": true,
	messaging: true,
	"provider-files": true,
	"local-serving": true,
	tunnel: true,
	"sharex-routing": true,
	"sharex-custom": true,
};

const DESTINATIONS: readonly BlobDestinationMetadata<BlobDestinationId>[] = Object.values(BUILTIN_BLOB_DESTINATIONS);

const PUBLISH_BACKEND_CHOICES = DESTINATIONS.filter(
	destination =>
		destination.status !== "incompatible" &&
		destination.status !== "defunct" &&
		NON_PAGE_FAMILIES[destination.family] !== true,
).map(destination => ({
	value: destination.id,
	label: destination.label,
	description: destination.reason ?? destination.family,
}));

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
			"Ordered destinations the publish tool uploads web pages to. Empty publishes to claude.ai Artifacts when logged in to Anthropic with OAuth. Options and credentials are shared with Image URL Backends. Object storage (S3, R2, GCS, Azure, B2, MinIO) keeps one URL across updates",
		options: PUBLISH_BACKEND_CHOICES,
		ordered: true,
	},
});
