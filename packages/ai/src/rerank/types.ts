import type { Usage } from "@oh-my-pi/pi-catalog/types";

export interface RerankRequest {
	query: string;
	documents: string[];
	topN?: number;
	returnDocuments?: boolean;
}

export interface RerankResultItem {
	index: number;
	relevanceScore: number;
	document?: string;
}

export interface RerankResult {
	results: RerankResultItem[];
	model: string;
	usage: Usage;
}
