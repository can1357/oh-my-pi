//! Type-checker and linter output filters.

use std::collections::BTreeMap;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	supports_program("", subcommand)
}

#[must_use]
pub fn supports_program(program: &str, subcommand: Option<&str>) -> bool {
	// Program-claim the JS type-checker/linters too: without this, a path-arg
	// invocation (`tsc --project x`, `eslint src/`, `biome ci app/`,
	// `oxlint src/`) resolves its subcommand to the path token, which is not in
	// the subcommand allowlist below, so the invocation would route UNFILTERED.
	// detect.rs yields these exact program tokens (see its
	// `detects_direct_lint_tools` test). Claiming the program makes the engine
	// pick the Rust path first; the residual defs/biome.toml & defs/oxlint.toml
	// remain as fallback for any unclaimed subcommand only.
	matches!(
		program,
		"ruff"
			| "mypy"
			| "rubocop"
			| "pyright"
			| "basedpyright"
			| "tsc"
			| "eslint"
			| "biome"
			| "oxlint"
	) || matches!(subcommand, None | Some("check" | "lint" | "run" | "format" | "fmt" | "typecheck"))
}

/// JS type-checker/linter programs whose human (non-JSON) output carries
/// code-frame body lines, underline rows, and tool-specific success/progress
/// chatter. The frame/noise strips below are gated to these programs so the
/// shared ruff/mypy/rubocop/pyright paths keep their existing behavior.
fn is_js_lint_program(program: &str) -> bool {
	matches!(program, "tsc" | "eslint" | "biome" | "oxlint")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_machine_readable_output(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let text = condense_lint_output(ctx.program, input, exit_code);
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

#[must_use]
pub fn condense_lint_output(program: &str, input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = strip_lint_noise(program, &cleaned, exit_code);
	if program == "eslint" {
		// eslint's default "stylish" output puts the file path on its own
		// non-indented header line and the diagnostics on the following indented
		// `L:C  severity  message  rule-id` rows. group_diagnostics expects the
		// file on the SAME line as the location, so reshape stylish into
		// per-diagnostic `file:line:col: …` lines first, then derive a Top-rules
		// summary from the trailing rule-id column (rtk's idea, re-derived from
		// DEFAULT text output, not JSON).
		if let Some(rendered) = render_eslint_stylish(&stripped) {
			return primitives::head_tail_lines(&rendered, 180, 100);
		}
	}
	let grouped = group_diagnostics(&stripped);
	primitives::head_tail_lines(&grouped, 180, 100)
}

fn strip_lint_noise(program: &str, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_lint_noise(program, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn preserves_machine_readable_output(ctx: &MinimizerCtx<'_>) -> bool {
	// pyright/basedpyright --outputjson
	if matches!(ctx.program, "pyright" | "basedpyright")
		&& ctx
			.command
			.split_whitespace()
			.any(|part| part == "--outputjson" || part.starts_with("--outputjson="))
	{
		return true;
	}
	// eslint with an explicit non-default formatter (-f / --format with value !=
	// stylish)
	if ctx.program == "eslint" {
		let tokens: Vec<&str> = ctx.command.split_whitespace().collect();
		for (i, t) in tokens.iter().enumerate() {
			if (*t == "-f" || *t == "--format") && tokens.get(i + 1).is_some_and(|v| *v != "stylish") {
				return true;
			}
			if let Some(val) = t.strip_prefix("--format=")
				&& val != "stylish"
			{
				return true;
			}
		}
	}
	false
}

fn is_lint_noise(program: &str, line: &str, exit_code: i32) -> bool {
	// eslint's `N error(s) … potentially fixable with the --fix option.` hint is
	// actionable chatter, not a diagnostic; drop it while keeping the
	// `✖ N problems (…)` summary line. Checked ahead of the diagnostic-signal
	// guard below because the hint itself contains the word "error".
	// (snip strips on `potentially fixable`.)
	if program == "eslint" && line.contains("potentially fixable") {
		return true;
	}
	// Code-frame / underline / box-drawing / progress chatter is stripped even at
	// exit!=0: these rows carry no diagnostic of their own, and oxlint's
	// `Found N warning…` / biome's `Fixed N file…` summaries match the
	// diagnostic-signal guard below only incidentally (the word "warning"). The
	// `× message` diagnostic rows are never matched here, so they survive.
	if is_js_lint_program(program) && is_js_frame_noise(program, line) {
		return true;
	}
	// pyright/basedpyright emit a version banner plus source-discovery progress
	// before the diagnostics. None of these rows carry a diagnostic, so strip them
	// even at exit!=0. Scoped to pyright/basedpyright so the other linters'
	// equivalent-looking lines (e.g. an oxlint `Found N warnings` summary) are not
	// caught here. (Ported from rtk/src/filters/basedpyright.toml strip patterns.)
	if matches!(program, "pyright" | "basedpyright") && is_pyright_banner_noise(line) {
		return true;
	}
	if exit_code != 0 && contains_diagnostic_signal(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	lower.starts_with("checked ")
		|| lower.starts_with("found 0")
		|| lower.starts_with("success:")
		|| lower.starts_with("all matched files")
		|| lower.starts_with("done in ")
		|| matches!(program, "eslint" | "biome") && lower.starts_with("warning: react version")
		|| matches!(program, "ruff") && lower.starts_with("all checks passed")
		|| matches!(program, "mypy") && lower.starts_with("success: no issues found")
		|| matches!(program, "pyright" | "basedpyright") && lower.starts_with("0 errors, 0 warnings")
		|| matches!(program, "rubocop")
			&& (lower.starts_with("inspecting ")
				|| lower == "offenses:"
				|| lower.ends_with(" files inspected, no offenses detected"))
}

/// pyright/basedpyright banner/progress noise: the version banner and the
/// source-file-discovery progress lines that precede the diagnostics. `line`
/// arrives already trimmed (see `strip_lint_noise`). Re-derived from
/// rtk/src/filters/basedpyright.toml's `strip_lines_matching` patterns:
///   `^Searching for source files`, `^Found \d+ source file`,
///   `^Pyright \d+\.\d+`, `^basedpyright \d+\.\d+`.
/// The blank-line pattern (`^\s*$`) is already handled by `strip_lint_noise`.
fn is_pyright_banner_noise(line: &str) -> bool {
	if line.starts_with("Searching for source files") {
		return true;
	}
	// `Pyright 1.1.0` / `basedpyright 1.22.0`: program token then a `MAJOR.MINOR`
	// version. Matched by a literal prefix plus a dotted-digit check on the rest so
	// a stray diagnostic message beginning with the word is not swept up.
	if let Some(rest) = line
		.strip_prefix("Pyright ")
		.or_else(|| line.strip_prefix("basedpyright "))
		&& starts_with_dotted_version(rest)
	{
		return true;
	}
	// `Found 42 source files`: literal prefix, then a count, then `source file`.
	if let Some(rest) = line.strip_prefix("Found ") {
		let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
		if !digits.is_empty() {
			let after = rest[digits.len()..].trim_start();
			if after.starts_with("source file") {
				return true;
			}
		}
	}
	false
}

/// True when `s` begins with `MAJOR.MINOR` (e.g. `1.22.0`, `1.1`): one or more
/// digits, a `.`, then one or more digits.
fn starts_with_dotted_version(s: &str) -> bool {
	let mut chars = s.chars().peekable();
	let mut saw_major = false;
	while let Some(&c) = chars.peek() {
		if c.is_ascii_digit() {
			saw_major = true;
			chars.next();
		} else {
			break;
		}
	}
	if !saw_major || chars.next() != Some('.') {
		return false;
	}
	matches!(chars.next(), Some(c) if c.is_ascii_digit())
}

/// Reshape eslint "stylish" output and render it through the shared grouped
/// renderer plus an eslint-specific Top-rules summary.
///
/// Returns `None` when no stylish diagnostic rows were recognized, so the
/// caller falls back to the generic grouped renderer (e.g. when eslint emitted
/// an already-flat or non-stylish shape). The reshape attributes each indented
/// `L:C  severity  message  rule-id` row to the most recent non-indented file
/// header, synthesizing a `file:line:col: severity message` line that
/// `group_diagnostics` can parse. Ungrouped lines (notably the
/// `✖ N problems (…)` summary) flow through `group_diagnostics` untouched.
fn render_eslint_stylish(stripped: &str) -> Option<String> {
	let mut current_header: Option<&str> = None;
	let mut synthesized = String::new();
	let mut passthrough = String::new();
	let mut rule_counts: BTreeMap<String, usize> = BTreeMap::new();
	let mut matched_any = false;

	for raw in stripped.lines() {
		if raw.trim().is_empty() {
			continue;
		}
		let indented = raw.starts_with(' ') || raw.starts_with('\t');
		if !indented {
			let trimmed = raw.trim_end();
			if looks_like_eslint_header(trimmed) {
				current_header = Some(trimmed);
			} else {
				// Summary lines (`✖ 3 problems (…)`) and any other non-indented,
				// non-path text are preserved verbatim for the renderer.
				passthrough.push_str(trimmed);
				passthrough.push('\n');
			}
			continue;
		}
		if let Some((loc, severity, message, rule)) = parse_eslint_row(raw.trim()) {
			matched_any = true;
			let header = current_header.unwrap_or("<unknown>");
			synthesized.push_str(header);
			synthesized.push(':');
			synthesized.push_str(loc);
			synthesized.push_str(": ");
			synthesized.push_str(severity);
			synthesized.push(' ');
			synthesized.push_str(message);
			synthesized.push('\n');
			if let Some(rule) = rule {
				*rule_counts.entry(rule.to_string()).or_default() += 1;
			}
		} else {
			passthrough.push_str(raw.trim_end());
			passthrough.push('\n');
		}
	}

	if !matched_any {
		return None;
	}

	let mut combined = synthesized;
	combined.push_str(&passthrough);
	let grouped = group_diagnostics(&combined);

	let rule_summary = format_code_summary(&rule_counts);
	if rule_summary.is_empty() {
		return Some(grouped);
	}
	let mut out = String::with_capacity(grouped.len() + rule_summary.len() + 12);
	// group_diagnostics prints `N diagnostics in M files` as the first line;
	// keep that header, then splice the eslint Top-rules summary right after it.
	let mut lines = grouped.splitn(2, '\n');
	if let Some(first) = lines.next() {
		out.push_str(first);
		out.push('\n');
		out.push_str("Top rules: ");
		out.push_str(&rule_summary);
		out.push('\n');
		if let Some(rest) = lines.next() {
			out.push_str(rest);
		}
	} else {
		out.push_str(&grouped);
	}
	Some(out)
}

/// A non-indented eslint stylish header is the file path preceding its
/// diagnostic rows. Reject summary/keyword lines so they are not mistaken for
/// file headers.
fn looks_like_eslint_header(line: &str) -> bool {
	if line.is_empty() || !looks_like_path(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	// Drop summary noise that also "looks like a path" (contains a dot) such as
	// `✖ 3 problems (2 errors, 1 warning)`.
	!line.starts_with('✖')
		&& !line.starts_with('×')
		&& !lower.contains("problem")
		&& !lower.contains(" error")
		&& !lower.contains(" warning")
}

/// Parse an eslint stylish diagnostic row (already trimmed of indentation):
/// `1:10  error    Unexpected var, use let or const instead  no-var`.
///
/// Returns `(location, severity, message, rule_id)`. The rule-id is the final
/// whitespace-separated token when it is a plain rule slug (`no-var`,
/// `@typescript-eslint/no-unused-vars`); rows without a trailing rule (e.g.
/// `Parsing error: Unexpected token`) yield `rule_id == None` and fold the
/// trailing text into the message.
fn parse_eslint_row(row: &str) -> Option<(&str, &str, &str, Option<&str>)> {
	let (loc, after_loc) = row.split_once(char::is_whitespace)?;
	if !is_line_col(loc) {
		return None;
	}
	let after_loc = after_loc.trim_start();
	let (severity, after_sev) = after_loc.split_once(char::is_whitespace)?;
	if !matches!(severity, "error" | "warning") {
		return None;
	}
	let body = after_sev.trim_start();
	if body.is_empty() {
		return None;
	}
	// eslint stylish separates the message from the trailing rule-id with a run of
	// >=2 spaces (`message␣␣rule-id`). Recognize the rule-id by that STRUCTURAL
	// position — the token after the last >=2-space gap — not by requiring a
	// hyphen, so hyphenless core rules (`semi`, `eqeqeq`, `camelcase`, `curly`,
	// `radix`, `complexity`) are counted and not glued onto the message text.
	// Rows with no >=2-space gap (`Parsing error: Unexpected token`) yield no
	// rule-id and keep their whole body as the message.
	if let Some((message, candidate)) = split_message_and_rule(body)
		&& is_eslint_rule_id(candidate)
	{
		return Some((loc, severity, message.trim_end(), Some(candidate)));
	}
	Some((loc, severity, body, None))
}

/// Split an eslint stylish body into `(message, rule-candidate)` at the LAST
/// run of two-or-more spaces. The rule-id column is right-aligned/space-padded
/// by eslint, so the final >=2-space gap precedes the rule slug. Returns `None`
/// when the body contains no such gap (the row carries no rule-id column).
fn split_message_and_rule(body: &str) -> Option<(&str, &str)> {
	let bytes = body.as_bytes();
	let mut idx = bytes.len();
	// Walk back to the last `"  "` (>=2 spaces) boundary; the tail after it is the
	// rule-candidate, which itself contains no internal space.
	while idx >= 2 {
		if bytes[idx - 1] == b' ' && bytes[idx - 2] == b' ' {
			let candidate = body[idx..].trim_start();
			if candidate.is_empty() || candidate.contains(' ') {
				return None;
			}
			return Some((&body[..idx - 2], candidate));
		}
		idx -= 1;
	}
	None
}

/// `line:col` location token: digits, a colon, digits.
fn is_line_col(token: &str) -> bool {
	let Some((line, col)) = token.split_once(':') else {
		return false;
	};
	!line.is_empty()
		&& !col.is_empty()
		&& line.chars().all(|ch| ch.is_ascii_digit())
		&& col.chars().all(|ch| ch.is_ascii_digit())
}

/// An eslint rule slug: lowercase letters/digits, hyphens, optional `@scope/`
/// prefix and `/` separators (`no-var`, `@typescript-eslint/no-unused-vars`,
/// and hyphenless core rules `semi`, `eqeqeq`, `camelcase`, `curly`, `radix`,
/// `complexity`). NO hyphen is required — recognition relies on the structural
/// >=2-space column split in `parse_eslint_row` plus this character-class. A
/// > leading lowercase letter excludes prose tokens that survived the split
/// > (uppercase-initial words, punctuation, trailing periods).
fn is_eslint_rule_id(token: &str) -> bool {
	let mut chars = token.chars();
	matches!(chars.next(), Some(ch) if ch.is_ascii_lowercase())
		&& chars
			.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '/' | '@'))
}

/// Code-frame / underline / tool-chatter noise specific to the JS lint family.
///
/// `line` arrives already trimmed (see `strip_lint_noise`), so leading-column
/// whitespace is gone; patterns are matched against the trimmed form. These
/// strips are deliberately gated to `tsc`/`eslint`/`biome`/`oxlint` so the
/// shared ruff/mypy/rubocop/pyright paths are unaffected.
fn is_js_frame_noise(program: &str, trimmed: &str) -> bool {
	// tsc pretty + biome/oxlint share the same caret/tilde underline rows and
	// gutter-numbered code-frame bodies; handle them for every JS lint program.
	//
	// Underline rows: only `~` (tsc) or `^` (biome/oxlint carets), optionally
	// with interior spaces, e.g. `~~~`, `^^^`, `~ ~`.
	if !trimmed.is_empty()
		&& trimmed
			.chars()
			.all(|ch| ch == '~' || ch == '^' || ch == ' ')
		&& trimmed.chars().any(|ch| ch == '~' || ch == '^')
	{
		return true;
	}
	// Code-frame body line: a leading line-number gutter followed by source.
	// biome/oxlint emit `3 │ interface Props {`; tsc pretty emits `3 foo = 1;`.
	//
	// The biome/oxlint `│`-bar gutter is unambiguous (no real summary line carries
	// a leading number then a box-drawing bar), so strip it unconditionally. The
	// tsc-pretty BARE form (`N source`, no bar) collides with genuine summary /
	// content lines that legitimately begin with a number — `7 errors and 2
	// warnings found`, `5 warnings`, `2 problems (2 errors)`, `3 files checked` —
	// so only strip the bare form when the line carries NO diagnostic signal. This
	// guards the exact information the exit!=0 diagnostic-signal gate was written
	// to protect (is_js_frame_noise runs ahead of that gate in is_lint_noise).
	if is_gutter_bar_line(trimmed) {
		return true;
	}
	if is_bare_gutter_numbered_line(trimmed) && !contains_diagnostic_signal(trimmed) {
		return true;
	}
	match program {
		"biome" => {
			// `│ ...` continuation rows (no leading number) and the post-fix
			// success summary. `Checked N files` is already covered by the
			// lowercase `checked ` rule in is_lint_noise.
			trimmed.starts_with('│') || trimmed.to_ascii_lowercase().starts_with("fixed ")
		},
		"oxlint" => {
			// Box-drawing closers and progress/summary chatter that carries no
			// diagnostic. `× rule: message` and `╭─[file:line]` are KEPT.
			trimmed.starts_with('╰')
				|| trimmed.starts_with("Finished in")
				|| trimmed.starts_with("Found ") && trimmed.contains("warning")
		},
		_ => false,
	}
}

/// True when `trimmed` is a biome/oxlint `│`-bar code-frame gutter row: a run
/// of ASCII digits, optional spaces, then the box-drawing bar `│` (`3 │
/// interface`, `12 │ items.forEach(...)`). The bar makes this form unambiguous,
/// so it is stripped unconditionally — no genuine summary line matches it.
fn is_gutter_bar_line(trimmed: &str) -> bool {
	let mut rest = trimmed;
	let digits = rest
		.find(|ch: char| !ch.is_ascii_digit())
		.unwrap_or(rest.len());
	if digits == 0 {
		return false;
	}
	rest = rest[digits..].trim_start_matches(' ');
	rest.starts_with('│')
}

/// True when `trimmed` begins with a tsc-pretty BARE line-number gutter: a run
/// of ASCII digits immediately followed by an ASCII space/tab then source
/// (`3 foo = 1;`, `10   const x: number = "hello";`). This form overlaps with
/// real summary lines that start with a number, so callers MUST additionally
/// exclude lines carrying a diagnostic signal before stripping.
fn is_bare_gutter_numbered_line(trimmed: &str) -> bool {
	let mut chars = trimmed.char_indices();
	let mut saw_digit = false;
	for (idx, ch) in chars.by_ref() {
		if ch.is_ascii_digit() {
			saw_digit = true;
			continue;
		}
		return saw_digit && idx > 0 && (ch == ' ' || ch == '\t');
	}
	false
}

#[must_use]
pub fn group_diagnostics(input: &str) -> String {
	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut ungrouped = Vec::new();
	let mut code_counts: BTreeMap<String, usize> = BTreeMap::new();

	for line in input.lines() {
		if let Some((file, rest)) = split_diagnostic(line) {
			if let Some(code) = extract_code(rest) {
				*code_counts.entry(code).or_default() += 1;
			}
			grouped
				.entry(file.to_string())
				.or_default()
				.push(rest.to_string());
		} else {
			ungrouped.push(line.to_string());
		}
	}

	if grouped.is_empty() {
		return primitives::dedup_consecutive_lines(input);
	}

	let mut files: Vec<_> = grouped.into_iter().collect();
	files.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

	let mut out = String::new();
	let diag_count: usize = files.iter().map(|(_, entries)| entries.len()).sum();
	out.push_str(&diag_count.to_string());
	out.push_str(" diagnostics in ");
	out.push_str(&files.len().to_string());
	out.push_str(" files\n");

	let code_summary = format_code_summary(&code_counts);
	if !code_summary.is_empty() {
		out.push_str("Top codes: ");
		out.push_str(&code_summary);
		out.push('\n');
	}

	for (file, entries) in files {
		out.push_str(&file);
		out.push_str(" (");
		out.push_str(&entries.len().to_string());
		out.push_str(" diagnostics)\n");
		for entry in entries.iter().take(12) {
			out.push_str("  ");
			out.push_str(&truncate_line(entry, 180));
			out.push('\n');
		}
		if entries.len() > 12 {
			out.push_str("  […");
			out.push_str(&(entries.len() - 12).to_string());
			out.push_str(" diagnostics elided…]\n");
		}
	}

	for line in ungrouped.iter().take(40) {
		out.push_str(line);
		out.push('\n');
	}
	if ungrouped.len() > 40 {
		out.push_str("[…");
		out.push_str(&(ungrouped.len() - 40).to_string());
		out.push_str(" ungrouped lines elided…]\n");
	}
	out
}

fn split_diagnostic(line: &str) -> Option<(&str, &str)> {
	if let Some((file, rest)) = split_tsc_diagnostic(line) {
		return Some((file, rest));
	}
	let (file, rest) = line.split_once(':')?;
	if !looks_like_path(file) || !starts_with_line_number(rest) {
		return None;
	}
	Some((file, rest))
}

fn split_tsc_diagnostic(line: &str) -> Option<(&str, &str)> {
	let paren = line.find('(')?;
	let close = line[paren..].find(')')? + paren;
	let file = &line[..paren];
	let loc = &line[paren + 1..close];
	if !looks_like_path(file)
		|| !loc
			.split(',')
			.all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
	{
		return None;
	}
	let rest = line.get(close + 1..)?.trim_start_matches(':').trim_start();
	Some((file, rest))
}

fn looks_like_path(value: &str) -> bool {
	!value.is_empty()
		&& !value.starts_with(' ')
		&& (value.contains('/') || value.contains('.') || value.ends_with(')'))
}

fn starts_with_line_number(rest: &str) -> bool {
	let rest = rest.trim_start();
	let mut chars = rest.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	first.is_ascii_digit()
}

fn extract_code(text: &str) -> Option<String> {
	for token in text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-') {
		if token.len() >= 3
			&& token.chars().any(|ch| ch.is_ascii_digit())
			&& token.chars().any(|ch| ch.is_ascii_alphabetic())
		{
			return Some(token.to_string());
		}
	}
	None
}

fn format_code_summary(counts: &BTreeMap<String, usize>) -> String {
	let mut counts: Vec<_> = counts.iter().collect();
	counts.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
	counts
		.iter()
		.take(5)
		.map(|(code, count)| format!("{code} ({count}x)"))
		.collect::<Vec<_>>()
		.join(", ")
}

fn truncate_line(line: &str, max_chars: usize) -> String {
	if line.chars().count() <= max_chars {
		return line.to_string();
	}
	let mut out: String = line.chars().take(max_chars.saturating_sub(1)).collect();
	out.push('…');
	out
}

fn contains_diagnostic_signal(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("warning")
		|| lower.contains("failed")
		|| lower.contains("panic")
		|| lower.contains("exception")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn pyright_outputjson_passes_through_untouched() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let json = "{\"version\": \"1.1.0\", \"generalDiagnostics\": []}\n";
		for command in ["pyright --outputjson src", "basedpyright --outputjson=true src"] {
			let ctx = MinimizerCtx {
				program: command.split_whitespace().next().unwrap(),
				subcommand: None,
				command,
				config: &cfg,
			};
			let out = filter(&ctx, json, 1);
			assert!(!out.changed, "{command} output must not be rewritten");
			assert_eq!(out.text, json);
		}
		// Plain (non-JSON) runs still condense.
		let ctx = MinimizerCtx {
			program:    "pyright",
			subcommand: None,
			command:    "pyright src",
			config:     &cfg,
		};
		let plain = "src/app.py:4:7 - error: bad\nsrc/app.py:9:3 - error: worse\n";
		assert!(filter(&ctx, plain, 1).changed);
	}

	#[test]
	fn supports_common_lint_subcommands_for_future_dispatch() {
		for subcommand in ["check", "lint", "run", "format", "typecheck"] {
			assert!(supports(Some(subcommand)), "{subcommand} should be supported");
		}
	}

	#[test]
	fn groups_tsc_and_colon_diagnostics_by_file() {
		let input = "src/a.ts(1,2): error TS2322: bad\nsrc/a.ts(2,1): error TS2322: \
		             bad\nlib/b.py:4: error: no attr [attr-defined]\n";
		let out = group_diagnostics(input);
		assert!(out.contains("3 diagnostics in 2 files"));
		assert!(out.contains("src/a.ts (2 diagnostics)"));
		assert!(out.contains("Top codes:"));
	}

	#[test]
	fn truncates_many_diagnostics_per_file() {
		let mut input = String::new();
		for i in 0..20 {
			input.push_str("src/main.rs:");
			input.push_str(&(i + 1).to_string());
			input.push_str(":1: warning: issue W");
			input.push_str(&i.to_string());
			input.push('\n');
		}
		let out = group_diagnostics(&input);
		assert!(out.contains("src/main.rs (20 diagnostics)"));
		assert!(out.contains("  […8 diagnostics elided…]"));
	}

	#[test]
	fn direct_pyright_support_and_grouping_work() {
		assert!(supports_program("pyright", None));
		let input = "0 errors, 0 warnings, 0 informations\nsrc/app.ts:4:7 - error TS2322: Type \
		             'string' is not assignable to type 'number'.\nsrc/app.ts:9:3 - error TS7006: \
		             Parameter 'x' implicitly has an 'any' type.\n";
		let out = condense_lint_output("pyright", input, 1);
		assert!(out.contains("2 diagnostics in 1 files"));
		assert!(out.contains("src/app.ts (2 diagnostics)"));
		assert!(out.contains("TS2322"));
		assert!(out.contains("TS7006"));
	}

	#[test]
	fn direct_basedpyright_success_noise_is_stripped() {
		assert!(supports_program("basedpyright", None));
		let out = condense_lint_output("basedpyright", "0 errors, 0 warnings, 0 notes\n", 0);
		assert_eq!(out, "");
	}

	#[test]
	fn basedpyright_banner_and_progress_noise_is_stripped() {
		// Re-derived from rtk/src/filters/basedpyright.toml's first inline test,
		// rendered through the minimizer's grouped per-file output. The version
		// banner, `Searching for source files`, and `Found N source files`
		// progress lines are dropped; the diagnostics survive and group by file.
		let input = "basedpyright 1.22.0\nSearching for source files\nFound 42 source \
		             files\n\n/home/user/app/main.py:10:5 - error: \"foo\" is not defined \
		             (reportUndefinedVariable)\n/home/user/app/main.py:25:1 - error: Type \"str\" \
		             is not assignable to type \"int\" \
		             (reportAssignmentType)\n/home/user/app/utils.py:8:9 - warning: Variable \"x\" \
		             is not accessed (reportUnusedVariable)\n";
		let out = condense_lint_output("basedpyright", input, 1);
		assert!(!out.contains("basedpyright 1.22.0"), "version banner must be stripped: {out}");
		assert!(!out.contains("Searching for source files"), "progress must be stripped: {out}");
		assert!(!out.contains("Found 42 source files"), "progress must be stripped: {out}");
		assert!(out.contains("3 diagnostics in 2 files"), "got: {out}");
		assert!(out.contains("reportUndefinedVariable"));
	}

	#[test]
	fn pyright_banner_strips_are_scoped_off_other_linters() {
		// The pyright banner/progress strips must not touch other linters: an
		// oxlint diagnostic that legitimately mentions `Found`/`source files`-style
		// text, or a version-like token, stays put.
		assert!(is_pyright_banner_noise("Found 3 source files")); // sanity: helper itself
		// Helper is scoped at the call site to pyright/basedpyright; confirm a
		// non-pyright program never reaches it via is_lint_noise.
		assert!(!is_lint_noise("oxlint", "Found 3 source files referenced", 1));
		assert!(!is_lint_noise("tsc", "Pyright 1.1 is mentioned here", 2));
		// And confirm the helper fires for pyright/basedpyright through is_lint_noise.
		assert!(is_lint_noise("pyright", "Searching for source files", 1));
		assert!(is_lint_noise("basedpyright", "Found 42 source files", 1));
		assert!(is_lint_noise("basedpyright", "basedpyright 1.22.0", 1));
		assert!(is_lint_noise("pyright", "Pyright 1.1.0", 1));
	}

	// -----------------------------------------------------------------
	// CONCERN 1: tsc program-claim + code-frame strips
	// (ported from snip/filters/tsc.yaml inline tests, re-rendered through
	// the minimizer's grouped per-file + Top-codes output instead of snip's
	// flat keep_lines)
	// -----------------------------------------------------------------

	#[test]
	fn tsc_eslint_biome_oxlint_are_program_claimed() {
		// Path-arg invocations resolve the subcommand to a path token that is not
		// in the subcommand allowlist; the program claim is what routes them.
		for program in ["tsc", "eslint", "biome", "oxlint"] {
			assert!(
				supports_program(program, Some("src/foo.ts")),
				"{program} path-arg invocation must be program-claimed"
			);
			assert!(supports_program(program, None), "{program} bare invocation must be claimed");
		}
	}

	#[test]
	fn tsc_pretty_strips_code_frames_and_groups_by_file() {
		// snip's "pretty format errors with context" fixture.
		let input = "src/index.ts:3:1 - error TS2304: Cannot find name 'foo'.\n\n3 foo = 1;\n  \
		             ~~~\n\nsrc/utils.ts:10:5 - error TS2322: Type 'string' is not assignable to \
		             type 'number'.\n\n10   const x: number = \"hello\";\n     ~\n\nFound 2 errors \
		             in 2 files.\n";
		let out = condense_lint_output("tsc", input, 2);
		assert!(out.contains("2 diagnostics in 2 files"), "got: {out}");
		assert!(out.contains("TS2304"));
		assert!(out.contains("TS2322"));
		assert!(out.contains("Top codes:"));
		// Code-frame body lines and underline rows are stripped.
		assert!(!out.contains("foo = 1;"), "code-frame body must be stripped: {out}");
		assert!(!out.contains("const x: number"), "code-frame body must be stripped: {out}");
		assert!(!out.contains('~'), "underline rows must be stripped: {out}");
	}

	#[test]
	fn tsc_classic_groups_by_file() {
		// snip's "classic format errors" fixture (no code frames).
		let input = "src/index.ts(3,1): error TS2304: Cannot find name 'foo'.\nsrc/utils.ts(10,5): \
		             error TS2322: Type 'string' is not assignable to type 'number'.\nFound 2 \
		             errors in 2 files.\n";
		let out = condense_lint_output("tsc", input, 2);
		assert!(out.contains("2 diagnostics in 2 files"), "got: {out}");
		assert!(out.contains("src/index.ts"));
		assert!(out.contains("src/utils.ts"));
		assert!(out.contains("TS2304"));
		assert!(out.contains("TS2322"));
	}

	#[test]
	fn tsc_empty_input_condenses_to_clean() {
		// snip emits "ok (no type errors)"; the minimizer renders empty input as
		// empty (its own clean-build signal), so assert that behavior.
		assert_eq!(condense_lint_output("tsc", "", 0), "");
	}

	// -----------------------------------------------------------------
	// CONCERN 2: eslint stylish-block parsing
	// (ported from snip/filters/eslint.yaml inline tests)
	// -----------------------------------------------------------------

	#[test]
	fn eslint_stylish_groups_rows_under_headers_with_top_rules() {
		// snip's "errors with summary" fixture (incl. a Parsing error row and the
		// fixable hint). Codepoints normalized: × is U+00D7-free here — eslint's
		// summary marker is the heavy ballot ✖ (U+2716), kept verbatim.
		let input = "/home/user/project/src/file.js\n  1:10  error    Unexpected var, use let or \
		             const instead  no-var\n  2:5   warning  Missing semicolon                     \
		             semi\n\n/home/user/project/src/other.js\n  3:1   error    Parsing error: \
		             Unexpected token\n\n✖ 3 problems (2 errors, 1 warning)\n  1 error and 0 \
		             warnings potentially fixable with the `--fix` option.\n";
		let out = condense_lint_output("eslint", input, 1);
		// Grouped per-file rendering with the shared diagnostics header.
		assert!(out.contains("3 diagnostics in 2 files"), "got: {out}");
		assert!(out.contains("file.js"));
		assert!(out.contains("other.js"));
		// Top-rules summary derived from the trailing rule-id column.
		assert!(out.contains("Top rules:"), "got: {out}");
		assert!(out.contains("no-var"));
		assert!(out.contains("semi"));
		// The Parsing error row (no rule-id) is preserved as a diagnostic.
		assert!(out.contains("Parsing error: Unexpected token"), "got: {out}");
		// Summary kept, fixable hint stripped.
		assert!(out.contains("✖ 3 problems (2 errors, 1 warning)"), "got: {out}");
		assert!(!out.contains("potentially fixable"), "fixable hint must be stripped: {out}");
	}

	#[test]
	fn eslint_stylish_single_file_keeps_summary() {
		// snip's "single file error" fixture.
		let input = "/app/src/index.js\n  5:3  error  'x' is defined but never used  \
		             no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n";
		let out = condense_lint_output("eslint", input, 1);
		assert!(out.contains("1 diagnostics in 1 files"), "got: {out}");
		assert!(out.contains("index.js"));
		assert!(out.contains("no-unused-vars"));
		assert!(out.contains("Top rules:"));
		assert!(out.contains("✖ 1 problem (1 error, 0 warnings)"), "got: {out}");
	}

	#[test]
	fn eslint_clean_run_condenses_to_clean() {
		// snip's "no errors produces ok": empty eslint output renders as empty
		// (the minimizer's clean signal). Reshape finds no rows and falls back to
		// the empty grouped output.
		assert_eq!(condense_lint_output("eslint", "", 0), "");
	}

	// -----------------------------------------------------------------
	// CONCERN 3: biome / oxlint split-brain alignment
	// (synthetic inline fixtures; × is U+00D7 — biome/oxlint emit U+00D7,
	// NOT snip's ✖/✔ keep-pattern codepoints)
	// -----------------------------------------------------------------

	#[test]
	fn biome_ci_keeps_diagnostics_strips_code_frames() {
		assert!(supports_program("biome", Some("ci")));
		// biome ci default output: grouped header line + `× message` rows +
		// numbered code-frame + caret underline. (× == U+00D7.)
		let input = "Checked 42 files in 0.5s\n\nsrc/app.tsx:5:3 lint/suspicious/noExplicitAny \
		             \u{2501}\u{2501}\u{2501}\n  \u{00d7} Unexpected any. Specify a different \
		             type.\n  3 \u{2502} interface Props {\n  4 \u{2502}   data: any;\n  5 \u{2502} \
		             \u{0020}        ^^^\n\nsrc/utils.ts:12:1 lint/complexity/noForEach \
		             \u{2501}\u{2501}\u{2501}\n  \u{00d7} Prefer for...of instead of forEach.\n 12 \
		             \u{2502} items.forEach(item => process(item));\n\nFound 2 errors.\n";
		let out = condense_lint_output("biome", input, 1);
		// Grouped header lines survive (file:line:col …), × rows survive.
		assert!(out.contains("src/app.tsx"), "got: {out}");
		assert!(out.contains("src/utils.ts"));
		assert!(out.contains('\u{00d7}'), "× diagnostic rows must survive: {out}");
		assert!(out.contains("Unexpected any"));
		assert!(out.contains("Prefer for...of"));
		// Code-frame body rows (`N │ …`) are stripped; success chatter gone.
		assert!(!out.contains("interface Props"), "code-frame body must be stripped: {out}");
		assert!(!out.contains("Checked 42 files"), "checked chatter must be stripped: {out}");
		assert!(!out.contains('^'), "caret underline must be stripped: {out}");
	}

	#[test]
	fn biome_strips_fixed_files_success() {
		// `Fixed N files` post-fix summary is chatter; stripped at success.
		let out = condense_lint_output("biome", "Fixed 3 files in 0.1s\n", 0);
		assert_eq!(out, "");
	}

	#[test]
	fn oxlint_keeps_rule_and_location_strips_frames() {
		assert!(supports_program("oxlint", Some("src/")));
		// oxlint default output: `× rule: message`, `╭─[file:line]` location,
		// numbered code-frame, `╰────` closer, Finished/Found chatter.
		let input = "  \u{00d7} eslint(no-console): Unexpected console statement.\n   \
		             \u{256d}\u{2500}[src/app.ts:5:3]\n 5 \u{2502}   console.log(\"debug\");\n   \
		             \u{2502}   ^^^^^^^^^^^\n   \u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\n\n  \
		             \u{00d7} eslint(no-unused-vars): 'x' is defined but never used.\n   \
		             \u{256d}\u{2500}[src/utils.ts:2:7]\n 2 \u{2502}   let x = 42;\n   \u{2502}       \
		             ^\n   \u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\n\nFound 2 warnings on 2 \
		             files.\nFinished in 12ms on 100 files.\n";
		let out = condense_lint_output("oxlint", input, 1);
		// Diagnostic rows and location markers survive.
		assert!(out.contains('\u{00d7}'), "× diagnostic rows must survive: {out}");
		assert!(out.contains("no-console"));
		assert!(out.contains("no-unused-vars"));
		assert!(
			out.contains("\u{256d}\u{2500}[src/app.ts:5:3]"),
			"location marker must survive: {out}"
		);
		// Code-frame rows, closers, and progress chatter are stripped.
		assert!(!out.contains("console.log"), "code-frame body must be stripped: {out}");
		assert!(!out.contains('\u{2570}'), "box closer must be stripped: {out}");
		assert!(!out.contains("Finished in"), "Finished chatter must be stripped: {out}");
		assert!(!out.contains("Found 2 warnings"), "Found chatter must be stripped: {out}");
	}

	#[test]
	fn oxlint_clean_run_condenses_to_clean() {
		// Only progress chatter, no diagnostics -> empty.
		let out = condense_lint_output("oxlint", "Finished in 5ms on 100 files.\n", 0);
		assert_eq!(out, "");
	}

	#[test]
	fn shared_python_ruby_paths_unaffected_by_js_strips() {
		// Regression pin for the SHARED renderer: ruff (file:line) and mypy
		// (bracketed code) diagnostics still group, and a leading-number gutter
		// line in their output is NOT mistaken for a JS code-frame (the strip is
		// gated to tsc/eslint/biome/oxlint only).
		let ruff = "src/app.py:1:1: F401 imported but unused\nFound 1 error.\n";
		let out = condense_lint_output("ruff", ruff, 1);
		assert!(out.contains("F401"), "got: {out}");

		let mypy = "lib/b.py:4: error: no attr [attr-defined]\n";
		let out = condense_lint_output("mypy", mypy, 1);
		assert!(out.contains("attr-defined") || out.contains("b.py"), "got: {out}");
	}

	// -----------------------------------------------------------------
	// Regression: blocking-issue fixes
	// -----------------------------------------------------------------

	#[test]
	fn js_lint_numeric_summary_line_is_not_gutter_stripped() {
		// BLOCKING 1 regression: a JS-lint summary/content line that BEGINS with a
		// number (`7 errors and 2 warnings found`) must survive — the bare-gutter
		// strip only applies to code-frame body rows that carry no diagnostic
		// signal, so this line (it contains "error"/"warning") is preserved.
		let input = "/app/x.js\n  1:1  error  bad  no-var\n\n7 errors and 2 warnings \
		             found\n\u{2716} 9 problems (9 errors, 0 warnings)\n";
		let out = condense_lint_output("eslint", input, 1);
		assert!(
			out.contains("7 errors and 2 warnings found"),
			"numeric summary line must survive the gutter strip: {out}"
		);
		assert!(out.contains("\u{2716} 9 problems (9 errors, 0 warnings)"), "got: {out}");

		// Helper-level pins: the BARE tsc form only strips when no diagnostic signal
		// is present, while the biome/oxlint `│`-bar form always strips.
		assert!(is_bare_gutter_numbered_line("3 foo = 1;"));
		assert!(contains_diagnostic_signal("7 errors and 2 warnings found"));
		assert!(contains_diagnostic_signal("5 warnings"));
		assert!(contains_diagnostic_signal("2 problems (2 errors)"));
		assert!(!is_gutter_bar_line("10 errors found"), "bare numeric is not a bar gutter");
		assert!(is_gutter_bar_line("3 \u{2502} interface Props {"), "biome bar gutter strips");
		assert!(is_gutter_bar_line("12 \u{2502} items.forEach(...)"), "oxlint bar gutter strips");
	}

	// -----------------------------------------------------------------
	// CONCERN: eslint explicit formatter passthrough
	// -----------------------------------------------------------------

	#[test]
	fn eslint_json_format_passes_through() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "eslint",
			subcommand: None,
			command:    "eslint -f json src/",
			config:     &cfg,
		};
		// should passthrough — preserves_machine_readable_output returns true
		let dummy = r#"[{"filePath":"src/foo.js","messages":[]}]"#;
		let out = filter(&ctx, dummy, 0);
		assert!(!out.changed, "eslint -f json must passthrough unchanged");
		assert_eq!(out.text, dummy);
	}

	#[test]
	fn eslint_format_long_flag_passes_through() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for command in [
			"eslint --format json src/",
			"eslint --format=json src/",
			"eslint --format compact src/",
			"eslint -f junit src/",
		] {
			let ctx = MinimizerCtx { program: "eslint", subcommand: None, command, config: &cfg };
			let dummy = r#"[{"filePath":"src/foo.js","messages":[]}]"#;
			let out = filter(&ctx, dummy, 0);
			assert!(!out.changed, "{command} must passthrough unchanged");
			assert_eq!(out.text, dummy);
		}
	}

	#[test]
	fn eslint_stylish_still_condensed() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "eslint",
			subcommand: None,
			command:    "eslint --format stylish src/",
			config:     &cfg,
		};
		let dummy = "\nsrc/foo.js\n  1:1  error  bad  no-var\n\n✖ 1 problem\n";
		let out = filter(&ctx, dummy, 1);
		// stylish goes through the condenser, result should be changed
		assert!(out.changed, "eslint --format stylish must go through the condenser");
	}

	#[test]
	fn eslint_no_format_flag_still_condensed() {
		// no -f/--format flag at all → default stylish → condenser runs
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "eslint",
			subcommand: None,
			command:    "eslint src/",
			config:     &cfg,
		};
		let dummy = "\nsrc/foo.js\n  1:1  error  bad  no-var\n\n✖ 1 problem\n";
		let out = filter(&ctx, dummy, 1);
		assert!(out.changed, "eslint without -f must go through the condenser");
	}

	#[test]
	fn eslint_hyphenless_rules_counted_under_top_rules_and_unglued() {
		// BLOCKING 2 regression: hyphenless core rules (`semi`, `eqeqeq`) are
		// recognized by their structural >=2-space column position, counted under
		// `Top rules:`, and NOT glued onto the message body.
		assert!(is_eslint_rule_id("semi"));
		assert!(is_eslint_rule_id("eqeqeq"));
		assert!(is_eslint_rule_id("camelcase"));
		assert!(is_eslint_rule_id("curly"));
		assert!(is_eslint_rule_id("radix"));
		assert!(is_eslint_rule_id("complexity"));
		// Prose tokens (uppercase-initial / punctuation) are still rejected.
		assert!(!is_eslint_rule_id("Unexpected"));
		assert!(!is_eslint_rule_id("token."));

		let input = "/app/x.js\n  1:1  error  Missing semicolon  semi\n  2:1  error  Expected ===  \
		             eqeqeq\n\n\u{2716} 2 problems (2 errors, 0 warnings)\n";
		let out = condense_lint_output("eslint", input, 1);
		assert!(out.contains("Top rules:"), "hyphenless rules must produce a Top rules line: {out}");
		assert!(out.contains("semi (1x)"), "semi must be counted: {out}");
		assert!(out.contains("eqeqeq (1x)"), "eqeqeq must be counted: {out}");
		// The rule slug must NOT be glued onto the diagnostic message body.
		assert!(
			!out.contains("Missing semicolon  semi") && !out.contains("Missing semicolon semi"),
			"rule slug must be split from the message, not glued: {out}"
		);
	}
}
