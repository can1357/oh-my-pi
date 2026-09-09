//! Package manager output filters.

use std::{collections::HashSet, fmt::Write as _};

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};
const PACKAGE_TREE_HEAD_LINES: usize = 80;

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"install"
				| "i" | "ci"
				| "add" | "update"
				| "up" | "upgrade"
				| "remove"
				| "rm" | "uninstall"
				| "list" | "ls"
				| "tree" | "pip"
				| "outdated"
				| "sync" | "lock"
				| "run" | "exec"
				| "audit"
				| "check"
				| "show" | "info"
				| "view" | "fund"
				| "explain"
				| "test" | "t"
				| "start"
				| "stop" | "restart"
				| "config"
				| "cache"
				| "prune"
				| "dedupe"
				| "publish"
				| "pack" | "link"
				| "why" | "export"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if exit_code == 0
		&& (command_contains_any(ctx.command, &["--json"])
			|| primitives::command_has_any_token(ctx.command, &["--format=json"])
			|| primitives::command_has_ordered_tokens(ctx.command, "--format", "json")
			|| ctx.program == "uv"
				&& matches!(ctx.subcommand, Some("pip"))
				&& command_contains_any(ctx.command, &["freeze"]))
	{
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);

	// Success no-op short-circuits, moved here from defs/poetry-install.toml and
	// defs/uv-sync.toml so they fire regardless of overlay ordering. Each is
	// scoped per (program, subcommand) so unrelated package managers are
	// untouched. A non-empty message means ensure_success_visible leaves it as-is
	// (no bare 'OK' rewrite).
	if exit_code == 0
		&& let Some(message) = success_up_to_date_short_circuit(ctx, &cleaned)
	{
		return MinimizerOutput::transformed(message.to_string(), input.len());
	}

	let text = if exit_code == 0 && is_package_lock_command(ctx) {
		compact_package_lock_output(ctx, &cleaned)
	} else {
		let stripped = strip_package_noise(ctx, &cleaned, exit_code);
		let deduped = primitives::dedup_consecutive_lines(&stripped);
		if contains_audit_or_security_summary(&deduped) {
			deduped
		} else if exit_code == 0
			&& (is_package_tree_command(ctx) || is_package_export_command(ctx))
			&& !command_contains_any(ctx.command, &["--json"])
			&& !primitives::command_has_any_token(ctx.command, &["--format=json"])
			&& !primitives::command_has_ordered_tokens(ctx.command, "--format", "json")
		{
			compact_package_tree_output(&deduped)
		} else {
			let cap = if exit_code == 0 {
				primitives::CapClass::Inventory
			} else {
				primitives::CapClass::Errors
			};
			primitives::head_tail_cap(&deduped, cap)
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// Per-(program, subcommand) success no-op detection. Returns the one-line
/// summary to emit when the raw output says nothing changed, replacing the
/// `match_output` overlays that previously lived in defs/poetry-install.toml
/// and defs/uv-sync.toml. Callers must gate on `exit_code` == 0.
fn success_up_to_date_short_circuit(ctx: &MinimizerCtx<'_>, cleaned: &str) -> Option<&'static str> {
	// poetry install/lock/update no-op: 'No dependencies to install or update'
	// (poetry 1.x) or 'No changes.' (poetry 2.x). Scoped to program=poetry.
	if ctx.program == "poetry"
		&& matches!(ctx.subcommand, Some("install" | "lock" | "update"))
		&& cleaned.lines().any(|line| {
			let lower = line.trim().to_ascii_lowercase();
			lower.starts_with("no dependencies to install or update") || lower == "no changes."
		}) {
		return Some("ok (up to date)");
	}
	// uv sync/add/remove no-op: 'Audited N packages in Xms' with no installs.
	// Scoped to those subcommands so npm/brew/composer 'Audited' is unaffected.
	// Only collapse when the run is a CLEAN no-op: uv co-prints actionable
	// diagnostics (e.g. 'warning: VIRTUAL_ENV=… does not match the project
	// environment path …') alongside the Audited line on exit 0, and eagerly
	// collapsing to 'ok (up to date)' would destroy them. On HEAD the global
	// is_noise_line stripped the Audited line but the surviving warning kept the
	// output non-empty, so it was reported; preserve that by short-circuiting only
	// when no warning/error line co-occurs. (poetry's branch above deliberately
	// collapses warnings too — its deleted overlay did the same, so it stays.)
	if ctx.program == "uv"
		&& matches!(ctx.subcommand, Some("sync" | "add" | "remove"))
		&& !uv_has_actionable_diagnostic(cleaned)
		&& cleaned.lines().any(|line| {
			let lower = line.trim().to_ascii_lowercase();
			lower.starts_with("audited ") && lower.contains("package")
		}) {
		return Some("ok (up to date)");
	}
	None
}

/// True when any line carries an actionable diagnostic ('warning'/'error'/
/// 'failed') that must survive a uv no-op short-circuit. Kept deliberately
/// narrow: the no-op summary lines themselves ('Resolved …', 'Audited …') carry
/// none of these tokens, so a clean no-op still collapses to 'ok (up to date)'.
/// Do NOT reuse `is_error_or_summary` here — it also matches 'audited'/'found'/
/// 'success'/'complete', which would suppress the short-circuit on every no-op.
fn uv_has_actionable_diagnostic(cleaned: &str) -> bool {
	cleaned.lines().any(|line| {
		let lower = line.to_ascii_lowercase();
		lower.contains("warning") || lower.contains("error") || lower.contains("failed")
	})
}

fn strip_package_noise(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut previous_blank = false;
	// snip keeps exactly one JS install-summary line ('added N packages…',
	// 'up to date', pnpm 'Done in Xs'/'Packages: +N', yarn 'Done in Xs'): the
	// count confirms lockfile/node_modules state. Keep the first such line and
	// treat later duplicates as noise. This check precedes is_noise_line so the
	// 'audited N packages' strip cannot eat the combined 'added…audited' summary.
	let mut kept_install_summary = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;

		if is_js_program(ctx.program) && is_js_install_summary(&trimmed.to_ascii_lowercase()) {
			if kept_install_summary {
				continue;
			}
			kept_install_summary = true;
			out.push_str(line.trim_end());
			out.push('\n');
			continue;
		}

		if is_noise_line(ctx, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn is_package_tree_command(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.program {
		"npm" | "pnpm" | "yarn" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree" | "why" | "explain"))
		},
		"bun" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree" | "why" | "explain"))
				|| matches!(ctx.subcommand, Some("pm"))
					&& command_contains_any(ctx.command, &["list", "ls", "tree", "why"])
		},
		"uv" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree"))
				|| matches!(ctx.subcommand, Some("pip"))
					&& command_contains_any(ctx.command, &["list", "ls", "tree"])
		},
		// Default tabular `pip list` / `pip list --outdated` are inventory dumps
		// like `uv pip list`; give them the same tree/list compaction. `--json`
		// already passes through earlier in filter(), so only text output lands.
		// `pip3` is not normalized to `pip`, so claim both spellings.
		"pip" | "pip3" => matches!(ctx.subcommand, Some("list")),
		"poetry" => {
			matches!(ctx.subcommand, Some("tree"))
				|| matches!(ctx.subcommand, Some("show"))
					&& command_contains_any(ctx.command, &["--tree"])
		},
		_ => false,
	}
}

fn is_package_export_command(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.program {
		"uv" | "poetry" => ctx.subcommand == Some("export"),
		_ => false,
	}
}

fn is_package_lock_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!((ctx.program, ctx.subcommand), ("uv" | "poetry", Some("lock")))
}

fn command_contains_any(command: &str, words: &[&str]) -> bool {
	command.split_whitespace().any(|part| words.contains(&part))
}

fn compact_package_tree_output(input: &str) -> String {
	if let Some(summary) = compact_package_tree_json_output(input) {
		return summary;
	}
	if let Some(summary) = compact_package_tree_ndjson_output(input) {
		return summary;
	}
	let lines: Vec<&str> = input
		.lines()
		.map(str::trim_end)
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= PACKAGE_TREE_HEAD_LINES {
		return input.to_string();
	}

	let mut out = format!("package tree/list: {} entries\n", lines.len());
	for line in lines.iter().take(PACKAGE_TREE_HEAD_LINES) {
		out.push_str(line);
		out.push('\n');
	}
	let _ = writeln!(out, "[…{} package entries elided…]", lines.len() - PACKAGE_TREE_HEAD_LINES);
	out
}

fn compact_package_tree_json_output(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let mut rows = Vec::new();
	let mut seen = HashSet::new();
	collect_package_tree_json_rows(&value, &mut rows, &mut seen);
	summarize_package_rows(rows)
}

fn compact_package_tree_ndjson_output(input: &str) -> Option<String> {
	let mut rows = Vec::new();
	let mut seen = HashSet::new();
	for line in input.lines().map(str::trim).filter(|line| !line.is_empty()) {
		let value: serde_json::Value = serde_json::from_str(line).ok()?;
		collect_package_tree_json_rows(&value, &mut rows, &mut seen);
		if let Some(data) = value.get("data").and_then(serde_json::Value::as_str) {
			for row in data
				.lines()
				.map(str::trim_end)
				.filter(|row| !row.trim().is_empty())
			{
				push_unique_row(&mut rows, &mut seen, row.to_string());
			}
		}
	}
	summarize_package_rows(rows)
}

fn summarize_package_rows(rows: Vec<String>) -> Option<String> {
	if rows.is_empty() {
		return None;
	}
	let mut out = format!("package tree/list: {} entries\n", rows.len());
	for row in rows.iter().take(PACKAGE_TREE_HEAD_LINES) {
		out.push_str(row);
		out.push('\n');
	}
	if rows.len() > PACKAGE_TREE_HEAD_LINES {
		let _ = writeln!(out, "[…{} package entries elided…]", rows.len() - PACKAGE_TREE_HEAD_LINES);
	}
	Some(out)
}

fn collect_package_tree_json_rows(
	value: &serde_json::Value,
	rows: &mut Vec<String>,
	seen: &mut HashSet<String>,
) {
	match value {
		serde_json::Value::Object(map) => {
			if let Some(name) = map.get("name").and_then(serde_json::Value::as_str) {
				let version = map
					.get("version")
					.and_then(serde_json::Value::as_str)
					.unwrap_or("");
				push_unique_row(
					rows,
					seen,
					if version.is_empty() {
						name.to_string()
					} else {
						format!("{name} {version}")
					},
				);
			}
			if let Some(dependencies) = map
				.get("dependencies")
				.and_then(serde_json::Value::as_object)
			{
				for (name, child) in dependencies {
					push_json_dependency_row(rows, seen, name, child);
				}
			}
			for value in map.values() {
				if value.is_array() || value.is_object() {
					collect_package_tree_json_rows(value, rows, seen);
				}
			}
		},
		serde_json::Value::Array(items) => {
			for item in items {
				collect_package_tree_json_rows(item, rows, seen);
			}
		},
		_ => {},
	}
}

fn push_json_dependency_row(
	rows: &mut Vec<String>,
	seen: &mut HashSet<String>,
	name: &str,
	child: &serde_json::Value,
) {
	let version = child
		.get("version")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("");
	push_unique_row(
		rows,
		seen,
		if version.is_empty() {
			name.to_string()
		} else {
			format!("{name} {version}")
		},
	);
}

fn push_unique_row(rows: &mut Vec<String>, seen: &mut HashSet<String>, row: String) {
	if seen.insert(row.clone()) {
		rows.push(row);
	}
}

fn is_noise_line(ctx: &MinimizerCtx<'_>, line: &str, exit_code: i32) -> bool {
	let lower = line.to_ascii_lowercase();

	// Strip: "found 0 vulnerabilities" (non-actionable success noise)
	if lower.contains("found 0 vulnerabilities") {
		return true;
	}
	// Strip: npm funding nags ("N packages are looking for funding" / "run `npm
	// fund` for details"). snip drops both; removing 'funding' from
	// is_audit_or_security_summary keeps real audit findings protected.
	if lower.contains("looking for funding") || lower.contains("npm fund") {
		return true;
	}
	// Strip: "audited X packages" timing summaries (non-actionable). This global
	// rule still governs npm/brew/composer. uv sync/add/remove never reach here
	// for an 'Audited' no-op — success_up_to_date_short_circuit() in filter()
	// consumes that line into 'ok (up to date)' on the raw output first.
	if lower.contains("audited") && lower.contains("package") {
		return true;
	}
	// Keep: vulnerability mentions (actionable — real findings)
	if lower.contains("vulnerab") {
		return false;
	}
	if exit_code != 0 && is_error_or_summary(line) {
		return false;
	}

	if is_package_lock_command(ctx) && is_lock_summary_line(&lower) {
		return false;
	}
	is_generic_progress(line, &lower)
		|| is_js_package_noise(ctx.program, line, &lower)
		|| is_python_package_noise(ctx, line, &lower)
		|| is_ruby_php_brew_noise(ctx.program, line, &lower)
}

fn compact_package_lock_output(ctx: &MinimizerCtx<'_>, input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		let lower = trimmed.to_ascii_lowercase();
		if is_lock_summary_line(&lower) {
			out.push_str(trimmed);
			out.push('\n');
			continue;
		}
		if is_generic_progress(trimmed, &lower)
			|| is_python_package_noise(ctx, trimmed, &lower)
			|| is_js_package_noise(ctx.program, trimmed, &lower)
		{
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
	}
	if out.trim().is_empty() {
		primitives::head_tail_cap(input, primitives::CapClass::Inventory)
	} else {
		primitives::head_tail_cap(&out, primitives::CapClass::Inventory)
	}
}

fn is_lock_summary_line(lower: &str) -> bool {
	lower.starts_with("writing lock file")
		|| lower.starts_with("updated lockfile")
		|| lower.starts_with("resolved ")
		|| lower.starts_with("installing dependencies from lock file")
		|| lower == "no changes."
		|| lower.starts_with("no dependencies to install or update")
}

fn is_generic_progress(line: &str, lower: &str) -> bool {
	line.starts_with("Progress:")
		|| line.starts_with("Resolving:")
		|| line.starts_with("Downloading:")
		|| line.starts_with("Downloaded")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("installing dependencies")
		|| lower.starts_with("fetching packages")
		|| lower.contains("spinner")
		|| line
			.chars()
			.all(|ch| matches!(ch, '⠁' | '⠂' | '⠄' | '⡀' | '⢀' | '⠠' | '⠐' | '⠈' | ' '))
}

fn is_js_program(program: &str) -> bool {
	matches!(program, "npm" | "pnpm" | "yarn" | "bun")
}

/// JS package-manager success-summary lines worth keeping exactly once. snip
/// retains these so the count confirms `lockfile/node_modules` state. Callers
/// must gate on `is_js_program` first.
fn is_js_install_summary(lower: &str) -> bool {
	lower.starts_with("added ") && lower.contains("package")
		|| lower.starts_with("removed ") && lower.contains("package")
		|| lower.starts_with("changed ") && lower.contains("package")
		|| lower.starts_with("up to date")
		|| lower.contains("already up-to-date")
		|| lower.starts_with("done in ")
		|| lower.starts_with("packages:")
		|| lower.starts_with("dependencies:")
}

/// Classic yarn step markers: `[N/4] Resolving|Fetching|Linking|Building …`.
fn is_yarn_step_marker(line: &str) -> bool {
	let Some(rest) = line.strip_prefix('[') else {
		return false;
	};
	let Some((counter, tail)) = rest.split_once(']') else {
		return false;
	};
	let Some((num, denom)) = counter.split_once('/') else {
		return false;
	};
	if num.is_empty()
		|| denom.is_empty()
		|| !num.bytes().all(|b| b.is_ascii_digit())
		|| !denom.bytes().all(|b| b.is_ascii_digit())
	{
		return false;
	}
	let step = tail.trim_start();
	step.starts_with("Resolving")
		|| step.starts_with("Fetching")
		|| step.starts_with("Linking")
		|| step.starts_with("Building")
}

fn is_js_package_noise(program: &str, line: &str, lower: &str) -> bool {
	if !is_js_program(program) {
		return false;
	}
	line.starts_with('>') && line.contains('@')
		|| lower.starts_with("npm notice")
		|| lower.starts_with("npm http fetch")
		|| lower.starts_with("pnpm: progress")
		// pnpm progress bars are runs of plus signs; anchor on 3+ so a bare '+'
		// diff line (a real change) still passes through.
		|| line.starts_with("+++")
		// yarn classic step markers and berry's structural YN0000 info lines
		// (box-drawing, section headers). Actionable codes (YN0002 peer warnings,
		// YN0060 incompatibilities) carry other YNxxxx codes and are kept.
		|| is_yarn_step_marker(line)
		|| lower.contains("yn0000")
		|| lower.starts_with("packages:")
		|| lower.starts_with("resolved ")
		|| lower.starts_with("reused ")
		|| lower.starts_with("added ") && lower.contains("packages")
		|| lower.starts_with("done in ")
		|| lower.contains("already up-to-date")
		|| lower.contains("up to date")
}

fn is_python_package_noise(ctx: &MinimizerCtx<'_>, _line: &str, lower: &str) -> bool {
	let program = ctx.program;
	if !matches!(program, "pip" | "pip3" | "uv" | "poetry") {
		return false;
	}
	lower.starts_with("collecting ")
		|| lower.starts_with("using cached ")
		|| lower.starts_with("downloading ")
		|| lower.starts_with("preparing metadata")
		|| lower.starts_with("installing build dependencies")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("writing lock file")
		|| lower.starts_with("package operations:")
		// pip prints an upgrade nag as '[notice] A new release of pip is
		// available' plus a '[notice] To update, run: …' follow-up — non-actionable
		// for the wrapped command. Scoped to pip/uv/poetry by the gate above.
		|| lower.starts_with("[notice]")
		|| program == "uv" && is_uv_progress_noise(lower, uv_keeps_install_summary(ctx))
		|| program == "poetry" && is_poetry_bullet_progress(lower)
}

/// poetry prefixes per-package progress with a `- ` or `• ` bullet, e.g.
/// `  - Downloading requests-2.31.0…` / `  • Installing certifi (2023.11.17)`,
/// plus virtualenv-setup chatter. These are the `strip_lines` that previously
/// lived in defs/poetry-install.toml; the bullet prefix means the bare
/// `downloading `/`installing ` checks above never reached them. `lower` is the
/// already-trimmed, lowercased line.
fn is_poetry_bullet_progress(lower: &str) -> bool {
	let bullet = lower
		.strip_prefix("- ")
		.or_else(|| lower.strip_prefix("• "));
	if let Some(rest) = bullet
		&& (rest.starts_with("downloading ") || rest.starts_with("installing ") && rest.contains('('))
	{
		return true;
	}
	lower.starts_with("creating virtualenv") || lower.starts_with("using virtualenv")
}

/// uv sync/add/remove keep the one-line 'Installed/Uninstalled N packages in
/// Xms' summary alongside the +/- delta rows (the count is the install signal).
/// uv lock/tree and every other subcommand still strip those rows as progress.
fn uv_keeps_install_summary(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.program == "uv" && matches!(ctx.subcommand, Some("sync" | "add" | "remove"))
}

fn is_uv_progress_noise(lower: &str, keep_install_summary: bool) -> bool {
	if keep_install_summary && (lower.starts_with("installed ") || lower.starts_with("uninstalled "))
	{
		return false;
	}
	lower.starts_with("resolved ")
		|| lower.starts_with("prepared ")
		|| lower.starts_with("installed ")
		|| lower.starts_with("uninstalled ")
		|| lower.starts_with("updated ")
		|| lower.starts_with("built ")
		|| lower.starts_with("downloaded ")
}

fn is_ruby_php_brew_noise(program: &str, _line: &str, lower: &str) -> bool {
	if !matches!(program, "bundle" | "brew" | "composer") {
		return false;
	}
	if program == "bundle" {
		// Keep 'Bundle complete! … N gems now installed' / 'Bundle updated!' — the
		// one-line gem-count signal (replaces the defs/bundle-install.toml
		// short-circuit). Strip the 'Use `bundle info [gemname]`…' follow-up hint.
		// Using/Fetching/Installing rows are still per-gem progress noise.
		if lower.starts_with("bundle complete") || lower.starts_with("bundle updated") {
			return false;
		}
		if lower.starts_with("use `bundle info") {
			return true;
		}
	}
	lower.starts_with("fetching ")
		|| lower.starts_with("installing ") && !lower.contains("error")
		|| lower.starts_with("using ")
		// brew/composer never emit 'Bundle complete'; this strip is preserved for
		// them but bundle now keeps the line (handled above).
		|| lower.starts_with("bundle complete")
		|| lower.starts_with("==> downloading")
		|| lower.starts_with("==> pouring")
		|| lower.starts_with("loading composer repositories")
		|| lower.starts_with("generating autoload files")
}

fn contains_audit_or_security_summary(input: &str) -> bool {
	input.lines().any(is_audit_or_security_summary)
}

fn is_audit_or_security_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	// 'funding' deliberately excluded: funding nags are stripped as noise and
	// must NOT bypass head_tail_cap. Real audit findings ('audit'/'vulnerab'/
	// 'security') still trip the bypass.
	lower.contains("audit")
		|| lower.contains("audited")
		|| lower.contains("vulnerab")
		|| lower.contains("security")
}

fn is_error_or_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("vulnerab")
		|| lower.contains("audited")
		|| lower.contains("found ")
		|| lower.contains("success")
		|| lower.contains("complete")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn strips_progress_but_keeps_package_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("npm", Some("install"), "npm install", &cfg);
		let input = "Resolving: total 10\nDownloading: left-pad\nERROR failed to install \
		             left-pad\nfound 1 vulnerability\n";
		let out = strip_package_noise(&ctx, input, 1);
		assert!(!out.contains("Resolving:"));
		assert!(!out.contains("Downloading:"));
		assert!(out.contains("ERROR failed"));
		assert!(out.contains("found 1 vulnerability"));
	}

	#[test]
	fn keeps_one_success_summary_strips_funding_and_zero_vulnerabilities() {
		// snip keeps the install summary (the count confirms node_modules state)
		// while dropping progress, funding nags, and 'found 0 vulnerabilities'.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("npm", Some("install"), "npm install", &cfg);
		let input = "Resolving: total 10\nadded 3 packages, and audited 4 packages in 1s\n2 \
		             packages are looking for funding\n  run `npm fund` for details\nfound 0 \
		             vulnerabilities\n";
		let out = strip_package_noise(&ctx, input, 0);
		assert!(!out.contains("Resolving:"));
		assert!(out.contains("added 3 packages, and audited 4 packages in 1s"));
		assert!(!out.contains("looking for funding"));
		assert!(!out.contains("npm fund"));
		assert!(!out.contains("found 0 vulnerabilities"));
	}

	#[test]
	fn preserves_deprecation_warnings() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("npm", Some("install"), "npm install", &cfg);
		let input = "npm warn deprecated left-pad@1.0.0: Please upgrade to left-pad@2.0.0\nnpm warn \
		             deprecated old-lib@2.0.0: Use new-lib instead\n";
		let out = strip_package_noise(&ctx, input, 0);
		assert!(out.contains("npm warn deprecated left-pad@1.0.0: Please upgrade to left-pad@2.0.0"));
		assert!(out.contains("npm warn deprecated old-lib@2.0.0: Use new-lib instead"));
	}

	#[test]
	fn supports_common_package_subcommands_for_future_dispatch() {
		for subcommand in [
			"ci", "add", "outdated", "sync", "audit", "why", "tree", "pip", "view", "fund", "explain",
			"test", "t", "start", "stop", "restart", "config", "cache", "prune", "dedupe", "publish",
			"pack", "link",
		] {
			assert!(supports(Some(subcommand)), "{subcommand} should be supported");
		}
	}

	#[test]
	fn bun_install_noise_uses_js_package_rules() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("install"), "bun install", &cfg);
		let input = "Resolving dependencies\nDownloaded foo\nerror: failed\n";
		let out = strip_package_noise(&ctx, input, 1);
		assert!(!out.contains("Resolving dependencies"));
		assert!(!out.contains("Downloaded foo"));
		assert!(out.contains("error: failed"));
	}

	#[test]
	fn npm_ci_keeps_one_added_summary_and_strips_funding() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("ci"), "npm ci", &cfg);
		let input = "npm warn deprecated glob@7.2.3: no longer supported\nadded 245 packages, and \
		             audited 246 packages in 12s\n\n29 packages are looking for funding\n  run `npm \
		             fund` for details\n\nfound 0 vulnerabilities\n";
		let out = filter(&context, input, 0);
		assert!(
			out.text
				.contains("added 245 packages, and audited 246 packages in 12s")
		);
		assert_eq!(out.text.matches("added 245 packages").count(), 1);
		assert!(!out.text.contains("looking for funding"));
		assert!(!out.text.contains("npm fund"));
		assert!(!out.text.contains("found 0 vulnerabilities"));
	}

	#[test]
	fn npm_audit_surfaces_real_vulnerabilities() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("install"), "npm install", &cfg);
		let input = "added 10 packages, and audited 11 packages in 2s\n3 packages are looking for \
		             funding\n  run `npm fund` for details\n\n2 vulnerabilities (1 moderate, 1 \
		             high)\n\nTo address all issues, run:\n  npm audit fix\n\nfound 2 \
		             vulnerabilities\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("2 vulnerabilities (1 moderate, 1 high)"));
		assert!(out.text.contains("found 2 vulnerabilities"));
		assert!(out.text.contains("npm audit fix"));
		assert!(!out.text.contains("looking for funding"));
	}

	#[test]
	fn pnpm_install_strips_plus_bars_keeps_packages_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("pnpm", Some("install"), "pnpm install", &cfg);
		let input = "Progress: resolved 120, reused 120, downloaded 0, added \
		             0\n+++++++++++++++++\nPackages: +183\n+ left-pad 1.3.0\nDone in 4.2s\n";
		let out = filter(&context, input, 0);
		assert!(!out.text.contains("+++"));
		assert!(out.text.contains("Packages: +183"));
		// A bare '+' diff line (a real change) survives the 3+ plus anchor.
		assert!(out.text.contains("+ left-pad 1.3.0"));
	}

	#[test]
	fn yarn_berry_keeps_actionable_codes_strips_yn0000() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("yarn", Some("install"), "yarn install", &cfg);
		let input = "➤ YN0000: ┌ Resolution step\n➤ YN0002: │ react is listed by your project but \
		             missing peer dependency\n➤ YN0060: │ incompatible peer dependency\n➤ YN0000: └ \
		             Completed\n[2/4] Fetching packages...\nDone in 5.31s\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("YN0002"));
		assert!(out.text.contains("YN0060"));
		assert!(!out.text.contains("YN0000"));
		assert!(!out.text.contains("[2/4] Fetching"));
		assert!(out.text.contains("Done in 5.31s"));
	}

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config }
	}

	#[test]
	fn compacts_large_js_package_tree() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("list"), "npm list --all", &cfg);
		let mut input = String::from("app@1.0.0\n");
		for idx in 0..90 {
			let _ = writeln!(input, "├── dep{idx:03}@1.0.0");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("├── dep000@1.0.0"));
		assert!(out.text.contains("├── dep078@1.0.0"));
		assert!(!out.text.contains("├── dep089@1.0.0"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn compacts_depth_limited_package_tree_commands() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("ls"), "npm ls --depth=0", &cfg);
		let mut input = String::from("app@1.0.0\n");
		for idx in 0..90 {
			let _ = writeln!(input, "├── dep{idx:03}@1.0.0");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("dep000"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn compacts_pnpm_why_style_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("pnpm", Some("why"), "pnpm why react", &cfg);
		let mut input =
			String::from("Legend: production dependency, optional only, dev only\nreact 19.0.0\n");
		for idx in 0..90 {
			let _ = writeln!(input, "└─ dependent{idx:03}");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 92 entries\n"));
		assert!(out.text.contains("react 19.0.0"));
		assert!(out.text.contains("└─ dependent000"));
		assert!(out.text.contains("[…12 package entries elided…]"));
	}

	#[test]
	fn passes_through_npm_json_dependency_tree() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("ls"), "npm ls --json", &cfg);
		let input = r#"{"name":"app","version":"1.0.0","dependencies":{"react":{"version":"19.0.0","dependencies":{"scheduler":{"version":"0.25.0"}}},"zod":{"version":"4.0.0"}}}"#;
		let out = filter(&context, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn passes_through_pnpm_why_json_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("pnpm", Some("why"), "pnpm why react --json", &cfg);
		let input = r#"[{"name":"react","version":"19.0.0","dependents":[{"name":"app","version":"1.0.0"},{"name":"docs","version":"1.0.0"}]}]"#;
		let out = filter(&context, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn passes_through_yarn_why_ndjson_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("yarn", Some("why"), "yarn why react --json", &cfg);
		let input = "{\"type\":\"info\",\"data\":\"=> Found \
		             \\\"react@npm:19.0.0\\\"\"}\n{\"type\":\"tree\",\"data\":\"react@npm:19.0.0\\\
		             n└─ app@workspace:.\"}\n";
		let out = filter(&context, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn passes_through_npm_explain_json_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("explain"), "npm explain react --json", &cfg);
		let input = r#"{"name":"react","version":"19.0.0","dependents":[{"name":"app","version":"1.0.0","location":"."}]}"#;
		let out = filter(&context, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn compacts_uv_pip_list_and_strips_progress_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("pip"), "uv pip list", &cfg);
		let mut input = String::from(
			"Resolved 91 packages in 12ms\nPrepared 2 packages in 3ms\nPackage Version\n",
		);
		for idx in 0..90 {
			let _ = writeln!(input, "pkg{idx:03} 1.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(!out.text.contains("Resolved 91 packages"));
		assert!(!out.text.contains("Prepared 2 packages"));
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("Package Version"));
		assert!(out.text.contains("pkg000 1.0.0"));
		assert!(out.text.contains("pkg078 1.0.78"));
		assert!(!out.text.contains("pkg089 1.0.89"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn compacts_uv_tree_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("tree"), "uv tree", &cfg);
		let mut input = String::from("project v1.0.0\n");
		for idx in 0..90 {
			let _ = writeln!(input, "├── pkg{idx:03} v1.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("project v1.0.0"));
		assert!(out.text.contains("pkg000"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn compacts_poetry_show_tree_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("show"), "poetry show --tree", &cfg);
		let mut input = String::from("requests 2.32.0 Python HTTP for Humans.\n");
		for idx in 0..90 {
			let _ = writeln!(input, "├── dep{idx:03} 1.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("requests 2.32.0"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn passes_through_uv_pip_freeze_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("pip"), "uv pip freeze", &cfg);
		let mut input = String::new();
		for idx in 0..90 {
			let _ = writeln!(input, "pkg{idx:03}==1.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
		assert!(out.text.contains("pkg089==1.0.89"));
		assert!(!out.text.starts_with("package tree/list:"));
	}

	#[test]
	fn compacts_uv_export_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("export"), "uv export -f requirements-txt", &cfg);
		let mut input = String::from("# generated by uv\n");
		for idx in 0..90 {
			let _ = writeln!(input, "pkg{idx:03}==1.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("pkg000==1.0.0"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn compacts_poetry_export_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("export"), "poetry export -f requirements.txt", &cfg);
		let mut input = String::from("# generated by poetry\n");
		for idx in 0..90 {
			let _ = writeln!(input, "dep{idx:03}==2.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("dep000==2.0.0"));
		assert!(out.text.contains("[…11 package entries elided…]"));
	}

	#[test]
	fn pip_install_strips_upgrade_notice_nag() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("pip", Some("install"), "pip install requests", &cfg);
		let input = "Collecting requests\n  Downloading requests-2.31.0-py3-none-any.whl (62 \
		             kB)\nInstalling collected packages: requests\nSuccessfully installed \
		             requests-2.31.0\n[notice] A new release of pip is available: 23.0 -> \
		             24.0\n[notice] To update, run: pip install --upgrade pip\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Successfully installed requests-2.31.0"));
		assert!(!out.text.contains("[notice]"));
		assert!(!out.text.contains("new release of pip"));
		assert!(!out.text.contains("Downloading requests"));
	}

	#[test]
	fn compacts_pip_list_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("pip", Some("list"), "pip list", &cfg);
		let mut input = String::from("Package    Version\n---------- -------\n");
		for idx in 0..90 {
			let _ = writeln!(input, "pkg{idx:03}     1.0.{idx}");
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 92 entries\n"));
		assert!(out.text.contains("pkg000"));
		assert!(out.text.contains("[…12 package entries elided…]"));
	}

	#[test]
	fn compacts_uv_lock_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("lock"), "uv lock", &cfg);
		let input =
			"Resolved 42 packages in 7ms\nDownloading requests\nUpdated lockfile at uv.lock\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Resolved 42 packages in 7ms"));
		assert!(out.text.contains("Updated lockfile at uv.lock"));
		assert!(!out.text.contains("Downloading requests"));
	}

	#[test]
	fn compacts_poetry_lock_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("lock"), "poetry lock", &cfg);
		let input =
			"Resolving dependencies...\nInstalling dependencies from lock file\nWriting lock file\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Installing dependencies from lock file"));
		assert!(out.text.contains("Writing lock file"));
	}

	#[test]
	fn poetry_install_no_changes_short_circuits_to_up_to_date() {
		// Carried over from defs/poetry-install.toml's match_output overlay; now
		// lives in pkg.rs so it fires regardless of overlay ordering. poetry 1.x
		// prints 'No dependencies to install or update'.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("install"), "poetry install", &cfg);
		let input =
			"Installing dependencies from lock file\n\nNo dependencies to install or update\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, "ok (up to date)");
		assert!(out.changed);
	}

	#[test]
	fn poetry_update_no_changes_bullet_short_circuits() {
		// poetry 2.x prints 'No changes.' after bullet rows; still a no-op.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("update"), "poetry update", &cfg);
		let input =
			"• Installing requests (2.31.0)\n• Installing certifi (2023.11.17)\n\nNo changes.\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, "ok (up to date)");
	}

	#[test]
	fn poetry_lock_no_changes_short_circuits() {
		// The short-circuit covers lock too (the deleted def matched
		// install|lock|update).
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("lock"), "poetry lock", &cfg);
		let input = "Resolving dependencies...\nNo changes.\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, "ok (up to date)");
	}

	#[test]
	fn poetry_install_with_real_work_is_not_short_circuited() {
		// A genuine install (no 'No changes'/'No dependencies…' no-op marker) must
		// NOT collapse to 'ok (up to date)'. An actionable warning survives the
		// progress strip and proves the short-circuit did not fire.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("install"), "poetry install", &cfg);
		let input = "Installing dependencies from lock file\n\n  - Downloading \
		             requests-2.31.0-py3-none-any.whl (62.6 kB)\nWarning: the lock file is not up \
		             to date\n";
		let out = filter(&context, input, 0);
		assert_ne!(out.text, "ok (up to date)");
		assert!(
			out.text
				.contains("Warning: the lock file is not up to date")
		);
		assert!(!out.text.contains("Downloading"));
	}

	#[test]
	fn uv_sync_audited_no_op_short_circuits_to_up_to_date() {
		// Replaces defs/uv-sync.toml's 'Audited' overlay; lands as 'ok (up to
		// date)' (not bare 'OK'). Scoped to uv sync/add/remove.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("sync"), "uv sync", &cfg);
		let input = "Resolved 42 packages in 123ms\nAudited 42 packages in 0.05ms\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, "ok (up to date)");
	}

	#[test]
	fn uv_sync_audited_no_op_with_warning_keeps_warning() {
		// Regression: the 'Audited' no-op short-circuit must NOT swallow a
		// co-printed actionable diagnostic. uv on exit 0 can print
		// 'warning: VIRTUAL_ENV=… does not match the project environment path …'
		// before the Resolved/Audited summary; collapsing to 'ok (up to date)'
		// would hide that the sync may have targeted the wrong environment. On HEAD
		// the global is_noise_line stripped 'Audited' but the surviving warning
		// kept the output, so it was reported — preserve that.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("sync"), "uv sync", &cfg);
		let input = "warning: VIRTUAL_ENV=.venv does not match the project environment path \
		             .venv-other\nResolved 42 packages in 123ms\nAudited 42 packages in 0.05ms\n";
		let out = filter(&context, input, 0);
		assert_ne!(out.text, "ok (up to date)");
		assert!(
			out.text
				.contains("warning: VIRTUAL_ENV=.venv does not match the project environment path")
		);
		assert!(!out.text.contains("Audited 42 packages"));
	}

	#[test]
	fn uv_sync_keeps_installed_summary_and_delta_rows() {
		// uv sync/add/remove keep the one-line 'Installed N packages' summary
		// alongside the +/- delta rows; Resolved/Prepared progress is stripped.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("sync"), "uv sync", &cfg);
		let input = "Resolved 5 packages in 12ms\nPrepared 5 packages in 100ms\nInstalled 5 \
		             packages in 23ms\n + certifi==2023.11.17\n + idna==3.6\n + requests==2.31.0\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Installed 5 packages in 23ms"));
		assert!(out.text.contains("+ certifi==2023.11.17"));
		assert!(out.text.contains("+ requests==2.31.0"));
		assert!(!out.text.contains("Resolved 5 packages"));
		assert!(!out.text.contains("Prepared 5 packages"));
	}

	#[test]
	fn uv_add_keeps_installed_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("add"), "uv add requests", &cfg);
		let input = "Resolved 5 packages in 9ms\nInstalled 1 package in 4ms\n + requests==2.31.0\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Installed 1 package in 4ms"));
		assert!(out.text.contains("+ requests==2.31.0"));
		assert!(!out.text.contains("Resolved 5 packages"));
	}

	#[test]
	fn uv_remove_keeps_uninstalled_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("remove"), "uv remove requests", &cfg);
		let input = "Resolved 4 packages in 6ms\nUninstalled 1 package in 2ms\n - requests==2.31.0\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Uninstalled 1 package in 2ms"));
		assert!(out.text.contains("- requests==2.31.0"));
		assert!(!out.text.contains("Resolved 4 packages"));
	}

	#[test]
	fn bundle_install_keeps_complete_line_strips_info_hint() {
		// Replaces defs/bundle-install.toml; keep the 'Bundle complete!' gem-count
		// signal, strip Using/Fetching/Installing rows and the 'Use `bundle info`'
		// hint. Scoped to program=bundle.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("bundle", Some("install"), "bundle install", &cfg);
		let input = "Fetching gem metadata from https://rubygems.org/.........\nResolving \
		             dependencies...\nUsing rake 13.1.0\nFetching rspec 3.13.0\nInstalling rspec \
		             3.13.0\nBundle complete! 85 Gemfile dependencies, 200 gems now installed.\nUse \
		             `bundle info [gemname]` to see where a bundled gem is installed.\n";
		let out = filter(&context, input, 0);
		assert!(
			out.text
				.contains("Bundle complete! 85 Gemfile dependencies, 200 gems now installed.")
		);
		assert!(!out.text.contains("Use `bundle info"));
		assert!(!out.text.contains("Using rake"));
		assert!(!out.text.contains("Installing rspec"));
		assert!(!out.text.contains("Fetching"));
	}

	#[test]
	fn bundle_update_keeps_updated_line() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("bundle", Some("update"), "bundle update", &cfg);
		let input = "Fetching gem metadata from https://rubygems.org/.........\nResolving \
		             dependencies...\nUsing rake 13.1.0\nFetching rspec 3.14.0 (was \
		             3.13.0)\nInstalling rspec 3.14.0 (was 3.13.0)\nBundle updated!\n";
		let out = filter(&context, input, 0);
		assert!(out.text.contains("Bundle updated!"));
		assert!(!out.text.contains("Using rake"));
		assert!(!out.text.contains("Installing rspec"));
	}

	#[test]
	fn brew_install_still_strips_pour_and_download_noise() {
		// Concern 4 scoping guard: brew is unaffected by the bundle-only keep.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("brew", Some("install"), "brew install jq", &cfg);
		let input =
			"==> Downloading https://example.com/jq.tar.gz\n==> Pouring jq--1.7.bottle.tar.gz\n";
		let out = filter(&context, input, 0);
		assert!(!out.text.contains("==> Downloading"));
		assert!(!out.text.contains("==> Pouring"));
	}

	#[test]
	fn test_pip_list_format_json_passthrough() {
		let input = r#"[{"name":"pip","version":"23.0"},{"name":"requests","version":"2.28.0"}]"#;
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };

		// --format=json form: output must be byte-identical to input (no JSON rewrite)
		let context = ctx("pip", Some("list"), "pip list --format=json", &cfg);
		let out = filter(&context, input, 0);
		assert!(!out.changed, "pip list --format=json must not be modified");
		assert_eq!(out.text, input, "pip list --format=json must pass through as JSON");

		// --format json form (two separate tokens): same contract
		let context2 = ctx("pip", Some("list"), "pip list --format json", &cfg);
		let out2 = filter(&context2, input, 0);
		assert!(!out2.changed, "pip list --format json must not be modified");
		assert_eq!(out2.text, input, "pip list --format json must pass through as JSON");
	}
}
