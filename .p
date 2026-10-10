diff --git a/packages/coding-agent/CHANGELOG.md b/packages/coding-agent/CHANGELOG.md
index 46d8a274843..017c3911480 100644
--- a/packages/coding-agent/CHANGELOG.md
+++ b/packages/coding-agent/CHANGELOG.md
@@ -25,6 +25,10 @@
 - Fixed a mermaid `xychart` whose axis range is finer than floating-point precision freezing the terminal ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
 - Fixed resuming a session whose saved model cannot be restored silently sending its transcript to another model. At startup, `--continue`/`--resume` in print, JSON, RPC, and `rpc-ui` modes (and in the TUI with `retry.modelFallback: false`) now exits with an error naming the model instead of using the settings-default or first available model. At runtime, RPC `open_session` and `switch_session`, ACP session load and fork, and extension session switches fail with `Could not restore model <provider/id>` and keep the current session instead of continuing on the current model; TUI `/resume` warns `Could not restore model <provider/id>. Using <provider/id>`, or fails with the error when `retry.modelFallback` is off. `/resume` also restores models from discovery-backed providers the way startup does ([#12274](https://github.com/can1357/oh-my-pi/issues/12274), [#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).
 - Auto-retry no longer switches to the fallback chain when Codex's native turn lane rejects live steering after the response streamed reasoning; the turn retries on the same model with the steering message as ordinary input, and the chain is consulted only once no same-model retry is left ([#14242](https://github.com/can1357/oh-my-pi/pull/14242) by [@alphastorm](https://github.com/alphastorm))
+### Fixed
+
+- Fixed two more Code Mode `display()` previews dropping the read continuation notice above the 8 KB model-visible cap: the streaming path on a file past `SNAPSHOT_MAX_BYTES`, which appends `[More lines in file (… total; not scanned to EOF). Use :N to continue]` and sets no `truncation` metadata, and a directory read sliced by a line selector, which appends `[N more lines in listing. Use :N to continue]`. Both now survive the cap like the byte-capped window notice did ([#12700](https://github.com/can1357/oh-my-pi/issues/12700) by [@F0Rextasy](https://github.com/F0Rextasy)).
+- Fixed a Code Mode `display()` preview dropping the read continuation notice when the value exceeded the 8 KB model-visible cap, leaving the model truncated content and no way to reach the rest. Notices are now re-attached after the elision marker inside that same cap, with any that did not fit counted in the marker, and only when they really end the field they came from, so a file that quotes the notice no longer invents a paging hint ([#12700](https://github.com/can1357/oh-my-pi/issues/12700) by [@F0Rextasy](https://github.com/F0Rextasy)).
 
 ## [18.6.2] - 2026-10-04
 
diff --git a/packages/coding-agent/src/tools/eval.ts b/packages/coding-agent/src/tools/eval.ts
index 9b5a9e9b3f6..8ea1962ea0f 100644
--- a/packages/coding-agent/src/tools/eval.ts
+++ b/packages/coding-agent/src/tools/eval.ts
@@ -157,6 +157,92 @@ interface FormattedDisplayJson {
 	spillFullValue: boolean;
 }
 
+/**
+ * Matches the serialised form because the separator is the escape `\n`, not a newline, so the line-based helper cannot see it.
+ *
+ * Each alternative is the literal opening of one notice `read` can emit at
+ * `tools/read.ts`: `Showing lines …` (a byte-capped window), `More lines in
+ * file (` (the streaming path on a file past `SNAPSHOT_MAX_BYTES`, which never
+ * reaches EOF and therefore carries no `truncation` object to describe it),
+ * `\d+ more lines in listing` (a directory read sliced by a line selector),
+ * `Some lines truncated to ` (bracket context), and the two grep match/result
+ * limits. A notice the model can act on has to survive the cap even when it
+ * is the last line of a field.
+ *
+ * The closing quote anchors each match to a field tail: `formatOutputNotice`
+ * appends the notice last, so a notice with content behind it is a file
+ * quoting the format, and re-attaching that would hand the model a paging hint
+ * for text it is not reading.
+ */
+const SERIALIZED_OUTPUT_NOTICE =
+	/\[(?:Showing |More lines in file \(|\d+ more lines in listing|Some lines truncated to |\d+ matches limit reached\. Use limit=\d+ for more|\d+ results limit reached)[^\]\\]*\](?=")/g;
+
+/** Share of the preview budget the re-attached notices may claim. */
+const NOTICE_TAIL_BUDGET_BYTES = Math.floor(MAX_DISPLAY_TEXT_BYTES / 4);
+
+interface SerializedNotice {
+	text: string;
+	/** UTF-16 offset into the serialised value, to compare against the head cut. */
+	index: number;
+}
+
+function collectSerializedNotices(fullText: string): SerializedNotice[] {
+	return [...fullText.matchAll(SERIALIZED_OUTPUT_NOTICE)].map(match => ({
+		text: match[0],
+		index: match.index ?? 0,
+	}));
+}
+
+function byteLength(text: string): number {
+	return Buffer.byteLength(text, "utf-8");
+}
+
+/**
+ * Join the re-attached notices into at most `budgetBytes`. The tail used to be
+ * appended after the truncation, so a value carrying hundreds of notices came
+ * out at 18,740 bytes against the 8,000 byte cap. Notices that do not fit are
+ * dropped and counted: a silently short tail reads as "that was all of them".
+ */
+function capNoticeTail(notices: readonly string[], budgetBytes: number): string {
+	if (notices.length === 0 || budgetBytes <= 0) return "";
+	let kept = notices;
+	while (kept.length > 1 && byteLength(kept.join("\n")) > budgetBytes) {
+		kept = kept.slice(0, -1);
+	}
+	const dropped = notices.length - kept.length;
+	const marker = dropped > 0 ? `\n[…${dropped} more notices elided…]` : "";
+	const room = budgetBytes - byteLength(marker);
+	if (room <= 0) return marker;
+	return `${truncateHeadBytes(kept.join("\n"), room).text}${marker}`;
+}
+
+/**
+ * Build the capped model-visible preview: a head-truncated prefix, the elision
+ * marker, then the notices the cut dropped. A notice is a tail line of one
+ * field, so the head cut takes it with everything else, and without the tail
+ * the model has truncated content and no way to reach the rest.
+ */
+function formatCappedPreview(fullText: string): string {
+	const headBudget = MAX_DISPLAY_TEXT_BYTES - DISPLAY_ELISION_RESERVE_BYTES;
+	const droppedAfter = (cut: number) =>
+		collectSerializedNotices(fullText)
+			.filter(notice => notice.index >= cut)
+			.map(notice => notice.text);
+	let head = truncateHeadBytes(fullText, headBudget);
+	let noticeTail = capNoticeTail(droppedAfter(head.text.length), NOTICE_TAIL_BUDGET_BYTES);
+	// The tail shares the budget with the head, so reserving its bytes shortens
+	// the head, which can drop a further notice into the tail. Settle first.
+	for (let pass = 0; pass < 4; pass++) {
+		const nextHead = truncateHeadBytes(fullText, headBudget - byteLength(noticeTail));
+		const nextTail = capNoticeTail(droppedAfter(nextHead.text.length), NOTICE_TAIL_BUDGET_BYTES);
+		if (nextHead.text === head.text && nextTail === noticeTail) break;
+		head = nextHead;
+		noticeTail = nextTail;
+	}
+	const elided = `\n[…${fullText.length - head.text.length}ch elided…]`;
+	return noticeTail ? `${head.text}${elided}\n${noticeTail}` : `${head.text}${elided}`;
+}
+
 /**
  * Format one structured `display()` value for the model text and the tool
  * `details`. The model-visible preview is always capped at
@@ -176,9 +262,7 @@ function formatDisplayJson(value: unknown, canSpill: boolean): FormattedDisplayJ
 	if (totalBytes <= MAX_DISPLAY_TEXT_BYTES) {
 		return { fullText, previewText: fullText, detailsValue: value, spillFullValue: false };
 	}
-
-	const head = truncateHeadBytes(fullText, MAX_DISPLAY_TEXT_BYTES - DISPLAY_ELISION_RESERVE_BYTES);
-	const previewText = `${head.text}\n[…${fullText.length - head.text.length}ch elided…]`;
+	const previewText = formatCappedPreview(fullText);
 	// Without an artifact to mirror into, keep the full value in details: there
 	// is no session JSONL to bloat, and discarding it would strand large
 	// displays from SDK consumers that read `details.jsonOutputs`.
