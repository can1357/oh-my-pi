//! `ast-grep new`: scaffolds an ast-grep project or items (a rule, test case
//! or global utility rule) under a `sgconfig.yml` project. Agents run it
//! non-interactively, so only the `-y`/`--yes` and command-line-argument forms
//! are implemented; a prompt that would need a terminal reports ast-grep's
//! non-terminal error instead of opening one.

use std::{
	io::Write as _,
	path::{Path, PathBuf},
};

use clap::{Args, Subcommand};

use super::{ProjectConfig, ProjectSetup, TestConfig, fail, load_project_setup, parse_lang};
use crate::host::Host;

const TEST_GUIDE: &str = "/guide/test-rule.html";
const UTIL_GUIDE: &str = "/guide/rule-config/utility-rule.html";

/// `ast-grep new` options.
#[derive(Args, Debug)]
pub(super) struct New {
	/// The ast-grep item type to create. Available options: project/rule/test/utils.
	#[command(subcommand)]
	entity: Option<Entity>,

	/// The id of the item to create.
	#[arg(value_name = "NAME", global = true)]
	name: Option<String>,

	/// The language of the item to create.
	#[arg(short, long, global = true, value_parser = parse_lang)]
	lang: Option<super::SupportLang>,

	/// Accept all default options without interactive input during creation.
	///
	/// You need to provide all required arguments via command line if this flag is true.
	/// Please see the command description for what arguments are required.
	#[arg(short, long, global = true)]
	yes: bool,
}

/// The ast-grep item type to create.
#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
enum Entity {
	/// Create an new project by scaffolding.
	Project,
	/// Create a new rule.
	Rule,
	/// Create a new test case.
	Test,
	/// Create a new global utility rule.
	Util,
}

/// Runs `ast-grep new`; returns its exit status.
pub(super) async fn execute(host: &mut Host, new: &New, config: Option<&str>) -> i32 {
	let project = match load_project_setup(host, config).await {
		Ok(project) => project,
		Err(code) => return code,
	};
	match &new.entity {
		Some(Entity::Project) if project.is_none() => create_project(host, new).await,
		Some(Entity::Project) => project_already_exists(host),
		Some(entity) => match project {
			Some(found) => match entity {
				Entity::Rule => create_rule(host, new, &found).await,
				Entity::Test => create_test(host, &found.config.test_configs, new.name.clone()).await,
				Entity::Util => create_util(host, new, &found).await,
				Entity::Project => unreachable!("matched above"),
			},
			None => project_not_found(host),
		},
		None => match project {
			Some(_) if new.yes => insufficient(host, "entity"),
			Some(_) => non_terminal(host),
			None => {
				// ast-grep's `print!("No sgconfig.yml found. ")`: no newline, so
				// the next line runs on from it.
				let _ = write!(host.stdout, "No sgconfig.yml found. ");
				create_project(host, new).await
			},
		},
	}
}

/// The directory a project is created in: ast-grep's canonical working directory.
async fn current_dir(host: &mut Host) -> Result<PathBuf, i32> {
	let cwd = host.resolve(".");
	match host.vfs().canonicalize(&cwd).await {
		Ok(path) => Ok(path),
		Err(error) => Err(plain_error(host, &error.to_string())),
	}
}

/// The default directory `-y` accepts; a prompt otherwise, which the builtin
/// cannot serve.
fn ask_dir(host: &mut Host, new: &New, default: &str) -> Result<String, i32> {
	if new.yes { Ok(default.to_owned()) } else { Err(non_terminal(host)) }
}

/// `-y` accepts the default `Yes`; a prompt otherwise.
fn confirm(host: &mut Host, new: &New) -> Result<bool, i32> {
	if new.yes { Ok(true) } else { Err(non_terminal(host)) }
}

fn ask_name(host: &mut Host, new: &New) -> Result<String, i32> {
	if let Some(name) = &new.name {
		Ok(name.clone())
	} else if new.yes {
		Err(insufficient(host, "name"))
	} else {
		Err(non_terminal(host))
	}
}

fn choose_language(host: &mut Host, new: &New) -> Result<super::SupportLang, i32> {
	if let Some(lang) = new.lang {
		Ok(lang)
	} else if new.yes {
		Err(insufficient(host, "lang"))
	} else {
		Err(non_terminal(host))
	}
}

/// Creates `dir` below `project_dir` with a `.gitkeep`, as ast-grep does.
async fn create_dir(host: &mut Host, project_dir: &Path, dir: &str) -> Result<PathBuf, i32> {
	let path = project_dir.join(dir);
	let vfs = host.vfs();
	if let Err(error) = vfs.create_dir_all(&path).await {
		return Err(plain_error(host, &error.to_string()));
	}
	if let Err(error) = vfs.write(path.join(".gitkeep"), b"").await {
		return Err(plain_error(host, &error.to_string()));
	}
	Ok(path)
}

async fn create_project(host: &mut Host, new: &New) -> i32 {
	let _ = writeln!(host.stdout, "Creating a new ast-grep project...");
	let project_dir = match current_dir(host).await {
		Ok(dir) => dir,
		Err(code) => return code,
	};
	let rule_dirs = match ask_dir(host, new, "rules") {
		Ok(dir) => dir,
		Err(code) => return code,
	};
	let rule_dir = match create_dir(host, &project_dir, &rule_dirs).await {
		Ok(path) => path,
		Err(code) => return code,
	};
	let test_dirs = match confirm(host, new) {
		Ok(true) => {
			let test_dir = match ask_dir(host, new, "rule-tests") {
				Ok(dir) => dir,
				Err(code) => return code,
			};
			match create_dir(host, &project_dir, &test_dir).await {
				Ok(path) => Some(TestConfig { test_dir: path, snapshot_dir: None }),
				Err(code) => return code,
			}
		},
		Ok(false) => None,
		Err(code) => return code,
	};
	let utils = match confirm(host, new) {
		Ok(true) => {
			let util_dir = match ask_dir(host, new, "utils") {
				Ok(dir) => dir,
				Err(code) => return code,
			};
			match create_dir(host, &project_dir, &util_dir).await {
				Ok(path) => Some(path),
				Err(code) => return code,
			}
		},
		Ok(false) => None,
		Err(code) => return code,
	};
	let config = ProjectConfig {
		rule_dirs: vec![rule_dir],
		test_configs: test_dirs.map(|test| vec![test]),
		util_dirs: utils.map(|util| vec![util]),
	};
	let text = match serde_yaml::to_string(&config) {
		Ok(text) => text,
		Err(error) => return plain_error(host, &error.to_string()),
	};
	if let Err(error) = host.vfs().write(project_dir.join(super::PROJECT_CONFIG), text).await {
		return plain_error(host, &error.to_string());
	}
	let _ = writeln!(host.stdout, "Your new ast-grep project has been created!");
	0
}

/// The default rule body ast-grep writes (`default_rule` in its `new.rs`).
fn default_rule(id: &str, lang: super::SupportLang) -> String {
	format!(
		r#"# yaml-language-server: $schema=https://raw.githubusercontent.com/ast-grep/ast-grep/main/schemas/rule.json

id: {id}
message: Add your rule message here....
severity: error # error, warning, info, hint
language: {lang}
rule:
  pattern: Your Rule Pattern here...
# utils: Extract repeated rule as local utility here.
# note: Add detailed explanation for the rule."#
	)
}

async fn create_rule(host: &mut Host, new: &New, found: &ProjectSetup) -> i32 {
	let name = match ask_name(host, new) {
		Ok(name) => name,
		Err(code) => return code,
	};
	if found.config.rule_dirs.len() > 1 {
		// ast-grep asks which rule dir to use; the builtin cannot prompt.
		return non_terminal(host);
	}
	let rule_dir = found.root.join(&found.config.rule_dirs[0]);
	let path = rule_dir.join(format!("{name}.yml"));
	if host.vfs().metadata(&path).await.is_ok() {
		return file_already_exists(host, &path);
	}
	let lang = match choose_language(host, new) {
		Ok(lang) => lang,
		Err(code) => return code,
	};
	if let Err(error) = host.vfs().write(&path, default_rule(&name, lang)).await {
		return plain_error(host, &error.to_string());
	}
	let _ = writeln!(host.stdout, "Created rules at {}", path.display());
	match confirm(host, new) {
		Ok(true) => create_test(host, &found.config.test_configs, Some(name)).await,
		Ok(false) => 0,
		Err(code) => code,
	}
}

/// The default test body ast-grep writes (`default_test` in its `new.rs`).
fn default_test(id: &str) -> String {
	format!(
		r#"id: {id}
valid:
- "valid code"
invalid:
- "invalid code"
"#
	)
}

async fn create_test(host: &mut Host, test_configs: &Option<Vec<TestConfig>>, name: Option<String>) -> i32 {
	let Some(tests) = test_configs else {
		return no_test_dir(host);
	};
	if tests.is_empty() {
		return no_test_dir(host);
	}
	if tests.len() > 1 {
		// ast-grep asks which test dir to use; the builtin cannot prompt.
		return non_terminal(host);
	}
	// ast-grep names `test`'s rule id through a prompt even under `-y`.
	let Some(name) = name else {
		return non_terminal(host);
	};
	let path = host.resolve(tests[0].test_dir.join(format!("{name}-test.yml")));
	if host.vfs().metadata(&path).await.is_ok() {
		return file_already_exists(host, &path);
	}
	if let Err(error) = host.vfs().write(&path, default_test(&name)).await {
		return plain_error(host, &error.to_string());
	}
	let _ = writeln!(host.stdout, "Created test at {}", path.display());
	0
}

/// The default utility rule body ast-grep writes (`default_util` in its `new.rs`).
fn default_util(id: &str, lang: super::SupportLang) -> String {
	format!(
		r#"id: {id}
language: {lang}
rule:
  pattern: Your Rule Pattern here...
# utils: Extract repeated rule as local utility here."#
	)
}

async fn create_util(host: &mut Host, new: &New, found: &ProjectSetup) -> i32 {
	let Some(utils) = &found.config.util_dirs else {
		return no_util_dir(host);
	};
	if utils.is_empty() {
		return no_util_dir(host);
	}
	if utils.len() > 1 {
		// ast-grep asks which util dir to use; the builtin cannot prompt.
		return non_terminal(host);
	}
	let util_dir = found.root.join(&utils[0]);
	let name = match ask_name(host, new) {
		Ok(name) => name,
		Err(code) => return code,
	};
	let path = util_dir.join(format!("{name}.yml"));
	if host.vfs().metadata(&path).await.is_ok() {
		return file_already_exists(host, &path);
	}
	let lang = match choose_language(host, new) {
		Ok(lang) => lang,
		Err(code) => return code,
	};
	if let Err(error) = host.vfs().write(&path, default_util(&name, lang)).await {
		return plain_error(host, &error.to_string());
	}
	let _ = writeln!(host.stdout, "Created util at {}", path.display());
	0
}

/// ast-grep's `InsufficientCLIArgument` report (exit status 22).
fn insufficient(host: &mut Host, argument: &str) -> i32 {
	let help = format!("You need to provide `{argument}` in command line to use non-interactive `new`.");
	fail(
		host,
		"Insufficient command line argument provided to use `--yes` option.",
		&help,
		None,
		None,
		22,
	)
}

/// ast-grep's `ProjectNotExist` report (exit status 3).
fn project_not_found(host: &mut Host) -> i32 {
	fail(
		host,
		"No ast-grep project configuration is found.",
		"You need to create an ast-grep project for this command. Try `sg new` to create one.",
		Some(super::PROJECT_GUIDE),
		None,
		3,
	)
}

/// ast-grep's `ProjectAlreadyExist` report (exit status 17).
fn project_already_exists(host: &mut Host) -> i32 {
	fail(
		host,
		"ast-grep project already exists.",
		"You are already inside a sub-folder of an ast-grep project. Try finding sgconfig.yml in ancestor directory?",
		Some(super::PROJECT_GUIDE),
		None,
		17,
	)
}

/// ast-grep's `FileAlreadyExist` report (exit status 17).
fn file_already_exists(host: &mut Host, path: &Path) -> i32 {
	fail(
		host,
		&format!("File `{}` already exists.", path.display()),
		"The item you want to create already exists. Try editing the existing file or create a new one with a different name?",
		None,
		None,
		17,
	)
}

/// ast-grep's `NoTestDirConfigured` report (exit status 5).
fn no_test_dir(host: &mut Host) -> i32 {
	fail(
		host,
		"No test file directory is configured.",
		"Fail to create a test file because the project `sgconfig.yml` does not specify any test configuration.",
		Some(TEST_GUIDE),
		None,
		5,
	)
}

/// ast-grep's `NoUtilDirConfigured` report (exit status 5).
fn no_util_dir(host: &mut Host) -> i32 {
	fail(
		host,
		"No util file directory is configured.",
		"Fail to create a utility rule because the project `sgconfig.yml` does not specify any utils directory.",
		Some(UTIL_GUIDE),
		None,
		5,
	)
}

/// The error inquire reports when a prompt has no terminal to read (exit
/// status 1): the builtin never opens one.
fn non_terminal(host: &mut Host) -> i32 {
	let _ = writeln!(host.stderr, "Error: The input device is not a TTY");
	1
}

/// A plain anyhow-style error (exit status 1), as ast-grep's fallback reporting prints it.
fn plain_error(host: &mut Host, message: &str) -> i32 {
	let _ = writeln!(host.stderr, "Error: {message}");
	1
}
