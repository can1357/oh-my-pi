<title-request>
Session UI request, not from the user. Your main reply continues separately; NEVER start on the task here.
{{#if card}}
Name this session for a small card: an icon, a short code, then a 3-6 word title for the user's goal, informed by the user's request and your reasoning so far.
{{else}}
Name this session with a 3-6 word title for the user's goal, informed by the user's request and your reasoning so far.
{{/if}}
{{#if nerdFonts}}
- nf: the Nerd Fonts class name (nf-md-*, nf-cod-*, nf-dev-*, nf-fa-*, nf-oct-*, nf-seti-*) of the most specific picture of this session's subject, one that tells it apart from the user's other sessions in the same project:
  - the concrete object or feature the title names (nf-md-file_tree for a directory walker); a variant only when it pictures the change itself (nf-md-bell_off for muting notifications);
  - a logo whenever the session is about that language, tool or service (nf-dev-docker for Docker builds), never just because the project is written in it;
  - a bug, flask, speedometer, gear or terminal only when the session is about that very thing, never as a stand-in for the kind of work (any fix, test, speedup or setting) or the project's own domain;
  Only a name you are certain exists; never invent one.
- emoji: the same picture as an emoji, for where the icon font is missing; never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
{{else if card}}
- emoji: the most specific emoji picture of this session's subject, one that tells it apart from the user's other sessions in the same project: the concrete object or feature the title names (🌲 for a directory walker, 🔕 for muting notifications); a mascot or symbol whenever the session is about that language, tool or service (🐳 for Docker builds), never just because the project is written in it; 🐛, 🧪 or ⚡ only when the session is about that very thing, never as a stand-in for the kind of work (any fix, test or speedup); never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
{{/if}}
{{#if card}}
- code: 1-6 capital letters or digits, never more, that name the subject at a glance, made from one word or name in the title: the whole word when it has 6 letters or fewer (SEED, SCOPE, FREEZE, Z3, 404), else cut to its first syllable or leading consonants (PROV for provider, FLBK for fallback). Never initials of several words unless the user writes them so (CTA, SDK), nor a code that passes for an unrelated name.
{{/if}}
- Title: imperative phrase built from the user's own key words: the feature, component, or error they name.
- No task to name (greeting, acknowledgement, gibberish)? Answer `<title/>`.
- No quotes, trailing punctuation, or explanation.
{{#if nerdFonts}}
Output exactly one line: `<title nf="nf-md-parking" emoji="🅿️" code="PARK">Fix flaky park tests</title>` (your own icon, emoji, code and title), or `<title/>`.
{{else if card}}
Output exactly one line: `<title emoji="🅿️" code="PARK">Fix flaky park tests</title>` (your own emoji, code and title), or `<title/>`.
{{else}}
Output exactly one line: `<title>Fix flaky park tests</title>` (your own title), or `<title/>`.
{{/if}}
</title-request>
