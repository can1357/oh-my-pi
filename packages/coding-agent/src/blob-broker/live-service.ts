import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Shape } from "@oh-my-pi/snapcompact";
import type { Settings } from "../config/settings";
import type { ProviderFileCredentialResolver } from "./provider-file-credential";
import type * as Broker from "./service";
import type { ImageUrlService, SnapcompactFrameSink } from "./service";
import { cfgImagesUrls, cfgImagesUrlsEnabled } from "./settings";

/**
 * Settings-bound {@link ImageUrlService} holder. Consult {@link current} per
 * request: any `images.urls.*` change stops the old service and builds a new
 * one (or none when disabled). Call {@link dispose} when the session ends.
 */
export class LiveImageUrlService implements SnapcompactFrameSink {
	#settings: Settings;
	#projectDir: () => string;
	#resolveCredential: ProviderFileCredentialResolver;
	#current: ImageUrlService | undefined;
	#generation = 0;
	#unwatch: () => void;

	constructor(settings: Settings, projectDir: () => string, resolveCredential: ProviderFileCredentialResolver) {
		this.#settings = settings;
		this.#projectDir = projectDir;
		this.#resolveCredential = resolveCredential;
		this.#current = this.#build();
		this.#unwatch = cfgImagesUrls.listen(settings, () => this.#rebuild());
	}

	/** Service for the next request; `undefined` when image URLs are disabled. */
	get current(): ImageUrlService | undefined {
		return this.#current;
	}

	/** Bumped on every rebuild: frames minted by a replaced service no longer resolve. */
	get generation(): number {
		return this.#generation;
	}

	/** Lazy snapcompact frames from the current service; `null` (render eagerly) while disabled. */
	async framesFor(text: string, shape: Shape, maxFrames?: number): Promise<ImageContent[] | null> {
		const service = this.#current;
		return service ? service.frameSink.framesFor(text, shape, maxFrames) : null;
	}

	/** Decorate `context` through the current service; identity when disabled. */
	async decorateContext(context: Context, model: Model): Promise<Context> {
		const service = this.#current;
		return service ? service.decorateContext(context, model) : context;
	}

	/** Stop observing settings and shut down the current service. */
	dispose(): void {
		this.#unwatch();
		this.#current?.stop();
		this.#current = undefined;
	}

	#build(): ImageUrlService | undefined {
		if (!cfgImagesUrlsEnabled.get(this.#settings)) return undefined;
		// Backend clients and transports are only needed when image URL publishing is enabled.
		const { createImageUrlServiceFromSettings }: typeof Broker = require("./service");
		const service = createImageUrlServiceFromSettings(this.#settings, this.#projectDir(), this.#resolveCredential);
		service?.prewarm();
		return service;
	}

	#rebuild(): void {
		const previous = this.#current;
		this.#generation++;
		this.#current = this.#build();
		previous?.stop();
		logger.debug("blob-broker: image URL service rebuilt from settings", { enabled: this.#current !== undefined });
	}
}
