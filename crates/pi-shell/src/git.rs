//! `git` builtin that creates linked worktrees through [`pi_vcs`].
//!
//! Opt-in: registered only when `PI_SMART_GIT` is truthy in the session or
//! process environment.
//!
//! `git worktree add` checks out every file of the target commit. pi-vcs
//! instead copy-on-write clones the source checkout (APFS `clonefile`, Linux
//! reflinks, Windows block cloning), registers the worktree metadata, and
//! rewrites only the paths that differ from the target commit, so ignored build
//! caches come along for free. Without a working clone backend it falls back to
//! an in-process checkout.
//!
//! Arguments are parsed the way git's parse-options does: bundled short flags
//! (`-qd`, `-qbname`), unique long-option abbreviations, `--no-` negations,
//! `--opt=value`, options mixed with operands, and `--`/`--end-of-options`.
//! The builtin serves `-f`, `-b`, `-B`, `-d`, `--checkout`, `--lock`,
//! `--reason`, `-q`, `--no-track`, `--[no-]guess-remote`, and
//! `--no-relative-paths`. Everything else — other subcommands and global
//! options, `--orphan`, `--no-checkout`, `--track`, `--relative-paths`, start
//! points that set up an upstream, bare/reftable/submodule repositories, env
//! redirection, and any invocation git would reject — runs the git binary with
//! the original arguments, so git keeps reporting its own errors.

use std::{
	io::{self, Write as _},
	path::{Path, PathBuf},
};

use brush_core::{
	CommandArg, Error, ErrorKind, ExecutionContext, ExecutionParameters, ExecutionResult, Shell,
	ShellExtensions,
	builtins::{self, Registration},
	commands::{ShellForCommand, SimpleCommand},
	openfiles::OpenFiles,
};
use clap::Parser;
use pi_vcs::{WorktreeAddOptions, WorktreeClone, git::GitRepo};
use pi_vfs::Fs;

use crate::shell::is_git_repo_location_var;

/// Exit status of a git `fatal:` error.
const FATAL_EXIT: u8 = 128;

/// Lock reason git records for `--lock` without `--reason`.
const DEFAULT_LOCK_REASON: &str = "added with --lock";

/// Long options of `git worktree add`; each also has a `--no-` form.
const LONG_OPTIONS: [&str; 10] = [
	"force",
	"orphan",
	"detach",
	"checkout",
	"lock",
	"reason",
	"quiet",
	"track",
	"guess-remote",
	"relative-paths",
];

/// Creates the `git` builtin registration.
pub fn git_builtin<SE: ShellExtensions>() -> Registration<SE> {
	builtins::builtin::<GitCommand, SE>()
}

/// Runs git, creating linked worktrees in-process via copy-on-write clones.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
struct GitCommand {
	/// Arguments forwarded to git.
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for GitCommand {
	type Error = Error;

	/// Bypasses clap: every argument belongs to git.
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { args: args.into_iter().skip(1).collect() })
	}

	fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = Result<ExecutionResult, Error>> + Send {
		let args = self.args.clone();
		async move {
			if let Some(request) = AddRequest::parse(&args)
				&& !git_env_redirected(context.shell)
			{
				let cwd = context.shell.working_dir().to_owned();
				let filesystem = context.shell.filesystem().clone();
				// Planning and cloning are synchronous filesystem work. They are not
				// abandoned on cancellation: a half-registered worktree is worse than a
				// late one.
				let outcome = tokio::task::spawn_blocking(move || request.create(&cwd, &filesystem))
					.await
					.map_err(|err| Error::from(ErrorKind::ThreadingError(err)))?;
				match outcome {
					Outcome::External => {},
					Outcome::Failed(message) => {
						let _ = writeln!(context.stderr(), "fatal: {message}");
						return Ok(ExecutionResult::new(FATAL_EXIT));
					},
					Outcome::Created(created) => return created.report(context).await,
				}
			}
			let ExecutionContext { shell, params, .. } = context;
			run_git(shell, params, args).await
		}
	}
}

/// A parsed `git [-C <dir>]… worktree add` invocation.
#[derive(Debug, Default, PartialEq, Eq)]
struct AddRequest {
	/// `-C` directories, applied in order.
	dirs:           Vec<String>,
	path:           String,
	commit_ish:     Option<String>,
	/// Branch named by `-b`/`-B`.
	new_branch:     Option<String>,
	/// `-B`: reset `new_branch` when it exists instead of refusing.
	reset:          bool,
	detach:         bool,
	quiet:          bool,
	/// `--lock` reason, written to the worktree's `locked` file.
	lock:           Option<String>,
	/// `--[no-]track`; `None` defers to `branch.autoSetupMerge`.
	track:          Option<bool>,
	/// `--[no-]guess-remote`; `None` defers to `worktree.guessRemote`.
	guess_remote:   Option<bool>,
	/// `--[no-]relative-paths`; `None` defers to `worktree.useRelativePaths`.
	relative_paths: Option<bool>,
}

impl AddRequest {
	/// Parses git's argv; `None` for anything but a well-formed `worktree add`
	/// without `--orphan` or `--no-checkout`.
	fn parse(args: &[String]) -> Option<Self> {
		let mut args = args.iter();
		let mut request = Self::default();
		loop {
			match args.next()?.as_str() {
				"-C" => request.dirs.push(args.next()?.clone()),
				// Pagers never start without a terminal; the rest only affect
				// advice and optional index refreshes.
				"-P" | "--no-pager" | "-p" | "--paginate" | "--no-optional-locks" | "--no-advice" => {},
				"worktree" => break,
				_ => return None,
			}
		}
		if args.next()? != "add" {
			return None;
		}

		let mut create_branch = None;
		let mut reset_branch = None;
		let (mut checkout, mut lock, mut orphan) = (true, false, false);
		let mut reason = None;
		let mut operands = Vec::new();
		while let Some(arg) = args.next() {
			if arg == "--" || arg == "--end-of-options" {
				operands.extend(args.by_ref().cloned());
			} else if let Some(long) = arg.strip_prefix("--") {
				let (name, inline) = match long.split_once('=') {
					Some((name, value)) => (name, Some(value)),
					None => (long, None),
				};
				let (option, negated) = long_option(name)?;
				if option == "reason" && !negated {
					reason = Some(match inline {
						Some(value) => value.to_owned(),
						None => args.next()?.clone(),
					});
					continue;
				}
				if inline.is_some() {
					return None;
				}
				match option {
					// Force only matters for targets already in use, which git handles.
					"force" => {},
					"orphan" => orphan = !negated,
					"detach" => request.detach = !negated,
					"checkout" => checkout = !negated,
					"lock" => lock = !negated,
					"reason" => reason = None,
					"quiet" => request.quiet = !negated,
					"track" => request.track = Some(!negated),
					"guess-remote" => request.guess_remote = Some(!negated),
					"relative-paths" => request.relative_paths = Some(!negated),
					_ => unreachable!("LONG_OPTIONS entry without a handler"),
				}
			} else if let Some(shorts) = arg.strip_prefix('-').filter(|shorts| !shorts.is_empty()) {
				for (at, flag) in shorts.char_indices() {
					match flag {
						'f' => {},
						'd' => request.detach = true,
						'q' => request.quiet = true,
						'b' | 'B' => {
							let rest = &shorts[at + 1..];
							let name = if rest.is_empty() {
								args.next()?.clone()
							} else {
								rest.to_owned()
							};
							*(if flag == 'b' {
								&mut create_branch
							} else {
								&mut reset_branch
							}) = Some(name);
							break;
						},
						_ => return None,
					}
				}
			} else {
				operands.push(arg.clone());
			}
		}

		// git rejects these combinations; `--orphan` and `--no-checkout` leave
		// states pi-vcs does not produce.
		let modes = usize::from(create_branch.is_some())
			+ usize::from(reset_branch.is_some())
			+ usize::from(request.detach);
		if modes > 1 || orphan || !checkout || (reason.is_some() && !lock) {
			return None;
		}
		request.reset = reset_branch.is_some();
		request.new_branch = create_branch.or(reset_branch);
		request.lock = lock.then(|| reason.unwrap_or_else(|| DEFAULT_LOCK_REASON.to_owned()));

		let mut operands = operands.into_iter();
		request.path = operands.next()?;
		request.commit_ish = operands.next();
		operands.next().is_none().then_some(request)
	}

	/// Creates the worktree in-process, or reports that git must.
	fn create(self, cwd: &Path, filesystem: &Fs) -> Outcome {
		let Ok(Some(plan)) = self.plan(cwd, filesystem) else {
			return Outcome::External;
		};
		// A failed branch update changes nothing, so git can report the refusal
		// (invalid name, concurrent update) in its own words.
		if let Some(branch) = &plan.branch
			&& plan
				.repo
				.create_branch(&plan.target, &branch.start, branch.reset)
				.is_err()
		{
			return Outcome::External;
		}
		match plan.add() {
			Ok(created) => Outcome::Created(created),
			Err(err) => Outcome::Failed(err.to_string()),
		}
	}

	/// Decides how pi-vcs reproduces this request; `None` hands it to git.
	fn plan(self, cwd: &Path, filesystem: &Fs) -> pi_vcs::Result<Option<Plan>> {
		// `-` and `@{…}` name branches through reflogs, which git expands itself.
		if self.track == Some(true)
			|| self
				.commit_ish
				.as_deref()
				.is_some_and(|rev| rev == "-" || rev.contains("@{"))
		{
			return Ok(None);
		}
		let dir = self
			.dirs
			.iter()
			.fold(cwd.to_owned(), |dir, next| dir.join(next));
		let Some(path) = physical_path(&dir.join(&self.path)) else {
			return Ok(None);
		};
		if !dir.is_dir()
			|| !filesystem.is_native_local(&dir)
			|| !filesystem.is_native_local(&path)
			|| !vacant(&path)
		{
			return Ok(None);
		}
		let Some(repo) = GitRepo::discover(&dir)? else {
			return Ok(None);
		};
		if repo.is_reftable()
			|| !filesystem.is_native_local(repo.root())
			// A cloned submodule keeps a `.git` pointer that is wrong from the
			// new location; git leaves submodules unpopulated instead.
			|| repo.root().join(".gitmodules").exists()
			|| config_true(&repo, "core.bare")?
			|| resolve_flag(&repo, self.relative_paths, "worktree.useRelativePaths")?
		{
			return Ok(None);
		}
		let worktrees = repo.worktrees()?;
		// A registered worktree whose directory is gone needs git's `-f` handling.
		if worktrees.iter().any(|entry| entry.path == path) {
			return Ok(None);
		}
		let checked_out = |branch: &str| {
			let full = format!("refs/heads/{branch}");
			worktrees
				.iter()
				.any(|entry| entry.branch.as_deref() == Some(full.as_str()))
		};
		let branch_exists = |branch: &str| repo.ref_exists(&format!("refs/heads/{branch}"));
		// Whether creating a branch at `start` stays untracked, as pi-vcs creates it.
		let untracked = |start: &str| match self.track {
			Some(false) => Ok(true),
			_ => creates_untracked_branch(&repo, start),
		};

		let (branch, target, detach, preparing) = if let Some(name) = self.new_branch {
			let start = self.commit_ish.unwrap_or_else(|| "HEAD".to_owned());
			let was = if branch_exists(&name)? {
				if !self.reset || checked_out(&name) {
					return Ok(None);
				}
				Some(repo.short_id(&format!("refs/heads/{name}"))?)
			} else {
				None
			};
			if !untracked(&start)? {
				return Ok(None);
			}
			let preparing = match was {
				Some(was) => Preparing::Resetting { branch: name.clone(), was },
				None => Preparing::NewBranch(name.clone()),
			};
			let reset = matches!(preparing, Preparing::Resetting { .. });
			(Some(BranchStep { start, reset }), name, false, preparing)
		} else if self.detach {
			(None, self.commit_ish.unwrap_or_else(|| "HEAD".to_owned()), true, Preparing::Detached)
		} else if let Some(commit_ish) = self.commit_ish {
			if branch_exists(&commit_ish)? {
				if checked_out(&commit_ish) {
					return Ok(None);
				}
				(None, commit_ish.clone(), false, Preparing::Checkout(commit_ish))
			} else {
				// Not a local branch: git detaches at the commit, or DWIMs a
				// remote-tracking branch of that name when nothing resolves.
				(None, commit_ish, true, Preparing::Detached)
			}
		} else {
			// git names the branch after the worktree directory as spelled.
			let Some(name) = Path::new(&self.path)
				.file_name()
				.and_then(|name| name.to_str())
			else {
				return Ok(None);
			};
			let name = name.to_owned();
			if branch_exists(&name)? {
				if checked_out(&name) {
					return Ok(None);
				}
				(None, name.clone(), false, Preparing::Checkout(name))
			} else {
				if resolve_flag(&repo, self.guess_remote, "worktree.guessRemote")?
					|| !untracked("HEAD")?
				{
					return Ok(None);
				}
				let branch = BranchStep { start: "HEAD".to_owned(), reset: false };
				(Some(branch), name.clone(), false, Preparing::NewBranch(name))
			}
		};
		// Covers unborn HEAD and names that are not commits (trees, blobs, typos).
		let start = branch
			.as_ref()
			.map_or(target.as_str(), |branch| branch.start.as_str());
		if repo.commit_details(start).is_err() {
			return Ok(None);
		}
		Ok(Some(Plan {
			repo,
			path,
			branch,
			target,
			detach,
			preparing,
			lock: self.lock,
			quiet: self.quiet,
		}))
	}
}

/// Resolves a long option spelling — exact, or a unique abbreviation as git's
/// parse-options accepts — to its name and whether it was negated.
fn long_option(spelled: &str) -> Option<(&'static str, bool)> {
	let spellings = || {
		LONG_OPTIONS.into_iter().flat_map(|option| {
			[(option, false), (option, true)].map(|(option, negated)| {
				let name = if negated {
					format!("no-{option}")
				} else {
					option.to_owned()
				};
				(name, option, negated)
			})
		})
	};
	if let Some((_, option, negated)) = spellings().find(|(name, ..)| name == spelled) {
		return Some((option, negated));
	}
	let mut prefixed =
		spellings().filter(|(name, ..)| !spelled.is_empty() && name.starts_with(spelled));
	let (_, option, negated) = prefixed.next()?;
	prefixed.next().is_none().then_some((option, negated))
}

/// What the builtin did with a `worktree add` request.
enum Outcome {
	/// Not reproducible in-process; the git binary runs instead.
	External,
	/// pi-vcs failed after starting; reported as a git `fatal:` error.
	Failed(String),
	Created(Created),
}

/// Branch update preceding the worktree, as `git branch [-f]` would make it.
struct BranchStep {
	start: String,
	/// `-B` on an existing branch: move it rather than create it.
	reset: bool,
}

/// A resolved in-process `worktree add`.
struct Plan {
	repo:      GitRepo,
	path:      PathBuf,
	branch:    Option<BranchStep>,
	/// Branch to check out, or the commit-ish to detach at.
	target:    String,
	detach:    bool,
	preparing: Preparing,
	lock:      Option<String>,
	quiet:     bool,
}

impl Plan {
	/// Creates and optionally locks the worktree.
	fn add(self) -> pi_vcs::Result<Created> {
		self
			.repo
			.worktree_add(&self.path, &self.target, WorktreeAddOptions {
				detach:       self.detach,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
			})?;
		let linked = GitRepo::require(&self.path)?;
		if let Some(reason) = &self.lock {
			// git's `write_file` terminates non-empty content with a newline.
			let content = if reason.is_empty() {
				String::new()
			} else {
				format!("{reason}\n")
			};
			std::fs::write(linked.info().git_dir.join("locked"), content)?;
		}
		Ok(Created {
			head:      linked.head_sha()?.unwrap_or_default(),
			oneline:   linked.log_onelines(1)?.pop().unwrap_or_default(),
			hook:      linked.hook_path("post-checkout")?,
			path:      self.path,
			preparing: self.preparing,
			quiet:     self.quiet,
		})
	}
}

/// Parenthesized detail of git's `Preparing worktree (…)` line.
enum Preparing {
	NewBranch(String),
	Resetting { branch: String, was: String },
	Checkout(String),
	Detached,
}

/// A worktree pi-vcs created, awaiting git's report and hook.
struct Created {
	path:      PathBuf,
	preparing: Preparing,
	/// Full id of the new worktree's HEAD.
	head:      String,
	/// `<short-id> <subject>` of the new worktree's HEAD.
	oneline:   String,
	hook:      Option<PathBuf>,
	quiet:     bool,
}

impl Created {
	/// Prints what `git worktree add` prints, then runs `post-checkout` as git
	/// does: in the new worktree, with stdout sent to stderr, its status
	/// becoming the command's.
	async fn report<SE: ShellExtensions>(
		self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Error> {
		if !self.quiet {
			let detail = match &self.preparing {
				Preparing::NewBranch(branch) => format!("new branch '{branch}'"),
				Preparing::Resetting { branch, was } => {
					format!("resetting branch '{branch}'; was at {was}")
				},
				Preparing::Checkout(branch) => format!("checking out '{branch}'"),
				Preparing::Detached => {
					format!("detached HEAD {}", self.oneline.split(' ').next().unwrap_or_default())
				},
			};
			let _ = writeln!(context.stderr(), "Preparing worktree ({detail})");
			let _ = writeln!(context.stdout(), "HEAD is now at {}", self.oneline);
		}
		if self.hook.is_none() {
			return Ok(ExecutionResult::success());
		}
		let ExecutionContext { shell, mut params, .. } = context;
		if let Some(stderr) = params.try_fd(shell, OpenFiles::STDERR_FD) {
			params.set_fd(OpenFiles::STDOUT_FD, stderr);
		}
		let null_oid = "0".repeat(self.head.len());
		let args = [
			"-C".to_owned(),
			self.path.to_string_lossy().into_owned(),
			"hook".to_owned(),
			"run".to_owned(),
			"--ignore-missing".to_owned(),
			"post-checkout".to_owned(),
			"--".to_owned(),
			null_oid,
			self.head,
			"1".to_owned(),
		];
		run_git(shell, params, args).await
	}
}

/// Runs the git binary on `PATH`, bypassing this builtin.
///
/// # Errors
/// [`ErrorKind::CommandNotFound`] when no git is on `PATH`; spawn and wait
/// failures as the shell reports them for any external command.
async fn run_git<SE: ShellExtensions>(
	shell: &mut Shell<SE>,
	params: ExecutionParameters,
	args: impl IntoIterator<Item = String>,
) -> Result<ExecutionResult, Error> {
	let Some(git) = shell.find_first_executable_in_path_using_cache("git").await else {
		return Err(ErrorKind::CommandNotFound("git".to_owned()).into());
	};
	let cancel = params.cancel_token();
	let argv = std::iter::once("git".to_owned())
		.chain(args)
		.map(CommandArg::from)
		.collect();
	// A path-qualified name dispatches straight to the binary.
	let mut command = SimpleCommand::new(
		ShellForCommand::ParentShell(shell),
		params,
		git.to_string_lossy().into_owned(),
		argv,
	);
	command.use_functions = false;
	command.argv0 = Some("git".to_owned());
	Ok(command
		.execute()
		.await?
		.wait_with_cancel(cancel)
		.await?
		.into())
}

/// Whether the command environment points git at another repository or
/// injects config; the in-process path reads neither.
fn git_env_redirected<SE: ShellExtensions>(shell: &Shell<SE>) -> bool {
	shell.env().iter_exported().any(|(name, _)| {
		is_git_repo_location_var(name)
			|| name
				.get(..10)
				.is_some_and(|prefix| prefix.eq_ignore_ascii_case("GIT_CONFIG"))
	})
}

/// Whether git creates a branch from `start` without upstream tracking,
/// which is all `GitRepo::create_branch` does.
fn creates_untracked_branch(repo: &GitRepo, start: &str) -> pi_vcs::Result<bool> {
	if matches!(repo.config_get("branch.autoSetupMerge")?.as_deref(), Some("always" | "inherit")) {
		return Ok(false);
	}
	// `@{upstream}` forms and remote-tracking branches set up tracking by default.
	Ok(!start.contains("@{")
		&& !start.starts_with("refs/remotes/")
		&& !repo.ref_exists(&format!("refs/remotes/{start}"))?)
}

/// A command-line switch when given, else the git boolean `key`.
fn resolve_flag(repo: &GitRepo, flag: Option<bool>, key: &str) -> pi_vcs::Result<bool> {
	flag.map_or_else(|| config_true(repo, key), Ok)
}

/// Reads a git boolean; valueless and unparsable entries count as unset.
fn config_true(repo: &GitRepo, key: &str) -> pi_vcs::Result<bool> {
	Ok(repo.config_get(key)?.is_some_and(|value| {
		matches!(value.to_ascii_lowercase().as_str(), "true" | "yes" | "on")
			|| value.parse::<i64>().is_ok_and(|number| number != 0)
	}))
}

/// Whether git may create a worktree at `path`: missing, or an empty directory.
fn vacant(path: &Path) -> bool {
	match std::fs::read_dir(path) {
		Ok(mut entries) => entries.next().is_none(),
		Err(err) => err.kind() == io::ErrorKind::NotFound,
	}
}

/// The absolute, symlink-free spelling git records for a worktree: the
/// deepest existing ancestor canonicalized, the missing tail appended.
/// `None` when the missing tail climbs (`missing/../x`).
#[cfg(not(windows))]
fn physical_path(path: &Path) -> Option<PathBuf> {
	let mut tail = Vec::new();
	for ancestor in path.ancestors() {
		if let Ok(real) = std::fs::canonicalize(ancestor) {
			return Some(tail.iter().rev().fold(real, |path, name| path.join(name)));
		}
		match ancestor.components().next_back()? {
			std::path::Component::Normal(name) => tail.push(name),
			_ => return None,
		}
	}
	None
}

/// Windows `canonicalize` yields verbatim (`\\?\`) paths git never writes;
/// `absolute` resolves `.` and `..` the way git's own normalization does.
#[cfg(windows)]
fn physical_path(path: &Path) -> Option<PathBuf> {
	std::path::absolute(path).ok()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse(line: &str) -> Option<AddRequest> {
		AddRequest::parse(&line.split(' ').map(str::to_owned).collect::<Vec<_>>())
	}

	fn request(path: &str) -> AddRequest {
		AddRequest { path: path.to_owned(), ..AddRequest::default() }
	}

	#[test]
	fn parses_worktree_add_like_git() {
		assert_eq!(parse("worktree add ../wt"), Some(request("../wt")));
		assert_eq!(
			parse("-C repo --no-pager worktree add -qfbfeat ../wt main"),
			Some(AddRequest {
				dirs: vec!["repo".to_owned()],
				commit_ish: Some("main".to_owned()),
				new_branch: Some("feat".to_owned()),
				quiet: true,
				..request("../wt")
			})
		);
		// Options may follow operands; abbreviations and negations resolve;
		// the last of a repeated option wins.
		assert_eq!(
			parse("worktree add ../wt --det --no-q -B x -B y --no-detach"),
			Some(AddRequest { new_branch: Some("y".to_owned()), reset: true, ..request("../wt") })
		);
		assert_eq!(
			parse("worktree add --lo --reas=busy --no-guess ../wt"),
			Some(AddRequest {
				lock: Some("busy".to_owned()),
				guess_remote: Some(false),
				..request("../wt")
			})
		);
		assert_eq!(
			parse("worktree add --lock --reason x --no-reason --no-track ../wt"),
			Some(AddRequest {
				lock: Some(DEFAULT_LOCK_REASON.to_owned()),
				track: Some(false),
				..request("../wt")
			})
		);
		// `--` and `--end-of-options` make dash-led operands literal.
		assert_eq!(parse("worktree add -- -wt"), Some(request("-wt")));
		assert_eq!(parse("worktree add --end-of-options -wt"), Some(request("-wt")));
	}

	/// Every form below has behavior pi-vcs does not reproduce, or is an
	/// error git must report itself.
	#[test]
	fn leaves_other_invocations_to_git() {
		for line in [
			"status",
			"worktree list",
			"-c core.abbrev=12 worktree add ../wt",
			"--git-dir=.git worktree add ../wt",
			"worktree add",
			"worktree add ../wt main extra",
			"worktree add --orphan ../wt",
			"worktree add --no-checkout ../wt",
			"worktree add --reason x ../wt",
			"worktree add --r x ../wt",
			"worktree add --detach=yes ../wt",
			"worktree add -h",
			"worktree add -qx ../wt",
			"worktree add -b x --detach ../wt",
			"worktree add -b x -B y ../wt",
			"worktree add -b",
		] {
			assert_eq!(parse(line), None, "{line}");
		}
	}

	/// Runs `git` reading the same config sources the builtin's gix does: the
	/// real global/system files at their default paths (gix ignores
	/// `GIT_CONFIG_GLOBAL`/`SYSTEM`/`NOSYSTEM`, ignoring these matches it),
	/// and never `GIT_CONFIG_PARAMETERS` (gix does not read it at all).
	/// `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` are left alone: gix reads those
	/// from the process environment, so the helper must see them too.
	#[cfg(unix)]
	fn git(dir: &Path, args: &[&str]) -> String {
		let output = std::process::Command::new("git")
			.args(args)
			.current_dir(dir)
			.env_remove("GIT_CONFIG_GLOBAL")
			.env_remove("GIT_CONFIG_SYSTEM")
			.env_remove("GIT_CONFIG_NOSYSTEM")
			.env_remove("GIT_CONFIG_PARAMETERS")
			.output()
			.expect("run git");
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout).expect("utf8 git output")
	}

	/// Repository with one commit, an ignored build cache, and a
	/// `post-checkout` hook that records its arguments and directory.
	#[cfg(unix)]
	fn fixture() -> (tempfile::TempDir, PathBuf) {
		use std::os::unix::fs::PermissionsExt as _;

		let temp = tempfile::tempdir().expect("tempdir");
		let repo = std::fs::canonicalize(temp.path())
			.expect("canonical tempdir")
			.join("repo");
		std::fs::create_dir(&repo).expect("create repo");
		git(&repo, &["init", "-q", "-b", "main"]);
		git(&repo, &["config", "user.name", "t"]);
		git(&repo, &["config", "user.email", "t@t"]);
		// Pin what a developer's global config would change, locally so the
		// builtin's gix reads see it too: signing makes `git commit` and
		// `git tag` need a key (and a tag a message), and a global
		// `core.hooksPath` would skip the hook below. Absolute, because
		// `hook_path` joins a relative one onto the linked worktree's root.
		let hooks = repo.join(".git/hooks");
		git(&repo, &["config", "commit.gpgSign", "false"]);
		git(&repo, &["config", "tag.gpgSign", "false"]);
		git(&repo, &["config", "core.hooksPath", &hooks.to_string_lossy()]);
		// The builtin hands a form to git when these change worktree or branch
		// behavior, so the parity cases below need git's defaults.
		git(&repo, &["config", "worktree.useRelativePaths", "false"]);
		git(&repo, &["config", "worktree.guessRemote", "false"]);
		git(&repo, &["config", "branch.autoSetupMerge", "true"]);
		std::fs::write(repo.join(".gitignore"), "cache/\n").expect("write gitignore");
		std::fs::write(repo.join("tracked.txt"), "tracked\n").expect("write tracked");
		git(&repo, &["add", "."]);
		git(&repo, &["commit", "-q", "-m", "first commit"]);
		std::fs::create_dir(repo.join("cache")).expect("create cache");
		std::fs::write(repo.join("cache/blob"), "warm").expect("write cache");
		let hook = hooks.join("post-checkout");
		std::fs::write(&hook, "#!/bin/sh\necho \"$* $PWD\" > ../hook.log\necho hook-out\n")
			.expect("write hook");
		std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod hook");
		(temp, repo)
	}

	/// Runs `command` in a one-shot shell, with the builtin enabled through
	/// `PI_SMART_GIT` when `smart`.
	///
	/// The shell exports the test process's environment, where any
	/// `GIT_CONFIG*` variable would hand every `git` call to the binary and
	/// leave the builtin untested, so the command unsets them first. Setting
	/// the process environment instead would race the other tests' threads.
	#[cfg(unix)]
	async fn run_with(repo: &Path, command: &str, smart: bool) -> (Option<i32>, String) {
		let (tx, rx) = flume::unbounded::<String>();
		let flag = if smart { "1" } else { "0" };
		let options = crate::ShellExecuteOptions {
			command: format!("unset -v \"${{!GIT_CONFIG@}}\"; {command}"),
			cwd: Some(repo.to_string_lossy().into_owned()),
			session_env: Some([("PI_SMART_GIT".to_owned(), flag.to_owned())].into()),
			..Default::default()
		};
		let result = crate::execute_shell(options, Some(tx), crate::cancel::CancelToken::default())
			.await
			.expect("execute_shell");
		(result.exit_code, rx.drain().collect())
	}

	#[cfg(unix)]
	async fn run(repo: &Path, command: &str) -> (Option<i32>, String) {
		run_with(repo, command, true).await
	}

	/// Without `PI_SMART_GIT`, `git` is the plain binary: no clone, so the
	/// ignored cache stays behind.
	#[cfg(target_os = "macos")]
	#[tokio::test(flavor = "multi_thread")]
	async fn worktree_add_is_plain_git_unless_opted_in() {
		let (_temp, repo) = fixture();
		let (code, output) = run_with(&repo, "git worktree add ../wt", false).await;
		assert_eq!(code, Some(0), "{output}");
		let wt = repo.parent().expect("parent").join("wt");
		assert!(wt.join("tracked.txt").exists(), "git checked out the worktree");
		assert!(!wt.join("cache/blob").exists(), "git never copies ignored files");
	}

	/// Only the copy-on-write clone carries ignored files; git never does. The
	/// macOS temp dir is APFS, where the clone always works.
	#[cfg(unix)]
	fn assert_cloned(worktree: &Path) {
		if cfg!(target_os = "macos") {
			assert_eq!(
				std::fs::read_to_string(worktree.join("cache/blob")).expect("cloned cache"),
				"warm"
			);
		}
	}

	/// The in-process path must leave a worktree git itself accepts, print
	/// git's report, and run `post-checkout` like git does.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn worktree_add_creates_git_compatible_worktree() {
		let (_temp, repo) = fixture();
		let (code, output) = run(&repo, "git worktree add ../wt").await;
		assert_eq!(code, Some(0), "{output}");

		let wt = repo.parent().expect("parent").join("wt");
		let head = git(&repo, &["rev-parse", "HEAD"]);
		let head = head.trim();
		let short = git(&repo, &["rev-parse", "--short", "HEAD"]);
		assert!(output.contains("Preparing worktree (new branch 'wt')"), "{output}");
		assert!(
			output.contains(&format!("HEAD is now at {} first commit", short.trim())),
			"{output}"
		);
		assert!(output.contains("hook-out"), "hook stdout reaches the transcript: {output}");

		let listed = git(&repo, &["worktree", "list", "--porcelain"]);
		assert!(
			listed.contains(&format!("worktree {}\nHEAD {head}\nbranch refs/heads/wt", wt.display())),
			"{listed}"
		);
		assert_eq!(git(&wt, &["status", "--porcelain"]), "");
		let hook_log = std::fs::read_to_string(repo.parent().expect("parent").join("hook.log"))
			.expect("post-checkout ran");
		assert_eq!(hook_log.trim(), format!("{} {head} 1 {}", "0".repeat(head.len()), wt.display()));
		assert_cloned(&wt);
	}

	/// Detaching at a tag, checking out an existing branch, resetting one with
	/// `-B`, and locking are distinct git outcomes the builtin must reproduce.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn worktree_add_reproduces_git_target_forms() {
		let (_temp, repo) = fixture();
		git(&repo, &["branch", "side"]);
		git(&repo, &["branch", "old"]);
		git(&repo, &["tag", "v1"]);
		let was = git(&repo, &["rev-parse", "--short", "old"]);
		git(&repo, &["commit", "-q", "--allow-empty", "-m", "second"]);

		let (code, output) = run(
			&repo,
			"git worktree add -q ../tagged v1 && git worktree add ../side side && git worktree add \
			 --lock --reason busy -B old ../old",
		)
		.await;
		assert_eq!(code, Some(0), "{output}");
		assert!(!output.contains("detached HEAD"), "-q silences the report: {output}");
		assert!(output.contains("Preparing worktree (checking out 'side')"), "{output}");
		assert!(
			output.contains(&format!(
				"Preparing worktree (resetting branch 'old'; was at {})",
				was.trim()
			)),
			"{output}"
		);

		let parent = repo.parent().expect("parent");
		assert_eq!(
			git(&parent.join("tagged"), &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
			"HEAD"
		);
		assert_eq!(git(&parent.join("side"), &["symbolic-ref", "--short", "HEAD"]).trim(), "side");
		assert!(git(&repo, &["branch", "--list", "v1"]).is_empty(), "a tag must not become a branch");
		assert_eq!(git(&repo, &["rev-parse", "old"]), git(&repo, &["rev-parse", "HEAD"]));
		assert!(
			git(&repo, &["reflog", "-1", "--format=%gs", "old"]).starts_with("branch: Reset to HEAD"),
			"-B records a reset, not a creation"
		);
		let listed = git(&repo, &["worktree", "list", "--porcelain"]);
		assert!(listed.contains("branch refs/heads/old\nlocked busy\n"), "{listed}");
		assert_cloned(&parent.join("old"));
	}

	/// Anything the builtin does not serve still reaches git with its
	/// arguments, output, and exit status intact.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn unsupported_invocations_run_the_git_binary() {
		let (_temp, repo) = fixture();
		let (code, output) =
			run(&repo, "git worktree add --no-checkout ../bare-wt && git rev-parse --abbrev-ref HEAD")
				.await;
		assert_eq!(code, Some(0), "{output}");
		assert!(output.ends_with("main\n"), "{output}");
		let wt = repo.parent().expect("parent").join("bare-wt");
		assert!(!wt.join("tracked.txt").exists(), "--no-checkout handled by git");

		// Branch already checked out: git's own fatal error and status.
		let (code, output) = run(&repo, "git worktree add ../again main").await;
		assert_eq!(code, Some(128));
		assert!(output.contains("fatal: 'main' is already used by worktree"), "{output}");
	}
}
