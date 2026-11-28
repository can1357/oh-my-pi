//! Conversion between worktree bytes and their stored blob form.
//!
//! Git never compares or patches raw worktree bytes against objects: content
//! passes through the clean/smudge pipeline (`core.autocrlf`, `eol`/`text`
//! attributes, `ident`, filter drivers) first. Skipping it makes every CRLF
//! checkout under `core.autocrlf=true` — the Git for Windows default — read as
//! modified and makes LF patches fail to apply.

use std::{collections::BTreeSet, io::Read, path::Path};

use gix::{
	bstr::ByteSlice,
	filter::plumbing::{
		driver::apply::Delay,
		pipeline::convert::{ToGitOutcome, ToWorktreeOutcome, to_worktree},
	},
};

use super::open::load_index_or_empty;
use crate::error::{Error, Result};

pub(crate) struct WorktreeFilter<'repo> {
	pipeline: gix::filter::Pipeline<'repo>,
	/// Index consulted by the safer-autocrlf rule: a path whose index blob
	/// already contains CR keeps its CRLFs (`git add` semantics). An empty
	/// index renormalizes unconditionally (`git apply` semantics).
	index:    gix::index::State,
	/// Paths read verbatim, as `git apply` does (`CONV_EOL_KEEP_CRLF`) when a
	/// patch's preimage itself carries CRLF line endings.
	verbatim: BTreeSet<String>,
	op:       &'static str,
}

impl<'repo> WorktreeFilter<'repo> {
	/// Filter with `git add` semantics against `index`.
	pub(crate) fn new(
		repo: &'repo gix::Repository,
		op: &'static str,
		index: gix::index::State,
	) -> Result<Self> {
		let (pipeline, _) = repo
			.filter_pipeline(None)
			.map_err(|err| Error::backend(op, err))?;
		Ok(Self { pipeline, index, verbatim: BTreeSet::new(), op })
	}

	/// Filter with `git add` semantics against the index on disk.
	pub(crate) fn staging(repo: &'repo gix::Repository, op: &'static str) -> Result<Self> {
		let (index, _) = load_index_or_empty(repo, op)?.into_parts();
		Self::new(repo, op, index)
	}

	/// Filter with `git apply` semantics: line endings are renormalized
	/// regardless of what the index holds.
	pub(crate) fn renormalizing(repo: &'repo gix::Repository, op: &'static str) -> Result<Self> {
		Self::new(repo, op, gix::index::State::new(repo.object_hash()))
	}

	/// Read `paths` without clean conversion.
	pub(crate) fn keep_verbatim(&mut self, paths: BTreeSet<String>) {
		self.verbatim = paths;
	}

	/// Convert worktree `bytes` found at repo-relative `path` to blob content.
	pub(crate) fn worktree_to_git(&mut self, path: &str, bytes: Vec<u8>) -> Result<Vec<u8>> {
		if self.verbatim.contains(path) {
			return Ok(bytes);
		}
		let converted = match self
			.pipeline
			.convert_to_git(bytes.as_slice(), Path::new(path), &self.index)
			.map_err(|err| Error::backend(self.op, err))?
		{
			ToGitOutcome::Unchanged(_) => None,
			ToGitOutcome::Buffer(buf) => Some(buf.to_vec()),
			ToGitOutcome::Process(mut read) => {
				let mut out = Vec::new();
				read.read_to_end(&mut out)?;
				Some(out)
			},
		};
		Ok(converted.unwrap_or(bytes))
	}

	/// Convert blob `bytes` destined for repo-relative `path` to worktree
	/// content.
	pub(crate) fn git_to_worktree(&mut self, path: &str, bytes: Vec<u8>) -> Result<Vec<u8>> {
		let converted = match self
			.pipeline
			.convert_to_worktree(&bytes, path.as_bytes().as_bstr(), to_worktree::Options {
				can_delay:        Delay::Forbid,
				unknown_encoding: to_worktree::UnknownEncoding::Fail,
			})
			.map_err(|err| Error::backend(self.op, err))?
		{
			ToWorktreeOutcome::Unchanged(_) => None,
			ToWorktreeOutcome::Buffer(buf) => Some(buf.to_vec()),
			mut outcome @ ToWorktreeOutcome::Process(_) => {
				let mut out = Vec::new();
				outcome.read_to_end(&mut out)?;
				Some(out)
			},
		};
		Ok(converted.unwrap_or(bytes))
	}
}

impl super::GitRepo {
	/// Convert worktree `data` found at each repo-relative path to the blob
	/// `git add` would store: `.gitattributes` `text`/`eol`, `core.autocrlf`
	/// (a path whose index blob holds CR keeps its CRLFs), `ident`, and clean
	/// filter drivers such as Git LFS. A reftable repository cannot be opened
	/// in-process and returns `data` unchanged.
	pub fn worktree_to_git(&self, entries: Vec<(String, Vec<u8>)>) -> Result<Vec<Vec<u8>>> {
		if self.is_reftable() {
			return Ok(entries.into_iter().map(|(_, data)| data).collect());
		}
		let repo = self.gix()?;
		let mut filter = WorktreeFilter::staging(&repo, "git add")?;
		entries
			.into_iter()
			.map(|(path, data)| filter.worktree_to_git(&path, data))
			.collect()
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, process::Command};

	use crate::git::GitRepo;

	fn git(dir: &std::path::Path, args: &[&str]) {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	}

	#[test]
	fn worktree_to_git_applies_autocrlf_and_eol_attributes() {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "core.autocrlf", "true"]);
		fs::write(temp.path().join(".gitattributes"), "*.bin -text\n*.cmd text eol=crlf\n").unwrap();
		let repo = GitRepo::require(temp.path()).unwrap();

		let converted = repo
			.worktree_to_git(vec![
				("a.txt".into(), b"one\r\ntwo\r\n".to_vec()),
				("run.cmd".into(), b"echo\r\n".to_vec()),
				("raw.bin".into(), b"keep\r\n".to_vec()),
			])
			.unwrap();
		assert_eq!(converted, vec![b"one\ntwo\n".to_vec(), b"echo\n".to_vec(), b"keep\r\n".to_vec()]);
	}
}
