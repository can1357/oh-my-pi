//! Bun package-manager, test-runner, and tool output filters.

use super::{cpp, generic, js_tools, lint, node_tests, pkg};
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const BUN_PACKAGE_SUBCOMMANDS: &[&str] = &[
	"install", "i", "add", "update", "up", "upgrade", "remove", "rm", "outdated", "pm", "audit",
	"run", "exec", "check",
];
const BUN_TEST_SUBCOMMANDS: &[&str] = &["test"];
const BUN_BUILD_SUBCOMMANDS: &[&str] = &["build"];
const BUN_TOOL_SUBCOMMANDS: &[&str] =
	&["tsc", "eslint", "biome", "next", "prettier", "prisma", "jest", "vitest", "playwright"];
const BUN_CPP_TOOL_SUBCOMMANDS: &[&str] = &["cmake", "ctest", "ninja", "gtest", "gtest-parallel"];

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"bun" => subcommand.is_some_and(|subcommand| {
			BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand)
				|| BUN_TEST_SUBCOMMANDS.contains(&subcommand)
				|| BUN_BUILD_SUBCOMMANDS.contains(&subcommand)
				|| BUN_TOOL_SUBCOMMANDS.contains(&subcommand)
				|| BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand)
		}),
		"bunx" => subcommand.is_some_and(|subcommand| {
			BUN_TOOL_SUBCOMMANDS.contains(&subcommand)
				|| BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand)
		}),
		_ => false,
	}
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let subcommand = ctx.subcommand;
	if matches!((ctx.program, subcommand), ("bun", Some(subcommand)) if is_non_exec_package_subcommand(subcommand))
	{
		return pkg::filter(ctx, input, exit_code);
	}
	if is_check_invocation(ctx.program, subcommand, ctx.command) {
		return filter_bun_check(ctx, input, exit_code);
	}
	if is_test_invocation(ctx.program, subcommand, ctx.command) {
		return node_tests::filter(ctx, input, exit_code);
	}
	if is_lint_invocation(ctx.program, subcommand, ctx.command) {
		return lint::filter(ctx, input, exit_code);
	}
	if is_cpp_invocation(ctx.program, subcommand, ctx.command) {
		return cpp::filter(ctx, input, exit_code);
	}
	if is_js_tool_invocation(ctx.program, subcommand, ctx.command) {
		return js_tools::filter(ctx, input, exit_code);
	}
	match (ctx.program, subcommand) {
		("bun", Some("check")) => filter_bun_check(ctx, input, exit_code),
		("bun", Some(subcommand)) if BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand) => {
			pkg::filter(ctx, input, exit_code)
		},
		("bun", Some("build")) => filter_bun_build(input, exit_code),
		_ => generic::filter(ctx, input, exit_code),
	}
}

fn is_non_exec_package_subcommand(subcommand: &str) -> bool {
	BUN_PACKAGE_SUBCOMMANDS.contains(&subcommand) && !matches!(subcommand, "run" | "exec" | "check")
}

fn is_test_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!(
		(program, subcommand),
		("bun", Some("test")) | ("bunx", Some("jest" | "vitest" | "playwright"))
	) || is_exec_package_subcommand(program, subcommand)
		&& command_invoked_word(command).is_some_and(|token| {
			["jest", "vitest", "playwright"].contains(&token) || is_test_script_token(token)
		})
}

fn command_invoked_word(command: &str) -> Option<&str> {
	let mut after_marker = false;
	let mut skip_option_value = false;
	for raw in command.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&')) {
		let token = trim_command_token(raw);
		if token.is_empty() {
			continue;
		}
		if !after_marker {
			if matches!(token, "run" | "exec") {
				after_marker = true;
			}
			continue;
		}
		if skip_option_value {
			skip_option_value = false;
			continue;
		}
		if token.starts_with('-') {
			if bun_wrapper_option_takes_value(token) && !token.contains('=') {
				skip_option_value = true;
			}
			continue;
		}
		return Some(token);
	}
	None
}

fn trim_command_token(token: &str) -> &str {
	token.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'))
}

fn bun_wrapper_option_takes_value(token: &str) -> bool {
	matches!(token, "--filter" | "--cwd" | "--env-file" | "--preload" | "-F" | "-C" | "-r")
}

fn is_test_script_token(token: &str) -> bool {
	let token = trim_command_token(token);
	matches!(token, "test" | "t" | "e2e" | "spec") || token.starts_with("test:")
}

fn is_exec_package_subcommand(program: &str, subcommand: Option<&str>) -> bool {
	matches!((program, subcommand), ("bun", Some("run" | "exec")))
}

fn is_check_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	is_exec_package_subcommand(program, subcommand)
		&& command_invoked_word(command).is_some_and(is_check_script_token)
}
fn is_check_script_token(token: &str) -> bool {
	let token = trim_command_token(token);
	matches!(token, "check") || token.starts_with("check:")
}

fn is_lint_script_token(token: &str) -> bool {
	let token = trim_command_token(token);
	matches!(token, "lint" | "typecheck" | "type-check")
		|| token.starts_with("lint:")
		|| token.starts_with("typecheck:")
		|| token.starts_with("type-check:")
}

fn is_lint_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bun" | "bunx", Some("tsc" | "eslint" | "biome")))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_invoked_word(command).is_some_and(|token| {
				["tsc", "eslint", "biome"].contains(&token) || is_lint_script_token(token)
			})
}

fn is_js_tool_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bun" | "bunx", Some("next" | "prettier" | "prisma")))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_invoked_word(command)
				.is_some_and(|token| ["next", "prettier", "prisma"].contains(&token))
}

fn is_cpp_invocation(program: &str, subcommand: Option<&str>, command: &str) -> bool {
	matches!((program, subcommand), ("bunx", Some(subcommand)) if BUN_CPP_TOOL_SUBCOMMANDS.contains(&subcommand))
		|| is_exec_package_subcommand(program, subcommand)
			&& command_invoked_word(command).is_some_and(|token| {
				BUN_CPP_TOOL_SUBCOMMANDS.contains(&token) || cpp::supports_invocation(token)
			})
}

fn filter_bun_check(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = compact_bun_check_output(ctx, &cleaned, exit_code)
		.unwrap_or_else(|| lint::condense_lint_output(ctx.program, &cleaned, exit_code));
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn compact_bun_check_output(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> Option<String> {
	let mut root_checked = false;
	let mut packages: Vec<&str> = Vec::new();
	let mut diagnostics: Vec<&str> = Vec::new();
	let mut nonzero_exits: Vec<&str> = Vec::new();
	let mut timeout: Option<&str> = None;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		let lower = trimmed.to_ascii_lowercase();
		if lower.contains("timeout") || lower.contains("timed out") {
			timeout = Some(trimmed);
			continue;
		}
		if trimmed.starts_with("$ ") || lower.contains(" check: $ ") {
			continue;
		}
		if let Some(package) = parse_checked_package(trimmed) {
			if !packages.contains(&package) {
				packages.push(package);
			}
			continue;
		}
		if lower.starts_with("checked ") && lower.contains("no fixes applied") {
			root_checked = true;
			continue;
		}
		if let Some(code) = parse_exited_code(trimmed) {
			if code != "0" {
				nonzero_exits.push(trimmed);
			}
			continue;
		}
		if is_bun_check_noise(trimmed, &lower) {
			continue;
		}
		if exit_code != 0 && is_important(trimmed) {
			diagnostics.push(trimmed);
		}
	}

	if !root_checked && packages.is_empty() && diagnostics.is_empty() && nonzero_exits.is_empty() {
		return None;
	}

	let mut out = String::new();
	out.push_str(command_summary(ctx.command));
	out.push_str(": ");
	if !nonzero_exits.is_empty() || !diagnostics.is_empty() {
		out.push_str("failed\n");
	} else if timeout.is_some() {
		out.push_str("visible checks passed; wrapper timed out\n");
	} else if exit_code == 0 {
		out.push_str("passed\n");
	} else {
		out.push_str("incomplete\n");
	}
	if root_checked {
		out.push_str("root biome: ok\n");
	}
	if !packages.is_empty() {
		out.push_str("packages checked: ");
		out.push_str(&packages.join(", "));
		out.push('\n');
	}
	if let Some(timeout) = timeout {
		out.push_str("timeout: ");
		out.push_str(trim_notice_brackets(timeout));
		out.push('\n');
	}
	for line in nonzero_exits.iter().chain(diagnostics.iter()).take(40) {
		out.push_str(line);
		out.push('\n');
	}
	let omitted = nonzero_exits.len() + diagnostics.len();
	if omitted > 40 {
		out.push_str("[…");
		out.push_str(&(omitted - 40).to_string());
		out.push_str(" diagnostic lines elided…]\n");
	}
	Some(out)
}

fn command_summary(command: &str) -> &str {
	let mut parts = command.split_whitespace();
	match (parts.next(), parts.next(), parts.next()) {
		(Some("bun"), Some("run"), Some(script)) => {
			script.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'))
		},
		_ => "bun check",
	}
}

fn parse_checked_package(line: &str) -> Option<&str> {
	let (package, rest) = line.split_once(" check: Checked ")?;
	if rest.contains("No fixes applied") {
		Some(package)
	} else {
		None
	}
}

fn parse_exited_code(line: &str) -> Option<&str> {
	let (_, code) = line.rsplit_once("Exited with code ")?;
	Some(code.trim())
}

fn is_bun_check_noise(line: &str, lower: &str) -> bool {
	line.starts_with("$ ")
		|| lower.contains(" check: $ ")
		|| lower.starts_with("checked ")
		|| lower.ends_with("no fixes applied.")
}

fn trim_notice_brackets(line: &str) -> &str {
	line.trim_matches(|ch| matches!(ch, '[' | ']' | '⟦' | '⟧'))
}

fn filter_bun_build(input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let mut out = String::new();
	for line in cleaned.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_bun_build_noise(trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	let text = if out.trim().is_empty() {
		primitives::head_tail_lines(&cleaned, 120, 80)
	} else {
		primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 120, 80)
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_bun_build_noise(line: &str, exit_code: i32) -> bool {
	if exit_code != 0 && is_important(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	lower.starts_with("bun build ")
		|| lower.starts_with("bundled ") && lower.contains(" in ")
		|| lower.starts_with("transpiled ")
		|| lower.starts_with("resolving ")
		|| lower.starts_with("installing ")
		|| lower.starts_with("saved lockfile")
}

fn is_important(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("panic")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config }
	}

	#[test]
	fn supports_bun_package_test_and_tool_subcommands() {
		for subcommand in ["install", "add", "run", "test", "build", "tsc", "next", "ctest", "check"]
		{
			assert!(supports("bun", Some(subcommand)), "{subcommand} should be supported");
		}
		assert!(supports("bunx", Some("vitest")));
		assert!(supports("bunx", Some("cmake")));
		assert!(!supports("bun", Some("unknown")));
	}

	#[test]
	fn bun_check_direct_subcommand_is_supported_and_routes_to_check_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// supports() must admit "check" as a subcommand
		assert!(supports("bun", Some("check")), "bun check should be supported");
		// filter() must route directly to filter_bun_check
		let ctx = ctx("bun", Some("check"), "bun check", &cfg);
		let biome_output = "packages/coding-agent/src/foo.ts:1:1 lint/suspicious/noExplicitAny \
		                    ━━━━━━━━━\n\n  ✖ Unexpected any.\n\nChecked 127 files in 234ms. 1 error \
		                    found.\n";
		let out = filter(&ctx, biome_output, 1);
		assert!(out.changed, "bun check output should be changed/compressed");
		// should not route to pkg::filter (which would strip the error details)
		assert!(out.text.contains("error"), "check filter must preserve error output");
	}

	#[test]
	fn bun_install_uses_package_noise_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("install"), "bun install", &cfg);
		let out = filter(&ctx, "Resolving dependencies\nDownloaded left-pad\nerror: failed\n", 1);
		assert!(!out.text.contains("Resolving dependencies"));
		assert!(out.text.contains("error: failed"));
	}

	#[test]
	fn bun_add_known_tool_package_names_use_package_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for package in ["eslint", "prettier", "jest"] {
			let command = format!("bun add {package}");
			let ctx = ctx("bun", Some("add"), &command, &cfg);
			let input = format!("Resolving dependencies\nDownloaded {package}\nerror: failed\n");
			let out = filter(&ctx, &input, 1);
			assert!(
				!out.text.contains("Resolving dependencies"),
				"{package} should use package filtering"
			);
			assert!(!out.text.contains("Downloaded"), "{package} should strip package download noise");
			assert!(out.text.contains("error: failed"));
		}
	}

	#[test]
	fn bun_next_build_uses_next_route_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		for (subcommand, command) in
			[(Some("next"), "bun next build"), (Some("run"), "bun run next build")]
		{
			let ctx = ctx("bun", subcommand, command, &cfg);
			let out = filter(
				&ctx,
				"   ▲ Next.js 15.2.0\nCreating an optimized production build ...\nRoute (app)                    Size     First Load JS\n┌ ○ /                          1.2 kB        132 kB\n✓ Built in 34.2s\n",
				0,
			);
			assert!(out.text.contains("Route (app)"));
			assert!(out.text.contains('/'));
			assert!(out.text.contains("Built in 34.2s"));
			assert!(!out.text.contains("Creating an optimized"));
		}
	}

	#[test]
	fn bun_test_uses_test_failure_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("test"), "bun test", &cfg);
		let out = filter(&ctx, "✓ ok\nFAIL app.test.ts\nError: nope\nTests 1 failed\n", 1);
		assert!(!out.text.contains("✓ ok"));
		assert!(out.text.contains("FAIL app.test.ts"));
		assert!(out.text.contains("Tests 1 failed"));
	}

	#[test]
	fn bun_run_cpp_tool_uses_cpp_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run ctest --output-on-failure", &cfg);
		let out = filter(
			&ctx,
			"Test project /tmp/build\n    Start 1: ok\n1/2 Test #1: ok ........   Passed    0.01 \
			 sec\n2/2 Test #2: bad .......***Failed    0.02 sec\nThe following tests FAILED:\n\t  2 \
			 - bad (Failed)\n",
			8,
		);
		assert!(!out.text.contains("Test #1"));
		assert!(out.text.contains("Test #2: bad"));
		assert!(out.text.contains("The following tests FAILED"));
	}

	#[test]
	fn bun_build_strips_success_noise_but_keeps_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("build"), "bun build src/index.ts", &cfg);
		let out = filter(
			&ctx,
			"bun build src/index.ts\nBundled 12 modules in 20ms\nerror: missing export\n",
			1,
		);
		assert!(!out.text.contains("Bundled 12 modules"));
		assert!(out.text.contains("error: missing export"));
	}

	#[test]
	fn bun_run_test_routes_to_node_tests() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run test", &cfg);
		let out = filter(&ctx, "✓ pass 1\n✓ pass 2\nFAIL app.test.ts\nTests 1 failed, 2 passed\n", 1);
		assert!(!out.text.contains("✓ pass 1"));
		assert!(out.text.contains("FAIL app.test.ts"));
		assert!(out.text.contains("Tests 1 failed, 2 passed"));
	}

	#[test]
	fn bun_run_lint_and_typecheck_route_to_lint_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = concat!(
			"src/app.ts:1:1: error TS2322: Type 'string' is not assignable to type 'number'.\n",
			"src/app.ts:2:1: error TS7006: Parameter 'x' implicitly has an 'any' type.\n",
		);

		for command in
			["bun run lint", "bun run lint:ci", "bun run typecheck", "bun run typecheck:ci"]
		{
			let ctx = ctx("bun", Some("run"), command, &cfg);
			let routed = filter(&ctx, input, 1).text;
			let expected = lint::filter(&ctx, input, 1).text;
			assert_eq!(routed, expected, "{command} should use lint filter");
			assert!(
				routed.contains("2 diagnostics in 1 files"),
				"{command} should condense lint output"
			);
		}
	}

	#[test]
	fn quoted_bun_run_test_routes_to_node_tests() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run 'test'", &cfg);
		let out = filter(&ctx, "✓ pass 1\nFAIL app.test.ts\nTests 1 failed, 1 passed\n", 1);
		assert!(!out.text.contains("✓ pass 1"));
		assert!(out.text.contains("FAIL app.test.ts"));
	}

	#[test]
	fn bun_run_test_colon_routes_to_node_tests() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run test:unit", &cfg);
		let out = filter(&ctx, "✓ passes\nFAIL src/example.test.ts\nTests 1 failed, 1 passed\n", 1);
		assert!(!out.text.contains("✓ passes"));
		assert!(out.text.contains("FAIL src/example.test.ts"));
	}

	#[test]
	fn bun_run_e2e_routes_to_node_tests() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run e2e", &cfg);
		let out = filter(&ctx, "✓ passes\nFAIL e2e/spec.ts\nTests 1 failed, 1 passed\n", 1);
		assert!(!out.text.contains("✓ passes"));
		assert!(out.text.contains("FAIL e2e/spec.ts"));
	}

	#[test]
	fn bun_run_check_colon_compacts_workspace_success_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run 'check:ts'", &cfg);
		let out = filter(
			&ctx,
			"$ bun run check:tools && bun run --workspaces --if-present check\n$ biome check . \
			 --no-errors-on-unmatched\nChecked 1690 files in 371ms. No fixes \
			 applied.\n@oh-my-pi/pi-utils check: Checked 40 files in 11ms. No fixes \
			 applied.\n@oh-my-pi/pi-utils check: $ tsgo -p tsconfig.json \
			 --noEmit\n@oh-my-pi/pi-utils check: Exited with code 0\n@oh-my-pi/pi-coding-agent \
			 check: Checked 1178 files in 287ms. No fixes applied.\n@oh-my-pi/pi-coding-agent check: \
			 $ tsgo -p tsconfig.json --noEmit\n@oh-my-pi/pi-coding-agent check: Exited with code 0\n",
			0,
		);

		assert!(out.text.contains("check:ts: passed"));
		assert!(out.text.contains("root biome: ok"));
		assert!(out.text.contains("@oh-my-pi/pi-utils"));
		assert!(out.text.contains("@oh-my-pi/pi-coding-agent"));
		assert!(!out.text.contains("No fixes applied"));
		assert!(!out.text.contains("tsgo -p"));
		assert!(!out.text.contains("Exited with code 0"));
	}

	#[test]
	fn bun_run_check_timeout_preserves_ambiguous_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run check:ts", &cfg);
		let out = filter(
			&ctx,
			"@oh-my-pi/pi-utils check: Checked 40 files in 11ms. No fixes \
			 applied.\n@oh-my-pi/pi-utils check: Exited with code 0\n[Command timed out after 300 \
			 seconds]\n",
			1,
		);

		assert!(
			out.text
				.contains("visible checks passed; wrapper timed out")
		);
		assert!(
			out.text
				.contains("timeout: Command timed out after 300 seconds")
		);
		assert!(!out.text.contains("failed"));
	}

	#[test]
	fn bun_run_build_still_uses_pkg_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run build", &cfg);
		let out = filter(&ctx, "Resolving dependencies\nDownloaded foo\nerror: failed\n", 1);
		assert!(!out.text.contains("Resolving dependencies"));
		assert!(out.text.contains("error: failed"));
	}

	#[test]
	fn bun_run_build_argument_named_test_stays_on_package_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("bun", Some("run"), "bun run build -- test", &cfg);
		let out = filter(&ctx, "PASS emitted by build\n✓ emitted by build\nerror: failed\n", 1);
		assert!(out.text.contains("PASS emitted by build"));
		assert!(out.text.contains("✓ emitted by build"));
		assert!(out.text.contains("error: failed"));
	}

	// --- bun test failure — failure lines and summary survive ---

	#[test]
	fn bun_test_failure_keeps_fail_file_and_summary() {
		// `bun test` failure: FAIL lines, error text, and the totals line
		// must survive.  Passing checkmarks must be stripped.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let bun_ctx = ctx("bun", Some("test"), "bun test", &cfg);
		let input = concat!(
			"✓ auth.test.ts > login passes (12ms)\n",
			"✓ auth.test.ts > logout ok (8ms)\n",
			"FAIL auth.test.ts\n",
			"● register fails when email taken\n",
			"  Error: expected status 409, got 200\n",
			"      at auth.test.ts:88:5\n",
			"Tests 1 failed, 2 passed (33ms)\n",
		);

		let out = filter(&bun_ctx, input, 1);

		assert!(
			!out.text.contains("✓ auth.test.ts > login"),
			"passing lines must be stripped: {:?}",
			out.text
		);
		assert!(out.text.contains("FAIL auth.test.ts"), "FAIL line must survive: {:?}", out.text);
		assert!(
			out.text.contains("Error: expected status 409"),
			"error body must survive: {:?}",
			out.text
		);
		assert!(out.text.contains("Tests 1 failed"), "summary line must survive: {:?}", out.text);
		assert!(out.text.contains("2 passed"), "passed count must survive: {:?}", out.text);
	}

	#[test]
	fn bun_test_success_strips_all_pass_lines() {
		// On success all ✓ lines are noise — the agent only needs the summary.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let bun_ctx = ctx("bun", Some("test"), "bun test", &cfg);
		let input = concat!(
			"✓ foo.test.ts > passes (5ms)\n",
			"✓ bar.test.ts > also passes (3ms)\n",
			"Tests 2 passed (8ms)\n",
		);

		let out = filter(&bun_ctx, input, 0);

		assert!(
			!out.text.contains("✓ foo.test.ts"),
			"passing lines must be stripped: {:?}",
			out.text
		);
		assert!(
			!out.text.contains("✓ bar.test.ts"),
			"passing lines must be stripped: {:?}",
			out.text
		);
		// Summary or some indication of passing must survive.
		assert!(
			out.text.contains("passed") || !out.changed,
			"summary must survive or output unchanged"
		);
	}

	// --- bun check failure — diagnostic lines survive, noise stripped ---

	#[test]
	fn bun_check_failure_keeps_diagnostic_and_emits_failed_status() {
		// `bun check` (routed via `bun run check:ts`) with real type errors
		// must surface the diagnostic lines and emit a `failed` verdict.
		// Package-manager download noise and `Exited with code 0` lines
		// must not appear.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let bun_ctx = ctx("bun", Some("run"), "bun run check:ts", &cfg);
		let input = concat!(
			"$ bun run --workspaces check\n",
			"@oh-my-pi/pi-utils check: $ tsgo -p tsconfig.json --noEmit\n",
			"@oh-my-pi/pi-utils check: Exited with code 0\n",
			"@oh-my-pi/pi-coding-agent check: $ tsgo -p tsconfig.json --noEmit\n",
			"src/tools/bash.ts(42,7): error TS2322: Type 'string' is not assignable to type \
			 'number'.\n",
			"@oh-my-pi/pi-coding-agent check: Exited with code 1\n",
		);

		let out = filter(&bun_ctx, input, 1);

		assert!(out.text.contains("failed"), "failed verdict must appear: {:?}", out.text);
		assert!(out.text.contains("error TS2322"), "diagnostic must survive: {:?}", out.text);
		assert!(
			!out.text.contains("tsgo -p"),
			"internal command lines must be stripped: {:?}",
			out.text
		);
		// Nonzero exit lines are preserved as evidence (code 0 exits are stripped).
		assert!(
			out.text.contains("Exited with code 1"),
			"nonzero exit line must survive as evidence: {:?}",
			out.text
		);
		assert!(
			!out.text.contains("Exited with code 0"),
			"zero exit noise must be stripped: {:?}",
			out.text
		);
	}

	#[test]
	fn bun_check_success_emits_passed_status_and_no_noise() {
		// Clean `bun run check:ts` (all packages exit 0) must compact to a
		// single `passed` summary line without biome/tsgo details.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let bun_ctx = ctx("bun", Some("run"), "bun run check:ts", &cfg);
		let input = concat!(
			"$ bun run --workspaces check\n",
			"Checked 1690 files in 371ms. No fixes applied.\n",
			"@oh-my-pi/pi-utils check: Checked 40 files in 11ms. No fixes applied.\n",
			"@oh-my-pi/pi-utils check: $ tsgo -p tsconfig.json --noEmit\n",
			"@oh-my-pi/pi-utils check: Exited with code 0\n",
			"@oh-my-pi/pi-coding-agent check: Checked 1178 files in 287ms. No fixes applied.\n",
			"@oh-my-pi/pi-coding-agent check: $ tsgo -p tsconfig.json --noEmit\n",
			"@oh-my-pi/pi-coding-agent check: Exited with code 0\n",
		);

		let out = filter(&bun_ctx, input, 0);

		assert!(out.changed, "clean check must be compacted");
		assert!(out.text.contains("passed"), "passed verdict must appear: {:?}", out.text);
		assert!(
			!out.text.contains("No fixes applied"),
			"biome noise must be stripped: {:?}",
			out.text
		);
		assert!(
			!out.text.contains("tsgo -p"),
			"internal command lines must be stripped: {:?}",
			out.text
		);
		assert!(
			!out.text.contains("Exited with code"),
			"exit noise must be stripped: {:?}",
			out.text
		);
	}
}
