# ERRATA — GPT-5 Harmony-Header Leakage

Historical research note, not a current runtime contract. The statistics below
come from the named local stats database snapshot, not from checked-in tests or
runtime code.

## Current runtime mitigation

Current behavior is implemented in
`packages/ai/src/utils/harmony-leak.ts` and
`packages/agent/src/agent-loop.ts`:

- Requests to Harmony-dialect models escape reserved `<|...|>` spellings in
  untrusted text, tool results, and serialized tool arguments before replay.
- Response leak detection is enabled for every model whose provider is
  `openai-codex`, rather than for a fixed model-ID list.
- A bare `to=functions.NAME` marker in thinking or tool arguments is not
  sufficient. Detection there requires a co-signal (channel adjacency, glitch
  token, script mismatch, cascade, fake-result framing, or a trusted
  trailing-parse boundary). In the *visible answer* the marker trips on its own
  (`V`): fenced blocks and inline code spans are exempt, and documentation, bug
  reports and this repository's tests all quote the marker in backticks.
- The visible answer is additionally scanned for marker-free prior collapse
  (§2.9): staccato line runs (`D`), fabricated harness notices (`N`), stranded
  non-Latin script residue (`S`), and fabricated harness envelopes (`E`) — the
  model writing omp's own `<system-notice>` / `<job-progress>` wrapper tags into
  its answer. Thinking blocks are exempt: they are legitimately staccato and
  legitimately multilingual.
- The agent loop scans finalized visible text and thinking. On a hit it discards
  the partial response and retries up to two times, then escalates with an
  error. Audit callbacks receive action/signal metadata and a hash/redacted
  preview of removed content.
- Tool-argument detection is intentionally inert unless a caller supplies the
  byte offset where a structurally valid tool parse ended. The main agent loop
  does not currently supply that boundary, avoiding false aborts on legitimate
  tool data that discusses the protocol.
- Recovery support exists for bounded free-form `eval` input and the current
  hashline `edit` DSL (input beginning with `@`): it truncates at the
  contaminated line and appends `*** Abort`. Apply-patch envelopes and
  JSON-schema edit inputs are not recovery-eligible and use abort/retry when a
  bounded detection is available.

The corpus tables below describe the historical input formats present in that
snapshot; they are not a list of the current `edit` tool's accepted syntaxes.

## 1. The problem

OpenAI frames tool calls in the Harmony chat protocol:

```
<|start|>assistant<|channel|>commentary to=functions.<NAME><|message|>{ARGS}<|call|>
```

`<|channel|>commentary to=functions.NAME` is the **routing header** —
control tokens consumed by the runtime to dispatch the call. These
tokens never appear as content under normal operation; the runtime
strips them.

The defect: gpt-5 models occasionally emit, **as ordinary content
inside `{ARGS}`**, the **plain-text shadow** of these routing tokens —
the same characters without the `<|…|>` brackets — and continue
producing more pseudo-routing structure (channel name, body marker,
multilingual spam, fake tool-result framing). The contamination lives
inside the visible tool argument and is dispatched to the tool as if it
were intended content.

**Critical detail.** The actual `<|start|>` / `<|channel|>` /
`<|message|>` / `<|call|>` special tokens almost never appear in tool
args. What leaks is the bracket-less spelling — `analysis to=functions.X
code …` — because OpenAI applies a logit mask suppressing the
control-token IDs inside the args region. The mass that would have gone
to those special tokens redistributes onto the un-bracketed plain-text
representation the model also learned. This makes the leak structurally
invisible to the routing parser and lands it in the tool input verbatim.

Manifestation in tool args (real corpus example):

```
~      add_function(iso, ctx, ns, "installSystemChangeObserver",
        os_install_system_change_observer);】【"】【analysis to=functions.edit
        code above เงินไทยฟรีuser to=functions.edit code …
```

The leading code is real and intended. Everything after the first
non-Latin token through the next clean structural boundary is corruption.

---

## 2. Observed statistics & failure modes

Source: `~/.omp/stats.db` (`ss_tool_calls`, `ss_assistant_msgs`), through
2026-05-10. 1.05M tool calls scanned.

### 2.1 Rate

| Model         | Leaks in tool args |   Calls | per million |
| ------------- | -----------------: | ------: | ----------: |
| gpt-5.4       |                 37 | 226,957 |         163 |
| gpt-5.3-codex |                 17 | 112,243 |         151 |
| gpt-5.5       |                  2 |  80,750 |          25 |
| gpt-5.2-codex |                  0 |       — |           — |

Plus 15 hits in assistant visible text / thinking blobs.

### 2.2 Tool distribution

| Tool                           |   Hits |
| ------------------------------ | -----: |
| `edit`                         |     38 |
| `eval`                         |     11 |
| `report_tool_issue`            |      3 |
| `grep`/`read`/`search`/`yield` | 1 each |

Concentrated in tools with free-form (non-JSON-schema) argument formats.

### 2.3 Leak shape (deterministic)

```
LEAK         ::= JUNK_PREFIX MARKER CHANNEL_BODY (LEAK)?
MARKER       ::= "to=functions." TOOL_NAME
CHANNEL_BODY ::= " code " (SPAM | reasoning_prose | fake_tool_output)*
JUNK_PREFIX  ::= (GLITCH_TOKEN | CHANNEL_WORD | NON_LATIN_RUN | "}" | "】【")+
```

**Cascading is common.** Of 96 marker occurrences across 71 contaminated
records, 39 contain ≥2 markers and 7 contain ≥3 — the model emits
multiple fake `to=functions.X code …` blocks back-to-back, often with
fake `code_output\nCell N:\n…` framing between them. Once the
plain-text scaffolding is in the residual stream, the prefix now _looks
like_ a fresh tool envelope start, so the macro prior over continuations
keeps voting for more scaffolding. Self-amplifying.

### 2.4 Glitch tokens

Single-token identifiers in `o200k_base` whose embeddings appear to be
near-init from underrepresentation in post-training. ASCII residue
immediately before the marker in the natural corpus:

| Surface string    | Single-token | Token ID |                  Hits in corpus |
| ----------------- | :----------: | -------: | ------------------------------: |
| `Japgolly`        |      ✅      |  199,745 |                               1 |
| `Jsii`            |      ✅      |  114,318 | (subtoken of `Jsii_commentary`) |
| `Jsii_commentary` |  — (3 toks)  |        — |                               2 |
| `changedFiles`    |  — (2 toks)  |        — |                               8 |
| `RTLU`            |  — (2 toks)  |        — |                               3 |

`Japgolly` is in the last 0.13% of the vocabulary — the same family of
GitHub-corpus residue that produced `SolidGoldMagikarp` in the 2023
GPT-2 vocabulary (Rumbelow & Watkins). `SolidGoldMagikarp` itself
tokenizes to 5 tokens in `o200k_base` — that specific token was retired,
but the class wasn't.

For the multi-token entries, the corpus-level signature is the surface
string; the underlying glitch trigger is a sub-token (e.g. `Jsii` inside
`Jsii_commentary`). The detector list (`G` signal) keys on the surface
strings.

Stable across unrelated sessions. Treated as a high-precision detector
signal.

### 2.5 Channel-word leakage

`analysis` (5), `assistant` (5), `commentary` (3), `user` (1) appear
directly preceding `to=`. Always bare words; never `<|channel|>analysis`
or any other bracketed form. Consistent with §1 — the brackets are
masked, the words are not.

### 2.6 Non-Latin spam residue

96 marker hits, by script: CJK 40, Cyrillic 12, Telugu/Kannada/Malayalam
18, Thai 8, Georgian 7, Armenian 7, Arabic 1. Recurring fragments are
Chinese gambling SEO (`大发时时彩`, `天天中彩票`), Georgian/Abkhaz junk,
and Thai casino spam — well-known low-quality crawl residue.

This is the same script distribution observed in the controlled
reproduction (§7.3), independent of the prompt's natural language.

### 2.7 Failure-mode breakdown for the `edit` tool

The `edit` tool exists in two variants in the corpus:

| Variant                                            | Calls | Recovery                                                                                                                                             |
| -------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch-DSL (`[PATH#TAG]`/anchor/`SWAP DEL INS` ops) |    27 | **Recoverable** by op-truncation (§3.3)                                                                                                              |
| JSON-schema (`{path,edits:[…]}`)                   |    11 | **Not recoverable** — contamination is escaped _inside_ JSON strings, parser accepts it cleanly, content would be written verbatim into source files |

For Patch-DSL leaks specifically:

- 20/27 cases: contamination on the last input line; nothing follows.
- 7/27 cases: contamination mid-input; what follows is one of: a
  duplicate replay of an earlier file/anchor, intended content for a
  _different_ tool call (the model started its next call inline), or
  pure hallucination. Post-contamination content is never trustworthy.

### 2.8 Mechanism (confirmed)

**Prior collapse from null-embedding glitch tokens, into a
control-token-masked basin whose mass redistributes onto the
plain-text shadow of the Harmony protocol.**

Step by step:

1. The model is mid-`{ARGS}` of a Harmony tool call. The runtime applies
   a logit mask suppressing structural control tokens (`<|channel|>`,
   `<|message|>`, `<|call|>`, `<|start|>`, `<|end|>`) inside the args
   region. Without this mask, normal generation would constantly
   hallucinate envelope-closes; with it, those token IDs have logit
   `-∞` in args.
2. A glitch token `g` is sampled. By construction `g` was in the BPE
   merge corpus but barely in LM/RL training, so its **input embedding
   `e_g` ≈ near-init noise of small norm**.
3. At position t+1, the residual update `h_{t+1} ≈ LN(h_t + e_g + Attn +
MLP)` is dominated by the prefix-derived terms; the just-emitted-token
   signal is effectively absent. Generation diversity normally comes
   from `e_x` steering the residual into different sub-regions —
   stripped here.
4. The next-token distribution therefore collapses onto the **conditional
   prior over continuations of the prefix, with local conditioning
   removed**. In a tool-calling rollout context, that prior is sharply
   peaked on Harmony scaffolding (control tokens + routing tokens) —
   that's what RL trained.
5. The mask zeros the control-token IDs. Mass redistributes onto the
   **next-best continuation**: the un-bracketed surface-form spelling of
   the same protocol (`analysis`, `commentary`, ` to=functions.X`,
   `code`). This spelling is unmasked because those characters are
   ordinary tokens.
6. Once a few tokens of plain-text scaffolding land in the residual
   stream, the prefix now resembles a fresh envelope start. The macro
   prior keeps voting for more scaffolding. Cascading (§2.3) follows.
7. Multilingual spam after the marker is the same prior-collapse
   continuation, drawn from the training neighborhood of the glitch
   token (often ESL/auto-generated multilingual web junk — exactly the
   crawl residue in §2.6).

**Two corollaries the corpus data demanded but only the experiment
explained:**

- **The brackets never appear** (§1, §2.5). The mask is what makes the
  leak land in plain text instead of as a real envelope-close.
- **Counterintuitive grammar dependency** (§7.4). The leak is _worse_ in
  formats closest to OpenAI's training distribution. Off-distribution
  custom grammars dampen the macro-prior basin; the official
  `*** Begin Patch` format is the strongest collapse target.

The 2023 SolidGoldMagikarp paper documented mechanism (1)+(2)+(4). The
new piece is (5): when constrained decoding masks the natural collapse
target, the mass laundered through the un-masked plain-text shadow
becomes a structurally-invisible exfiltration channel.

### 2.9 Marker-free collapse in the visible channel (gpt-5.6)

Source: 264 persisted omp sessions, 6,127 assistant text blocks and 52,431
thinking blocks, 2026-08-13 .. 2026-09-10, scanned with the shipped detector.

§2.8 steps 4–7 do not require the routing marker to survive. When the tool-name
token is simply unavailable, the collapse still happens and lands in the *final
answer* with no marker at all. Every marker-anchored signal (`C`/`G`/`S`/`B`/`R`)
is therefore blind to it: the earlier detector needed `M` before it would
evaluate any co-signal.

Five shapes, all observed:

| Signal | Shape | Blocks |
| ------ | ----- | -----: |
| `N` | Fabricated harness notice — `You have 1431 weighted tokens left`, a repeated single letter (`a a`), or an interactive consent dialog as the entire answer | 150 |
| `D` | Staccato run — one short clause per line, whitespace-only separators between them: `stop.` `no.` `end.` `done.` `final.` | 56 |
| `S` | Script residue stranded in an ASCII answer, including substitution *inside* an ASCII word: `declauding` rendered as `declაუდing` 14 times in one session | 24 |
| `V` | A bare `to=functions.NAME` marker rendered in the final answer, outside code | 3 |
| `E` | Fabricated harness envelope — the model writing omp's own injected `<system-notice>` / `<job-progress>` wrapper tags into its answer | 2 |

219 distinct blocks across 5 sessions and 3 projects, counting a block once per
signal set (so the per-signal column sums higher). Zero hits on the other 259
sessions and zero on all 52,431 thinking blocks.

Three observations that matter for the runtime contract:

- **The notice text is fabricated, not echoed.** No omp surface emits
  `You have N weighted tokens left`; the phrase appears nowhere in the harness
  or in the session's system prompt, which explicitly forbids narrating token
  budgets. The model invented a system-notice-shaped string and rendered it to
  the user.
- **Recurrence is driven by replay, not by the provider.** In the
  2026-09-09T15-58-05Z session the first contaminated turn is 63 minutes and 412
  records before the first full cascade; the same fragment reappears verbatim.
  Remote compaction preserves provider-native history, so `/compact` does not
  clear it. Detection has to fire on the *first* contaminated turn, which is why
  `V` trips on a bare marker in a rendered answer.
- **The collapse target is whatever protocol the model has been conditioned
  on.** §2.8 describes mass landing on the plain-text shadow of the *Harmony*
  envelope. In 2026-09-09T16-02-08Z it landed on the plain-text shadow of the
  *omp* envelope instead: one 357,273-character answer block fabricated 824
  `<system-notice>` wakes, incremented their `elapsed` attribute from `9.1s` to
  `33d23h`, and answered each of its own fabricated wakes — `No.` 167 times,
  then `34d. I'll quit.`, then `I will now actually send a final message.` The
  mechanism is identical; only the scaffolding the model reaches for changed.
  `E` therefore detects harness-envelope fabrication directly, independent of
  any Harmony marker.

Thresholds are measured against that corpus, not chosen:

- `D` requires 5 consecutive staccato lines that also *look* collapsed: mean
  line length ≤ 12 characters and at least half the lines sentence-terminated.
  Line count alone is not enough — the longest clean short-line run in the
  corpus is 8, a parts enumeration (`platen clip` / `crankshaft` / …) with mean
  length 12.2 and no terminators. The longest clean run carrying the collapse
  shape is 4, against a threshold of 5.
- `N`'s consent-dialog form matches only when the prompt is the *whole* answer
  (≤200 characters). 115 corpus blocks are nothing but that dialog, while prose
  discussing it — this document, the bug reports, the 4.7 KB answer that first
  described the shape — stays clean.
- `S` allows at most 8 non-Latin characters in a block that is ≥90% ASCII, and
  additionally requires the run to be *stranded*: abutting an ASCII letter, or
  opening its own line without being a cited word — alone on the line, or with
  something glued to it (`ាន? Wait ...`). A whitespace-delimited term stays
  clean wherever it sits in the sentence ("the Japanese word for cat is 猫",
  "猫 means cat in Japanese"). Genuinely multilingual answers blow the budget.
- `V` and `E` are exempt inside fenced blocks, inline code spans, indented code
  blocks, and matched `<code>…</code>` pairs, which the TUI's
  `collapseInlineHtml` renders as inline code. Fences and spans are parsed per
  CommonMark. A fence closes only on a repeat of the opener's character, at
  least as long, with no info string — naive toggling let a ```` ```xml ````
  block nested in a ```` ```text ```` block close the outer fence early, which
  produced the only false positive measured across the corpus. An inline span
  needs a closing run of *equal* length, ignores backslash-escaped backticks,
  may cross a single line break, and never leaves its leaf block: a stray
  backtick in a heading must not pair with one paragraphs later and exempt
  everything between them. An indented block cannot interrupt a paragraph, so
  a four-space continuation line inside prose is still scanned.
  A fence still opens inside a block quote, whose `>` prefix the renderer's
  lexer strips, and an HTML pair straddling two blocks does not exempt: the
  renderer pairs tags per block and drops the rest, so that marker is prose.

Fixtures: `packages/ai/test/fixtures/harmony-visible-collapse-corpus.json`.
