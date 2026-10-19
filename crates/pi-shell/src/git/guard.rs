//! Shared-checkout guard layered into the `git` builtin.
//!
//! Opt-in: active only when `PI_GIT_GUARD` is truthy in the session or process
//! environment (the coding agent sets it from its `bash.gitGuard` setting).
//!
//! Agents sharing one checkout lose work when one of them runs a git command
//! that discards uncommitted changes or moves HEAD. The guard judges every
//! `git` the shell dispatches — after expansion, in the directory it actually
//! runs in — and refuses:
//!
//! - `stash`, except the read-only `stash list` and `stash show`;
//! - `reset --hard`, and `reset` to a commit other than HEAD's;
//! - `checkout`, `switch`, and working-tree `restore`, unless a merge, rebase,
//!   cherry-pick, or revert is underway, where they pick conflict sides — and
//!   even then not forced (`-f`, `--force`, `--discard-changes`) or over the
//!   whole tree (`.`, `:/`, `*`).
//!
//! Index-only commands always run: `reset [<path>…]` and `restore --staged`
//! only unstage. Git started by path (`/usr/bin/git`) or by another program
//! (`xargs git`, `sh -c`) never reaches the builtin and is not judged.

use std::path::{Path, PathBuf};

use brush_core::{Error, ErrorKind, Shell, ShellExtensions};
use pi_vcs::git::GitRepo;

use crate::shell::is_git_repo_location_var;

/// Exit status of a refused command; git's own for a refused operation.
pub(super) const REFUSED_EXIT: u8 = 1;

/// A judged `git` invocation, detached from the shell so its repository reads
/// can run off the async workers.
pub(super) struct Review(Judgment);

impl Review {
	/// Judges `args` (git's arguments, without `git`) as `shell` would run them.
	pub(super) fn of<SE: ShellExtensions>(shell: &Shell<SE>, args: &[String]) -> Self {
		let Some(invocation) = Invocation::parse(args) else {
			return Self(Judgment::Allow);
		};
		let sub = invocation.sub;
		let site = || Site {
			dir:        invocation
				.dirs
				.iter()
				.fold(shell.working_dir().to_owned(), |dir, next| dir.join(next)),
			// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … retarget git as
			// `--git-dir` does.
			redirected: invocation.redirected
				|| shell
					.env()
					.iter_exported()
					.any(|(name, _)| is_git_repo_location_var(name)),
		};
		Self(match classify(sub, invocation.args) {
			Verdict::Allow => Judgment::Allow,
			Verdict::Stash => Judgment::Refuse(Refusal::Stash),
			Verdict::Destructive => Judgment::Refuse(Refusal::Destructive(sub)),
			Verdict::ResetTo(rev) => Judgment::ResetTo(rev.to_owned(), site()),
			Verdict::ConflictOnly => Judgment::ConflictOnly(sub, site()),
		})
	}

	/// The message to print instead of running git, or `None` when git may run.
	///
	/// # Errors
	/// [`ErrorKind::ThreadingError`] when the repository read cannot finish.
	pub(super) async fn refusal(self) -> Result<Option<String>, Error> {
		let refusal = match self.0 {
			Judgment::Allow => None,
			Judgment::Refuse(refusal) => Some(refusal),
			// A redirected repository is not the one found from `dir`; refuse.
			Judgment::ResetTo(rev, site) => (site.redirected
				|| blocking(move || moves_head(&site.dir, &rev)).await?)
				.then_some(Refusal::CommitMove),
			Judgment::ConflictOnly(sub, site) => {
				if site.redirected {
					Some(Refusal::Redirected(sub))
				} else if blocking(move || mid_operation(&site.dir)).await? {
					None
				} else {
					Some(Refusal::OutsideConflict(sub))
				}
			},
		};
		Ok(refusal.map(|refusal| refusal.message()))
	}
}

/// What the guard decided, or which repository read decides it.
enum Judgment {
	Allow,
	Refuse(Refusal),
	/// `reset` to a revision: refused when it moves HEAD.
	ResetTo(String, Site),
	/// Refused unless the repository is mid-operation.
	ConflictOnly(Sub, Site),
}

/// Where git would run.
struct Site {
	/// The working directory with `-C` applied.
	dir:        PathBuf,
	/// Git is pointed at a repository other than the one found from `dir`.
	redirected: bool,
}

/// Runs a synchronous repository read on the blocking pool.
async fn blocking<T: Send + 'static>(
	read: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Error> {
	tokio::task::spawn_blocking(read)
		.await
		.map_err(|err| Error::from(ErrorKind::ThreadingError(err)))
}

/// Whether `reset` to `rev` moves HEAD in the repository at `dir`.
fn moves_head(dir: &Path, rev: &str) -> bool {
	let repo = match GitRepo::discover(dir) {
		Ok(Some(repo)) => repo,
		// Outside a repository git fails on its own.
		Ok(None) => return false,
		Err(_) => return true,
	};
	match (repo.resolve_ref(rev), repo.head_sha()) {
		// Not a revision: git reads it as a path and only rewrites the index.
		(Ok(None), _) => false,
		(Ok(Some(target)), Ok(head)) => head.as_deref() != Some(target.as_str()),
		_ => true,
	}
}

/// Whether the repository at `dir` is mid-merge, -rebase, -cherry-pick, or
/// -revert; an unreadable repository is not.
fn mid_operation(dir: &Path) -> bool {
	matches!(
		GitRepo::discover(dir),
		Ok(Some(repo)) if repo.operation_in_progress().unwrap_or(false)
	)
}

/// A git subcommand the guard judges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sub {
	Stash,
	Reset,
	Checkout,
	Switch,
	Restore,
}

impl Sub {
	fn parse(name: &str) -> Option<Self> {
		Some(match name {
			"stash" => Self::Stash,
			"reset" => Self::Reset,
			"checkout" => Self::Checkout,
			"switch" => Self::Switch,
			"restore" => Self::Restore,
			_ => return None,
		})
	}

	const fn name(self) -> &'static str {
		match self {
			Self::Stash => "stash",
			Self::Reset => "reset",
			Self::Checkout => "checkout",
			Self::Switch => "switch",
			Self::Restore => "restore",
		}
	}

	/// Short and long options whose value may be the next argument.
	const fn valued(self) -> (&'static [char], &'static [&'static str]) {
		match self {
			Self::Stash => (&[], &[]),
			Self::Reset => (&['U'], &["pathspec-from-file", "unified", "inter-hunk-context"]),
			Self::Checkout => (&['b', 'B', 'U'], &[
				"orphan",
				"conflict",
				"pathspec-from-file",
				"unified",
				"inter-hunk-context",
			]),
			Self::Switch => (&['c', 'C'], &["orphan", "conflict"]),
			Self::Restore => (&['s', 'U'], &[
				"source",
				"conflict",
				"pathspec-from-file",
				"unified",
				"inter-hunk-context",
			]),
		}
	}
}

/// `git [<global options>] <sub> <args>…` with a guarded subcommand.
struct Invocation<'a> {
	/// `-C` directories, applied in order.
	dirs:       Vec<&'a str>,
	/// `--git-dir`/`--work-tree` point git at another repository.
	redirected: bool,
	sub:        Sub,
	args:       &'a [String],
}

impl<'a> Invocation<'a> {
	/// `None` when the subcommand is not guarded, or there is none.
	fn parse(args: &'a [String]) -> Option<Self> {
		let mut dirs = Vec::new();
		let mut redirected = false;
		let mut at = 0;
		while let Some(arg) = args.get(at) {
			at += 1;
			match arg.as_str() {
				"-C" => {
					dirs.push(args.get(at)?.as_str());
					at += 1;
				},
				"--git-dir" | "--work-tree" => {
					redirected = true;
					at += 1;
				},
				"-c" | "--config-env" | "--namespace" | "--super-prefix" | "--attr-source" => at += 1,
				arg if arg.starts_with("--git-dir=") || arg.starts_with("--work-tree=") => {
					redirected = true;
				},
				arg if arg.starts_with('-') => {},
				name => {
					return Some(Self { dirs, redirected, sub: Sub::parse(name)?, args: &args[at..] });
				},
			}
		}
		None
	}
}

/// One subcommand argument, read the way git's parse-options reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arg<'a> {
	/// `--name` or `--name=value`, by name.
	Long(&'a str),
	/// One letter of a short-option bundle: `-qf` yields `q`, then `f`.
	Short(char),
	/// A non-option argument before `--`.
	Operand(&'a str),
	/// An argument after `--`.
	Pathspec(&'a str),
}

/// Splits `sub`'s arguments into options and operands, skipping option values
/// so they are never mistaken for operands.
fn scan(sub: Sub, args: &[String]) -> Vec<Arg<'_>> {
	let (short_valued, long_valued) = sub.valued();
	let mut scanned = Vec::new();
	let mut options = true;
	let mut args = args.iter();
	while let Some(arg) = args.next() {
		if arg == "--" {
			scanned.extend(args.by_ref().map(|arg| Arg::Pathspec(arg)));
			break;
		}
		if !options {
			scanned.push(Arg::Operand(arg));
		} else if arg == "--end-of-options" {
			options = false;
		} else if let Some(long) = arg.strip_prefix("--") {
			let (name, inline) = long
				.split_once('=')
				.map_or((long, false), |(name, _)| (name, true));
			if !inline && long_valued.contains(&name) {
				args.next();
			}
			scanned.push(Arg::Long(name));
		} else if let Some(bundle) = arg.strip_prefix('-').filter(|bundle| !bundle.is_empty()) {
			for (at, flag) in bundle.char_indices() {
				scanned.push(Arg::Short(flag));
				if short_valued.contains(&flag) {
					// The value is the rest of the bundle, else the next argument.
					if at + flag.len_utf8() == bundle.len() {
						args.next();
					}
					break;
				}
			}
		} else {
			scanned.push(Arg::Operand(arg));
		}
	}
	scanned
}

/// What a guarded command would do, judged from its arguments alone.
#[derive(Debug, PartialEq, Eq)]
enum Verdict<'a> {
	Allow,
	Stash,
	/// Discards the working tree or index wholesale; refused even mid-conflict.
	Destructive,
	/// `reset` to this revision without a pathspec: moves HEAD unless it names
	/// HEAD's commit.
	ResetTo(&'a str),
	/// Rewrites working-tree files or switches branches; allowed only
	/// mid-conflict.
	ConflictOnly,
}

fn classify(sub: Sub, args: &[String]) -> Verdict<'_> {
	match sub {
		Sub::Stash => match args.first().map(String::as_str) {
			Some("list" | "show") => Verdict::Allow,
			_ => Verdict::Stash,
		},
		Sub::Reset => classify_reset(&scan(sub, args)),
		Sub::Checkout | Sub::Switch | Sub::Restore => classify_tree_write(sub, &scan(sub, args)),
	}
}

/// `reset` moves HEAD only in its `reset [<mode>] <commit>` form: one revision
/// and no pathspec. With paths, a pathspec file, or `--patch` it rewrites index
/// entries only.
fn classify_reset<'a>(args: &[Arg<'a>]) -> Verdict<'a> {
	let mut operands = Vec::new();
	let (mut hard, mut index_only) = (false, false);
	for arg in args {
		match *arg {
			Arg::Long("hard") => hard = true,
			Arg::Long("patch" | "pathspec-from-file") | Arg::Short('p') | Arg::Pathspec(_) => {
				index_only = true;
			},
			Arg::Operand(operand) => operands.push(operand),
			Arg::Long(_) | Arg::Short(_) => {},
		}
	}
	match operands[..] {
		_ if hard => Verdict::Destructive,
		[rev] if !index_only && !matches!(rev, "HEAD" | "@") => Verdict::ResetTo(rev),
		_ => Verdict::Allow,
	}
}

/// `checkout`, `switch`, and `restore` rewrite working-tree files or switch
/// branches — except `restore --staged` without `--worktree`, which only
/// unstages, and a bare `checkout`, which only reports.
fn classify_tree_write(sub: Sub, args: &[Arg<'_>]) -> Verdict<'static> {
	if sub == Sub::Checkout && args.is_empty() {
		return Verdict::Allow;
	}
	let (mut staged, mut worktree, mut forced, mut whole_tree) = (false, false, false, false);
	for arg in args {
		match (sub, *arg) {
			(Sub::Checkout | Sub::Switch, Arg::Short('f') | Arg::Long("force"))
			| (Sub::Switch, Arg::Long("discard-changes")) => forced = true,
			(Sub::Restore, Arg::Short('S') | Arg::Long("staged")) => staged = true,
			(Sub::Restore, Arg::Short('W') | Arg::Long("worktree")) => worktree = true,
			(Sub::Checkout | Sub::Restore, Arg::Operand(spec) | Arg::Pathspec(spec)) => {
				whole_tree |= is_whole_tree(spec);
			},
			_ => {},
		}
	}
	if staged && !worktree {
		Verdict::Allow
	} else if forced || whole_tree {
		Verdict::Destructive
	} else {
		Verdict::ConflictOnly
	}
}

/// Whether `spec` covers everything under the working directory or the
/// repository root: `.`, `*`, `:/`, or a path climbing out with `..`.
fn is_whole_tree(spec: &str) -> bool {
	let rest = spec
		.strip_prefix(":/")
		.or_else(|| spec.strip_prefix(":(top)"))
		.unwrap_or(spec);
	rest == "*" || rest.split('/').all(|part| matches!(part, "" | "." | ".."))
}

/// Why the guard refuses a command.
enum Refusal {
	Stash,
	Destructive(Sub),
	CommitMove,
	OutsideConflict(Sub),
	Redirected(Sub),
}

impl Refusal {
	fn message(&self) -> String {
		match self {
			Self::Stash => "git stash is blocked by workspace policy — do not work around it.\nThis \
			                is a SHARED workspace; stash mutates the tree/index other concurrent \
			                agents rely on, silently trashing their work. You cannot stash with \
			                unmerged paths anyway — resolve conflicts in place. Read-only `git stash \
			                list` and `git stash show` remain available.\n"
				.to_owned(),
			Self::Destructive(sub) => format!(
				"git {} is blocked: this form (--hard / --force / --discard-changes, or a whole-tree \
				 pathspec like `.`, `:/`, `*`) discards the working tree/index wholesale and would \
				 destroy other agents' uncommitted work — being mid-conflict does not make it \
				 safe.\nResolve conflicts with targeted forms instead: git checkout/restore \
				 --ours|--theirs <path>. Unstage with git reset <path> or git restore --staged \
				 <path>.\n",
				sub.name()
			),
			Self::CommitMove => "git reset to another commit is blocked: moving HEAD/the branch \
			                     (e.g. `HEAD~1`, a sha, or a branch name) rewrites history other \
			                     agents share.\nUnstaging is allowed — drop the commit argument: git \
			                     reset [-q] [--] <path> (or bare git reset to unstage everything), \
			                     or git restore --staged <path>.\n"
				.to_owned(),
			Self::OutsideConflict(sub) => format!(
				"git {} is blocked by workspace policy — do not work around it.\nThis is a SHARED \
				 workspace; overwriting working-tree files or switching branches discards or strands \
				 uncommitted changes other concurrent agents rely on. It is exempt only while a \
				 merge/rebase conflict is being resolved, and the repository is not in \
				 one.\nUnstaging is always allowed: git reset [<path>] / git restore --staged <path>. \
				 To undo working-tree edits, edit forward; inspect history read-only with git \
				 diff/log/show.\n",
				sub.name()
			),
			Self::Redirected(sub) => format!(
				"git {} is blocked: the conflict exemption checks the repository found from the \
				 working directory, and this command points git elsewhere (--git-dir / --work-tree / \
				 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE), so that repository's state cannot be \
				 verified.\nRun it from inside the target checkout (cd or git -C) without overriding \
				 git's repository location.\n",
				sub.name()
			),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[cfg(unix)]
	use crate::git::tests::{fixture, git, run_with};

	/// How the guard reads `line` before consulting any repository.
	fn judged(line: &str) -> String {
		let args: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
		match Invocation::parse(&args) {
			Some(invocation) => format!("{:?}", classify(invocation.sub, invocation.args)),
			None => "unguarded".to_owned(),
		}
	}

	#[test]
	fn reads_arguments_as_git_does() {
		for (line, expected) in [
			// Global options: values are skipped, `-C` is not a subcommand.
			("-C stash status", "unguarded"),
			("-c core.pager=cat --no-pager stash", "Stash"),
			("--git-dir .git status", "unguarded"),
			("stash list", "Allow"),
			("stash show -p", "Allow"),
			("stash -p", "Stash"),
			("stash pop", "Stash"),
			// Bare and path-scoped resets only rewrite the index.
			("reset", "Allow"),
			("reset -q HEAD", "Allow"),
			("reset main tracked.txt", "Allow"),
			("reset -- main", "Allow"),
			("reset -p main", "Allow"),
			("reset --pathspec-from-file list main", "Allow"),
			("reset --soft main", "ResetTo(\"main\")"),
			("reset main --", "ResetTo(\"main\")"),
			("reset --end-of-options -weird", "ResetTo(\"-weird\")"),
			("reset -q --hard", "Destructive"),
			("checkout", "Allow"),
			("checkout main", "ConflictOnly"),
			("checkout --theirs tracked.txt", "ConflictOnly"),
			("checkout -qf main", "Destructive"),
			// `-b` takes the rest of its bundle as the branch name.
			("checkout -bf topic", "ConflictOnly"),
			("checkout --theirs .", "Destructive"),
			("checkout -- :/", "Destructive"),
			("checkout HEAD -- ../..", "Destructive"),
			("switch -c topic", "ConflictOnly"),
			("switch --discard-changes main", "Destructive"),
			("restore tracked.txt", "ConflictOnly"),
			("restore --staged .", "Allow"),
			("restore -SW tracked.txt", "ConflictOnly"),
			("restore --staged --worktree *", "Destructive"),
			// `--source`'s value is a tree, not a pathspec.
			("restore --source . tracked.txt", "ConflictOnly"),
		] {
			assert_eq!(judged(line), expected, "git {line}");
		}
	}

	#[cfg(unix)]
	async fn guarded(repo: &Path, command: &str) -> (Option<i32>, String) {
		run_with(repo, command, &["PI_GIT_GUARD"]).await
	}

	/// The guard sees the command as the shell runs it, so an expanded
	/// subcommand is still a stash; listing stays available.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn stash_is_refused_however_it_is_spelled() {
		let (_temp, repo) = fixture();
		std::fs::write(repo.join("tracked.txt"), "mine\n").expect("edit");

		let (code, output) = guarded(&repo, "git stash list && s=stash && git $s").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("git stash is blocked"), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "mine\n");
		assert_eq!(git(&repo, &["stash", "list"]), "");

		// Off unless asked for, also beside the worktree layer.
		let (code, output) = run_with(&repo, "git stash -q", &["PI_SMART_GIT"]).await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "tracked\n");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn reset_unstages_but_never_discards_or_moves_head() {
		let (_temp, repo) = fixture();
		std::fs::write(repo.join("tracked.txt"), "mine\n").expect("edit");
		git(&repo, &["add", "tracked.txt"]);

		// `main` is HEAD's commit, so resetting to it only unstages.
		let (code, output) = guarded(&repo, "git reset -q main && git reset -q tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "");

		let (code, output) = guarded(&repo, "git reset --hard").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "mine\n");

		git(&repo, &["commit", "-qam", "second"]);
		let head = git(&repo, &["rev-parse", "HEAD"]);
		let (code, output) = guarded(&repo, "git reset --soft HEAD~1").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("git reset to another commit is blocked"), "{output}");
		assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
	}

	/// Outside a conflict every working-tree rewrite is refused; while one is
	/// being resolved — conflicted or resolved but uncommitted — targeted
	/// forms run, whole-tree and redirected ones still do not.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn working_tree_rewrites_wait_for_a_conflict() {
		let (_temp, repo) = fixture();
		git(&repo, &["checkout", "-qb", "side"]);
		std::fs::write(repo.join("tracked.txt"), "theirs\n").expect("edit side");
		git(&repo, &["commit", "-qam", "side"]);
		git(&repo, &["checkout", "-q", "main"]);
		std::fs::write(repo.join("tracked.txt"), "ours\n").expect("edit main");
		git(&repo, &["commit", "-qam", "main"]);
		std::fs::write(repo.join("tracked.txt"), "uncommitted\n").expect("edit");

		for command in ["git checkout tracked.txt", "git restore tracked.txt", "git switch -q side"] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains("not in one"), "{command}: {output}");
		}
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "uncommitted\n");

		git(&repo, &["checkout", "-q", "--", "tracked.txt"]);
		let (code, output) = guarded(&repo, "git merge -q side").await;
		assert_eq!(code, Some(1), "the merge conflicts: {output}");

		let (code, output) = guarded(&repo, "git checkout --theirs .").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		let (code, output) = guarded(&repo, "git --git-dir=.git checkout --theirs tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("points git elsewhere"), "{output}");

		let (code, output) =
			guarded(&repo, "cd .. && git -C repo checkout --theirs tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "theirs\n");

		// Resolved: no unmerged entries left, but MERGE_HEAD remains.
		git(&repo, &["add", "tracked.txt"]);
		std::fs::write(repo.join("tracked.txt"), "scratch\n").expect("edit");
		let (code, output) = guarded(&repo, "git restore tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "theirs\n");
	}
}
