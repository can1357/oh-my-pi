//! Orphaned jobs ([`EngineConfig::end_orphan_jobs`]): a subshell that exits
//! takes the in-engine work of its background jobs with it.
//!
//! A child whose parent subshell is gone is an orphan: the root of an
//! orphaned job tree (the vprocs [`Shell::in_job`] counts as its job,
//! nested jobs excluded). The tree is ended as a `TERM` ends a vproc
//! ([`Shell::kill`]: its native task or external signalled, its frames
//! unwound) once one of its vprocs runs in-engine work: a shell loop, a
//! native task, a `wait`. Until then it is watched, after each slice of one
//! of its vprocs: a job that is just its program (`(server &)`, `$(server
//! & …)`) waits on that external and runs on as its own process, as in
//! bash; one that only runs builtins on the way to it (`(cd d && server
//! &)`) gets there. A detached tree (`nohup`) is never ended, and a vproc
//! of a detached lineage never counts.
//!
//! The judgement is derived from the vprocs alone, so nothing of it is
//! externalized: a restored shell finds its orphans again
//! ([`Shell::seed_orphans`]).
//!
//! [`EngineConfig::end_orphan_jobs`]: crate::bash::EngineConfig::end_orphan_jobs

use super::{
	Cx, Shell,
	proc::{Awaited, Live, LoopKind, Target, Vproc},
};
use crate::bash::{
	ids::{IntrinsicId, Vpid},
	signal::Signal,
};

impl Shell {
	/// Judge orphaned jobs: first the children of the vprocs gone since the
	/// last call ([`Self::reaped`]), then, after a slice of `ran`, the
	/// orphaned job tree `ran` belongs to. A no-op unless
	/// [`EngineConfig::end_orphan_jobs`](crate::bash::EngineConfig::end_orphan_jobs)
	/// is set.
	pub(super) fn end_orphans(&mut self, cx: &mut Cx<'_>, ran: Option<Vpid>) {
		if self.gone.is_empty() && self.orphans.is_empty() {
			return;
		}
		self.judge_gone(cx);
		if let Some(ran) = ran
			&& let Some(job) = self.orphan_root(ran)
			&& self
				.procs
				.iter()
				.any(|p| p.vpid == ran && !p.lineage.detached && in_engine(p))
		{
			self.end_job(cx, job);
			self.judge_gone(cx);
		}
	}

	/// Judge the children of the vprocs gone since the last call: a job
	/// tree already running in-engine work ends at once, any other is
	/// watched ([`Self::orphans`]). Orphans that ended meanwhile are
	/// forgotten.
	fn judge_gone(&mut self, cx: &mut Cx<'_>) {
		// A watched orphan that ended is gone too: nothing to forget either.
		if self.gone.is_empty() {
			return;
		}
		// Children not adopted yet (a callout's subshell) are judged once
		// they are.
		let mut later = Vec::new();
		while let Some(parent) = self.gone.pop() {
			if self.k.spawned.iter().any(|p| p.parent == Some(parent)) {
				later.push(parent);
			}
			let found: Vec<Vpid> = self
				.procs
				.iter()
				.filter(|p| p.parent == Some(parent) && !p.lineage.detached)
				.map(|p| p.vpid)
				.filter(|v| !self.orphans.contains(v))
				.collect();
			for job in found {
				if self.tree_in_engine(job) {
					// Ending it may orphan its nested jobs: `gone` again.
					self.end_job(cx, job);
				} else {
					self.orphans.push(job);
				}
			}
		}
		self.gone = later;
		let procs = &self.procs;
		self
			.orphans
			.retain(|&job| procs.iter().any(|p| p.vpid == job));
	}

	/// The orphan whose job tree `vpid` belongs to, if any.
	fn orphan_root(&self, mut vpid: Vpid) -> Option<Vpid> {
		loop {
			if self.orphans.contains(&vpid) {
				return Some(vpid);
			}
			let parent = self.procs.iter().find(|p| p.vpid == vpid)?.parent?;
			let process = self.procs.iter().find(|p| p.vpid == parent)?;
			if process.jobs.by_vpid(vpid).is_some() {
				return None;
			}
			vpid = parent;
		}
	}

	/// Whether a vproc of the job tree rooted at `job` runs in-engine work.
	fn tree_in_engine(&self, job: Vpid) -> bool {
		self
			.procs
			.iter()
			.any(|p| !p.lineage.detached && in_engine(p) && self.in_job(p.vpid, job))
	}

	/// End the job tree rooted at `job` as an untrapped `TERM` does, sparing
	/// its detached vprocs. The children of the vprocs it removes are
	/// judged next ([`Self::reaped`] lists them as gone).
	fn end_job(&mut self, cx: &mut Cx<'_>, job: Vpid) {
		let status = Signal::Term.exit_status(self.k.engine.config().platform);
		let hits: Vec<usize> = (0..self.procs.len())
			.filter(|&i| !self.procs[i].lineage.detached && self.in_job(self.procs[i].vpid, job))
			.collect();
		for &i in hits.iter().rev() {
			self.kill(cx, i, Signal::Term, status);
		}
		self.orphans.retain(|&v| v != job);
	}

	/// After a restore: the vprocs whose parent is gone are orphans again,
	/// judged at the next step.
	pub(super) fn seed_orphans(&mut self) {
		if !self.k.engine.config().end_orphan_jobs {
			return;
		}
		for p in &self.procs {
			if let Some(parent) = p.parent
				&& !self.gone.contains(&parent)
				&& !self.procs.iter().any(|q| q.vpid == parent)
			{
				self.gone.push(parent);
			}
		}
	}
}

/// Whether `p` runs in-engine work that may not end on its own: it is in a
/// shell loop (a zsh `always` block is none), runs a native task, or waits
/// for its children (`wait`).
fn in_engine(p: &Vproc) -> bool {
	p.frames.iter().any(|f| {
		let looping = f
			.loops
			.iter()
			.any(|l| !matches!(l.kind, LoopKind::Try { .. }));
		let busy = f.scratch.as_ref().is_some_and(|sc| {
			// The `wait` builtin; a nested shell or a hook parks on its child
			// as `Jobs` too, and is judged by that child.
			let waits = sc.exec.as_ref().is_some_and(|e| {
				e.target == Some(Target::Intrinsic(IntrinsicId::Wait))
					&& matches!(
						e.waiting,
						Some(Awaited::Jobs { .. } | Awaited::AllJobs | Awaited::AnyJob)
					)
			});
			waits || matches!(sc.live, Live::Task(_))
		});
		looping || busy
	})
}
