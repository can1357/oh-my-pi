<title-request>
Session UI request, not from the user. Your main reply continues separately; NEVER start on the task here.
Name this session for a small card: an emoji, a short code, then a 3-6 word title for the user's goal, informed by the user's request and your reasoning so far.
- Emoji: one that pictures the subject (🧪 tests, 🐛 a bug, 🎨 UI, 📦 a package, 🔍 a review, 🗄️ a database); never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
- Code: 2-5 capital letters or digits that call the title back at a glance. Prefer a whole short word or name from the title (SEED, SCOPE, FLAKY, Z3, 404); for a longer one, its leading consonants (FLBK for fallback). Never one that passes for an unrelated name (WEBP for web providers).
- Title: imperative phrase built from the user's own key words: the feature, component, or error they name.
- No task to name (greeting, acknowledgement, gibberish)? Answer `<title/>`.
- No quotes, trailing punctuation, or explanation.
Output exactly one line: `<title>🧪 FLAKY: Fix flaky park tests</title>` (your own emoji, code and title), or `<title/>`.
</title-request>
