<title-request>
Session UI request, not from the user. Your main reply continues separately; NEVER start on the task here.
Name this session for a small card: an emoji, a short code, then a 3-6 word title for the user's goal, informed by the user's request and your reasoning so far.
- Emoji: one that pictures the subject (🧪 tests, 🐛 a bug, 🎨 UI, 📦 a package, 🔍 a review, 🗄️ a database); never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
- Code: 2-5 capital letters or digits, never more, that name the subject at a glance, made from one word or name in the title: the whole word when it has 5 letters or fewer (SEED, SCOPE, FLAKY, Z3, 404), else cut to its first syllable or leading consonants (PROV for provider, FRZ for freeze). Never initials of several words unless the user writes them so (CTA, SDK), nor a code that passes for an unrelated name.
- Title: imperative phrase built from the user's own key words: the feature, component, or error they name.
- No task to name (greeting, acknowledgement, gibberish)? Answer `<title/>`.
- No quotes, trailing punctuation, or explanation.
Output exactly one line: `<title>🧪 FLAKY: Fix flaky park tests</title>` (your own emoji, code and title), or `<title/>`.
</title-request>
