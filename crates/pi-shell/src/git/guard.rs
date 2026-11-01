//! Shared-checkout guard layered into the `git` builtin.
//!
//! Opt-in: active only when `PI_GIT_GUARD` is truthy in the session or process
//! environment (the coding agent sets it from its `bash.gitGuard` setting).
//!
//! Agents sharing one checkout lose work when one of them runs a git command
//! that discards uncommitted changes or moves HEAD. The guard judges every
//! `git` the shell dispatches — after expansion, in the directory it actually
//! runs in — by whose checkout that is.
//!
//! A linked worktree (`git worktree add`) of a repository with a main checkout,
//! and a submodule inside one, belong to one line of work. There every command
//! runs, except that `stash pop`, `apply`, `drop`, `branch`, and `clear` refuse
//! entries saved on another branch or a detached HEAD, since every worktree
//! shares one stash list; and a command that discards uncommitted changes first
//! records them on [`DISCARDED_REF`]'s reflog, or is refused when it would also
//! discard changes inside submodules, which that record cannot hold.
//!
//! Any other checkout — a repository's main worktree, a clone, or one git is
//! redirected to — may be shared by concurrent sessions, and there the guard
//! refuses:
//!
//! - `stash`, except the read-only `stash list` and `stash show` and `stash
//!   create`, which writes only an object;
//! - `reset --hard`, and `reset` to a commit other than HEAD's;
//! - `switch`, and `checkout` of a branch or commit;
//! - `checkout` of paths and working-tree `restore`, unless a merge, rebase,
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

/// Ref whose reflog records uncommitted changes before a command in a
/// one-agent checkout discards them. Git expires entries other than the
/// latest with every reflog (`gc.reflogExpireUnreachable`, 30 days).
const DISCARDED_REF: &str = "refs/omp/discarded";

/// Where to take a command the guard refuses in a shared checkout.
const OWN_WORKTREE: &str = "In a worktree of your own (git worktree add <path> [<branch>]) it \
                            runs, and uncommitted changes it would discard are saved first.";

/// A judged `git` invocation, detached from the shell so its repository reads
/// can run off the async workers.
pub(super) struct Review(Judgment);

/// What the builtin does with a judged command.
pub(super) enum Decision {
	Run,
	/// Print this note to stderr, then run git.
	RunNoted(String),
	/// Print this message instead of running git.
	Refuse(String),
}

impl Review {
	/// Judges `args` (git's arguments, without `git`) as `shell` would run them.
	pub(super) fn of<SE: ShellExtensions>(shell: &Shell<SE>, args: &[String]) -> Self {
		let Some(invocation) = Invocation::parse(args) else {
			return Self(Judgment::Allow);
		};
		let verdict = classify(invocation.sub, invocation.args);
		if verdict == Verdict::Allow {
			return Self(Judgment::Allow);
		}
		Self(Judgment::Check(invocation.sub, verdict, Site {
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
			// Configuration passed through the environment (`GIT_CONFIG_COUNT`)
			// may turn on `submodule.recurse`.
			recurse:    recurse_option(invocation.sub, invocation.args)
				.or(invocation.recurse)
				.or_else(|| {
					shell
						.env()
						.iter_exported()
						.any(|(name, _)| name == "GIT_CONFIG_COUNT")
						.then_some(true)
				}),
			command:    args.join(" "),
		}))
	}

	/// Whether git runs, reading and saving repository state as the verdict
	/// needs.
	///
	/// # Errors
	/// [`ErrorKind::ThreadingError`] when the repository work cannot finish.
	pub(super) async fn decide(self) -> Result<Decision, Error> {
		let Judgment::Check(sub, verdict, site) = self.0 else {
			return Ok(Decision::Run);
		};
		tokio::task::spawn_blocking(move || match Place::of(&site) {
			Place::Private(repo) => in_private(&repo, sub, verdict, &site),
			place => in_shared(&place, sub, verdict, &site.dir)
				.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message())),
		})
		.await
		.map_err(|err| Error::from(ErrorKind::ThreadingError(err)))
	}
}

/// What the guard decided, or which repository read decides it.
enum Judgment {
	Allow,
	/// Decided by the checkout git runs in.
	Check(Sub, Verdict, Site),
}

/// Where git would run.
struct Site {
	/// The working directory with `-C` applied.
	dir:        PathBuf,
	/// Git is pointed at a repository other than the one found from `dir`.
	redirected: bool,
	/// `--[no-]recurse-submodules` or `-c submodule.recurse`, when given; the
	/// repository's `submodule.recurse` otherwise.
	recurse:    Option<bool>,
	/// Git's arguments, for the record of what discarded saved changes.
	command:    String,
}

/// The checkout a command runs in.
enum Place {
	/// Git is redirected away from the repository found from the directory.
	Redirected,
	/// The repository there cannot be read.
	Unreadable,
	/// No repository: git fails on its own.
	Outside,
	/// A checkout other sessions may be using.
	Shared(GitRepo),
	/// A checkout that belongs to one line of work.
	Private(GitRepo),
}

impl Place {
	fn of(site: &Site) -> Self {
		if site.redirected {
			return Self::Redirected;
		}
		match GitRepo::discover(&site.dir) {
			Ok(Some(repo)) if is_private(&repo) => Self::Private(repo),
			Ok(Some(repo)) => Self::Shared(repo),
			Ok(None) => Self::Outside,
			Err(_) => Self::Unreadable,
		}
	}
}

/// Whether `repo`'s checkout belongs to one line of work: a worktree linked to
/// a repository that has a main checkout of its own, or a submodule checked
/// out inside one. Any other checkout may be shared, including every worktree
/// of a bare repository, where one of them is where a person works.
fn is_private(repo: &GitRepo) -> bool {
	let info = repo.info();
	if repo.is_linked_worktree() {
		return info
			.common_dir
			.file_name()
			.is_some_and(|name| name == ".git");
	}
	// A submodule's `.git` is a file pointing into its superproject's.
	info.git_entry_path.is_file()
		&& info.repo_root.parent().is_some_and(|parent| {
			matches!(GitRepo::discover(parent), Ok(Some(superproject)) if is_private(&superproject))
		})
}

/// Why `verdict`, run in `dir`, is refused in a checkout other sessions may be
/// using, if it is.
fn in_shared(place: &Place, sub: Sub, verdict: Verdict, dir: &Path) -> Option<Refusal> {
	let repo = match place {
		Place::Shared(repo) => Some(repo),
		// The repository found from the directory is not the one git changes.
		Place::Redirected => return Some(Refusal::Redirected(sub)),
		Place::Unreadable | Place::Outside | Place::Private(_) => None,
	};
	match verdict {
		Verdict::Allow => None,
		Verdict::Stash(_) => Some(Refusal::Stash),
		Verdict::Destructive => Some(Refusal::Destructive(sub)),
		Verdict::BranchMove => Some(Refusal::BranchMove(sub)),
		Verdict::ResetTo(rev, _) => match repo {
			Some(repo) => moves_head(repo, &rev).then_some(Refusal::CommitMove),
			// Outside a repository git fails on its own.
			None => matches!(place, Place::Unreadable).then_some(Refusal::CommitMove),
		},
		Verdict::ConflictOnly => outside_conflict(repo, sub),
		Verdict::CheckoutOne(operand) => {
			if repo.is_some_and(|repo| !names_path(repo, dir, &operand)) {
				Some(Refusal::BranchMove(sub))
			} else {
				outside_conflict(repo, sub)
			}
		},
	}
}

/// Whether `verdict` runs in a checkout of one line of work: it does, after
/// uncommitted changes it would discard are saved, unless it takes another
/// branch's stash entry or the save fails.
fn in_private(repo: &GitRepo, sub: Sub, verdict: Verdict, site: &Site) -> Decision {
	match verdict {
		Verdict::Allow | Verdict::Stash(Stash::Saves) | Verdict::BranchMove => Decision::Run,
		Verdict::Stash(Stash::Takes(op, entry)) => foreign_stash(repo, op, entry.as_deref())
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message())),
		Verdict::Stash(Stash::Clear) => foreign_stash(repo, "clear", None)
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message())),
		// `--soft` keeps the index and working tree. `--keep` keeps working-tree
		// changes but can drop staged ones, so it saves first.
		Verdict::ResetTo(_, true) => Decision::Run,
		Verdict::ResetTo(_, false) | Verdict::Destructive => save_then_run(repo, sub, site, false),
		Verdict::ConflictOnly => save_then_run(repo, sub, site, true),
		Verdict::CheckoutOne(operand) if names_path(repo, &site.dir, &operand) => {
			save_then_run(repo, sub, site, true)
		},
		Verdict::CheckoutOne(_) => Decision::Run,
	}
}

/// Whether `reset` to `rev` moves HEAD in `repo`.
fn moves_head(repo: &GitRepo, rev: &str) -> bool {
	match (repo.resolve_ref(rev), repo.head_sha()) {
		// Not a revision: git reads it as a path and only rewrites the index.
		(Ok(None), _) => false,
		(Ok(Some(target)), Ok(head)) => head.as_deref() != Some(target.as_str()),
		_ => true,
	}
}

/// Why a working-tree rewrite in `repo` is refused, if it is: it runs only
/// mid-merge, -rebase, -cherry-pick, or -revert. Without a readable repository
/// it is not mid-operation.
fn outside_conflict(repo: Option<&GitRepo>, sub: Sub) -> Option<Refusal> {
	(!repo.is_some_and(|repo| repo.operation_in_progress().unwrap_or(false)))
		.then_some(Refusal::OutsideConflict(sub))
}

/// Records `repo`'s uncommitted changes on [`DISCARDED_REF`] before the command
/// at `site` discards them. When git cannot write them, a `targeted` command
/// still runs mid-operation, where it picks a conflict side: git cannot record
/// unmerged entries.
fn save_then_run(repo: &GitRepo, sub: Sub, site: &Site, targeted: bool) -> Decision {
	// The record holds this repository's changes, not its submodules'. A
	// submodule's git directory outlives the `.gitmodules` a command restores.
	let info = repo.info();
	if recurses(repo, site.recurse)
		&& (!matches!(repo.submodule_paths(), Ok(paths) if paths.is_empty())
			|| info.git_dir.join("modules").is_dir()
			|| info.common_dir.join("modules").is_dir())
	{
		return Decision::Refuse(Refusal::Recursive(sub).message());
	}
	let id = match repo.stash_create() {
		Ok(None) => return Decision::Run,
		Ok(Some(id)) => id,
		Err(_) if targeted && repo.operation_in_progress().unwrap_or(false) => {
			return Decision::Run;
		},
		Err(err) => return Decision::Refuse(Refusal::Unsaved(sub, err.to_string()).message()),
	};
	// Once the changes are written, a failure to keep them is never exempt.
	if let Err(err) = repo.record_ref(DISCARDED_REF, &id, &format!("before git {}", site.command)) {
		return Decision::Refuse(Refusal::Unsaved(sub, err.to_string()).message());
	}
	let short = repo.short_id(&id).unwrap_or(id);
	Decision::RunNoted(format!(
		"git {}: saved your uncommitted changes as {short} on {DISCARDED_REF} first; git stash \
		 apply --index {short} brings them back.\n",
		sub.name()
	))
}

/// Whether git recurses into submodules: as `option` says when given, else as
/// `submodule.recurse` does. An unreadable setting counts as on.
fn recurses(repo: &GitRepo, option: Option<bool>) -> bool {
	option.unwrap_or_else(|| match repo.config_get("submodule.recurse") {
		Ok(None) => false,
		Ok(Some(value)) => {
			!matches!(value.to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0")
		},
		Err(_) => true,
	})
}

/// Why `stash <op>` of `entry` (`stash@{0}` when `None`; every entry for
/// `clear`) is refused, if it is: an entry another branch or a detached HEAD
/// saved, or one whose saver is unknown, may be another session's.
fn foreign_stash(repo: &GitRepo, op: &'static str, entry: Option<&str>) -> Option<Refusal> {
	let target = StashTarget::of(entry);
	// A commit named outside the stash list is the caller's choice.
	if matches!(target, StashTarget::Commit) {
		return None;
	}
	let here = repo.current_branch().ok().flatten();
	let refuse = |entry: String, subject: Option<String>| {
		Some(Refusal::ForeignStash { op, entry, subject, here: here.clone() })
	};
	let (StashTarget::Entry(position), Ok(subjects)) = (target, repo.stash_subjects()) else {
		return refuse(entry.unwrap_or("stash@{0}").to_owned(), None);
	};
	let foreign = |subject: &&String| {
		!matches!(
			(saved_on(subject), here.as_deref()),
			(Saver::Branch(saver), Some(here)) if saver == here
		)
	};
	let (position, subject) = if op == "clear" {
		subjects
			.iter()
			.enumerate()
			.find(|(_, subject)| foreign(subject))?
	} else {
		// Past the end of the list git fails on its own.
		(position, subjects.get(position).filter(foreign)?)
	};
	refuse(format!("stash@{{{position}}}"), Some(subject.clone()))
}

/// The stash entry a `stash` subcommand names.
enum StashTarget {
	/// `stash@{n}`, `refs/stash@{n}`, or `n`.
	Entry(usize),
	/// A stash list entry not named by position (`stash@{yesterday}`).
	Unindexed,
	/// A commit outside the stash list.
	Commit,
}

impl StashTarget {
	fn of(entry: Option<&str>) -> Self {
		let Some(entry) = entry else {
			return Self::Entry(0);
		};
		if let Ok(position) = entry.parse() {
			return Self::Entry(position);
		}
		let Some(selector) = entry
			.strip_prefix("refs/stash")
			.or_else(|| entry.strip_prefix("stash"))
		else {
			return Self::Commit;
		};
		if selector.is_empty() {
			return Self::Entry(0);
		}
		if let Some(rest) = selector.strip_prefix("@{") {
			return rest
				.strip_suffix('}')
				.and_then(|position| position.parse().ok())
				.map_or(Self::Unindexed, Self::Entry);
		}
		// `stash^`, `stash~1`, `stash:<path>` reach into the list; any other
		// name only starts with `stash` (`stash-backup`).
		if selector.starts_with(['^', '~', ':', '@']) {
			Self::Unindexed
		} else {
			Self::Commit
		}
	}
}

/// What saved a stash entry, read from git's `WIP on <branch>: …` or `On
/// <branch>: …` subject.
#[derive(Debug, PartialEq, Eq)]
enum Saver<'a> {
	Branch(&'a str),
	Detached,
	Unknown,
}

fn saved_on(subject: &str) -> Saver<'_> {
	let saver = subject.split_once(": ").and_then(|(head, _)| {
		head
			.strip_prefix("WIP on ")
			.or_else(|| head.strip_prefix("On "))
	});
	match saver {
		Some("(no branch)") => Saver::Detached,
		Some(branch) if !branch.is_empty() => Saver::Branch(branch),
		_ => Saver::Unknown,
	}
}

/// Whether `checkout <operand>`, run in `dir`, restores a path: the operand
/// names no revision, and it is a glob or a file that exists there. Git takes
/// any other name as a branch to create from a remote-tracking one, through
/// whatever fetch refspec maps it, or fails on its own; and `A...B`, `A...`,
/// or `...B` as their merge base, even beside a file of that name.
fn names_path(repo: &GitRepo, dir: &Path, operand: &str) -> bool {
	!operand.contains("...")
		&& matches!(repo.resolve_ref(operand), Ok(None))
		&& (operand.contains(['*', '?', '[', '\\']) || dir.join(operand).symlink_metadata().is_ok())
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

	/// Long options git accepts, which it also accepts abbreviated.
	const fn long_options(self) -> &'static [&'static str] {
		match self {
			// Only the subcommand and its operands matter.
			Self::Stash => &[],
			Self::Reset => &[
				"auto-advance",
				"hard",
				"intent-to-add",
				"inter-hunk-context",
				"keep",
				"merge",
				"mixed",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"quiet",
				"recurse-submodules",
				"refresh",
				"soft",
				"unified",
			],
			Self::Checkout => &[
				"auto-advance",
				"conflict",
				"detach",
				"force",
				"guess",
				"ignore-other-worktrees",
				"ignore-skip-worktree-bits",
				"inter-hunk-context",
				"merge",
				"orphan",
				"ours",
				"overlay",
				"overwrite-ignore",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"progress",
				"quiet",
				"recurse-submodules",
				"theirs",
				"track",
				"unified",
			],
			Self::Switch => &[
				"conflict",
				"create",
				"detach",
				"discard-changes",
				"force",
				"force-create",
				"guess",
				"ignore-other-worktrees",
				"merge",
				"orphan",
				"overwrite-ignore",
				"progress",
				"quiet",
				"recurse-submodules",
				"track",
			],
			Self::Restore => &[
				"conflict",
				"ignore-skip-worktree-bits",
				"ignore-unmerged",
				"inter-hunk-context",
				"merge",
				"ours",
				"overlay",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"progress",
				"quiet",
				"recurse-submodules",
				"source",
				"staged",
				"theirs",
				"unified",
				"worktree",
			],
		}
	}
}

/// `git [<global options>] <sub> <args>…` with a guarded subcommand.
struct Invocation<'a> {
	/// `-C` directories, applied in order.
	dirs:       Vec<&'a str>,
	/// `--git-dir`/`--work-tree` point git at another repository.
	redirected: bool,
	/// `-c submodule.recurse=<bool>`, the last one winning.
	recurse:    Option<bool>,
	sub:        Sub,
	args:       &'a [String],
}

impl<'a> Invocation<'a> {
	/// `None` when the subcommand is not guarded, or there is none.
	fn parse(args: &'a [String]) -> Option<Self> {
		let mut dirs = Vec::new();
		let mut redirected = false;
		let mut recurse = None;
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
				"-c" => {
					let setting = args.get(at)?.to_ascii_lowercase();
					if let Some(value) = setting.strip_prefix("submodule.recurse") {
						recurse = Some(!matches!(value, "=false" | "=no" | "=off" | "=0"));
					}
					at += 1;
				},
				"--config-env" => {
					// Its value comes from the environment; assume it turns
					// recursion on.
					let setting = args.get(at)?.to_ascii_lowercase();
					if setting.starts_with("submodule.recurse=") {
						recurse = Some(true);
					}
					at += 1;
				},
				arg if arg
					.to_ascii_lowercase()
					.starts_with("--config-env=submodule.recurse=") =>
				{
					recurse = Some(true);
				},
				"--namespace" | "--super-prefix" | "--attr-source" => at += 1,
				arg if arg.starts_with("--git-dir=") || arg.starts_with("--work-tree=") => {
					redirected = true;
				},
				arg if arg.starts_with('-') => {},
				name => {
					return Some(Self {
						dirs,
						redirected,
						recurse,
						sub: Sub::parse(name)?,
						args: &args[at..],
					});
				},
			}
		}
		None
	}
}

/// One subcommand argument, read the way git's parse-options reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arg<'a> {
	/// `--name` or `--name=value`, by name; an abbreviation by the name it
	/// stands for.
	Long(&'a str),
	/// `--no-name`, by the name it negates.
	Negated(&'a str),
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
			let (spelled, inline) = long
				.split_once('=')
				.map_or((long, false), |(name, _)| (name, true));
			match super::long_option(sub.long_options(), spelled) {
				Some((name, true)) => scanned.push(Arg::Negated(name)),
				Some((name, false)) => {
					if !inline && long_valued.contains(&name) {
						args.next();
					}
					scanned.push(Arg::Long(name));
				},
				// Unknown or ambiguous: git refuses it on its own.
				None => scanned.push(Arg::Long(spelled)),
			}
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
enum Verdict {
	Allow,
	Stash(Stash),
	/// Discards the working tree or index wholesale; refused even mid-conflict.
	Destructive,
	/// `reset` to this revision without a pathspec: moves HEAD unless it names
	/// HEAD's commit. True for `--soft`, which discards no uncommitted change.
	ResetTo(String, bool),
	/// Rewrites working-tree files; allowed only mid-conflict.
	ConflictOnly,
	/// Switches branches or moves one; refused even mid-conflict.
	BranchMove,
	/// `checkout` with one operand and no pathspec: git switches to it when it
	/// names a commit and restores it as a path otherwise.
	CheckoutOne(String),
}

/// What a `stash` subcommand does to the working tree and the stash list.
#[derive(Debug, PartialEq, Eq)]
enum Stash {
	/// Moves uncommitted changes into the list (`push`, `save`, a bare
	/// `stash`), or adds a commit to it (`store`).
	Saves,
	/// `pop`, `apply`, `drop`, or `branch` of one entry: `stash@{0}` when
	/// `None`.
	Takes(&'static str, Option<String>),
	/// Drops every entry.
	Clear,
}

fn classify(sub: Sub, args: &[String]) -> Verdict {
	match sub {
		Sub::Stash => classify_stash(args),
		Sub::Reset => classify_reset(&scan(sub, args)),
		Sub::Checkout | Sub::Switch | Sub::Restore => classify_tree_write(sub, &scan(sub, args)),
	}
}

/// What `--[no-]recurse-submodules` says, the last one winning; `None` when
/// neither is given.
fn recurse_option(sub: Sub, args: &[String]) -> Option<bool> {
	scan(sub, args).iter().rev().find_map(|arg| match arg {
		Arg::Long("recurse-submodules") => Some(true),
		Arg::Negated("recurse-submodules") => Some(false),
		_ => None,
	})
}

/// `list`, `show`, and `create` touch neither the working tree nor the list.
fn classify_stash(args: &[String]) -> Verdict {
	// `branch <name> [<stash>]` names its entry second.
	let (op, entry_at) = match args.first().map(String::as_str) {
		Some("list" | "show" | "create") => return Verdict::Allow,
		Some("clear") => return Verdict::Stash(Stash::Clear),
		Some("pop") => ("pop", 0),
		Some("apply") => ("apply", 0),
		Some("drop") => ("drop", 0),
		Some("branch") => ("branch", 1),
		_ => return Verdict::Stash(Stash::Saves),
	};
	let entry = scan(Sub::Stash, &args[1..])
		.into_iter()
		.filter_map(|arg| match arg {
			Arg::Operand(operand) | Arg::Pathspec(operand) => Some(operand.to_owned()),
			Arg::Long(_) | Arg::Negated(_) | Arg::Short(_) => None,
		})
		.nth(entry_at);
	Verdict::Stash(Stash::Takes(op, entry))
}

/// `reset` moves HEAD only in its `reset [<mode>] <commit>` form: one revision
/// and no pathspec. With paths, a pathspec file, or `--patch` it rewrites index
/// entries only.
fn classify_reset(args: &[Arg<'_>]) -> Verdict {
	let flags = Flags::of(Sub::Reset, args);
	let mut operands = Vec::new();
	let mut pathspec = false;
	for arg in args {
		match *arg {
			Arg::Pathspec(_) => pathspec = true,
			Arg::Operand(operand) => operands.push(operand),
			Arg::Long(_) | Arg::Negated(_) | Arg::Short(_) => {},
		}
	}
	let index_only = pathspec || flags.any(&["patch", "pathspec-from-file"]);
	let mode = flags.last(&["hard", "soft", "mixed", "merge", "keep"]);
	match operands[..] {
		_ if mode == Some("hard") => Verdict::Destructive,
		[rev] if !index_only && !matches!(rev, "HEAD" | "@") => {
			// `--soft` discards no uncommitted change.
			Verdict::ResetTo(rev.to_owned(), mode == Some("soft"))
		},
		_ => Verdict::Allow,
	}
}

/// `checkout`, `switch`, and `restore` rewrite working-tree files or switch
/// branches — except `restore --staged` without `--worktree`, which only
/// unstages, and a bare `checkout`, which only reports.
fn classify_tree_write(sub: Sub, args: &[Arg<'_>]) -> Verdict {
	if sub == Sub::Checkout && args.is_empty() {
		return Verdict::Allow;
	}
	let flags = Flags::of(sub, args);
	let mut operands = Vec::new();
	let (mut new_branch, mut pathspec, mut whole_tree) = (false, false, false);
	for arg in args {
		match (sub, *arg) {
			(Sub::Checkout, Arg::Short('b' | 'B')) => new_branch = true,
			(Sub::Checkout, Arg::Operand(spec)) => {
				// `-` is the previous branch.
				new_branch |= spec == "-";
				whole_tree |= is_whole_tree(spec);
				operands.push(spec);
			},
			(Sub::Checkout | Sub::Restore, Arg::Pathspec(spec))
			| (Sub::Restore, Arg::Operand(spec)) => {
				whole_tree |= is_whole_tree(spec);
				pathspec = true;
			},
			_ => {},
		}
	}
	let forced = flags.on("force") || (sub == Sub::Switch && flags.on("discard-changes"));
	let branch = sub == Sub::Switch || new_branch || flags.any(&["orphan", "detach", "track"]);
	let paths = sub == Sub::Restore
		|| pathspec
		|| flags.any(&["ours", "theirs", "patch", "pathspec-from-file"]);
	if flags.on("staged") && !flags.on("worktree") {
		Verdict::Allow
	} else if forced || whole_tree {
		Verdict::Destructive
	} else if branch {
		Verdict::BranchMove
	} else if let [operand] = operands[..]
		&& !paths
	{
		Verdict::CheckoutOne(operand.to_owned())
	} else {
		Verdict::ConflictOnly
	}
}

/// A subcommand's flags as git reads them: of `--name`, `--no-name`, and the
/// short form, the last one given wins.
struct Flags<'a>(Vec<(&'a str, bool)>);

impl<'a> Flags<'a> {
	fn of(sub: Sub, args: &[Arg<'a>]) -> Self {
		Self(
			args
				.iter()
				.filter_map(|arg| match (sub, *arg) {
					(_, Arg::Long(name)) => Some((name, true)),
					(_, Arg::Negated(name)) => Some((name, false)),
					(Sub::Reset | Sub::Checkout | Sub::Restore, Arg::Short('p')) => {
						Some(("patch", true))
					},
					(Sub::Checkout | Sub::Switch, Arg::Short('f')) => Some(("force", true)),
					(Sub::Checkout, Arg::Short('2')) => Some(("ours", true)),
					(Sub::Checkout, Arg::Short('3')) => Some(("theirs", true)),
					(Sub::Checkout | Sub::Switch, Arg::Short('d')) => Some(("detach", true)),
					(Sub::Checkout | Sub::Switch, Arg::Short('t')) => Some(("track", true)),
					(Sub::Restore, Arg::Short('S')) => Some(("staged", true)),
					(Sub::Restore, Arg::Short('W')) => Some(("worktree", true)),
					_ => None,
				})
				.collect(),
		)
	}

	fn on(&self, name: &str) -> bool {
		self
			.0
			.iter()
			.rev()
			.find(|(flag, _)| *flag == name)
			.is_some_and(|&(_, on)| on)
	}

	fn any(&self, names: &[&str]) -> bool {
		names.iter().any(|name| self.on(name))
	}

	/// Which of `names`, mutually exclusive modes, was given last.
	fn last(&self, names: &[&str]) -> Option<&'a str> {
		self
			.0
			.iter()
			.rev()
			.find(|(flag, on)| *on && names.contains(flag))
			.map(|&(flag, _)| flag)
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
	BranchMove(Sub),
	OutsideConflict(Sub),
	Redirected(Sub),
	/// `stash <op>` of `entry`, whose `subject` names its saver when read, in
	/// a worktree on branch `here` (`None` when detached).
	ForeignStash {
		op:      &'static str,
		entry:   String,
		subject: Option<String>,
		here:    Option<String>,
	},
	/// The uncommitted changes `sub` would discard could not be saved.
	Unsaved(Sub, String),
	/// `sub` would also discard changes inside submodules, which the save
	/// does not hold.
	Recursive(Sub),
}

impl Refusal {
	fn message(&self) -> String {
		match self {
			Self::Stash => format!(
				"git stash is blocked by workspace policy — do not work around it.\nOther sessions \
				 may be using this checkout (it is not a worktree of its own): stash takes their \
				 uncommitted changes out of the working tree along with yours. git stash list, git \
				 stash show, and git stash create run here.\n{OWN_WORKTREE}\n"
			),
			Self::Destructive(sub) => format!(
				"git {} is blocked: this form (--hard / --force / --discard-changes, or a whole-tree \
				 pathspec like `.`, `:/`, `*`) discards the working tree/index wholesale, and other \
				 sessions may be using this checkout (it is not a worktree of its own) — being \
				 mid-conflict does not make it safe.\nResolve conflicts with targeted forms instead: \
				 git checkout/restore --ours|--theirs <path>. Unstage with git reset <path> or git \
				 restore --staged <path>.\n{OWN_WORKTREE}\n",
				sub.name()
			),
			Self::CommitMove => format!(
				"git reset to another commit is blocked: it moves the branch checked out here, and \
				 other sessions may be using this checkout (it is not a worktree of its \
				 own).\nUnstaging is allowed — drop the commit argument: git reset [-q] [--] <path> \
				 (or bare git reset to unstage everything), or git restore --staged \
				 <path>.\n{OWN_WORKTREE}\n"
			),
			Self::BranchMove(sub) => format!(
				"git {} to another branch or commit is blocked by workspace policy — do not work \
				 around it.\nOther sessions may be using this checkout (it is not a worktree of its \
				 own); switching branches moves HEAD and the working tree under them. A merge or \
				 rebase in progress does not make it safe. While resolving conflicts, git checkout -- \
				 <path> and git restore <path> still run; put -- before a path that shares its name \
				 with a branch. Inspect other revisions read-only with git show <rev>:<path> / git \
				 diff / git log.\n{OWN_WORKTREE}\n",
				sub.name()
			),
			Self::OutsideConflict(sub) => format!(
				"git {} is blocked by workspace policy — do not work around it.\nOther sessions may \
				 be using this checkout (it is not a worktree of its own); overwriting working-tree \
				 files discards uncommitted changes they may rely on. It is exempt only while a \
				 merge/rebase conflict is being resolved, and the repository is not in \
				 one.\nUnstaging is always allowed: git reset [<path>] / git restore --staged <path>. \
				 To undo working-tree edits here, edit forward; inspect history read-only with git \
				 diff/log/show.\n{OWN_WORKTREE}\n",
				sub.name()
			),
			Self::Redirected(sub) => format!(
				"git {} is blocked: the guard judges the checkout found from the working directory, \
				 and this command points git elsewhere (--git-dir / --work-tree / GIT_DIR / \
				 GIT_WORK_TREE / GIT_INDEX_FILE), so it cannot tell whose checkout it changes.\nRun \
				 it from inside the target checkout (cd or git -C) without overriding git's \
				 repository location.\n",
				sub.name()
			),
			Self::ForeignStash { op, entry, subject, here } => {
				let saver = match subject.as_deref().map(saved_on) {
					Some(Saver::Branch(branch)) => format!("was saved on {branch}"),
					Some(Saver::Detached) => "was saved on a detached HEAD".to_owned(),
					Some(Saver::Unknown) | None => "does not say which branch saved it".to_owned(),
				};
				let subject = subject
					.as_deref()
					.map_or_else(String::new, |subject| format!(" (\"{subject}\")"));
				let here = here.as_deref().map_or_else(
					|| "this worktree's HEAD is detached".to_owned(),
					|branch| format!("this worktree is on {branch}"),
				);
				let own = if *op == "clear" {
					"Drop your own entries one at a time: git stash drop stash@{n}."
				} else {
					"Name your own entry from git stash list (stash@{n}), or apply a commit by id: git \
					 stash apply <commit>."
				};
				format!(
					"git stash {op} is blocked: {entry}{subject} {saver}, and {here}. Every worktree \
					 of a repository shares one stash list, so the entry may be another session's \
					 work.\n{own}\n"
				)
			},
			Self::Unsaved(sub, error) => format!(
				"git {} is blocked: it would discard uncommitted changes, and saving them first \
				 failed: {}\nCommit them or save a patch first (git diff > <file>); a merge or rebase \
				 in progress ends with git merge --abort or git rebase --abort.\n",
				sub.name(),
				error.trim()
			),
			Self::Recursive(sub) => format!(
				"git {} is blocked: it recurses into submodules (--recurse-submodules or \
				 submodule.recurse), and uncommitted changes it discards there cannot be saved \
				 first.\nRun it without recursing (--no-recurse-submodules), or commit or save a \
				 patch of each submodule's changes first (git -C <submodule> diff > <file>).\n",
				sub.name()
			),
		}
	}
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::path::Path;

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
			("-c core.pager=cat --no-pager stash", "Stash(Saves)"),
			("--git-dir .git status", "unguarded"),
			("stash list", "Allow"),
			("stash show -p", "Allow"),
			("stash create", "Allow"),
			("stash -p", "Stash(Saves)"),
			("stash store -m saved 1234abc", "Stash(Saves)"),
			("stash pop", "Stash(Takes(\"pop\", None))"),
			("stash apply -q --index stash@{2}", "Stash(Takes(\"apply\", Some(\"stash@{2}\")))"),
			("stash branch topic 1", "Stash(Takes(\"branch\", Some(\"1\")))"),
			("stash clear", "Stash(Clear)"),
			// Bare and path-scoped resets only rewrite the index.
			("reset", "Allow"),
			("reset -q HEAD", "Allow"),
			("reset main tracked.txt", "Allow"),
			("reset -- main", "Allow"),
			("reset -p main", "Allow"),
			("reset --pathspec-from-file list main", "Allow"),
			("reset --soft main", "ResetTo(\"main\", true)"),
			("reset --keep main", "ResetTo(\"main\", false)"),
			("reset --merge main", "ResetTo(\"main\", false)"),
			("reset --soft --mixed main", "ResetTo(\"main\", false)"),
			("reset main --", "ResetTo(\"main\", false)"),
			("reset --end-of-options -weird", "ResetTo(\"-weird\", false)"),
			("reset -q --hard", "Destructive"),
			// Long options are read by unique abbreviation, as git reads them.
			("reset --ha", "Destructive"),
			// Of the modes, the last one wins.
			("reset --ha --mixed HEAD", "Allow"),
			("reset --soft --hard main", "Destructive"),
			("reset --so main", "ResetTo(\"main\", true)"),
			// Of `--x` and `--no-x`, the last one wins.
			("reset --patc --no-patc HEAD~1", "ResetTo(\"HEAD~1\", false)"),
			("reset -p --no-patch main", "ResetTo(\"main\", false)"),
			("checkout", "Allow"),
			// One operand is a branch or a path; the repository decides.
			("checkout main", "CheckoutOne(\"main\")"),
			("checkout main tracked.txt", "ConflictOnly"),
			("checkout --theirs tracked.txt", "ConflictOnly"),
			("checkout -2 tracked.txt", "ConflictOnly"),
			("checkout -3 tracked.txt", "ConflictOnly"),
			("checkout -qf main", "Destructive"),
			// `-b` takes the rest of its bundle as the branch name.
			("checkout -bf topic", "BranchMove"),
			("checkout -q -B topic HEAD~1", "BranchMove"),
			("checkout -", "BranchMove"),
			("checkout -qd", "BranchMove"),
			("checkout --det", "BranchMove"),
			// `--orphan`'s value is a branch name, abbreviated or not.
			("checkout --orph topic", "BranchMove"),
			("checkout --no-track tracked.txt", "CheckoutOne(\"tracked.txt\")"),
			("checkout --theirs .", "Destructive"),
			("checkout -- :/", "Destructive"),
			("checkout HEAD -- ../..", "Destructive"),
			("switch -c topic", "BranchMove"),
			("switch --discard-changes main", "Destructive"),
			("restore tracked.txt", "ConflictOnly"),
			("restore --staged .", "Allow"),
			("restore --stag tracked.txt", "Allow"),
			("restore --staged --no-staged tracked.txt", "ConflictOnly"),
			("checkout -d --no-detach tracked.txt", "CheckoutOne(\"tracked.txt\")"),
			("checkout -p --no-patch main", "CheckoutOne(\"main\")"),
			("switch -f --no-force main", "BranchMove"),
			("restore -SW tracked.txt", "ConflictOnly"),
			("restore --staged --worktree *", "Destructive"),
			// `--source`'s value is a tree, not a pathspec.
			("restore --source . tracked.txt", "ConflictOnly"),
		] {
			assert_eq!(judged(line), expected, "git {line}");
		}
	}

	#[test]
	fn reads_which_branch_saved_a_stash_entry() {
		for (subject, expected) in [
			("WIP on main: 1234abc first commit", Saver::Branch("main")),
			("On will/topic: notes: second try", Saver::Branch("will/topic")),
			("WIP on (no branch): 1234abc first commit", Saver::Detached),
			("index on main: 1234abc first commit", Saver::Unknown),
			("custom message", Saver::Unknown),
		] {
			assert_eq!(saved_on(subject), expected, "{subject}");
		}
		for (entry, expected) in [
			(None, Some(0)),
			(Some("3"), Some(3)),
			(Some("stash@{1}"), Some(1)),
			(Some("refs/stash@{2}"), Some(2)),
			(Some("stash"), Some(0)),
		] {
			assert!(
				matches!(StashTarget::of(entry), StashTarget::Entry(at) if Some(at) == expected),
				"{entry:?}"
			);
		}
		for entry in ["stash@{yesterday}", "stash~1", "stash^2", "refs/stash:tracked.txt"] {
			assert!(matches!(StashTarget::of(Some(entry)), StashTarget::Unindexed), "{entry}");
		}
		for entry in ["1234abc", "stash-backup", "refs/stash-backup"] {
			assert!(matches!(StashTarget::of(Some(entry)), StashTarget::Commit), "{entry}");
		}
	}

	#[test]
	fn reads_whether_git_recurses_into_submodules() {
		for (line, expected) in [
			("reset --hard", None),
			("reset --hard --recurse-submodules", Some(true)),
			("checkout --recurse-submodules --no-recurse-submodules main", Some(false)),
			("-c submodule.recurse=true reset --hard", Some(true)),
			("-c submodule.recurse reset --hard", Some(true)),
			("-c submodule.recurse=true reset --hard --no-recurse", Some(false)),
			("-c Submodule.Recurse=off restore tracked.txt", Some(false)),
			("--config-env submodule.recurse=RECURSE reset --hard", Some(true)),
			("--config-env=submodule.recurse=RECURSE reset --hard", Some(true)),
		] {
			let args: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
			let invocation = Invocation::parse(&args).expect("guarded");
			let recurse = recurse_option(invocation.sub, invocation.args).or(invocation.recurse);
			assert_eq!(recurse, expected, "git {line}");
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

		// `create` only writes the stash commit and prints its id.
		let (code, output) = guarded(&repo, "git stash create").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(output.trim().len(), 40, "{output}");
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
	/// forms run, while whole-tree, redirected, and branch-switching ones still
	/// do not.
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

		for command in ["git checkout tracked.txt", "git restore tracked.txt"] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains("not in one"), "{command}: {output}");
		}
		let (code, output) = guarded(&repo, "git switch -q side").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("to another branch or commit is blocked"), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "uncommitted\n");

		git(&repo, &["checkout", "-q", "--", "tracked.txt"]);
		let (code, output) = guarded(&repo, "git merge -q side").await;
		assert_eq!(code, Some(1), "the merge conflicts: {output}");

		let (code, output) = guarded(&repo, "git checkout --theirs .").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		let (code, output) = guarded(&repo, "git --git-dir=.git checkout --theirs tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("points git elsewhere"), "{output}");

		// A branch only a remote has is checked out as a new local branch.
		git(&repo, &["remote", "add", "origin", "../nowhere"]);
		git(&repo, &["update-ref", "refs/remotes/origin/remoteonly", "HEAD"]);
		let head = git(&repo, &["rev-parse", "HEAD"]);
		for command in [
			"git checkout -q side",
			"git checkout -q -B main HEAD~1",
			"git switch -q side",
			"git checkout -q remoteonly",
			"git checkout -q -d",
			"git checkout -q --det",
		] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains("to another branch or commit is blocked"), "{command}: {output}");
		}
		assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
		assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main\n");
		assert!(repo.join(".git/MERGE_HEAD").exists());

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

		// Git switches for a merge base (even beside a file of that name), a
		// branch any fetch refspec maps, and a patch flag taken back; a file
		// sharing a remote branch's name is still a path.
		let fetch = "+refs/heads/*:refs/custom/origin/*";
		git(&repo, &["config", "--add", "remote.origin.fetch", fetch]);
		git(&repo, &["update-ref", "refs/custom/origin/custom", "HEAD"]);
		std::fs::write(repo.join("main...side"), "a file\n").expect("write main...side");
		for command in [
			"git checkout -q main...side",
			"git checkout -q main...",
			"git checkout -q custom",
			"git checkout -q -p --no-patch side",
		] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains("to another branch or commit is blocked"), "{command}: {output}");
		}
		assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
		assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main\n");
		assert!(repo.join(".git/MERGE_HEAD").exists());
		git(&repo, &["update-ref", "refs/remotes/origin/tracked.txt", "HEAD"]);
		std::fs::write(repo.join("tracked.txt"), "scratch\n").expect("edit");
		let (code, output) = guarded(&repo, "git checkout --no-guess tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "theirs\n");
	}

	/// git keeps `REBASE_HEAD` after a rebase that stopped on a conflict
	/// finishes; the rebase is over, so working-tree rewrites are refused again.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_finished_rebase_is_not_a_conflict() {
		let (_temp, repo) = fixture();
		git(&repo, &["checkout", "-qb", "side"]);
		std::fs::write(repo.join("tracked.txt"), "side\n").expect("edit side");
		git(&repo, &["commit", "-qam", "side"]);
		git(&repo, &["checkout", "-q", "main"]);
		std::fs::write(repo.join("tracked.txt"), "main\n").expect("edit main");
		git(&repo, &["commit", "-qam", "main"]);
		git(&repo, &["checkout", "-q", "side"]);
		let (code, output) = run_with(&repo, "git rebase -q main", &[]).await;
		assert_eq!(code, Some(1), "the rebase conflicts: {output}");
		std::fs::write(repo.join("tracked.txt"), "resolved\n").expect("resolve");
		git(&repo, &["add", "tracked.txt"]);
		let (code, output) = run_with(&repo, "GIT_EDITOR=true git rebase --continue", &[]).await;
		assert_eq!(code, Some(0), "{output}");
		assert!(repo.join(".git/REBASE_HEAD").exists());

		std::fs::write(repo.join("tracked.txt"), "uncommitted\n").expect("edit");
		let (code, output) = guarded(&repo, "git checkout tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("not in one"), "{output}");
		assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).expect("read"), "uncommitted\n");
	}

	#[cfg(unix)]
	fn read(checkout: &Path) -> String {
		std::fs::read_to_string(checkout.join("tracked.txt")).expect("read tracked")
	}

	/// A linked worktree is one agent's: forms that discard changes run once
	/// the guard has saved them, and the save brings them back, staged changes
	/// staged. The main checkout and a clone stay guarded, whatever directory a
	/// command meant to leave the main checkout for.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn own_checkouts_run_after_saving_what_they_discard() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let (worktree, clone) = (parent.join("wt"), parent.join("clone"));
		git(&repo, &["worktree", "add", "-q", "-b", "topic", &worktree.to_string_lossy()]);
		std::fs::write(worktree.join("topic.txt"), "topic\n").expect("write topic");
		git(&worktree, &["add", "topic.txt"]);
		git(&worktree, &["commit", "-qm", "topic"]);
		git(&parent, &["clone", "-q", "--shared", &repo.to_string_lossy(), "clone"]);

		std::fs::write(worktree.join("tracked.txt"), "mine\n").expect("edit");
		let (code, output) = guarded(&worktree, "git checkout tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(output.contains("saved your uncommitted changes as"), "{output}");
		assert_eq!(read(&worktree), "tracked\n");
		let saved = git(&worktree, &["rev-parse", DISCARDED_REF]);
		let command = format!("git stash apply -q {}", saved.trim());
		let (code, output) = guarded(&worktree, &command).await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(read(&worktree), "mine\n");

		// A staged change the working tree no longer shows.
		git(&worktree, &["add", "tracked.txt"]);
		std::fs::write(worktree.join("tracked.txt"), "tracked\n").expect("edit again");
		let (code, output) = guarded(&worktree, "git reset -q --hard").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(output.contains("git stash apply --index"), "{output}");
		assert_eq!(git(&worktree, &["status", "--porcelain"]), "");
		let saved = git(&worktree, &["rev-parse", DISCARDED_REF]);
		let command = format!("git stash apply -q --index {}", saved.trim());
		let (code, output) = guarded(&worktree, &command).await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(
			(git(&worktree, &["show", ":tracked.txt"]), read(&worktree)),
			("mine\n".to_owned(), "tracked\n".to_owned())
		);

		// `reset --merge` to another commit overwrites staged changes too.
		git(&worktree, &["reset", "-q", "--hard"]);
		std::fs::write(worktree.join("tracked.txt"), "second\n").expect("edit");
		git(&worktree, &["commit", "-qam", "second"]);
		std::fs::write(worktree.join("tracked.txt"), "staged\n").expect("edit");
		git(&worktree, &["add", "tracked.txt"]);
		let (code, output) = guarded(&worktree, "git reset -q --merge HEAD~1").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(output.contains("saved your uncommitted changes as"), "{output}");
		assert_eq!(read(&worktree), "tracked\n");
		assert_eq!(git(&worktree, &["show", &format!("{DISCARDED_REF}:tracked.txt")]), "staged\n");

		// Nothing uncommitted, nothing saved.
		let (code, output) = guarded(&worktree, "git restore tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(!output.contains("saved"), "{output}");
		assert_eq!(
			git(&worktree, &["reflog", "--format=%gs", DISCARDED_REF]),
			concat!(
				"before git reset -q --merge HEAD~1\n",
				"before git reset -q --hard\n",
				"before git checkout tracked.txt\n"
			)
		);

		// An empty `cd` target leaves the shell in the main checkout.
		let head = git(&repo, &["rev-parse", "HEAD"]);
		std::fs::write(repo.join("tracked.txt"), "theirs\n").expect("edit main");
		std::fs::write(clone.join("tracked.txt"), "theirs\n").expect("edit clone");
		for (checkout, command) in [
			(&repo, "cd \"$EMPTY\"; git reset -q --keep topic"),
			(&repo, "git checkout tracked.txt"),
			(&clone, "git checkout tracked.txt"),
		] {
			let (code, output) = guarded(checkout, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains("git worktree add"), "{command}: {output}");
		}
		assert_eq!((git(&repo, &["rev-parse", "HEAD"]), read(&repo)), (head, "theirs\n".to_owned()));
		assert_eq!(read(&clone), "theirs\n");

		let (code, output) =
			guarded(&worktree, "git reset -q --keep main && git switch -q -c side").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), git(&repo, &["rev-parse", "main"]));
	}

	/// A submodule is as shared as the checkout it lives in, and a command
	/// that recurses into submodules cannot save what it discards there.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_submodule_follows_its_superproject() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let (library, worktree) = (parent.join("library"), parent.join("wt"));
		git(&parent, &["clone", "-q", &repo.to_string_lossy(), "library"]);
		let file = ["-c", "protocol.file.allow=always"];
		git(
			&repo,
			&[&file[..], &["submodule", "add", "-q", &library.to_string_lossy(), "lib"]].concat(),
		);
		git(&repo, &["commit", "-qm", "lib"]);
		git(&repo, &["worktree", "add", "-q", "-b", "topic", &worktree.to_string_lossy()]);
		git(&worktree, &[&file[..], &["submodule", "update", "-q", "--init"]].concat());

		for (checkout, expected) in [(repo.join("lib"), REFUSED_EXIT), (worktree.join("lib"), 0)] {
			git(&checkout, &["config", "user.name", "t"]);
			git(&checkout, &["config", "user.email", "t@t"]);
			std::fs::write(checkout.join("tracked.txt"), "mine\n").expect("edit");
			let (code, output) = guarded(&checkout, "git checkout tracked.txt").await;
			assert_eq!(code, Some(i32::from(expected)), "{}: {output}", checkout.display());
		}
		assert_eq!(
			(read(&repo.join("lib")), read(&worktree.join("lib"))),
			("mine\n".to_owned(), "tracked\n".to_owned())
		);

		std::fs::write(worktree.join("lib/tracked.txt"), "mine\n").expect("edit lib");
		std::fs::write(worktree.join("tracked.txt"), "top\n").expect("edit top");
		let (code, output) = guarded(&worktree, "git reset -q --hard --recurse-submodules").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("recurses into submodules"), "{output}");
		// The submodule's git directory still counts once `.gitmodules` is gone.
		std::fs::remove_file(worktree.join(".gitmodules")).expect("remove .gitmodules");
		let (code, output) = guarded(&worktree, "git reset -q --hard --recurse-submodules").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		git(&worktree, &["checkout", "-q", "--", ".gitmodules"]);
		let config = "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=submodule.recurse \
		              GIT_CONFIG_VALUE_0=true; git reset -q --hard";
		let (code, output) = guarded(&worktree, config).await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		git(&repo, &["config", "submodule.recurse", "true"]);
		let (code, output) = guarded(&worktree, "git reset -q --hard").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(
			(read(&worktree), read(&worktree.join("lib"))),
			("top\n".to_owned(), "mine\n".to_owned())
		);

		let (code, output) = guarded(&worktree, "git reset -q --hard --no-recurse-submodules").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(
			(read(&worktree), read(&worktree.join("lib"))),
			("tracked\n".to_owned(), "mine\n".to_owned())
		);
	}

	/// Every worktree of a bare repository is linked, and one of them is where
	/// a person works: none counts as one agent's.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn worktrees_of_a_bare_repository_stay_guarded() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let (bare, worktree) = (parent.join("bare.git"), parent.join("main"));
		git(&parent, &["clone", "-q", "--bare", &repo.to_string_lossy(), "bare.git"]);
		git(&bare, &["worktree", "add", "-q", &worktree.to_string_lossy(), "main"]);
		std::fs::write(worktree.join("tracked.txt"), "mine\n").expect("edit");
		let (code, output) = guarded(&worktree, "git checkout tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("git worktree add"), "{output}");
		assert_eq!(read(&worktree), "mine\n");
	}

	/// Mid-merge a path restore runs without a save only when git cannot
	/// write one; a save it wrote but could not keep refuses the command.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_save_that_cannot_be_kept_refuses_even_mid_merge() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let worktree = parent.join("wt");
		git(&repo, &["checkout", "-qb", "side"]);
		std::fs::write(repo.join("side.txt"), "side\n").expect("write side");
		git(&repo, &["add", "side.txt"]);
		git(&repo, &["commit", "-qm", "side"]);
		git(&repo, &["checkout", "-q", "main"]);
		git(&repo, &["worktree", "add", "-q", "-b", "topic", &worktree.to_string_lossy()]);
		git(&worktree, &["merge", "-q", "--no-commit", "--no-ff", "side"]);
		std::fs::write(worktree.join("tracked.txt"), "mine\n").expect("edit");
		let lock = repo.join(".git/refs/omp/discarded.lock");
		std::fs::create_dir_all(lock.parent().expect("refs/omp")).expect("refs/omp");
		std::fs::write(&lock, "").expect("stale lock");

		let (code, output) = guarded(&worktree, "git restore tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("saving them first failed"), "{output}");
		assert_eq!(read(&worktree), "mine\n");
	}

	/// Every worktree shares one stash list: a worktree takes back only the
	/// entries saved on its own branch, and one with a detached HEAD none; a
	/// commit named by id is the caller's choice.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn worktrees_take_back_only_their_own_stash_entries() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let (a, b, detached) = (parent.join("a"), parent.join("b"), parent.join("d"));
		for (branch, worktree) in [("a", &a), ("b", &b)] {
			git(&repo, &["worktree", "add", "-q", "-b", branch, &worktree.to_string_lossy()]);
		}
		git(&repo, &["worktree", "add", "-q", "--detach", &detached.to_string_lossy()]);

		std::fs::write(a.join("tracked.txt"), "a\n").expect("edit a");
		let (code, output) = guarded(&a, "git stash -q").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(read(&a), "tracked\n");

		// A push that saves nothing leaves another worktree's entry on top.
		let (code, output) = guarded(&b, "git stash -q; git stash pop -q").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("stash@{0}"), "{output}");
		assert!(output.contains("was saved on a, and this worktree is on b"), "{output}");
		assert_eq!(read(&b), "tracked\n");
		let entry = git(&repo, &["rev-parse", "stash@{0}"]);
		let (code, output) = guarded(&b, &format!("git stash apply -q {}", entry.trim())).await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(read(&b), "a\n");

		std::fs::write(detached.join("tracked.txt"), "d\n").expect("edit d");
		let (code, output) = guarded(&detached, "git stash -q && git stash pop -q").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("HEAD is detached"), "{output}");

		let (code, output) = guarded(&a, "git stash clear").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		let (code, output) = guarded(&a, "git stash pop -q stash@{1}").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(read(&a), "a\n");
		assert_eq!(
			git(&repo, &["stash", "list", "--format=%s"])
				.lines()
				.count(),
			1
		);
	}
}
