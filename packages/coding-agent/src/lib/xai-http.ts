/** Resolved endpoint and configured headers for an xAI HTTP tool request. */
export interface XAIHttpTransport {
	baseURL: string;
	headers?: Record<string, string>;
}
