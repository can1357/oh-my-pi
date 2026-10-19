<title-request>
Session UI request, not from the user. Your main reply continues separately; NEVER start on the task here.
Name this session for a small card: an icon, a short code, then a 3-6 word title for the user's goal, informed by the user's request and your reasoning so far.
- nf: the Nerd Fonts class name of an icon that pictures the subject (nf-md-*, nf-cod-*, nf-dev-*, nf-fa-*, nf-oct-*, nf-seti-*): a language, tool or service by its logo (nf-dev-rust, nf-dev-docker), else the thing worked on (nf-md-flask for tests, nf-cod-bug for a bug). Only a name you are certain exists; never invent one.
- emoji: the same picture as an emoji, for where the icon font is missing; never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
- code: 1-6 capital letters or digits, never more, that name the subject at a glance, made from one word or name in the title: the whole word when it has 6 letters or fewer (SEED, SCOPE, FREEZE, Z3, 404), else cut to its first syllable or leading consonants (PROV for provider, FLBK for fallback). Never initials of several words unless the user writes them so (CTA, SDK), nor a code that passes for an unrelated name.
- Title: imperative phrase built from the user's own key words: the feature, component, or error they name.
- No task to name (greeting, acknowledgement, gibberish)? Answer `<title/>`.
- No quotes, trailing punctuation, or explanation.
Output exactly one line: `<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>` (your own icon, emoji, code and title), or `<title/>`.
</title-request>
