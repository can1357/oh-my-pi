declare const self: Worker & {
	onmessage: ((event: MessageEvent) => void) | null;
};

/**
 * Echoes every inbound message. Used to exercise the tab worker transport
 * against a real Bun worker thread: the failure it guards is Bun's own
 * `postMessage` behaviour after the thread exits, which a hand-rolled handle
 * cannot reproduce.
 */
self.onmessage = (event: MessageEvent): void => {
	self.postMessage(event.data);
};
