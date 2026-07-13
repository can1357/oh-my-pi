import type { ContextArtifactPolicy } from "@pk-nerdsaver-ai/pi-context-policy";

export interface StoredArtifact {
	artifactId: string;
	contentHash: string;
	bytes: number;
	createdAt: string;
}

export interface RetrievalPrincipal {
	userId: string;
	projectId?: string;
	caseId?: string;
	sessionId?: string;
}

export interface DeletionReceipt {
	requestId: string;
	artifactIds: string[];
	deletedAt: string;
	verified: boolean;
	failures: Array<{ artifactId: string; reason: string }>;
}

/** Implementations must enforce the policy ownership fields before returning content. */
export interface ArtifactStore {
	put(content: Uint8Array, metadata: ContextArtifactPolicy): Promise<StoredArtifact>;
	getAuthorized(artifactId: string, principal: RetrievalPrincipal): Promise<Uint8Array | null>;
	deleteCascade(artifactId: string, reason: string): Promise<DeletionReceipt>;
}
