//! `direnv` in the embedded shell: `.envrc` files are evaluated by the engine
//! with direnv's stdlib, and `direnv exec` runs its command in the shell.
//!
//! Unix only: the fixtures are executable files and POSIX paths.
#![cfg(unix)]

use std::path::PathBuf;

use super::*;

/// A scratch tree holding a project (`tree/proj`), a directory no `.envrc`
/// governs (`outside`) and direnv's own state.
struct Project {
	root: PathBuf,
	_dir: tempfile::TempDir,
}

impl Project {
	fn new() -> Self {
		let dir = tempfile::tempdir().expect("scratch tree");
		let root = std::fs::canonicalize(dir.path()).expect("canonical scratch tree");
		for sub in ["home", "outside", "tree/proj"] {
			std::fs::create_dir_all(root.join(sub)).expect("create directory");
		}
		Self { root, _dir: dir }
	}

	fn text(&self, relative: &str) -> String {
		self.root.join(relative).to_str().expect("utf-8 path").to_owned()
	}

	fn write(&self, relative: &str, content: &str) {
		std::fs::write(self.root.join(relative), content).expect("write file");
	}

	/// Runs `script` in a new session standing in the project, direnv's
	/// state under the tree and nothing loaded, with `$root` the tree.
	/// Returns the exit status and everything written.
	async fn run(&self, script: &str) -> (Option<i32>, String) {
		let root = quote_arg(&self.text(""));
		let prelude = format!(
			"root={root}; root=${{root%/}}\nexport HOME=\"$root/home\" XDG_DATA_HOME=\"$root/data\" \
			 XDG_CONFIG_HOME=\"$root/config\" XDG_CACHE_HOME=\"$root/cache\" TERM=dumb\nunset \
			 DIRENV_DIFF DIRENV_DIR DIRENV_FILE DIRENV_WATCHES DIRENV_LOG_FORMAT DIRENV_CONFIG \
			 DIRENV_EXE_PATH DIRENV_BASH DIRENV_WARN_TIMEOUT DIRENV_DISABLE DIRENV_REQUIRED \
			 DIRENV_DUMP_FILE_PATH FOO PARENT LOCAL HAS_CAT EXPANDED DOTENV_VAR EXTRA_PATH GOPATH \
			 GOBIN\ncd \"$root/tree/proj\" || exit 99\n"
		);
		let (result, output) = execute_captured(format!("{prelude}{script}")).await;
		(result.exit_code, output)
	}
}

/// Contract: an allowed `.envrc` runs with direnv's stdlib (`source_up`,
/// `PATH_add`, `path_add`, `MANPATH_add`, `layout`, `dotenv`,
/// `source_env_if_exists`, `watch_file`, `has`, `expand_path`,
/// `log_status`, `env_vars_required`), and `export json` reports exactly
/// what it changed: new and changed variables, `null` for removed ones, and
/// direnv's bookkeeping. What the file prints goes to stderr. The exports
/// load into the calling shell, stay loaded until a watched file changes,
/// and unload on leaving the directory.
#[tokio::test(flavor = "multi_thread")]
async fn envrc_stdlib_builds_the_exported_environment() {
	let project = Project::new();
	let proj = project.text("tree/proj");
	project.write("tree/.envrc", "export PARENT=from-parent\n");
	project.write(
		"tree/proj/.envrc",
		"source_up\nPATH_add bin\npath_add EXTRA_PATH lib\nMANPATH_add man\nlayout go\nexport \
		 FOO=bar\ndotenv\ndotenv_if_exists missing.env\nsource_env_if_exists .envrc.local\nwatch_file \
		 extra.txt\nhas cat && export HAS_CAT=yes\nexport EXPANDED=\"$(expand_path \
		 sub/../file)\"\nunset DROPPED\nlog_status \"custom status\"\nenv_vars_required FOO\necho \
		 \"stdout from envrc\"\n",
	);
	project.write("tree/proj/.env", "DOTENV_VAR=\"dot value\"\n");
	project.write("tree/proj/.envrc.local", "export LOCAL=1\n");

	let (status, output) = project
		.run(
			"export DROPPED=1 MANPATH=/usr/share/man\ndirenv allow || exit 90\ndirenv export json \
			 >\"$root/out.json\" 2>\"$root/err.txt\"; echo \"export=$?\"\neval \"$(direnv export bash \
			 2>/dev/null)\"\necho \"FOO=$FOO PARENT=$PARENT LOCAL=$LOCAL DROPPED=${DROPPED-unset} \
			 FILE=$DIRENV_FILE\"\necho \"again=[$(direnv export bash 2>&1)]\"\ncd \
			 \"$root/outside\"\neval \"$(direnv export bash 2>\"$root/unload.txt\")\"\necho \
			 \"FOO=${FOO-unset} DROPPED=${DROPPED-unset} FILE=${DIRENV_FILE-unset}\"\n",
		)
		.await;
	assert_eq!(status, Some(0), "{output}");
	assert_eq!(
		output,
		format!(
			"export=0\nFOO=bar PARENT=from-parent LOCAL=1 DROPPED=unset \
			 FILE={proj}/.envrc\nagain=[]\nFOO=unset DROPPED=1 FILE=unset\n"
		)
	);

	let exported = std::fs::read_to_string(project.text("out.json")).expect("export output");
	let exported: serde_json::Value = serde_json::from_str(&exported).expect("export JSON");
	let exported = exported.as_object().expect("JSON object");
	let mut names: Vec<&str> = exported.keys().map(String::as_str).collect();
	names.sort_unstable();
	assert_eq!(names, [
		"DIRENV_DIFF",
		"DIRENV_DIR",
		"DIRENV_FILE",
		"DIRENV_WATCHES",
		"DOTENV_VAR",
		"DROPPED",
		"EXPANDED",
		"EXTRA_PATH",
		"FOO",
		"GOBIN",
		"GOPATH",
		"HAS_CAT",
		"LOCAL",
		"MANPATH",
		"PARENT",
		"PATH",
	]);
	let value = |name: &str| exported[name].as_str().unwrap_or("<null>");
	assert_eq!(value("DIRENV_FILE"), format!("{proj}/.envrc"));
	assert_eq!(value("DOTENV_VAR"), "dot value");
	assert!(exported["DROPPED"].is_null(), "a removed variable is null");
	assert_eq!(value("EXPANDED"), format!("{proj}/file"));
	assert_eq!(value("EXTRA_PATH"), format!("{proj}/lib"));
	assert_eq!(value("FOO"), "bar");
	assert_eq!(value("GOPATH"), format!("{proj}/.direnv/go"));
	assert_eq!(value("HAS_CAT"), "yes");
	assert_eq!(value("LOCAL"), "1");
	assert_eq!(value("MANPATH"), format!("{proj}/man:/usr/share/man"));
	assert_eq!(value("PARENT"), "from-parent");
	assert!(
		value("PATH").starts_with(&format!("{proj}/.direnv/go/bin:{proj}/bin:")),
		"PATH: {}",
		value("PATH")
	);

	let log = std::fs::read_to_string(project.text("err.txt")).expect("export log");
	for line in [
		format!("direnv: loading {proj}/.envrc"),
		format!("direnv: loading {}/.envrc", project.text("tree")),
		"direnv: custom status".to_owned(),
		"stdout from envrc".to_owned(),
		"direnv: export +DOTENV_VAR +EXPANDED +EXTRA_PATH +FOO +GOBIN +GOPATH +HAS_CAT +LOCAL +PARENT \
		 -DROPPED ~MANPATH ~PATH"
			.to_owned(),
	] {
		assert!(log.lines().any(|found| found == line), "missing {line:?} in:\n{log}");
	}
	let unload = std::fs::read_to_string(project.text("unload.txt")).expect("unload log");
	assert_eq!(unload, "direnv: unloading\n");
}

/// Contract: `direnv exec DIR COMMAND` runs the command in the shell itself
/// (a builtin stays a builtin, a program is found on the loaded `PATH`),
/// with the loaded environment, the caller's stdin and working directory,
/// and its exit status; nothing loads into the calling shell.
#[tokio::test(flavor = "multi_thread")]
async fn exec_runs_the_command_in_the_shell_with_the_loaded_environment() {
	use std::os::unix::fs::PermissionsExt as _;

	let project = Project::new();
	project.write("tree/proj/.envrc", "export FOO=from-envrc\nPATH_add bin\n");
	std::fs::create_dir_all(project.root.join("tree/proj/bin")).expect("bin");
	project.write("tree/proj/bin/tool", "#!/bin/sh\necho tool-ran \"$@\"\n");
	std::fs::set_permissions(
		project.root.join("tree/proj/bin/tool"),
		std::fs::Permissions::from_mode(0o755),
	)
	.expect("make tool executable");

	let (status, output) = project
		.run(
			"direnv allow || exit 90\nexec 2>/dev/null\ndirenv exec . type cat\ndirenv exec . printenv \
			 FOO\necho piped | direnv exec . cat\ndirenv exec . tool a b\ndirenv exec . sh -c 'exit 7'; \
			 echo \"status=$?\"\necho \"after=${FOO-unset}\"\ncd \"$root/outside\"\ndirenv exec \
			 \"$root/tree/proj\" printenv FOO\ndirenv exec \"$root/tree/proj\" pwd\n",
		)
		.await;
	assert_eq!(status, Some(0), "{output}");
	assert_eq!(
		output,
		format!(
			"cat is a shell builtin\nfrom-envrc\npiped\ntool-ran a \
			 b\nstatus=7\nafter=unset\nfrom-envrc\n{}\n",
			project.text("outside")
		)
	);
}

/// Contract: an `.envrc` runs only once allowed. `exec` refuses a file
/// nobody allowed, runs its command without the file once it is denied, and
/// evaluates it after `allow`.
#[tokio::test(flavor = "multi_thread")]
async fn envrc_is_evaluated_only_once_allowed() {
	let project = Project::new();
	project.write("tree/proj/.envrc", "touch evaluated\nexport FOO=1\n");
	let (status, output) = project
		.run(
			"direnv exec . echo ran; echo \"blocked=$?\"\n[ -e evaluated ] && echo \
			 evaluated-while-blocked\ndirenv deny\ndirenv exec . echo ran; echo \"denied=$?\"\n[ -e \
			 evaluated ] && echo evaluated-while-denied\ndirenv allow\ndirenv exec . printenv FOO \
			 2>/dev/null; echo \"allowed=$?\"\n[ -e evaluated ] && echo evaluated-when-allowed\n",
		)
		.await;
	assert_eq!(status, Some(0), "{output}");
	let lines: Vec<&str> = output.lines().collect();
	let blocked = format!(
		"{}/.envrc is blocked. Run `direnv allow` to approve its content",
		project.text("tree/proj")
	);
	assert!(lines[0].contains(&blocked), "{output}");
	assert_eq!(lines[1..], ["blocked=1", "ran", "denied=0", "1", "allowed=0", "evaluated-when-allowed"]);
}

/// Contract: an `.envrc` that fails under `strict_env` fails the load:
/// `exec` does not run its command, and `export` fails without exporting
/// what the file set before it stopped.
#[tokio::test(flavor = "multi_thread")]
async fn failing_strict_envrc_fails_the_load() {
	let project = Project::new();
	project.write("tree/proj/.envrc", "strict_env\nexport BEFORE=1\nfalse\nexport AFTER=1\n");
	let (status, output) = project
		.run(
			"direnv allow || exit 90\ndirenv exec . echo ran 2>\"$root/err.txt\"; echo \
			 \"exec=$?\"\ndirenv export json 2>/dev/null >\"$root/out.json\"; echo \"export=$?\"\n",
		)
		.await;
	assert_eq!(status, Some(0), "{output}");
	assert_eq!(output, "exec=1\nexport=1\n");
	let log = std::fs::read_to_string(project.text("err.txt")).expect("exec log");
	assert!(log.contains("direnv: error exit status 1"), "{log}");
	let exported = std::fs::read_to_string(project.text("out.json")).expect("export output");
	let exported: serde_json::Value = serde_json::from_str(&exported).expect("export JSON");
	assert!(exported.get("DIRENV_FILE").is_some(), "bookkeeping is exported: {exported}");
	assert!(exported.get("BEFORE").is_none(), "a failed load exports nothing else: {exported}");
}
