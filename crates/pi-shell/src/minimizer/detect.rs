//! Best-effort command detection for minimizer dispatch.

/// Parsed command identity used for filter dispatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandIdentity {
	pub program:    String,
	pub subcommand: Option<String>,
}

/// Extract the executable and the relevant subcommand from a shell command.
///
/// The detector intentionally handles the common interactive subset instead
/// of emulating a full shell parser. Ambiguous commands return `None` and are
/// left streaming unchanged.
#[must_use]
pub fn detect(command: &str) -> Option<CommandIdentity> {
	let tokens = tokenize(command);
	detect_tokens(&tokens)
}

/// Extract command identity from an already-expanded argv vector.
#[must_use]
pub fn detect_tokens(tokens: &[String]) -> Option<CommandIdentity> {
	let tokens = strip_launch_prefix(tokens)?;
	let (program, rest) = tokens.split_first()?;
	let normalized = normalize_program(program)?;
	let is_docker_compose = program
		.rsplit('/')
		.next()
		.is_some_and(|n| n.eq_ignore_ascii_case("docker-compose"));
	let subcommand = if is_docker_compose {
		// docker-compose v1 flags that consume a value; skip them so the
		// real action (up/down/ps/logs/etc.) is found, matching docker compose
		// routing in docker.rs.
		first_non_global_arg(
			rest,
			&[
				"-f",
				"--file",
				"--profile",
				"-p",
				"--project-name",
				"--env-file",
				"--parallel",
				"--progress",
				"--project-directory",
				"--workdir",
				"-w",
				"--ansi",
				"--log-level",
				"-H",
				"--host",
				"--tlscacert",
				"--tlscert",
				"--tlskey",
			],
			&["--compatibility", "--dry-run", "--verbose", "-v", "--no-ansi"],
			&[],
		)
	} else {
		detect_subcommand(&normalized, rest)
	};
	Some(CommandIdentity { program: normalized, subcommand })
}

fn strip_launch_prefix(tokens: &[String]) -> Option<&[String]> {
	let mut index = 0;

	loop {
		let before = index;
		while tokens
			.get(index)
			.is_some_and(|token| is_env_assignment(token))
		{
			index += 1;
		}

		let token = tokens.get(index)?;

		match token.as_str() {
			"env" => {
				index = skip_env_options(tokens, index + 1)?;
			},
			"sudo" => {
				index = skip_sudo_options(tokens, index + 1)?;
			},
			"command" => {
				index = skip_command_options(tokens, index + 1)?;
			},
			"builtin" | "noglob" => {
				index += 1;
			},
			"exec" => {
				index = skip_exec_options(tokens, index + 1)?;
			},
			"time" => {
				index = skip_time_options(tokens, index + 1)?;
			},
			_ => {},
		}

		if index == before {
			break;
		}
	}

	Some(&tokens[index..])
}

fn is_env_assignment(token: &str) -> bool {
	let Some((name, _)) = token.split_once('=') else {
		return false;
	};
	let mut chars = name.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	(first == '_' || first.is_ascii_alphabetic())
		&& chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn normalize_program(program: &str) -> Option<String> {
	let name = program.rsplit('/').next()?;
	if name.is_empty() {
		return None;
	}
	let lowered = name.to_lowercase();
	// Exact-match allowlist for Windows launcher scripts whose `.bat`/`.cmd`
	// twin should dispatch identically to the bare wrapper. Kept explicit on
	// purpose: a generic `.bat`/`.cmd` strip would over-match unrelated scripts
	// (e.g. `foo.bat`, `deploy.cmd`).
	Some(match lowered.as_str() {
		"gradlew.bat" => "gradlew".to_string(),
		"mvnw.cmd" => "mvnw".to_string(),
		"docker-compose" => "docker".to_string(),
		_ => lowered,
	})
}

fn skip_env_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-S" | "--split-string" => return None,
			"-i" | "-" | "--ignore-environment" => index += 1,
			"-u" | "--unset" | "-C" | "--chdir" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with("--unset=") || token.starts_with("--chdir=") => index += 1,
			_ if is_env_assignment(token) => index += 1,
			_ => break,
		}
	}
	Some(index)
}

fn skip_sudo_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-E" | "-H" | "-n" | "-S" | "-k" | "-K" | "-b" => index += 1,
			"-u" | "--user" | "-g" | "--group" | "-h" | "--host" | "-p" | "--prompt" | "-C"
			| "--close-from" | "-T" | "--command-timeout" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with("--user=")
				|| token.starts_with("--group=")
				|| token.starts_with("--host=")
				|| token.starts_with("--prompt=")
				|| token.starts_with("--close-from=")
				|| token.starts_with("--command-timeout=") =>
			{
				index += 1;
			},
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_command_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-p" => index += 1,
			"-v" | "-V" => return None,
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_exec_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-c" | "-l" => index += 1,
			"-a" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_time_options(tokens: &[String], mut index: usize) -> Option<usize> {
	while let Some(token) = tokens.get(index) {
		match token.as_str() {
			"--" => return Some(index + 1),
			"-p" | "--portability" | "-v" | "--verbose" => index += 1,
			"-f" | "--format" | "-o" | "--output" => index = skip_option_value(tokens, index)?,
			_ if token.starts_with("--format=") || token.starts_with("--output=") => index += 1,
			_ if token.starts_with('-') => return None,
			_ => break,
		}
	}
	Some(index)
}

fn skip_aws_global_options(args: &[String]) -> Option<usize> {
	const VALUE_FLAGS: &[&str] = &[
		"--profile",
		"--region",
		"--endpoint-url",
		"--cli-binary-format",
		"--output",
		"--cli-read-timeout",
		"--cli-connect-timeout",
		"--ca-bundle",
		"--color",
		"--query",
		"--cli-input-json",
		"--cli-input-yaml",
	];
	const BOOL_FLAGS: &[&str] = &[
		"--no-cli-pager",
		"--debug",
		"--no-verify-ssl",
		"--no-paginate",
		"--no-sign-request",
		"--cli-auto-prompt",
		"--no-cli-auto-prompt",
	];

	let mut index = 0;
	while let Some(arg) = args.get(index) {
		if arg == "--" {
			return args.get(index + 1).map(|_| index + 1);
		}
		if BOOL_FLAGS.contains(&arg.as_str()) {
			index += 1;
			continue;
		}
		if arg == "--generate-cli-skeleton" {
			index += 1;
			if args
				.get(index)
				.is_some_and(|value| matches!(value.as_str(), "input" | "output" | "yaml-input"))
			{
				index += 1;
			}
			continue;
		}
		if arg.starts_with("--generate-cli-skeleton=") {
			index += 1;
			continue;
		}
		if option_consumes_value(arg, VALUE_FLAGS) {
			index = if option_has_inline_value(arg, VALUE_FLAGS) {
				index + 1
			} else {
				index + 2
			};
			continue;
		}
		break;
	}
	if index > args.len() {
		None
	} else {
		Some(index)
	}
}

fn skip_option_value(tokens: &[String], index: usize) -> Option<usize> {
	let token = tokens.get(index)?;
	if token.starts_with("--") && token.contains('=') {
		return Some(index + 1);
	}
	if token.starts_with('-') && !token.starts_with("--") && token.len() > 2 {
		return Some(index + 1);
	}
	tokens.get(index + 1).map(|_| index + 2)
}

fn detect_subcommand(program: &str, args: &[String]) -> Option<String> {
	match program {
		"git" | "yadm" => first_non_global_arg(
			args,
			&["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--html-path"],
			&[
				"--bare",
				"--no-pager",
				"--paginate",
				"--no-optional-locks",
				"--literal-pathspecs",
				"--glob-pathspecs",
				"--noglob-pathspecs",
				"--icase-pathspecs",
				"--no-replace-objects",
			],
			&[],
		),
		"cargo" => first_non_global_arg(
			args,
			&["-C", "--manifest-path", "--target-dir", "--config", "-Z", "--color", "--jobs", "-j"],
			&[
				"--locked",
				"--offline",
				"--frozen",
				"--workspace",
				"--all",
				"--verbose",
				"-v",
				"--quiet",
				"-q",
			],
			&["+"],
		),
		"docker" => first_non_global_arg(
			args,
			&[
				"--config",
				"--context",
				"-c",
				"--host",
				"-H",
				"--log-level",
				"--tlscacert",
				"--tlscert",
				"--tlskey",
			],
			&["--debug", "-D", "--tls", "--tlsverify"],
			&[],
		),
		"gh" => first_non_global_arg(
			args,
			&["--repo", "-R", "--hostname", "--jq", "--template"],
			&["--paginate", "--slurp", "--verbose"],
			&[],
		),
		// glab's clap-level globals are `-R`/`--repo` and `-g`/`--group`
		// (donor rtk/src/cmds/git/glab_cmd.rs + README); both take a value, so
		// skip them and their argument to reach the real subcommand.
		"glab" => first_non_global_arg(args, &["-R", "--repo", "-g", "--group"], &[], &[]),
		"gt" => first_non_global_arg(
			args,
			&["--repo", "--cwd", "--config", "--debug-context"],
			&["--no-interactive", "--interactive", "--version", "--help"],
			&[],
		),
		"npm" => first_non_global_arg(
			args,
			&["--prefix", "-C", "--workspace", "-w", "--userconfig", "--cache", "--registry"],
			&[
				"--global",
				"-g",
				"--workspaces",
				"--include-workspace-root",
				"--offline",
				"--prefer-offline",
			],
			&[],
		),
		"npx" => first_non_global_arg(
			args,
			&[
				"--workspace",
				"-w",
				"--package",
				"-p",
				"--prefix",
				"--cache",
				"--registry",
				"--userconfig",
				"--call",
				"--shell",
				"--node-arg",
			],
			&["--yes", "--no", "--no-install", "--quiet", "--silent", "--verbose"],
			&[],
		)
		// Strip npm version qualifier from package specs (jest@latest → jest,
		// @scope/pkg@1.0 → @scope/pkg). The idx > 0 guard preserves the leading
		// `@` on scoped packages. This keeps version-pinned invocations routed to
		// the same filter as their unpinned equivalents.
		.map(|s| match s.rfind('@') {
			Some(idx) if idx > 0 => s[..idx].to_string(),
			_ => s,
		}),
		"pnpm" => first_non_global_arg(
			args,
			&["--dir", "-C", "--filter", "-F", "--workspace", "--config", "--store-dir"],
			&["--global", "-g", "--workspace-root", "-w", "--offline", "--recursive", "-r"],
			&[],
		),
		"yarn" => first_non_global_arg(
			args,
			&["--cwd", "--cache-folder", "--global-folder", "--modules-folder", "--mutex"],
			&["--offline", "--silent", "--verbose"],
			&[],
		),
		"bun" => first_non_global_arg(
			args,
			&["--cwd", "-C", "--config", "--registry", "--cache-dir"],
			&["--bun", "--silent", "--verbose", "--watch", "--hot", "--no-clear-screen"],
			&[],
		),
		"pip" | "pip3" => first_non_global_arg(
			args,
			&[
				"--python",
				"--cache-dir",
				"--proxy",
				"--timeout",
				"--trusted-host",
				"--cert",
				"--client-cert",
			],
			&["--isolated", "--require-virtualenv", "--no-cache-dir", "--disable-pip-version-check"],
			&[],
		),
		"bundle" => first_non_global_arg(
			args,
			&["--gemfile", "--path", "--jobs", "--retry"],
			&["--verbose", "--quiet", "--no-color"],
			&[],
		),
		"aws" => skip_aws_global_options(args)
			.and_then(|index| args.get(index))
			.map(|arg| arg.to_lowercase()),
		"uv" | "uvx" => first_non_global_arg(
			args,
			&[
				"--directory",
				"-C",
				"--project",
				"-p",
				"--cache-dir",
				"--config-file",
				"--config-setting",
				"--python",
				"--python-preference",
				"--exclude-newer",
				"--color",
				"--allow-insecure-host",
				"--no-binary",
				"--only-binary",
			],
			&[
				"--offline",
				"--no-cache",
				"--no-cache-dir",
				"--no-progress",
				"--native-tls",
				"--no-native-tls",
				"--quiet",
				"-q",
				"--verbose",
				"-v",
				"--upgrade",
				"--no-upgrade",
				"--require-hashes",
				"--verify-hashes",
				"--no-verify-hashes",
				"--no-build",
				"--reinstall",
			],
			&[],
		),
		"jest" | "vitest" => first_non_global_arg(args, &[], &[], &[]),
		_ => args
			.iter()
			.find(|arg| !arg.starts_with('-'))
			.map(|arg| arg.to_lowercase()),
	}
}

fn first_non_global_arg(
	args: &[String],
	flags_with_values: &[&str],
	flag_only: &[&str],
	bare_prefixes: &[&str],
) -> Option<String> {
	let mut index = 0;
	while let Some(arg) = args.get(index) {
		if arg == "--" {
			return args.get(index + 1).map(|value| value.to_lowercase());
		}
		if bare_prefixes.iter().any(|prefix| arg.starts_with(prefix)) {
			index += 1;
			continue;
		}
		if flag_only.contains(&arg.as_str()) {
			index += 1;
			continue;
		}
		if option_consumes_value(arg, flags_with_values) {
			index += if option_has_inline_value(arg, flags_with_values) {
				1
			} else {
				2
			};
			continue;
		}
		if arg.starts_with('-') {
			index += 1;
			continue;
		}
		return Some(arg.to_lowercase());
	}
	None
}

fn option_consumes_value(arg: &str, flags_with_values: &[&str]) -> bool {
	flags_with_values.iter().any(|flag| {
		arg == *flag
			|| (flag.starts_with("--") && arg.starts_with(&format!("{flag}=")))
			|| (!flag.starts_with("--") && arg.starts_with(flag) && arg.len() > flag.len())
	})
}

fn option_has_inline_value(arg: &str, flags_with_values: &[&str]) -> bool {
	flags_with_values.iter().any(|flag| {
		(flag.starts_with("--") && arg.starts_with(&format!("{flag}=")))
			|| (!flag.starts_with("--") && arg.starts_with(flag) && arg.len() > flag.len())
	})
}

fn tokenize(command: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	let mut current = String::new();
	let mut chars = command.chars();
	let mut quote: Option<char> = None;
	while let Some(ch) = chars.next() {
		match (quote, ch) {
			(None, '\'' | '"') => quote = Some(ch),
			(Some(q), c) if c == q => quote = None,
			(None, '\\') => {
				if let Some(next) = chars.next() {
					current.push(next);
				}
			},
			(None, c) if c.is_whitespace() => {
				if !current.is_empty() {
					tokens.push(std::mem::take(&mut current));
				}
			},
			(None, ';' | '|' | '&') => break,
			(_, c) => current.push(c),
		}
	}
	if !current.is_empty() {
		tokens.push(current);
	}
	tokens
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn detects_basic_program_and_subcommand() {
		let command = detect("git status --short").expect("git command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn skips_env_prefix_and_git_globals() {
		let command = detect("FOO=1 git -C repo -c color.ui=false status")
			.expect("git command after env assignment is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn handles_quoted_program_args() {
		let command = detect("env FOO=bar cargo --manifest-path 'a b/Cargo.toml' test")
			.expect("cargo command is detected");
		assert_eq!(command.program, "cargo");
		assert_eq!(command.subcommand.as_deref(), Some("test"));
	}

	#[test]
	fn normalizes_env_and_executable_path() {
		let command = detect("env FOO=1 /usr/bin/git status").expect("path command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn skips_shell_launch_wrappers() {
		let command = detect("sudo -E command -p /usr/bin/git --no-pager status")
			.expect("wrapped command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn skips_cargo_toolchain_and_globals() {
		let command = detect("cargo +nightly --manifest-path path/Cargo.toml clippy")
			.expect("cargo command is detected");
		assert_eq!(command.program, "cargo");
		assert_eq!(command.subcommand.as_deref(), Some("clippy"));
	}

	#[test]
	fn skips_cargo_cwd_and_toolchain_globals() {
		let command = detect("cargo -C repo +nightly test");
		assert_eq!(command.as_ref().map(|value| value.program.as_str()), Some("cargo"));
		assert_eq!(
			command
				.as_ref()
				.and_then(|value| value.subcommand.as_deref()),
			Some("test")
		);
	}

	#[test]
	fn skips_package_manager_globals() {
		let command = detect("pnpm --filter @app/web install").expect("pnpm command is detected");
		assert_eq!(command.program, "pnpm");
		assert_eq!(command.subcommand.as_deref(), Some("install"));
	}

	#[test]
	fn stops_at_compound_command_boundary() {
		let command = detect("git -C repo status | cat").expect("first command is detected");
		assert_eq!(command.program, "git");
		assert_eq!(command.subcommand.as_deref(), Some("status"));
	}

	#[test]
	fn returns_none_for_non_launching_wrappers() {
		assert!(detect("command -v git").is_none());
		assert!(detect("env -S 'git status'").is_none());
	}

	#[test]
	fn detects_direct_lint_tools() {
		let command = detect("eslint src/foo.ts").expect("eslint command is detected");
		assert_eq!(command.program, "eslint");
		assert_eq!(command.subcommand.as_deref(), Some("src/foo.ts"));

		let command = detect("tsc --project tsconfig.json").expect("tsc command is detected");
		assert_eq!(command.program, "tsc");
		assert_eq!(command.subcommand.as_deref(), Some("tsconfig.json"));
	}

	#[test]
	fn detects_gradle_and_maven_wrapper_scripts() {
		let command = detect("./gradlew build").expect("gradlew command is detected");
		assert_eq!(command.program, "gradlew");
		assert_eq!(command.subcommand.as_deref(), Some("build"));

		let command = detect("gradlew.bat assembleDebug").expect("gradlew.bat normalizes to gradlew");
		assert_eq!(command.program, "gradlew");
		assert_eq!(command.subcommand.as_deref(), Some("assembledebug"));

		let command = detect("mvnw.cmd package").expect("mvnw.cmd normalizes to mvnw");
		assert_eq!(command.program, "mvnw");
		assert_eq!(command.subcommand.as_deref(), Some("package"));
	}

	#[test]
	fn wrapper_allowlist_does_not_strip_unrelated_bat_or_cmd() {
		// The allowlist is exact-match only; arbitrary `.bat`/`.cmd` scripts keep
		// their full basename so unrelated tools are not silently re-dispatched.
		let command = detect("foo.bat run").expect("foo.bat command is detected");
		assert_eq!(command.program, "foo.bat");
		assert_eq!(command.subcommand.as_deref(), Some("run"));

		let command = detect("deploy.cmd go").expect("deploy.cmd command is detected");
		assert_eq!(command.program, "deploy.cmd");
		assert_eq!(command.subcommand.as_deref(), Some("go"));
	}

	#[test]
	fn detects_glab_subcommand_past_repo_global() {
		let command = detect("glab -R owner/repo mr list").expect("glab command is detected");
		assert_eq!(command.program, "glab");
		assert_eq!(command.subcommand.as_deref(), Some("mr"));
	}

	#[test]
	fn default_arm_returns_first_positional_for_unknown_program() {
		// Regression pin: programs without a dedicated arm fall through to the
		// default branch, which returns the first non-flag token verbatim.
		let command = detect("rustc main.rs").expect("rustc command is detected");
		assert_eq!(command.program, "rustc");
		assert_eq!(command.subcommand.as_deref(), Some("main.rs"));
	}

	#[test]
	fn detects_gt_through_wrappers_and_globals() {
		let command = detect("env GRAPHITE_TOKEN=x command gt --repo owner/repo submit --stack")
			.expect("gt command is detected");
		assert_eq!(command.program, "gt");
		assert_eq!(command.subcommand.as_deref(), Some("submit"));
	}

	#[test]
	fn detects_gt_inline_global_value() {
		let command = detect("gt --repo=owner/repo sync").expect("gt command is detected");
		assert_eq!(command.program, "gt");
		assert_eq!(command.subcommand.as_deref(), Some("sync"));
	}

	#[test]
	fn skips_aws_global_options() {
		let command = detect(
			"aws --profile foo --region=us-east-1 --endpoint-url http://localhost:4566 \
			 --no-cli-pager --generate-cli-skeleton output s3 ls",
		)
		.expect("aws command is detected");
		assert_eq!(command.program, "aws");
		assert_eq!(command.subcommand.as_deref(), Some("s3"));
	}

	#[test]
	fn aws_double_dash_terminates_global_options() {
		let command = detect("aws -- --literal-service op").expect("aws command is detected");
		assert_eq!(command.program, "aws");
		assert_eq!(command.subcommand.as_deref(), Some("--literal-service"));
	}

	#[test]
	fn aws_global_option_permutations_keep_service_subcommand() {
		let flags = [
			"--profile dev",
			"--region us-east-1",
			"--endpoint-url=http://localhost:4566",
			"--cli-binary-format raw-in-base64-out",
			"--output json",
			"--cli-read-timeout=5",
			"--cli-connect-timeout 5",
			"--ca-bundle /tmp/ca.pem",
			"--color off",
			"--query Buckets[].Name",
			"--cli-input-json file://input.json",
			"--cli-input-yaml file://input.yaml",
			"--no-cli-pager",
			"--debug",
			"--no-verify-ssl",
			"--no-paginate",
			"--no-sign-request",
			"--cli-auto-prompt",
			"--no-cli-auto-prompt",
			"--generate-cli-skeleton",
			"--generate-cli-skeleton=output",
		];
		for idx in 0..128 {
			let mut command = String::from("aws");
			for (bit, flag) in flags.iter().enumerate() {
				if idx & (1 << (bit % 7)) != 0 && (idx + bit) % 3 == 0 {
					command.push(' ');
					command.push_str(flag);
				}
			}
			command.push_str(" lambda list-functions");
			let detected = detect(&command).expect("aws command is detected");
			assert_eq!(detected.subcommand.as_deref(), Some("lambda"), "{command}");
		}
	}
}

#[test]
fn detects_bun_globals_and_subcommands() {
	let command = detect("bun --cwd packages/app install").expect("bun command is detected");
	assert_eq!(command.program, "bun");
	assert_eq!(command.subcommand.as_deref(), Some("install"));

	let command = detect("env CI=1 /usr/local/bin/bun test").expect("bun test is detected");
	assert_eq!(command.program, "bun");
	assert_eq!(command.subcommand.as_deref(), Some("test"));
}

#[test]
fn npx_workspace_value_is_skipped_in_subcommand_detection() {
	// `npx -w <workspace>` is a value-taking option; the workspace name must
	// not be returned as the subcommand. The actual tool name follows after
	// the option value.
	let command = detect("npx -w vitest echo PASS").expect("npx command is detected");
	assert_eq!(command.program, "npx");
	assert_eq!(command.subcommand.as_deref(), Some("echo"));

	// plain npx invocation with an actual tool still resolves correctly
	let command = detect("npx vitest").expect("npx vitest is detected");
	assert_eq!(command.program, "npx");
	assert_eq!(command.subcommand.as_deref(), Some("vitest"));

	// workspace value that happens to be a tool name is skipped; the next
	// token is the actual tool
	let command = detect("npx -w my-workspace vitest").expect("npx with workspace is detected");
	assert_eq!(command.program, "npx");
	assert_eq!(command.subcommand.as_deref(), Some("vitest"));

	// version-qualified package specs are stripped to the bare tool name so
	// `npx jest@latest` routes identically to `npx jest`
	let command = detect("npx jest@latest --runInBand").expect("version-qualified npx detected");
	assert_eq!(command.program, "npx");
	assert_eq!(command.subcommand.as_deref(), Some("jest"), "jest@latest must normalise to jest");

	// scoped package leading @ is preserved; only the trailing @version is stripped
	let command = detect("npx @scope/pkg@1.0.0 --flag").expect("scoped npx detected");
	assert_eq!(
		command.subcommand.as_deref(),
		Some("@scope/pkg"),
		"@scope/pkg@1.0.0 must normalise to @scope/pkg"
	);

	// unversioned scoped package is unchanged
	let command = detect("npx @scope/tool").expect("unversioned scoped npx detected");
	assert_eq!(
		command.subcommand.as_deref(),
		Some("@scope/tool"),
		"unversioned scoped package must be unchanged"
	);
}

#[test]
fn normalizes_docker_compose_to_docker() {
	let command = detect("docker-compose up").expect("docker-compose command is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("up"));

	let command = detect("/usr/local/bin/docker-compose logs")
		.expect("path-prefixed docker-compose is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("logs"));
}

#[test]
fn docker_composer_is_not_normalized() {
	let command = detect("docker-composer up").expect("docker-composer command is detected");
	assert_eq!(command.program, "docker-composer");
	assert_eq!(command.subcommand.as_deref(), Some("up"));
}

#[test]
fn docker_compose_with_flags_finds_real_subcommand() {
	// Value-taking compose flags must be skipped so the real action is found.
	let command =
		detect("docker-compose -p myproj up").expect("docker-compose with -p flag is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("up"));

	let command = detect("docker-compose --profile logs up")
		.expect("docker-compose with --profile flag is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("up"));

	let command = detect("docker-compose -f docker-compose.yml ps")
		.expect("docker-compose with -f flag is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("ps"));
}

#[test]
fn docker_compose_global_value_flags_skip_correctly() {
	// --log-level consumes its value; the next token is the subcommand.
	let command = detect("docker-compose --log-level debug up")
		.expect("docker-compose --log-level is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("up"));

	// -H consumes its value.
	let command =
		detect("docker-compose -H tcp://host:2376 ps").expect("docker-compose -H is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("ps"));

	// --host=inline also works.
	let command = detect("docker-compose --host=tcp://host:2376 logs")
		.expect("docker-compose --host= is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("logs"));

	// --tlscacert consumes its value.
	let command = detect("docker-compose --tlscacert /path/ca.pem up")
		.expect("docker-compose --tlscacert is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("up"));

	// --tlscert consumes its value.
	let command = detect("docker-compose --tlscert /path/cert.pem ps")
		.expect("docker-compose --tlscert is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("ps"));

	// --tlskey consumes its value.
	let command = detect("docker-compose --tlskey /path/key.pem logs")
		.expect("docker-compose --tlskey is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("logs"));
}

#[test]
fn docker_compose_without_flags_still_works() {
	let command = detect("docker-compose up").expect("docker-compose command is detected");
	assert_eq!(command.program, "docker");
	assert_eq!(command.subcommand.as_deref(), Some("up"));
}
