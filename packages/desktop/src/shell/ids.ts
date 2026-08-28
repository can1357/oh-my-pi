/**
 * A name no chat has ever had, and none will have again.
 *
 * The id a tab is given is the label Rust registers its sidecar under, and that
 * pool outlives the webview. So an id derived from anything the webview owns —
 * this was `new:<counter>:<cwd>`, and the counter was a ref that resets on
 * reload — collides with itself: starting a chat in a folder you had started one
 * in before a reload produced exactly the label that folder's previous sidecar
 * was still registered under. `agent_start` found it, re-pointed the stream at
 * it and reported `resumed: true`, and since the tab carried no session file
 * nothing replayed any history. The result was a blank transcript sitting on a
 * live conversation, with whatever you typed going into it.
 *
 * Derived from nothing, therefore. Two chats in one folder are two chats.
 */
export function newChatId(): string {
	return `new:${crypto.randomUUID()}`;
}
