/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register } from "../config/registry";
import { BUILTIN_BLOB_DESTINATIONS, type BlobDestinationId, type BlobDestinationMetadata } from "./destinations";

const DEFAULT_IMAGES_URLS_BACKENDS: BlobDestinationId[] = ["provider-files", "tailscale", "cloudflared", "litterbox"];
const EMPTY_IMAGES_URLS_OPTIONS: Partial<Record<BlobDestinationId, Record<string, unknown>>> = {};
const EMPTY_IMAGES_URLS_CREDENTIALS: Partial<Record<BlobDestinationId, Record<string, string>>> = {};

const BUILTIN_BLOB_DESTINATION_METADATA: readonly BlobDestinationMetadata<BlobDestinationId>[] =
	Object.values(BUILTIN_BLOB_DESTINATIONS);

const BLOB_BACKEND_CHOICES = BUILTIN_BLOB_DESTINATION_METADATA.filter(
	destination =>
		destination.id === "provider-files" ||
		(destination.directImage && destination.status !== "incompatible" && destination.status !== "defunct"),
).map(destination => ({
	value: destination.id,
	label: destination.label,
	description: destination.reason ?? destination.family,
}));

export const cfgImagesUrlsEnabled = register({
	id: "images.urls.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Serve Images as URLs",
		description:
			"Publish outgoing images through the configured backend chain and send URL-fetching providers short URLs instead of inline base64. Falls back to inline automatically when every backend or a provider fetch fails",
	},
});

export const cfgImagesUrlsBackends = register({
	id: "images.urls.backends",
	type: "array",
	default: DEFAULT_IMAGES_URLS_BACKENDS,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image URL Backends",
		description: "Ordered destinations tried when publishing images for provider access",
		options: BLOB_BACKEND_CHOICES,
		ordered: true,
	},
});

export const cfgImagesUrlsOptions = register({
	id: "images.urls.options",
	type: "record",
	default: EMPTY_IMAGES_URLS_OPTIONS,
});

export const cfgImagesUrlsCredentials = register({
	id: "images.urls.credentials",
	type: "record",
	default: EMPTY_IMAGES_URLS_CREDENTIALS,
	credential: true,
});

export const cfgImagesUrlsCommand = register({
	id: "images.urls.command",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image Upload Command",
		description:
			"Argv template for the command backend; {file} is the image path, {mime}/{ext} optional. The last URL printed on stdout is used (e.g. pasta -b -f {file})",
	},
});

export const cfgImagesUrlsPublicBaseUrl = register({
	id: "images.urls.publicBaseUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image URL Public Base",
		description: "Externally reachable base URL fronting the blob server (required for ssh, optional for direct)",
	},
});

export const cfgImagesUrlsTtlHours = register({
	id: "images.urls.ttlHours",
	type: "number",
	default: 72,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image URL Lifetime (hours)",
		description:
			"Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs",
	},
});

export const cfgImagesUrlsBindHost = register({
	id: "images.urls.bindHost",
	type: "string",
	default: "127.0.0.1",
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image URL Bind Host",
		description: "Host the blob server binds to; loopback for tunnels, 0.0.0.0 for direct serving",
	},
});

export const cfgImagesUrlsSshTarget = register({
	id: "images.urls.sshTarget",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image URL SSH Target",
		description: "user@host destination for the ssh reverse forward",
	},
});

export const cfgImagesUrlsSshRemotePort = register({
	id: "images.urls.sshRemotePort",
	type: "number",
	default: 8787,
	ui: {
		tab: "model",
		group: "Vision",
		label: "Image URL SSH Remote Port",
		description: "Remote listen port of the ssh reverse forward that your web server proxies to",
	},
});

/** Every `images.urls.*` setting; the live image URL service rebuilds when any changes. */
export const cfgImagesUrls = combine({
	enabled: cfgImagesUrlsEnabled,
	backends: cfgImagesUrlsBackends,
	options: cfgImagesUrlsOptions,
	credentials: cfgImagesUrlsCredentials,
	command: cfgImagesUrlsCommand,
	publicBaseUrl: cfgImagesUrlsPublicBaseUrl,
	ttlHours: cfgImagesUrlsTtlHours,
	bindHost: cfgImagesUrlsBindHost,
	sshTarget: cfgImagesUrlsSshTarget,
	sshRemotePort: cfgImagesUrlsSshRemotePort,
});
