import type { BlobDestinationId } from "./destinations";

/** A replayable HTTP request that removes a remotely published blob. */
export interface RemoteDeleteAction {
	/** HTTP method required by the destination. */
	method: "DELETE" | "GET" | "POST";
	/** Absolute deletion endpoint. */
	url: string;
	/** Destination-specific request headers. */
	headers?: Readonly<Record<string, string>>;
	/** Destination-specific request body. */
	body?: string;
}

/** The durable result of publishing a blob to a destination. */
export interface BlobPublication {
	/** Public URL of the uploaded bytes. */
	url: string;
	/** Registry destination that produced the publication. */
	destination: BlobDestinationId;
	/** Number of bytes uploaded. */
	bytes: number;
	/** Unix epoch milliseconds after which the publication may be unavailable. */
	expiresAt?: number;
	/** Replayable action for removing the remote object. */
	delete?: RemoteDeleteAction;
	/** Provider-assigned object identifier. */
	remoteId?: string;
}

/** Immutable input supplied to a blob uploader. */
export interface BlobUploadRequest {
	/** Raw blob bytes. */
	bytes: Uint8Array;
	/** Internet media type of the blob. */
	mimeType: string;
	/** File extension without a leading dot. */
	extension: string;
	/** Preferred remote filename when a backend supports naming. */
	filename?: string;
}

/** A configured destination capable of publishing blobs. */
export interface BlobUploader {
	/** Registry destination implemented by this uploader. */
	readonly destination: BlobDestinationId;
	/** Publish one blob and return its durable publication metadata. */
	upload(request: BlobUploadRequest): Promise<BlobPublication>;
}
