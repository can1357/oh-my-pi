//! Shared-checkout guard layered into the `git` builtin.
//!
//! Opt-in: active only when `PI_GIT_GUARD` is truthy in the session or process
//! environment (the coding agent sets it from its `bash.gitGuard` setting).
//! `PI_GIT_GUARD_OVNFS` supplies the ovnfs command for separate-checkout hints.
//!
//! Agents sharing one checkout lose work when one of them runs a git command
//! that discards uncommitted changes or moves HEAD. The guard judges every
//! `git` the shell dispatches — after expansion, in the directory it actually
//! runs in — by whose checkout that is.
//!
//! An ovnfs checkout (marked by repository-local `ovnfs.checkout`), a linked
//! worktree (`git worktree add`) of a repository with a main checkout, and a
//! submodule inside either belong to one line of work. There every command
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
//!   whole tree (`.`, `:/`, `*`);
//! - `rebase`, `merge`, `pull`, `cherry-pick`, and `revert` (except
//!   `--continue`, `--abort`, `--skip`, `--quit`, and `rebase --edit-todo`
//!   while that operation is already underway, or `rebase
//!   --show-current-patch`);
//! - `commit --amend` (except dry-run forms);
//! - `clean` (except `-n` / `--dry-run`).
//!
//! Index-only commands always run: `reset [<path>…]` and `restore --staged`
//! only unstage. Git started by path (`/usr/bin/git`) or by another program
//! (`xargs git`, `sh -c`) never reaches the builtin and is not judged.

use std::{
	borrow::Cow,
	path::{Path, PathBuf},
};

use omp_vcs::git::GitRepo;

use super::is_git_repo_location_var;

/// Exit status of a refused command; git's own for a refused operation.
pub const REFUSED_EXIT: u8 = 1;

/// Ref whose reflog records uncommitted changes before a command in a
/// one-agent checkout discards them. Git expires entries other than the
/// latest with every reflog (`gc.reflogExpireUnreachable`, 30 days).
const DISCARDED_REF: &str = "refs/omp/discarded";

/// Where to take a command the guard refuses in a shared checkout.
const OWN_WORKTREE: &str = "In a worktree of your own (git worktree add <path> [<branch>]) it \
                            runs, and uncommitted changes it would discard are saved first.";

fn own_checkout_hint(ovnfs: Option<&str>) -> Cow<'static, str> {
	match ovnfs.map(str::trim).filter(|command| !command.is_empty()) {
		Some(command) => {
			// The hint is pasted into shell commands: the command is always
			// single-quoted, so no character of a path can split or expand it.
			let command = format!("'{}'", command.replace('\'', r"'\''"));
			Cow::Owned(format!(
				"In an ovnfs checkout of your own ({command} new --name <name>) it runs, and \
				 uncommitted changes it would discard are saved first. Add --rev <rev> to start at a \
				 clean commit or branch. Commit its work there; {command} land <name> brings the \
				 commits onto the branch checked out here, files included (--rebase when that branch \
				 moved), or {command} apply <name> brings all its changes as uncommitted edits. Use \
				 {command} run --rev HEAD -- <command> for a clean-commit check without touching this \
				 checkout; --take SRC:PATH mixes in paths from the folder (.), the index (empty SRC), \
				 or another revision."
			))
		},
		None => Cow::Borrowed(OWN_WORKTREE),
	}
}

/// A judged `git` invocation, detached from the shell so its repository reads
/// can run off the shell's thread.
pub struct Review(Judgment);

/// What the builtin does with a judged command.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
	/// Run git.
	Run,
	/// Print this note to stderr, then run git.
	RunNoted(String),
	/// Print this message instead of running git.
	Refuse(String),
}

impl Review {
	/// Judges `args` (git's arguments, without `git`) as git would run them
	/// in `cwd` with the exported variables named by `exported`.
	pub fn of<'a>(
		cwd: &Path,
		exported: impl Iterator<Item = &'a str> + Clone,
		args: &[String],
	) -> Self {
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
				.fold(cwd.to_owned(), |dir, next| dir.join(next)),
			// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … retarget git as
			// `--git-dir` does.
			redirected: invocation.redirected || exported.clone().any(is_git_repo_location_var),
			// Configuration passed through the environment (`GIT_CONFIG_COUNT`)
			// may turn on `submodule.recurse`.
			recurse:    recurse_option(invocation.sub, invocation.args)
				.or(invocation.recurse)
				.or_else(|| {
					exported
						.clone()
						.any(|name| name == "GIT_CONFIG_COUNT")
						.then_some(true)
				}),
			command:    args.join(" "),
		}))
	}

	/// Whether git runs, reading and saving repository state as the verdict
	/// needs. `ovnfs` selects the separate-checkout hint. Blocks on repository
	/// I/O: run it off the shell's thread.
	pub fn decide(self, ovnfs: Option<&str>) -> Decision {
		let Judgment::Check(sub, verdict, site) = self.0 else {
			return Decision::Run;
		};
		match Place::of(&site) {
			Place::Private(repo) => in_private(&repo, sub, verdict, &site),
			place => in_shared(&place, sub, verdict, &site.dir)
				.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message(ovnfs))),
		}
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

/// Whether `repo`'s checkout belongs to one line of work: an ovnfs checkout, a
/// worktree linked to a repository that has a main checkout of its own, or a
/// submodule inside either. Other checkouts may be shared, including every
/// worktree of a bare repository, where one of them is where a person works.
fn is_private(repo: &GitRepo) -> bool {
	if repo.config_has_local("ovnfs.checkout").unwrap_or(false) {
		return true;
	}
	let info = repo.info();
	if repo.is_linked_worktree() {
		return matches!(repo.is_common_repo_bare(), Ok(false));
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
		Verdict::HistoryRewrite => Some(Refusal::HistoryRewrite(sub)),
		Verdict::InProgressOnly => {
			if repo.is_some_and(|repo| matches_in_progress(repo, sub)) {
				None
			} else {
				Some(Refusal::HistoryRewrite(sub))
			}
		},
		Verdict::CommitAmend => Some(Refusal::CommitAmend),
		Verdict::Clean => Some(Refusal::Clean),
	}
}

/// Whether `verdict` runs in a checkout of one line of work: it does, after
/// uncommitted changes it would discard are saved, unless it takes another
/// branch's stash entry or the save fails.
fn in_private(repo: &GitRepo, sub: Sub, verdict: Verdict, site: &Site) -> Decision {
	match verdict {
		Verdict::Allow
		| Verdict::Stash(Stash::Saves)
		| Verdict::BranchMove
		| Verdict::HistoryRewrite
		| Verdict::InProgressOnly
		| Verdict::CommitAmend
		| Verdict::Clean => Decision::Run,
		Verdict::Stash(Stash::Takes(op, entry)) => foreign_stash(repo, op, entry.as_deref())
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message(None))),
		Verdict::Stash(Stash::Clear) => foreign_stash(repo, "clear", None)
			.map_or(Decision::Run, |refusal| Decision::Refuse(refusal.message(None))),
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

/// Whether `repo` currently has an in-progress operation matching `sub`.
fn matches_in_progress(repo: &GitRepo, sub: Sub) -> bool {
	match repo.operation_kind() {
		Ok(Some("rebase")) => sub == Sub::Rebase,
		Ok(Some("merge")) => sub == Sub::Merge,
		Ok(Some("cherry-pick")) => sub == Sub::CherryPick,
		Ok(Some("revert")) => sub == Sub::Revert,
		Ok(Some("sequencer")) => matches!(sub, Sub::CherryPick | Sub::Revert),
		_ => false,
	}
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
		return Decision::Refuse(Refusal::Recursive(sub).message(None));
	}
	let id = match repo.stash_create() {
		Ok(None) => return Decision::Run,
		Ok(Some(id)) => id,
		Err(_) if targeted && repo.operation_in_progress().unwrap_or(false) => {
			return Decision::Run;
		},
		Err(err) => return Decision::Refuse(Refusal::Unsaved(sub, err.to_string()).message(None)),
	};
	// Once the changes are written, a failure to keep them is never exempt.
	if let Err(err) = repo.record_ref(DISCARDED_REF, &id, &format!("before git {}", site.command)) {
		return Decision::Refuse(Refusal::Unsaved(sub, err.to_string()).message(None));
	}
	let short = repo
		.short_id(&id)
		.map_or_else(|_| unambiguous_short_id(&id, &id), |s| unambiguous_short_id(&s, &id));
	Decision::RunNoted(format!(
		"git {}: saved your uncommitted changes as {short} on {DISCARDED_REF} first; git stash \
		 apply --index {short} brings them back.\n",
		sub.name()
	))
}

/// Extends an all-digit `short` hash past its first hex letter from `full` (or
/// appends `^0`) so `git stash apply` does not parse it as `stash@{n}`.
fn unambiguous_short_id(short: &str, full: &str) -> String {
	if !short.bytes().all(|b| b.is_ascii_digit()) {
		return short.to_owned();
	}
	if let Some(pos) = full.bytes().position(|b| !b.is_ascii_digit()) {
		return full[..(pos + 1).max(short.len())].to_owned();
	}
	format!("{full}^0")
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
fn is_magic_pathspec(operand: &str) -> bool {
	operand.starts_with(":(")
		|| operand
			.strip_prefix(':')
			.is_some_and(|rest| rest.starts_with(['/', '!', '^']))
}

fn names_path(repo: &GitRepo, dir: &Path, operand: &str) -> bool {
	!operand.contains("...")
		&& matches!(repo.resolve_ref(operand), Ok(None))
		&& (is_magic_pathspec(operand)
			|| operand.contains(['*', '?', '[', '\\'])
			|| dir.join(operand).symlink_metadata().is_ok())
}

/// A git subcommand the guard judges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sub {
	Stash,
	Reset,
	Checkout,
	Switch,
	Restore,
	Rebase,
	Merge,
	Pull,
	CherryPick,
	Revert,
	Commit,
	Clean,
}

impl Sub {
	fn parse(name: &str) -> Option<Self> {
		Some(match name {
			"stash" => Self::Stash,
			"reset" => Self::Reset,
			"checkout" => Self::Checkout,
			"switch" => Self::Switch,
			"restore" => Self::Restore,
			"rebase" => Self::Rebase,
			"merge" => Self::Merge,
			"pull" => Self::Pull,
			"cherry-pick" => Self::CherryPick,
			"revert" => Self::Revert,
			"commit" => Self::Commit,
			"clean" => Self::Clean,
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
			Self::Rebase => "rebase",
			Self::Merge => "merge",
			Self::Pull => "pull",
			Self::CherryPick => "cherry-pick",
			Self::Revert => "revert",
			Self::Commit => "commit",
			Self::Clean => "clean",
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
			Self::Rebase => (&['C', 's', 'X', 'x'], &[
				"onto",
				"trailer",
				"whitespace",
				"empty",
				"exec",
				"strategy",
				"strategy-option",
			]),
			Self::Merge => (&['s', 'X', 'm', 'F'], &[
				"cleanup",
				"strategy",
				"strategy-option",
				"message",
				"file",
				"into-name",
			]),
			Self::Pull => (&['s', 'X', 'o'], &[
				"cleanup",
				"strategy",
				"strategy-option",
				"upload-pack",
				"depth",
				"shallow-since",
				"shallow-exclude",
				"deepen",
				"refmap",
				"server-option",
				"negotiation-tip",
			]),
			Self::CherryPick => {
				(&['m', 'X'], &["cleanup", "mainline", "strategy", "strategy-option", "empty"])
			},
			Self::Revert => (&['m', 'X'], &["cleanup", "mainline", "strategy", "strategy-option"]),
			Self::Commit => (&['F', 'm', 'c', 'C', 't', 'U'], &[
				"file",
				"author",
				"date",
				"message",
				"reedit-message",
				"reuse-message",
				"fixup",
				"squash",
				"trailer",
				"template",
				"cleanup",
				"unified",
				"inter-hunk-context",
				"pathspec-from-file",
			]),
			Self::Clean => (&['e'], &["exclude"]),
		}
	}

	/// Short options that accept an optional attached value (e.g. `-S<key>`):
	/// never consumes the next argument, but stops scanning the bundle so
	/// characters of the attached value are not read as flags.
	const fn short_optional_valued(self) -> &'static [char] {
		match self {
			Self::Rebase => &['S', 'r'],
			Self::Merge | Self::CherryPick | Self::Revert => &['S'],
			Self::Pull => &['r', 'S', 'j'],
			Self::Commit => &['S', 'u'],
			Self::Stash
			| Self::Reset
			| Self::Checkout
			| Self::Switch
			| Self::Restore
			| Self::Clean => &[],
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
				"help",
				"help-all",
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
				"help",
				"help-all",
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
				"help",
				"help-all",
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
				"help",
				"help-all",
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
			Self::Rebase => &[
				"abort",
				"apply",
				"autosquash",
				"autostash",
				"committer-date-is-author-date",
				"continue",
				"edit-todo",
				"empty",
				"exec",
				"ff",
				"force-rebase",
				"fork-point",
				"gpg-sign",
				"help",
				"help-all",
				"ignore-whitespace",
				"interactive",
				"keep-base",
				"merge",
				"onto",
				"quiet",
				"quit",
				"reapply-cherry-picks",
				"rebase-merges",
				"rerere-autoupdate",
				"reschedule-failed-exec",
				"reset-author-date",
				"root",
				"show-current-patch",
				"signoff",
				"skip",
				"stat",
				"strategy",
				"strategy-option",
				"trailer",
				"update-refs",
				"verbose",
				"verify",
				"whitespace",
			],
			Self::Merge => &[
				"abort",
				"allow-unrelated-histories",
				"autostash",
				"cleanup",
				"commit",
				"compact-summary",
				"continue",
				"edit",
				"ff",
				"ff-only",
				"file",
				"gpg-sign",
				"help",
				"help-all",
				"into-name",
				"log",
				"message",
				"overwrite-ignore",
				"progress",
				"quiet",
				"quit",
				"rerere-autoupdate",
				"signoff",
				"squash",
				"stat",
				"strategy",
				"strategy-option",
				"summary",
				"verbose",
				"verify",
				"verify-signatures",
			],
			Self::Pull => &[
				"all",
				"allow-unrelated-histories",
				"append",
				"autostash",
				"cleanup",
				"commit",
				"compact-summary",
				"deepen",
				"depth",
				"dry-run",
				"edit",
				"ff",
				"ff-only",
				"force",
				"gpg-sign",
				"help",
				"help-all",
				"ipv4",
				"ipv6",
				"jobs",
				"keep",
				"log",
				"negotiation-tip",
				"progress",
				"prune",
				"quiet",
				"rebase",
				"recurse-submodules",
				"refmap",
				"server-option",
				"set-upstream",
				"shallow-exclude",
				"shallow-since",
				"show-forced-updates",
				"signoff",
				"squash",
				"stat",
				"strategy",
				"strategy-option",
				"tags",
				"unshallow",
				"update-shallow",
				"upload-pack",
				"verbose",
				"verify",
				"verify-signatures",
			],
			Self::CherryPick => &[
				"abort",
				"allow-empty",
				"allow-empty-message",
				"cleanup",
				"commit",
				"continue",
				"edit",
				"empty",
				"ff",
				"gpg-sign",
				"help",
				"help-all",
				"keep-redundant-commits",
				"mainline",
				"quit",
				"rerere-autoupdate",
				"signoff",
				"skip",
				"strategy",
				"strategy-option",
			],
			Self::Revert => &[
				"abort",
				"cleanup",
				"commit",
				"continue",
				"edit",
				"gpg-sign",
				"help",
				"help-all",
				"mainline",
				"quit",
				"reference",
				"rerere-autoupdate",
				"signoff",
				"skip",
				"strategy",
				"strategy-option",
			],
			Self::Commit => &[
				"ahead-behind",
				"all",
				"allow-empty",
				"allow-empty-message",
				"amend",
				"author",
				"branch",
				"cleanup",
				"date",
				"dry-run",
				"edit",
				"file",
				"fixup",
				"gpg-sign",
				"help",
				"help-all",
				"include",
				"inter-hunk-context",
				"interactive",
				"long",
				"message",
				"null",
				"only",
				"patch",
				"pathspec-file-nul",
				"pathspec-from-file",
				"porcelain",
				"post-rewrite",
				"quiet",
				"reedit-message",
				"reset-author",
				"reuse-message",
				"short",
				"signoff",
				"squash",
				"status",
				"template",
				"trailer",
				"unified",
				"untracked-files",
				"verbose",
				"verify",
			],
			Self::Clean => {
				&["dry-run", "exclude", "force", "help", "help-all", "interactive", "quiet"]
			},
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
	/// `--name` or `--name=value`, by name and optional inline value; an
	/// abbreviation by the name it stands for.
	Long(&'a str, Option<&'a str>),
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
				.map_or((long, None), |(name, value)| (name, Some(value)));
			match super::long_option(sub.long_options(), spelled) {
				Some((name, true)) => scanned.push(Arg::Negated(name)),
				Some((name, false)) => {
					if inline.is_none() && long_valued.contains(&name) {
						args.next();
					}
					scanned.push(Arg::Long(name, inline));
				},
				// Unknown or ambiguous: git refuses it on its own.
				None => scanned.push(Arg::Long(spelled, inline)),
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
				if sub.short_optional_valued().contains(&flag) {
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
	/// Rewrites history or working tree (`rebase`, `merge`, `pull`,
	/// `cherry-pick`, `revert`).
	HistoryRewrite,
	/// Continues, aborts, skips, or quits an already-running operation.
	InProgressOnly,
	/// `commit --amend` without dry-run flags.
	CommitAmend,
	/// `clean` without `-n` / `--dry-run`.
	Clean,
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

fn is_help(args: &[Arg<'_>]) -> bool {
	args
		.iter()
		.any(|arg| matches!(arg, Arg::Short('h') | Arg::Long("help" | "help-all", None)))
}

fn classify(sub: Sub, args: &[String]) -> Verdict {
	match sub {
		Sub::Stash => classify_stash(args),
		Sub::Reset => classify_reset(&scan(sub, args)),
		Sub::Checkout | Sub::Switch | Sub::Restore => classify_tree_write(sub, &scan(sub, args)),
		Sub::Rebase => {
			let scanned = scan(sub, args);
			let flags = Flags::of(sub, &scanned);
			if is_help(&scanned) || flags.on("show-current-patch") {
				Verdict::Allow
			} else if flags.any(&["continue", "abort", "skip", "quit", "edit-todo"]) {
				Verdict::InProgressOnly
			} else {
				Verdict::HistoryRewrite
			}
		},
		Sub::Merge => {
			let scanned = scan(sub, args);
			let flags = Flags::of(sub, &scanned);
			if is_help(&scanned) {
				Verdict::Allow
			} else if flags.any(&["continue", "abort", "quit"]) {
				Verdict::InProgressOnly
			} else {
				Verdict::HistoryRewrite
			}
		},
		Sub::Pull => {
			let scanned = scan(sub, args);
			if is_help(&scanned) {
				Verdict::Allow
			} else {
				Verdict::HistoryRewrite
			}
		},
		Sub::CherryPick | Sub::Revert => {
			let scanned = scan(sub, args);
			let flags = Flags::of(sub, &scanned);
			if is_help(&scanned) {
				Verdict::Allow
			} else if flags.any(&["continue", "abort", "skip", "quit"]) {
				Verdict::InProgressOnly
			} else {
				Verdict::HistoryRewrite
			}
		},
		Sub::Commit => {
			let scanned = scan(sub, args);
			let flags = Flags::of(sub, &scanned);
			let status_format = flags
				.0
				.iter()
				.rev()
				.find(|(flag, _)| matches!(*flag, "short" | "porcelain" | "long"))
				.is_some_and(|&(_, on)| on);
			let dry_run = flags.on("dry-run") || flags.on("null") || status_format;
			if !is_help(&scanned) && flags.on("amend") && !dry_run {
				Verdict::CommitAmend
			} else {
				Verdict::Allow
			}
		},
		Sub::Clean => {
			let scanned = scan(sub, args);
			let flags = Flags::of(sub, &scanned);
			if is_help(&scanned) || flags.on("dry-run") {
				Verdict::Allow
			} else {
				Verdict::Clean
			}
		},
	}
}

/// What `--[no-]recurse-submodules` says, the last one winning; `None` when
/// neither is given.
fn recurse_option(sub: Sub, args: &[String]) -> Option<bool> {
	scan(sub, args).iter().rev().find_map(|arg| match arg {
		Arg::Long("recurse-submodules", value) => Some(!matches!(
			value.map(str::to_ascii_lowercase).as_deref(),
			Some("false" | "no" | "off" | "0")
		)),
		Arg::Negated("recurse-submodules") => Some(false),
		_ => None,
	})
}

/// `list`, `show`, and `create` touch neither the working tree nor the list.
fn classify_stash(args: &[String]) -> Verdict {
	// `branch <name> [<stash>]` names its entry second.
	let (op, entry_at) = match args.first().map(String::as_str) {
		Some("list" | "show" | "create" | "-h" | "--help" | "--help-all") => return Verdict::Allow,
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
			Arg::Long(..) | Arg::Negated(_) | Arg::Short(_) => None,
		})
		.nth(entry_at);
	Verdict::Stash(Stash::Takes(op, entry))
}

/// `reset` moves HEAD only in its `reset [<mode>] <commit>` form: one revision
/// and no pathspec. With paths, a pathspec file, or `--patch` it rewrites index
/// entries only.
fn classify_reset(args: &[Arg<'_>]) -> Verdict {
	if is_help(args) {
		return Verdict::Allow;
	}
	let flags = Flags::of(Sub::Reset, args);
	let mut operands = Vec::new();
	let mut pathspec = false;
	for arg in args {
		match *arg {
			Arg::Pathspec(_) => pathspec = true,
			Arg::Operand(operand) => operands.push(operand),
			Arg::Long(..) | Arg::Negated(_) | Arg::Short(_) => {},
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
	if (sub == Sub::Checkout && args.is_empty()) || is_help(args) {
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
					(_, Arg::Long(name, _)) => Some((name, true)),
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
					(Sub::Clean, Arg::Short('n')) => Some(("dry-run", true)),
					(Sub::Commit, Arg::Short('z')) => Some(("null", true)),
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
	if spec.starts_with(":!") || spec.starts_with(":^") {
		return true;
	}
	let mut rest = if let Some(after) = spec.strip_prefix(":(")
		&& let Some((magic, path)) = after.split_once(')')
	{
		if magic.split(',').any(|attr| attr == "exclude") {
			return true;
		}
		path
	} else {
		spec.strip_prefix(":/").unwrap_or(spec)
	};
	while let Some(tail) = rest.strip_prefix("./") {
		rest = tail;
	}
	matches!(rest, "*" | "**") || rest.split('/').all(|part| matches!(part, "" | "." | ".."))
}

/// Why the guard refuses a command.
enum Refusal {
	Stash,
	Destructive(Sub),
	CommitMove,
	BranchMove(Sub),
	OutsideConflict(Sub),
	HistoryRewrite(Sub),
	CommitAmend,
	Clean,
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
	fn message(&self, ovnfs: Option<&str>) -> String {
		match self {
			Self::Stash => format!(
				"git stash is blocked by workspace policy — do not work around it.\nOther sessions \
				 may be using this checkout (it is not a private checkout): stash takes their \
				 uncommitted changes out of the working tree along with yours. git stash list, git \
				 stash show, and git stash create run here.\n{}\n",
				own_checkout_hint(ovnfs)
			),
			Self::Destructive(sub) => format!(
				"git {} is blocked: this form (--hard / --force / --discard-changes, or a whole-tree \
				 pathspec like `.`, `:/`, `*`) discards the working tree/index wholesale, and other \
				 sessions may be using this checkout (it is not a private checkout) — being \
				 mid-conflict does not make it safe.\nResolve conflicts with targeted forms instead: \
				 git checkout/restore --ours|--theirs <path>. Unstage with git reset <path> or git \
				 restore --staged <path>.\n{}\n",
				sub.name(),
				own_checkout_hint(ovnfs)
			),
			Self::CommitMove => format!(
				"git reset to another commit is blocked: it moves the branch checked out here, and \
				 other sessions may be using this checkout (it is not a private checkout).\nUnstaging \
				 is allowed — drop the commit argument: git reset [-q] [--] <path> (or bare git reset \
				 to unstage everything), or git restore --staged <path>.\n{}\n",
				own_checkout_hint(ovnfs)
			),
			Self::BranchMove(sub) => format!(
				"git {} to another branch or commit is blocked by workspace policy — do not work \
				 around it.\nOther sessions may be using this checkout (it is not a private \
				 checkout); switching branches moves HEAD and the working tree under them. A merge or \
				 rebase in progress does not make it safe. Do not fall back to committing on the \
				 current branch or working around this with plumbing (commit-tree, read-tree, branch \
				 -f). While resolving conflicts, git checkout -- <path> and git restore <path> still \
				 run; put -- before a path that shares its name with a branch. Inspect other \
				 revisions read-only with git show <rev>:<path> / git diff / git log.\n{}\n",
				sub.name(),
				own_checkout_hint(ovnfs)
			),
			Self::OutsideConflict(sub) => format!(
				"git {} is blocked by workspace policy — do not work around it.\nOther sessions may \
				 be using this checkout (it is not a private checkout); overwriting working-tree \
				 files discards uncommitted changes they may rely on. It is exempt only while a \
				 merge/rebase conflict is being resolved, and the repository is not in \
				 one.\nUnstaging is always allowed: git reset [<path>] / git restore --staged <path>. \
				 To undo working-tree edits here, edit forward; inspect history read-only with git \
				 diff/log/show.\n{}\n",
				sub.name(),
				own_checkout_hint(ovnfs)
			),
			Self::Redirected(sub) => format!(
				"git {} is blocked: the guard judges the checkout found from the working directory, \
				 and this command points git elsewhere (--git-dir / --work-tree / GIT_DIR / \
				 GIT_WORK_TREE / GIT_INDEX_FILE), so it cannot tell whose checkout it changes.\nRun \
				 it with the target checkout as the working directory, without overriding git's \
				 repository location.\n",
				sub.name()
			),
			Self::HistoryRewrite(sub) => {
				let resume = match sub {
					Sub::Pull => "",
					Sub::Merge => {
						" While an operation is already underway, --continue, --abort, and --quit still \
						 run."
					},
					_ => {
						" While an operation is already underway, --continue, --abort, --skip, and \
						 --quit still run."
					},
				};
				format!(
					"git {} is blocked by workspace policy — do not work around it.\nOther sessions \
					 may be using this checkout (it is not a private checkout); it moves HEAD and \
					 rewrites the working tree under them.{resume}\n{}\n",
					sub.name(),
					own_checkout_hint(ovnfs)
				)
			},
			Self::CommitAmend => format!(
				"git commit --amend is blocked by workspace policy — do not work around it.\nOther \
				 sessions may be using this checkout (it is not a private checkout); amending \
				 rewrites HEAD under them. Make a new commit instead (prefer eval's commit.draft() in \
				 a shared checkout), or amend in a separate checkout.\n{}\n",
				own_checkout_hint(ovnfs)
			),
			Self::Clean => format!(
				"git clean is blocked by workspace policy — do not work around it.\nOther sessions \
				 may be using this checkout (it is not a private checkout); clean deletes untracked \
				 files they may rely on. Preview with git clean -n / --dry-run.\n{}\n",
				own_checkout_hint(ovnfs)
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
				 failed: {}\nCommit them or save a patch first (git diff --output=<file>); a merge or \
				 rebase in progress ends with git merge --abort or git rebase --abort.\n",
				sub.name(),
				error.trim()
			),
			Self::Recursive(sub) => format!(
				"git {} is blocked: it recurses into submodules (--recurse-submodules or \
				 submodule.recurse), and uncommitted changes it discards there cannot be saved \
				 first.\nRun it without recursing (--no-recurse-submodules), or commit or save a \
				 patch of each submodule's changes first (run git diff --output=<file> inside each \
				 submodule).\n",
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
	fn ovnfs_hint_keeps_the_command_one_literal_shell_word() {
		let hint = own_checkout_hint(Some("C:/Program Files/$HOME/it's/ovnfs.exe"));
		assert!(
			hint.contains(r"('C:/Program Files/$HOME/it'\''s/ovnfs.exe' new --name <name>)"),
			"{hint}"
		);
		// A leading `NAME=value` word is an environment assignment, not the
		// command.
		let hint = own_checkout_hint(Some("ovnfs=dev"));
		assert!(hint.contains("('ovnfs=dev' new --name <name>)"), "{hint}");
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
			// New subcommands: rebase, merge, pull, cherry-pick, revert, commit,
			// clean.
			("rebase main", "HistoryRewrite"),
			("rebase --onto main topic", "HistoryRewrite"),
			("rebase --show-current-patch", "Allow"),
			("rebase --continue", "InProgressOnly"),
			("rebase --abort", "InProgressOnly"),
			("rebase --skip", "InProgressOnly"),
			("rebase --quit", "InProgressOnly"),
			("rebase -x --continue main", "HistoryRewrite"),
			("rebase -h", "Allow"),
			("merge side", "HistoryRewrite"),
			("merge --abort", "InProgressOnly"),
			("merge --abort --no-abort side", "HistoryRewrite"),
			("pull", "HistoryRewrite"),
			("pull --dry-run", "HistoryRewrite"),
			("pull --help", "Allow"),
			("cherry-pick abc123", "HistoryRewrite"),
			("cherry-pick --continue", "InProgressOnly"),
			("cherry-pick -s abc123", "HistoryRewrite"),
			("revert abc123", "HistoryRewrite"),
			("revert --abort", "InProgressOnly"),
			("commit -m hello", "Allow"),
			("commit --amend", "CommitAmend"),
			("commit --amend --no-amend", "Allow"),
			("commit --amend --dry-run", "Allow"),
			("commit --amend --short", "Allow"),
			("commit --amend --porcelain", "Allow"),
			("commit -m --amend", "Allow"),
			("commit -- --amend", "Allow"),
			("commit --amend --no-edit -S/home/user/key", "CommitAmend"),
			("commit --amend --long", "Allow"),
			("commit --amend -z", "Allow"),
			("commit --amend --short --no-porcelain", "CommitAmend"),
			("checkout --help", "Allow"),
			("reset --hard --help", "Allow"),
			("checkout :(literal).", "Destructive"),
			("checkout :!foo", "Destructive"),
			("checkout **", "Destructive"),
			("clean -fd", "Clean"),
			("clean -n", "Allow"),
			("clean -dn", "Allow"),
			("clean -n --no-dry-run -f", "Clean"),
			("clean -e -n -f", "Clean"),
			("clean -f -- --help", "Clean"),
			("clean -h", "Allow"),
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
			("checkout --recurse-submodules=false main", Some(false)),
			("checkout --recurse-submodules=0 main", Some(false)),
			("checkout --recurse-submodules=on-demand main", Some(true)),
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
		let (code, output) = run_with(&repo, "git merge -q side", &[]).await;
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
		for (checkout, command, hint) in [
			(&repo, "cd \"$EMPTY\"; git reset -q --keep topic", "git worktree add"),
			(
				&repo,
				"PI_GIT_GUARD_OVNFS=/opt/ovnfs git checkout tracked.txt",
				"'/opt/ovnfs' new --name <name>",
			),
			(&clone, "git checkout tracked.txt", "git worktree add"),
		] {
			let (code, output) = guarded(checkout, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains(hint), "{command}: {output}");
			if hint.contains("ovnfs") {
				assert!(output.contains("--rev <rev>"), "{command}: {output}");
				assert!(
					output.contains("'/opt/ovnfs' run --rev HEAD -- <command>"),
					"{command}: {output}"
				);
				assert!(output.contains("--take SRC:PATH"), "{command}: {output}");
				assert!(
					output.contains("folder (.), the index (empty SRC), or another revision"),
					"{command}: {output}"
				);
				assert!(!output.contains("git worktree add"), "{command}: {output}");
			}
		}
		assert_eq!((git(&repo, &["rev-parse", "HEAD"]), read(&repo)), (head, "theirs\n".to_owned()));
		assert_eq!(read(&clone), "theirs\n");

		let (code, output) =
			guarded(&worktree, "git reset -q --keep main && git switch -q -c side").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), git(&repo, &["rev-parse", "main"]));
	}

	/// Only a repo-local checkout marker makes a checkout private; a global
	/// marker never permits discarding shared work. Private checkouts retain
	/// discarded edits.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn ovnfs_checkout_marker_is_repo_local_and_preserves_discarded_changes() {
		const CHILD: &str = "PI_GUARD_TEST_GLOBAL_HOME";
		if std::env::var_os(CHILD).is_none() {
			// Give the child its own actual global config, without changing this
			// test process's environment or another test's Git configuration.
			let home = tempfile::tempdir().expect("global config home");
			std::fs::write(home.path().join(".gitconfig"), "[ovnfs]\n\tcheckout = global-only\n")
				.expect("global checkout marker");
			let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
				.args([
					"--exact",
					"git::guard::tests::ovnfs_checkout_marker_is_repo_local_and_preserves_discarded_changes",
					"--nocapture",
				])
				.env(CHILD, "1")
				.env("HOME", home.path())
				.env("XDG_CONFIG_HOME", home.path().join(".config"))
				.env_remove("GIT_CONFIG_GLOBAL")
				.env_remove("GIT_CONFIG_PARAMETERS")
				.env_remove("GIT_CONFIG_COUNT")
				.output()
				.expect("isolated global config test");
			assert!(
				output.status.success(),
				"{}\n{}",
				String::from_utf8_lossy(&output.stdout),
				String::from_utf8_lossy(&output.stderr)
			);
			return;
		}

		let (_temp, repo) = fixture();
		// An ovnfs checkout's .git file points at its own, non-shared gitdir.
		let private = repo.parent().expect("fixture parent").join("private-git");
		std::fs::rename(repo.join(".git"), &private).expect("move private gitdir");
		std::fs::write(repo.join(".git"), format!("gitdir: {}\n", private.display()))
			.expect("private gitdir pointer");
		std::fs::write(repo.join("tracked.txt"), "mine\n").expect("edit");
		assert_eq!(
			GitRepo::require(&repo)
				.expect("repo")
				.config_get("ovnfs.checkout")
				.expect("global config"),
			Some("global-only".to_owned())
		);
		let (code, output) = guarded(&repo, "git checkout HEAD -- .").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(read(&repo), "mine\n");

		git(&repo, &["config", "--global", "--unset", "ovnfs.checkout"]);
		let (code, output) = guarded(&repo, "git checkout HEAD -- .").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert_eq!(read(&repo), "mine\n");

		git(&repo, &["config", "--local", "ovnfs.checkout", "guard-checkout"]);
		let (code, output) = guarded(&repo, "git checkout HEAD -- .").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(output.contains("saved your uncommitted changes as"), "{output}");
		assert_eq!(read(&repo), "tracked\n");
		assert_eq!(git(&repo, &["show", &format!("{DISCARDED_REF}:tracked.txt")]), "mine\n");
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
		let (code, output) =
			guarded(&worktree, "PI_GIT_GUARD_OVNFS=ovnfs git checkout tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("'ovnfs' new --name <name>"), "{output}");
		assert!(output.contains("--rev <rev>"), "{output}");
		assert!(output.contains("'ovnfs' run --rev HEAD -- <command>"), "{output}");
		assert!(output.contains("--take SRC:PATH"), "{output}");
		assert!(
			output.contains("folder (.), the index (empty SRC), or another revision"),
			"{output}"
		);
		assert!(!output.contains("git worktree add"), "{output}");
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

	#[test]
	fn unambiguous_short_id_extends_all_digit_prefixes() {
		assert_eq!(unambiguous_short_id("1234a56", "1234a56789"), "1234a56");
		assert_eq!(
			unambiguous_short_id("1234567", "123456789abcdef0123456789abcdef012345678"),
			"123456789a"
		);
		assert_eq!(
			unambiguous_short_id("12345678", "1234567a9bcdef0123456789abcdef0123456789"),
			"1234567a"
		);
		let all_digits = "1234567890123456789012345678901234567890";
		assert_eq!(unambiguous_short_id("1234567", all_digits), format!("{all_digits}^0"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn shared_checkouts_block_history_rewrites_amend_and_clean() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let worktree = parent.join("wt");
		git(&repo, &["checkout", "-qb", "side"]);
		std::fs::write(repo.join("side.txt"), "side\n").expect("write side");
		git(&repo, &["add", "side.txt"]);
		git(&repo, &["commit", "-qm", "side"]);
		git(&repo, &["checkout", "-q", "main"]);
		std::fs::write(repo.join("tracked.txt"), "main-edit\n").expect("write main");
		git(&repo, &["commit", "-qam", "main-edit"]);
		git(&repo, &["worktree", "add", "-q", "-b", "topic", &worktree.to_string_lossy()]);

		let side_sha = git(&repo, &["rev-parse", "side"]).trim().to_owned();
		std::fs::write(repo.join("untracked.txt"), "keep\n").expect("write untracked");
		for command in [
			"git rebase side",
			"git merge side",
			"git pull",
			&format!("git cherry-pick {side_sha}"),
			"git revert HEAD",
			"git commit --amend --no-edit",
			"git clean -fd",
		] {
			let (code, output) = guarded(&repo, command).await;
			assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{command}: {output}");
			assert!(output.contains("blocked by workspace policy"), "{command}: {output}");
		}
		assert!(repo.join("untracked.txt").exists());

		// Allowed read-only / dry-run / non-amend forms in shared checkouts.
		let (code, output) = guarded(&repo, "git clean -n").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(repo.join("untracked.txt").exists());
		let (code, output) = guarded(&repo, "git commit --allow-empty -qm plain").await;
		assert_eq!(code, Some(0), "{output}");

		// Mid-operation --abort/--continue allowed ONLY when that operation is
		// underway.
		let (code, output) = guarded(&repo, "git merge --abort").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		let (code, output) = run_with(&repo, "git merge -q --no-commit --no-ff side", &[]).await;
		assert_eq!(code, Some(0), "{output}");
		let (code, output) = guarded(&repo, "git rebase --continue").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "rebase --continue during merge: {output}");
		let (code, output) = guarded(&repo, "git merge --abort").await;
		assert_eq!(code, Some(0), "{output}");
		// Sequencer state (`sequencer/todo` without `CHERRY_PICK_HEAD`) still
		// allows --continue/--abort.
		std::fs::create_dir_all(repo.join(".git/sequencer")).expect("sequencer dir");
		std::fs::write(repo.join(".git/sequencer/todo"), "pick deadbeef\n").expect("sequencer todo");
		let (_code, output) = guarded(&repo, "git cherry-pick --abort").await;
		assert!(!output.contains("blocked by workspace policy"), "{output}");
		let _ = std::fs::remove_dir_all(repo.join(".git/sequencer"));

		// All of them run in a linked worktree.
		std::fs::write(worktree.join("untracked.txt"), "drop\n").expect("write wt untracked");
		let (code, output) = guarded(&worktree, "git clean -fd").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(!worktree.join("untracked.txt").exists());
		let (code, output) = guarded(&worktree, "git commit --allow-empty --amend -qm amended").await;
		assert_eq!(code, Some(0), "{output}");
		let (code, output) = guarded(&worktree, "git merge -q --no-edit side").await;
		assert_eq!(code, Some(0), "{output}");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn magic_pathspecs_and_separate_git_dir_work_and_hints_stay_clean() {
		let (_temp, repo) = fixture();
		let parent = repo.parent().expect("fixture parent").to_owned();
		let worktree = parent.join("wt");
		git(&repo, &["worktree", "add", "-q", "-b", "topic", &worktree.to_string_lossy()]);

		// Magic pathspec is recognized as a pathspec (refused outside conflict in
		// shared, saved in private).
		std::fs::write(repo.join("tracked.txt"), "shared-edit\n").expect("edit shared");
		let (code, output) = guarded(&repo, "git checkout ':(literal)tracked.txt'").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
		assert!(output.contains("not in one"), "{output}");

		std::fs::write(worktree.join("tracked.txt"), "wt-edit\n").expect("edit wt");
		let (code, output) = guarded(&worktree, "git checkout ':(literal)tracked.txt'").await;
		assert_eq!(code, Some(0), "{output}");
		assert!(output.contains("saved your uncommitted changes as"), "{output}");
		assert_eq!(read(&worktree), "tracked\n");

		// Refusal hints avoid `git -C` and `> <file>`.
		let redirected = Refusal::Redirected(Sub::Checkout).message(None);
		assert!(!redirected.contains("git -C"), "{redirected}");
		let unsaved = Refusal::Unsaved(Sub::Checkout, "boom".into()).message(None);
		assert!(!unsaved.contains("> <file>"), "{unsaved}");
		let recursive = Refusal::Recursive(Sub::Reset).message(None);
		assert!(!recursive.contains("git -C"), "{recursive}");
		assert!(!recursive.contains("> <file>"), "{recursive}");

		// `--separate-git-dir` linked worktree is private; bare repo named `.git`
		// stays guarded.
		let sep_wt = parent.join("sep-main");
		let sep_git = parent.join("sep-git");
		git(&parent, &[
			"init",
			"-q",
			"-b",
			"main",
			"--separate-git-dir",
			&sep_git.to_string_lossy(),
			&sep_wt.to_string_lossy(),
		]);
		git(&sep_wt, &["config", "user.name", "Test"]);
		git(&sep_wt, &["config", "user.email", "test@example.com"]);
		std::fs::write(sep_wt.join("tracked.txt"), "tracked\n").expect("write");
		git(&sep_wt, &["add", "tracked.txt"]);
		git(&sep_wt, &["commit", "-qm", "init"]);
		let sep_linked = parent.join("sep-linked");
		git(&sep_wt, &["worktree", "add", "-q", "-b", "t", &sep_linked.to_string_lossy()]);
		std::fs::write(sep_linked.join("tracked.txt"), "mine\n").expect("edit");
		let (code, output) = guarded(&sep_linked, "git checkout tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");

		let bare_dot_git = parent.join("bare-holder/.git");
		std::fs::create_dir_all(&bare_dot_git).expect("mkdir");
		git(&parent, &[
			"clone",
			"-q",
			"--bare",
			&repo.to_string_lossy(),
			&bare_dot_git.to_string_lossy(),
		]);
		let bare_linked = parent.join("bare-linked");
		git(&bare_dot_git, &["worktree", "add", "-q", &bare_linked.to_string_lossy(), "main"]);
		std::fs::write(bare_linked.join("tracked.txt"), "mine\n").expect("edit");
		let (code, output) = guarded(&bare_linked, "git checkout tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn recurse_submodules_false_runs_in_private_worktree() {
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
		git(&repo, &["config", "submodule.recurse", "true"]);

		std::fs::write(worktree.join("tracked.txt"), "mine\n").expect("edit");
		let (code, output) =
			guarded(&worktree, "git checkout --recurse-submodules=false tracked.txt").await;
		assert_eq!(code, Some(0), "{output}");
		assert_eq!(read(&worktree), "tracked\n");
		let (code, output) =
			guarded(&worktree, "git checkout --recurse-submodules tracked.txt").await;
		assert_eq!(code, Some(i32::from(REFUSED_EXIT)), "{output}");
	}
}
