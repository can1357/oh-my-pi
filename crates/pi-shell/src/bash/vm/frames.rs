//! Externalize / restore: the `Frames` blob.
//!
//! The blob holds execution position only. The root shell's tables (its
//! function scopes, `$?`, `PIPESTATUS`, `$!`, job table, `getopts`
//! progress, `ulimit` values, cwd) and the kernel's counters (`next_vpid`,
//! `next_job`, `$RANDOM`, `$SECONDS` base) and child-process table are in
//! the store at all times; restore reads them there, with or without a
//! blob. A subshell vproc's scopes, overlay and fields are execution
//! position and are in the blob.
//!
//! Layout: a postcard [`Header`] (magic `OBF1`, IR version, frames version,
//! engine build id, ids of the scripts in flight) followed by a postcard
//! [`Image`] of every vproc, script, frame and staged op. The header decodes
//! on its own, so an incompatible blob can still be abandoned with
//! `RestoreOpts { drop_frames: true }`.
//!
//! Fds: the image numbers every distinct fd object once ([`FdObjImage`];
//! slots, saved fds and substitutions refer to it by index), and every
//! engine memory object those hold once (pipes, here-documents, captures;
//! contents inline). Restore rebuilds each once, so shared fds stay shared
//! and a pipe counts exactly the ends restored fds hold. Only host files
//! (and what externals held) are lost.

use std::{collections::HashMap, sync::Arc};

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize};

use super::{
	CallOutcome, Cx, Kernel, Shell, host_stdio,
	proc::{
		Atom, Awaited, ExecState, Frame, FrameKind, JobState, Live, LoopRec, PendingSub,
		PendingWrite, Probe, ProbeResult, RedirProgress, Run, Saved, Scratch, ScratchIo, ScratchZsh,
		ScriptKind, Stage, Target, Vproc,
	},
	state::{self, Overlay, Root, Scope},
};
use crate::bash::{
	engine::Engine,
	error::{ExtError, Incompatibility, RestoreError},
	event::{EventData, EventMask, OriginChain, WaitKey},
	fd::{FdOrigin, FdRef, FdTable},
	fs::FileKind,
	host::{Host, StdFd},
	ids::{CallId, ModeId, RunId, UnitId, Vpid},
	ir::{
		AssignVal, CondIr, IR_VERSION, Op, OpIr, Opcode, Part, RedirTargetIr, SpawnKind, SubIr, Unit,
		materialize,
	},
	mem::{Capture, MemEnd, MemImage, MemObj},
	signal::{SigSet, Signal},
	snapshot::{ExternalizeReport, Lost, RestoreOpts, RestoreReport},
	store::{BlobSlot, Change, Key, MiscKey, Record, StateStore, StoreError, Table, TrapKey},
};

/// Version of the [`Image`] layout; part of the header and the build id.
/// Also bumped when [`IntrinsicId`](crate::bash::ids::IntrinsicId) gains a
/// variant: an exec target holds it by index.
pub const FRAMES_VERSION: u32 = 30;

const MAGIC: [u8; 4] = *b"OBF1";

#[derive(Serialize, Deserialize)]
struct Header {
	magic:  [u8; 4],
	ir:     u32,
	frames: u32,
	build:  [u8; 32],
	runs:   Vec<RunId>,
}

#[derive(Serialize, Deserialize)]
struct Image {
	seq:       u64,
	next_run:  u64,
	next_call: u64,
	next_cmd:  u64,
	paused:    bool,
	mask:      u64,
	rr:        u32,
	/// The scheduler's unfinished slice (vproc, ops left).
	slice:     Option<(Vpid, u32)>,
	/// The control's wake count (the `at` marks of blocked vprocs refer
	/// to it).
	wakes:     u64,
	done:      Vec<(RunId, i32)>,
	results:   Vec<(CallId, CallOutcome)>,
	procs:     Vec<ProcImage>,
	/// Fd objects, referred to by index.
	fd_objs:   Vec<FdObjImage>,
	/// Engine memory objects, referred to by index.
	mems:      Vec<MemImage>,
	/// Background jobs still deciding on their pid ([`Kernel::bangs`]).
	bangs:     Vec<super::proc::Bang>,
	/// Their commands' redirections still deciding ([`Kernel::deferrals`]).
	deferrals: Vec<super::proc::Deferral>,
}

/// One fd object.
#[derive(Serialize, Deserialize)]
enum FdObjImage {
	/// The shell's standard stream, re-acquired from the host.
	Std(StdFd),
	/// A host object of this kind: lost.
	Host(FileKind),
	/// An end of memory object `obj`.
	Mem { obj: u32, end: MemEnd },
	/// Already lost (by an earlier restore).
	Lost(FdOrigin),
	/// Closed.
	Closed,
}

/// Numbers the fd and memory objects of an image, once each.
#[derive(Default)]
struct FdImager {
	objs:   Vec<FdObjImage>,
	by_obj: HashMap<usize, u32>,
	mems:   Vec<MemImage>,
	by_mem: HashMap<usize, u32>,
}

impl FdImager {
	/// Index of fd object `h`.
	fn fd(&mut self, h: &FdRef) -> u32 {
		if let Some(&i) = self.by_obj.get(&h.key()) {
			return i;
		}
		let mem = h.with_mem(|m| {
			let (key, end) = m.key();
			(self.mem(key, || m.image()), end)
		});
		let img = match (mem, h.origin(), h.kind()) {
			(Some((obj, end)), ..) => FdObjImage::Mem { obj, end },
			(None, FdOrigin::Std(s), _) => FdObjImage::Std(s),
			(None, FdOrigin::Host, Some(kind)) => FdObjImage::Host(kind),
			(None, origin @ (FdOrigin::Host | FdOrigin::Mem), _) => FdObjImage::Lost(origin),
			(None, FdOrigin::Closed, _) => FdObjImage::Closed,
		};
		let i = self.objs.len() as u32;
		self.objs.push(img);
		self.by_obj.insert(h.key(), i);
		i
	}

	/// Index of the memory object with identity `key`.
	fn mem(&mut self, key: usize, image: impl FnOnce() -> MemImage) -> u32 {
		if let Some(&i) = self.by_mem.get(&key) {
			return i;
		}
		let i = self.mems.len() as u32;
		self.mems.push(image());
		self.by_mem.insert(key, i);
		i
	}

	fn capture(&mut self, c: &Capture) -> u32 {
		self.mem(c.key(), || c.image())
	}
}

/// Rebuilds the fd and memory objects of an image, each once.
struct FdRebuild<'s> {
	objs:  Vec<FdObjImage>,
	mems:  Vec<MemObj>,
	built: Vec<Option<FdRef>>,
	stdio: &'s mut [Option<FdRef>; 3],
}

impl FdRebuild<'_> {
	/// Fd object `i`.
	fn fd(&mut self, host: &mut dyn Host, i: u32) -> FdRef {
		self.build(i, |s| host.stdio(s))
	}

	/// Fd object `i`; a standard stream comes from `stream` (once).
	fn build(
		&mut self,
		i: u32,
		stream: impl FnOnce(StdFd) -> Option<Box<dyn crate::bash::fs::File>>,
	) -> FdRef {
		let i = i as usize;
		if let Some(Some(h)) = self.built.get(i) {
			return h.clone();
		}
		let h = match self.objs.get(i) {
			Some(FdObjImage::Std(s)) => {
				let s = *s;
				self.stdio[s.fd() as usize]
					.get_or_insert_with(|| match stream(s) {
						Some(f) => FdRef::open(f, FdOrigin::Std(s)),
						None => FdRef::closed(),
					})
					.clone()
			},
			Some(FdObjImage::Host(_)) => FdRef::lost(FdOrigin::Host),
			Some(FdObjImage::Mem { obj, end }) => self
				.mems
				.get(*obj as usize)
				.and_then(|m| m.end(*end))
				.map_or_else(|| FdRef::lost(FdOrigin::Mem), FdRef::mem),
			Some(FdObjImage::Lost(origin)) => FdRef::lost(*origin),
			Some(FdObjImage::Closed) | None => FdRef::closed(),
		};
		if let Some(slot) = self.built.get_mut(i) {
			*slot = Some(h.clone());
		}
		h
	}

	/// The kind of host object fd object `i` was (lost by the restore).
	fn host_kind(&self, i: u32) -> Option<FileKind> {
		match self.objs.get(i as usize) {
			Some(FdObjImage::Host(kind)) => Some(*kind),
			_ => None,
		}
	}

	/// The capture memory object `i` is.
	fn capture(&self, i: u32) -> Capture {
		self
			.mems
			.get(i as usize)
			.and_then(MemObj::capture)
			.unwrap_or_default()
	}

	fn saved(&mut self, host: &mut dyn Host, s: Vec<SavedImage>) -> Vec<Saved> {
		s.into_iter()
			.map(|s| Saved { fd: s.fd, prev: s.prev.map(|i| self.fd(host, i)) })
			.collect()
	}
}

/// One vproc. The fields in [`Fields`] are the root vproc's store records
/// (`state::sync_root`), so the root's image has none.
#[derive(Serialize, Deserialize)]
struct ProcImage {
	vpid:          Vpid,
	parent:        Option<Vpid>,
	runs:          Vec<RunImage>,
	frames:        Vec<FrameImage>,
	/// Fd object index of every slot.
	fds:           Vec<Option<u32>>,
	/// A subshell's own state (`None` for the root vproc).
	fields:        Option<Fields>,
	out:           Vec<PendingWrite>,
	pending_traps: SigSet,
	stopped:       bool,
	transient:     bool,
	/// This vproc's EXIT trap has already been started (a forked subshell
	/// has no `Run` to keep the flag on).
	exit_trap_run: bool,
	procsubs:      Vec<(u32, i32)>,
	coprocs:       Vec<super::proc::Coproc>,
	restore_opts:  Vec<BString>,
	trace_base:    u32,
	/// `$BASH_SUBSHELL`.
	subshell:      u32,
	/// `BASH_COMMAND`: the unit (written to the store) and syntax node; a
	/// trap action that runs after the restore still names the trapped
	/// command.
	command:       Option<(UnitId, u32)>,
	/// Pushes onto bash's call-stack arrays.
	calls:         Vec<super::callstack::Call>,
	/// The pseudo-signal traps the vproc set itself.
	own_traps:     super::proc::OwnTraps,
	/// Current mode (the root's is also `MiscKey::Mode`).
	mode:          ModeId,
	/// zsh state (sticky emulation, frames' restores).
	zsh:           Option<Box<super::proc::VprocZsh>>,
	/// Host lineage (a detached tree stays detached after a restore).
	lineage:       crate::bash::host::Lineage,
	/// What the vproc was parked on and the wake count then: a restored
	/// shell schedules exactly as the externalized one would have (no
	/// second `Blocked`, same interleaving).
	blocked:       Option<(WaitKey, u64)>,
}

/// A subshell vproc's state that the root vproc keeps in the store.
#[derive(Serialize, Deserialize)]
struct Fields {
	scopes:     Vec<Scope>,
	cwd:        BString,
	status:     i32,
	pipestatus: Vec<i32>,
	overlay:    Overlay,
	jobs:       super::proc::JobTable,
	last_bg:    super::proc::LastBg,
	getopts:    super::proc::GetoptsState,
	rlimits:    Vec<(crate::bash::host::Rlimit, Option<u64>, Option<u64>)>,
}

#[derive(Serialize, Deserialize)]
struct RunImage {
	id:                RunId,
	tag:               u64,
	src:               BString,
	chain:             OriginChain,
	mode:              ModeId,
	restore_mode:      Option<ModeId>,
	explicit_mode:     bool,
	lossy:             u8,
	args:              Option<Vec<BString>>,
	cwd:               Option<BString>,
	env:               Vec<(BString, BString)>,
	started:           bool,
	exit_trap_started: bool,
}

#[derive(Serialize, Deserialize)]
struct FrameImage {
	unit:              Option<UnitId>,
	pc:                u32,
	kind:              FrameKind,
	loops:             Vec<LoopRec>,
	enters:            Vec<(u32, u64)>,
	cases:             Vec<(BString, bool)>,
	times:             Vec<super::proc::TimeMark>,
	redirs:            Vec<Vec<SavedImage>>,
	scratch:           Option<ScratchImage>,
	line_shift:        u32,
	debug_pc:          Option<u32>,
	debug_trap_local:  bool,
	err_trap_local:    bool,
	return_trap_local: bool,
	trace_local:       bool,
	debug_errexit:     bool,
	err_reported:      bool,
	ignore_errexit:    bool,
	subshell_line:     Option<u32>,
	getopts:           super::proc::GetoptsState,
}

/// A saved fd: the fd object it held.
#[derive(Serialize, Deserialize)]
struct SavedImage {
	fd:   i32,
	prev: Option<u32>,
}

/// An in-flight command substitution and its capture (a memory object).
#[derive(Serialize, Deserialize)]
enum SubImage {
	Fork { vpid: Vpid, capture: u32 },
	NoFork { value: bool, capture: u32 },
	Here { status: i32 },
	Math { status: i32, slot: u8 },
}

#[derive(Serialize, Deserialize)]
struct ScratchImage {
	/// The external the exec waits for was running (reported lost); an
	/// earlier restore's loss is not reported again.
	ext_live:     bool,
	logs:         [Vec<Atom>; 4],
	sub:          Option<SubImage>,
	exec:         Option<ExecState>,
	redir_done:   usize,
	redir_target: Option<BString>,
	redir_more:   Vec<(u32, BString)>,
	probes:       Vec<(Probe, ProbeResult)>,
	/// The probe in flight and the bytes an fd read has taken so far: a
	/// restored `read`/`select` neither loses them nor repeats its prompt
	/// (a probe that restarts an fs operation clears them itself).
	probing:      Option<Probe>,
	input:        Vec<u8>,
	saved:        Vec<SavedImage>,
	children:     Vec<(Vpid, Option<i32>)>,
	inline:       Option<super::proc::InlineStage>,
}

fn saved_image(s: &[Saved], fds: &mut FdImager) -> Vec<SavedImage> {
	s.iter()
		.map(|s| SavedImage { fd: s.fd, prev: s.prev.as_ref().map(|h| fds.fd(h)) })
		.collect()
}

/// Image of a scratch; transient handles are checkpointed or reported.
fn scratch_image(
	sc: &mut Scratch,
	vpid: Vpid,
	report: &mut ExternalizeReport,
	fds: &mut FdImager,
) -> ScratchImage {
	let exec = sc.exec.as_ref().map(|e| {
		let mut state = ExecState::clone(e);
		match &mut sc.live {
			Live::Task(task) => {
				state.checkpoint = task.checkpoint();
				if state.checkpoint.is_none()
					&& let Some(Awaited::Task(native)) = state.waiting
				{
					report.lost.push(Lost::Task { vpid, native });
				}
			},
			Live::Ext(child) => report.lost.push(Lost::Ext { vpid, pid: child.pid() }),
			// Fs ops are counted below; a timer is re-armed (from the
			// restore) when the read retries.
			Live::Stat(_)
			| Live::Access(_)
			| Live::Path(_)
			| Live::Open(_)
			| Live::File(_)
			| Live::OpenDir(_)
			| Live::Dir(_)
			| Live::Spawn(_)
			| Live::Timer(_)
			| Live::Fd(_)
			| Live::Fs(_)
			| Live::Zftp(_)
			| Live::None => {},
		}
		state
	});
	// A pending fs op of the exec or of a probe is re-issued after a
	// restore, except a FIFO open (a rendezvous with the other end) and a
	// read of a pipe, FIFO or device (what it consumed is gone): a suspend
	// leaves those running and the snapshot loses them.
	match &sc.live {
		live if live.is_idempotent_fs() => report.reissued_fs += 1,
		Live::File(file) => report.lost.push(Lost::Pending { vpid, kind: file.kind() }),
		Live::Open(_) => report
			.lost
			.push(Lost::Pending { vpid, kind: FileKind::Pipe }),
		// An accept or a lock wait holds a socket or file of its own.
		Live::Fd(_) => report
			.lost
			.push(Lost::Pending { vpid, kind: FileKind::Socket }),
		// A mutation (`mkdir`, a mapfile write) is not asked twice.
		Live::Fs(_) => report
			.lost
			.push(Lost::Pending { vpid, kind: FileKind::Regular }),
		// zftp's traffic on its sockets.
		Live::Zftp(_) => report
			.lost
			.push(Lost::Pending { vpid, kind: FileKind::Socket }),
		_ => {},
	}
	let io = sc.io.as_deref();
	ScratchImage {
		ext_live: matches!(sc.live, Live::Ext(_)),
		logs: sc.logs.clone(),
		sub: sc.sub.as_ref().map(|s| match s {
			PendingSub::Fork { vpid, capture } => {
				SubImage::Fork { vpid: *vpid, capture: fds.capture(capture) }
			},
			PendingSub::NoFork { value, capture } => {
				SubImage::NoFork { value: *value, capture: fds.capture(capture) }
			},
			PendingSub::Here { status } => SubImage::Here { status: *status },
			PendingSub::Math { status, slot } => {
				SubImage::Math { status: *status, slot: *slot as u8 }
			},
		}),
		exec,
		redir_done: io.map_or(0, |io| io.redir.done),
		redir_target: io.and_then(|io| io.redir.target.clone()),
		redir_more: io
			.and_then(|io| io.zsh.as_ref())
			.map_or_default(|z| z.more.clone()),
		probes: sc.probes().to_vec(),
		probing: sc.probing().cloned(),
		input: io.map_or_default(|io| io.input.clone()),
		saved: saved_image(io.map_or_default(|io| io.saved.as_slice()), fds),
		children: sc.children.clone(),
		inline: sc.inline,
	}
}

impl Shell {
	/// Write the shell's transient state to the store: dirty root records,
	/// the unit blobs live frames and function records reference, and the
	/// `Frames` blob. The shell keeps running afterwards; see
	/// [`crate::bash::snapshot`] for when the result is complete and what it
	/// reports as lost.
	///
	/// # Errors
	///
	/// [`ExtError::Store`] when the store fails, [`ExtError::Encode`] when
	/// serialization fails.
	pub fn externalize(&mut self, cx: &mut Cx<'_>) -> Result<ExternalizeReport, ExtError> {
		self.see_epoch(cx);
		// Subshells a host submitted since the last step become vprocs (and
		// proc records) first.
		self.adopt(cx);
		self.k.sync_root(cx.store, &self.procs[0]);
		// The root's frames pop every scope they pushed: a restored shell
		// must count the empty ones too.
		self.k.root.materialize(cx.store);
		if let Some(err) = self.k.root.take_fault() {
			return Err(ExtError::Store(err));
		}
		let mut report = ExternalizeReport {
			reissued_fs: std::mem::take(&mut self.k.dropped_fs),
			..ExternalizeReport::default()
		};
		// Function bodies: a restored shell loads them by id rather than
		// recompiling the canonical text, which would lose the definition's
		// line numbers.
		let mut funcs = Vec::new();
		cx.store.scan(Table::Func, &mut |_, rec| {
			if let Record::Func { unit, .. } = rec {
				funcs.push(*unit);
			}
		})?;
		for ov in self.procs.iter().filter_map(|p| p.overlay.as_ref()) {
			for rec in ov.records.values().flatten() {
				if let Record::Func { unit, .. } = rec {
					funcs.push(*unit);
				}
			}
		}
		for id in funcs {
			if !self.k.written.contains(&id)
				&& let Some(unit) = self.k.engine.cached(&id)
			{
				let bytes = postcard::to_stdvec(&*unit).map_err(ExtError::Encode)?;
				cx.store.put_blob(BlobSlot::Unit(id), &bytes)?;
				self.k.note_written(id);
				report.units_written += 1;
			}
		}
		let mut procs = Vec::with_capacity(self.procs.len());
		let mut runs = Vec::new();
		let mut fds = FdImager::default();
		for p in &mut self.procs {
			let mut frames = Vec::with_capacity(p.frames.len());
			for f in &mut p.frames {
				if let Some(unit) = &f.unit
					&& self.k.note_written(unit.id)
				{
					let bytes = postcard::to_stdvec(&**unit).map_err(ExtError::Encode)?;
					cx.store.put_blob(BlobSlot::Unit(unit.id), &bytes)?;
					report.units_written += 1;
				}
				let scratch = f
					.scratch
					.as_mut()
					.map(|sc| scratch_image(sc, p.vpid, &mut report, &mut fds));
				frames.push(FrameImage {
					unit: f.unit.as_ref().map(|u| u.id),
					pc: f.pc,
					kind: f.kind.clone(),
					loops: f.loops.clone(),
					enters: f.enters.clone(),
					cases: f.cases.clone(),
					times: f.times.clone(),
					redirs: f.redirs.iter().map(|r| saved_image(r, &mut fds)).collect(),
					scratch,
					line_shift: f.line_shift,
					debug_pc: f.debug_pc,
					debug_trap_local: f.debug_trap_local,
					err_trap_local: f.err_trap_local,
					return_trap_local: f.return_trap_local,
					trace_local: f.trace_local,
					debug_errexit: f.debug_errexit,
					err_reported: f.err_reported,
					ignore_errexit: f.ignore_errexit,
					subshell_line: f.subshell_line,
					getopts: f.getopts.as_deref().cloned().unwrap_or_default(),
				});
			}
			for (fd, h) in p.fds.iter() {
				if h.origin() == FdOrigin::Host
					&& let Some(kind) = h.kind()
				{
					report.lost.push(Lost::Fd { vpid: p.vpid, fd, kind });
				}
			}
			let slots = p
				.fds
				.slots()
				.iter()
				.map(|s| s.as_ref().map(|h| fds.fd(h)))
				.collect();
			runs.extend(p.runs.iter().map(|r| r.id));
			let command = match &p.command {
				Some((unit, node)) => {
					if self.k.note_written(unit.id) {
						let bytes = postcard::to_stdvec(&**unit).map_err(ExtError::Encode)?;
						cx.store.put_blob(BlobSlot::Unit(unit.id), &bytes)?;
						report.units_written += 1;
					}
					Some((unit.id, *node))
				},
				None => None,
			};
			let fields = p.overlay.as_ref().map(|overlay| Fields {
				scopes:     p.scopes.clone(),
				cwd:        p.cwd.clone(),
				status:     p.status,
				pipestatus: p.pipestatus.clone(),
				overlay:    overlay.clone(),
				jobs:       p.jobs.clone(),
				last_bg:    p.last_bg,
				getopts:    p.getopts.clone(),
				rlimits:    p.rlimits.clone(),
			});
			procs.push(ProcImage {
				vpid: p.vpid,
				parent: p.parent,
				runs: p.runs.iter().map(run_image).collect(),
				frames,
				fds: slots,
				fields,
				out: p.out.iter().cloned().collect(),
				pending_traps: p.pending_traps,
				stopped: p.stopped,
				transient: p.transient,
				exit_trap_run: p.exit_trap_run,
				procsubs: p.procsubs.clone(),
				coprocs: p.coprocs.clone(),
				restore_opts: p.restore_opts.clone(),
				trace_base: p.trace_base,
				subshell: p.subshell,
				command,
				calls: p.calls.clone(),
				own_traps: p.own_traps,
				mode: p.mode,
				zsh: p.zsh.clone(),
				lineage: p.lineage,
				blocked: p.blocked.as_ref().map(|b| (b.key.clone(), b.at)),
			});
		}
		let k = &self.k;
		let header = Header {
			magic: MAGIC,
			ir: IR_VERSION,
			frames: FRAMES_VERSION,
			build: Engine::build_id(),
			runs,
		};
		let image = Image {
			seq: k.seq,
			next_run: k.next_run,
			next_call: k.next_call,
			next_cmd: k.next_cmd,
			paused: k.paused,
			mask: k.mask.bits(),
			rr: self.rr as u32,
			slice: self.slice,
			wakes: k.ctl.wakes(),
			done: k.done.iter().copied().collect(),
			results: k.results.iter().map(|(id, o)| (*id, o.clone())).collect(),
			procs,
			fd_objs: fds.objs,
			mems: fds.mems,
			bangs: k.bangs.clone(),
			deferrals: k.deferrals.clone(),
		};
		let mut bytes = postcard::to_stdvec(&header).map_err(ExtError::Encode)?;
		bytes.extend_from_slice(&postcard::to_stdvec(&image).map_err(ExtError::Encode)?);
		cx.store.put_blob(BlobSlot::Frames, &bytes)?;
		report.bytes = bytes.len();
		Ok(report)
	}

	/// Re-attach to a store that holds root state (and possibly a `Frames`
	/// blob) — after a heap restore, in any process. The frames blob is
	/// consumed (deleted) on success.
	///
	/// Externals in flight are lost (their waiters see 137 and a `Lost`
	/// event); tasks resume through
	/// [`Host::restore_task`](crate::bash::Host::restore_task) when they left a
	/// checkpoint; host-supplied fds read EOF and fail writes; pending
	/// idempotent fs operations are re-issued; pending callouts stay pending.
	///
	/// # Errors
	///
	/// [`RestoreError::Incompatible`] for frames of another IR version or
	/// engine build (retry with `drop_frames`), [`RestoreError::Corrupt`] /
	/// [`RestoreError::InvalidUnit`] for undecodable or inconsistent blobs,
	/// [`RestoreError::MissingUnit`], [`RestoreError::Store`].
	pub fn restore(
		engine: &Arc<Engine>,
		cx: &mut Cx<'_>,
		opts: RestoreOpts,
	) -> Result<(Self, RestoreReport), RestoreError> {
		let root = Root::load(cx.store)?;
		let argv0 = state::root_misc(cx.store, MiscKey::Argv0)?
			.map_or_else(|| BString::from("bash"), BString::from);
		let shell_pid = parse_misc(cx.store, MiscKey::ShellPid)?.unwrap_or(0);
		let mode = state::root_misc(cx.store, MiscKey::Mode)?
			.and_then(|m| std::str::from_utf8(m).ok())
			.and_then(|m| m.parse().ok())
			.unwrap_or_default();
		let cwd = state::root_misc(cx.store, MiscKey::Cwd)?
			.map_or_else(|| BString::from("/"), BString::from);
		let mut k = Kernel::new(engine, root, argv0, shell_pid);
		// The counters a shell restored from the store alone continues
		// (`Shell::create` wrote them; the root vproc took the first vpid).
		let base = engine.config().vpid_base;
		k.next_vpid = parse_misc(cx.store, MiscKey::NextVpid)?.unwrap_or(base + 1);
		k.written_vpid = k.next_vpid;
		k.next_job = parse_misc(cx.store, MiscKey::NextJob)?.unwrap_or(1);
		k.rand = state::root_misc(cx.store, MiscKey::Random)?
			.and_then(state::Random::decode)
			.unwrap_or_default();
		k.start_ns = match parse_misc(cx.store, MiscKey::StartNs)? {
			Some(ns) => ns,
			None => cx.host.now_ns(),
		};
		// The overlays restored below may hold DEBUG/ERR/RETURN actions a
		// subshell set: `start_trap` takes its full path for them.
		k.pseudo_traps.note_all();
		let mut stdio = [None, None, None];
		let mut root_vp =
			Vproc::new(Vpid(base), None, host_stdio(cx.host, &mut stdio), cwd, None, false);
		root_vp.mode = mode;
		state::load_root(&mut k.root, cx.store, &mut root_vp)?;
		let mut shell = Self {
			k,
			procs: vec![Box::new(root_vp)],
			rr: 0,
			slice: None,
			gone: Vec::new(),
			orphans: Vec::new(),
		};
		let mut report = RestoreReport::default();
		let mut restored = false;
		if let Some(bytes) = cx.store.get_blob(BlobSlot::Frames)? {
			let (header, body) =
				postcard::take_from_bytes::<Header>(&bytes).map_err(RestoreError::Corrupt)?;
			if opts.drop_frames {
				for &run in &header.runs {
					shell.k.done.push_back((run, 255));
					shell.k.next_run = shell.k.next_run.max(run.0 + 1);
				}
				report.abandoned = header.runs;
			} else {
				check(&header).map_err(|why| RestoreError::Incompatible { why })?;
				let image: Image = postcard::from_bytes(body).map_err(RestoreError::Corrupt)?;
				shell.apply(engine, cx, image, &mut stdio, &mut report)?;
				shell.seed_orphans();
				restored = true;
			}
			cx.store.del_blob(BlobSlot::Frames)?;
		}
		if !restored {
			shell.lose_running(cx, &mut report)?;
		}
		shell.k.sync_root(cx.store, &shell.procs[0]);
		if let Some(err) = shell.k.root.take_fault() {
			return Err(RestoreError::Store(err));
		}
		reinstall_signal_traps(cx)?;
		let root = (shell.procs[0].vpid, shell.procs[0].mode);
		shell
			.k
			.emit(cx, root, None, EventData::Restored { report: &report });
		Ok((shell, report))
	}

	fn apply(
		&mut self,
		engine: &Engine,
		cx: &mut Cx<'_>,
		img: Image,
		stdio: &mut [Option<FdRef>; 3],
		report: &mut RestoreReport,
	) -> Result<(), RestoreError> {
		// The root vproc as `restore` loaded it from the store: the image
		// holds its execution position, the store its fields.
		let loaded = self
			.procs
			.pop()
			.expect("restore starts with the root vproc");
		let k = &mut self.k;
		k.seq = img.seq;
		k.next_run = img.next_run;
		k.next_call = img.next_call;
		k.next_cmd = img.next_cmd;
		k.paused = img.paused;
		k.mask = EventMask::from_bits(img.mask);
		k.ctl.restore_wakes(img.wakes);
		k.done = img.done.into();
		k.results = img.results.into_iter().collect();
		// Only a restored vproc still decides (a job that never settles
		// would hold its `$!` readers forever).
		k.bangs = img
			.bangs
			.into_iter()
			.filter(|b| img.procs.iter().any(|p| p.vpid == b.vproc))
			.collect();
		k.deferrals = img
			.deferrals
			.into_iter()
			.filter(|d| img.procs.iter().any(|p| p.vpid == d.vproc))
			.collect();
		let built = (0..img.fd_objs.len()).map(|_| None).collect();
		let mut objs = FdRebuild {
			objs: img.fd_objs,
			mems: img
				.mems
				.into_iter()
				.map(|m| MemObj::rebuild(m, &k.waker))
				.collect(),
			built,
			stdio,
		};
		let mut procs = Vec::with_capacity(img.procs.len());
		for p in img.procs {
			let vpid = p.vpid;
			let mut fds = FdTable::default();
			for (fd, obj) in p.fds.into_iter().enumerate() {
				if let Some(obj) = obj {
					if let Some(kind) = objs.host_kind(obj) {
						report.lost.push(Lost::Fd { vpid, fd: fd as i32, kind });
					}
					fds.set(fd as i32, Some(objs.fd(cx.host, obj)));
				}
			}
			let mut vp = if let Some(f) = p.fields {
				let mut vp = Vproc::new(vpid, p.parent, fds, f.cwd, Some(f.overlay), p.transient);
				vp.scopes = f.scopes;
				vp.status = f.status;
				vp.pipestatus = f.pipestatus;
				vp.jobs = f.jobs;
				vp.last_bg = f.last_bg;
				vp.getopts = f.getopts;
				vp.rlimits = f.rlimits;
				vp
			} else {
				let mut vp = Vproc::new(vpid, p.parent, fds, loaded.cwd.clone(), None, p.transient);
				vp.status = loaded.status;
				vp.pipestatus.clone_from(&loaded.pipestatus);
				vp.jobs.clone_from(&loaded.jobs);
				vp.last_bg = loaded.last_bg;
				vp.getopts.clone_from(&loaded.getopts);
				vp.rlimits.clone_from(&loaded.rlimits);
				vp
			};
			vp.out = p.out.into();
			vp.pending_traps = p.pending_traps;
			vp.stopped = p.stopped;
			vp.exit_trap_run = p.exit_trap_run;
			vp.procsubs = p.procsubs;
			vp.coprocs = p.coprocs;
			vp.restore_opts = p.restore_opts;
			vp.trace_base = p.trace_base;
			vp.subshell = p.subshell;
			vp.calls = p.calls;
			vp.own_traps = p.own_traps;
			vp.mode = p.mode;
			vp.zsh = p.zsh;
			vp.lineage = p.lineage;
			if let Some((id, node)) = p.command {
				let unit = load_unit(
					engine,
					cx.store,
					id,
					k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
				)?;
				k.note_written(unit.id);
				vp.command = Some((unit, node));
			}
			// Waits on engine objects whose wake-ups were restored (child
			// vprocs, jobs, in-memory pipes) keep their mark, so scheduling
			// matches the plain run. Every other source (externals,
			// callouts, tasks, fs, host files) was dropped or replaced by
			// the restore: an `at` the count never holds retries it once.
			let blocked = p.blocked.map(|(key, at)| {
				let exact = match &key {
					WaitKey::Proc(_) | WaitKey::Job(_) => true,
					WaitKey::Read { fd } | WaitKey::Write { fd } => vp
						.fds
						.get(*fd)
						.is_some_and(|h| h.with_mem(|_| ()).is_some()),
					_ => false,
				};
				super::proc::Blocked { key, at: if exact { at } else { u64::MAX } }
			});
			vp.blocked = blocked;
			for r in p.runs {
				vp.runs.push_back(Run {
					id:                r.id,
					tag:               r.tag,
					src:               Arc::from(r.src.as_slice()),
					chain:             r.chain,
					mode:              r.mode,
					restore_mode:      r.restore_mode,
					explicit_mode:     r.explicit_mode,
					lossy:             r.lossy,
					args:              r.args,
					cwd:               r.cwd,
					env:               r.env,
					started:           r.started,
					exit_trap_started: r.exit_trap_started,
				});
			}
			report.runs += vp.runs.len() as u32;
			for f in p.frames {
				let unit = match f.unit {
					Some(id) => {
						let unit = load_unit(
							engine,
							cx.store,
							id,
							k.mask.contains(crate::bash::event::EventKind::UnitCompiled),
						)?;
						k.note_written(unit.id);
						let in_range = |pc: u32| (pc as usize) < unit.ops.len();
						if !in_range(f.pc)
							|| !f.loops.iter().all(|l| in_range(l.exit) && in_range(l.cont))
						{
							return Err(RestoreError::InvalidUnit { unit: id });
						}
						Some(unit)
					},
					None => None,
				};
				let scratch = match f.scratch {
					Some(img) => {
						let mut live = Live::None;
						let ext_live = img.ext_live;
						let exec = img.exec.map(|mut state| {
							match state.waiting {
								Some(Awaited::Task(native)) => match state.checkpoint.take() {
									Some(bytes) => match cx.host.restore_task(&native, &bytes) {
										Ok(task) => {
											live = Live::Task(task);
											report.tasks_resumed += 1;
										},
										Err(_) => report.lost.push(Lost::Task { vpid, native }),
									},
									None => report.lost.push(Lost::Task { vpid, native }),
								},
								Some(Awaited::Ext { pid }) if ext_live => {
									report.lost.push(Lost::Ext { vpid, pid });
								},
								Some(
									Awaited::Ext { .. }
									| Awaited::Call(_)
									| Awaited::Frame
									| Awaited::Jobs { .. }
									| Awaited::AllJobs
									| Awaited::AnyJob,
								)
								| None => {},
							}
							if state.stage == Stage::Lookup && state.target == Some(Target::Search) {
								report.reissued_fs += 1;
							}
							state
						});
						let saved = objs.saved(cx.host, img.saved);
						// I/O progress only where the image holds some
						// (`Scratch::io`).
						let io = if img.redir_done == 0
							&& img.redir_target.is_none()
							&& img.redir_more.is_empty()
							&& img.probes.is_empty()
							&& img.probing.is_none()
							&& img.input.is_empty()
							&& saved.is_empty()
						{
							None
						} else {
							Some(Box::new(ScratchIo {
								redir: RedirProgress {
									done:    img.redir_done,
									target:  img.redir_target,
									opening: None,
								},
								saved,
								probes: img.probes,
								probing: img.probing,
								search: None,
								input: img.input,
								walk: None,
								zsh: (!img.redir_more.is_empty()).then(|| {
									Box::new(ScratchZsh { more: img.redir_more, ..ScratchZsh::default() })
								}),
							}))
						};
						Some(Box::new(Scratch {
							logs: img.logs,
							sub: img.sub.map(|s| match s {
								SubImage::Fork { vpid, capture } => {
									PendingSub::Fork { vpid, capture: objs.capture(capture) }
								},
								SubImage::NoFork { value, capture } => {
									PendingSub::NoFork { capture: objs.capture(capture), value }
								},
								SubImage::Here { status } => PendingSub::Here { status },
								SubImage::Math { status, slot } => PendingSub::Math {
									status,
									slot: match slot {
										1 => super::proc::Slot::Redirs,
										2 => super::proc::Slot::Assigns,
										3 => super::proc::Slot::Builtin,
										_ => super::proc::Slot::Words,
									},
								},
							}),
							exec: exec.map(Box::new),
							io,
							live,
							children: img.children,
							inline: img.inline,
							..Scratch::default()
						}))
					},
					None => None,
				};
				let redirs = f
					.redirs
					.into_iter()
					.map(|r| objs.saved(cx.host, r))
					.collect();
				let mut frame = Frame::new(unit, f.pc, f.kind);
				frame.loops = f.loops;
				frame.enters = f.enters;
				frame.cases = f.cases;
				frame.times = f.times;
				frame.redirs = redirs;
				frame.scratch = scratch;
				frame.line_shift = f.line_shift;
				frame.debug_pc = f.debug_pc;
				frame.debug_trap_local = f.debug_trap_local;
				frame.err_trap_local = f.err_trap_local;
				frame.return_trap_local = f.return_trap_local;
				frame.trace_local = f.trace_local;
				frame.debug_errexit = f.debug_errexit;
				frame.err_reported = f.err_reported;
				frame.ignore_errexit = f.ignore_errexit;
				frame.subshell_line = f.subshell_line;
				frame.getopts =
					(f.getopts != super::proc::GetoptsState::default()).then(|| Box::new(f.getopts));
				if matches!(frame.kind, FrameKind::Script { what: ScriptKind::Trap { .. }, .. }) {
					vp.trap_frames += 1;
				}
				vp.frames.push(frame);
			}
			procs.push(Box::new(vp));
		}
		if procs.is_empty() {
			self.procs.push(loaded);
			return Ok(());
		}
		report.vprocs = procs.len() as u32;
		self.procs = procs;
		self.rr = (img.rr as usize).min(self.procs.len() - 1);
		self.slice = img.slice;
		Ok(())
	}

	/// Restored without frames: a child vproc the store lists as running has
	/// no execution position; it is lost (status 137, its job done, a
	/// [`Lost::Vproc`] entry). Records of children of vprocs that are gone
	/// (subshells' children) are dropped, and so are the root's function
	/// scopes (the calls they belonged to are gone).
	fn lose_running(
		&mut self,
		cx: &mut Cx<'_>,
		report: &mut RestoreReport,
	) -> Result<(), StoreError> {
		self.k.root.drop_scopes(cx.store);
		let root = self.procs[0].vpid;
		let mut children = Vec::new();
		cx.store.scan(Table::Proc, &mut |key, rec| {
			if let (Key::Proc(vpid), Record::Proc { parent, status }) = (key, rec) {
				children.push((vpid, *parent, *status));
			}
		})?;
		children.sort_unstable_by_key(|(vpid, ..)| *vpid);
		for (vpid, parent, status) in children {
			if parent != Some(root) {
				self.k.root.write(cx.store, Change::Del(Key::Proc(vpid)));
			} else if status.is_none() {
				report.lost.push(Lost::Vproc { vpid });
				self.k.proc_exited(cx.store, vpid, parent, 137);
				if let Some(job) = self.procs[0].jobs.by_vpid_mut(vpid) {
					job.state = JobState::Done(137);
					job.notified = false;
				}
			}
		}
		Ok(())
	}
}

/// Give the host the OS disposition of every trapped or ignored signal in
/// the root trap table: a restore in a new process starts with default
/// dispositions (handlers do not survive `exec`), so a trapped signal
/// would otherwise kill it. `KILL` and `STOP` cannot be trapped; `CHLD`
/// traps run from the engine (one per reaped child), with no OS handler,
/// as the `trap` builtin sets them.
///
/// # Errors
///
/// [`RestoreError::Store`] when the trap table cannot be read,
/// [`RestoreError::SignalSetup`] when the host refuses a disposition.
fn reinstall_signal_traps(cx: &mut Cx<'_>) -> Result<(), RestoreError> {
	let mut traps = Vec::new();
	cx.store.scan(Table::Trap, &mut |key, rec| {
		if let (Key::Trap(TrapKey::Signal(sig)), Record::Trap { action, .. }) = (key, rec)
			&& !matches!(sig, Signal::Kill | Signal::Stop | Signal::Chld)
		{
			traps.push((sig, action.clone()));
		}
	})?;
	for (sig, action) in traps {
		// `Ok(false)`: ignored on entry, which the trap table already says.
		cx.host
			.set_signal_trap(sig, Some(BStr::new(&action)))
			.map_err(|source| RestoreError::SignalSetup { sig, source })?;
	}
	Ok(())
}

fn run_image(r: &Run) -> RunImage {
	RunImage {
		id:                r.id,
		tag:               r.tag,
		src:               BString::from(&*r.src),
		chain:             r.chain.clone(),
		mode:              r.mode,
		restore_mode:      r.restore_mode,
		explicit_mode:     r.explicit_mode,
		lossy:             r.lossy,
		args:              r.args.clone(),
		cwd:               r.cwd.clone(),
		env:               r.env.clone(),
		started:           r.started,
		exit_trap_started: r.exit_trap_started,
	}
}

fn check(h: &Header) -> Result<(), Incompatibility> {
	if h.magic != MAGIC {
		return Err(Incompatibility::Magic);
	}
	if h.ir != IR_VERSION {
		return Err(Incompatibility::IrVersion { found: h.ir, expected: IR_VERSION });
	}
	if h.frames != FRAMES_VERSION || h.build != Engine::build_id() {
		return Err(Incompatibility::Build);
	}
	Ok(())
}

/// A decimal root `Misc` value.
fn parse_misc<T: std::str::FromStr>(
	store: &mut dyn StateStore,
	key: MiscKey,
) -> Result<Option<T>, StoreError> {
	Ok(state::root_misc(store, key)?
		.and_then(|v| std::str::from_utf8(v).ok())
		.and_then(|v| v.parse().ok()))
}

/// A unit by id: the engine cache, else the store's blob (validated).
/// Restore and calls of functions defined before a restore use it.
pub fn load_unit(
	engine: &Engine,
	store: &mut dyn StateStore,
	id: UnitId,
	observed: bool,
) -> Result<Arc<Unit>, RestoreError> {
	if let Some(unit) = engine.cached(&id) {
		return Ok(unit);
	}
	let bytes = store
		.get_blob(BlobSlot::Unit(id))?
		.ok_or(RestoreError::MissingUnit { unit: id })?;
	let unit: Unit = postcard::from_bytes(&bytes)
		.map_err(|source| RestoreError::CorruptUnit { unit: id, source })?;
	if unit.id != id || !valid(&unit) {
		return Err(RestoreError::InvalidUnit { unit: id });
	}
	let unit = if unit.deferred.is_some() {
		materialize(&unit, observed)
			.filter(valid)
			.ok_or(RestoreError::InvalidUnit { unit: id })?
	} else {
		unit
	};
	Ok(engine.intern(unit))
}

/// Every operand of every op and every index inside the side tables points
/// at an existing entry, so a decoded unit cannot make the VM index out of
/// bounds.
fn valid(u: &Unit) -> bool {
	if let Some(tree) = &u.deferred {
		return u.root.is_some() && (!tree.is_empty() || !u.source.is_empty()) && u.ops.is_empty();
	}
	let n = u.ops.len() as u32;
	let w_ok = |w: u32| (w as usize) < u.words.len();
	// Brace alternatives are plain words, so expansion cannot recurse.
	let braces_ok = u.words.iter().all(|w| {
		w.braces.as_ref().is_none_or(|alts| {
			alts.iter().all(|&a| {
				u.words
					.get(a as usize)
					.is_some_and(|alt| alt.braces.is_none())
			})
		})
	});
	let words_ok = braces_ok
		&& u.words.iter().all(|w| {
			w.parts.iter().all(|p| match p {
				Part::Lit(_)
				| Part::Quoted(_)
				| Part::Arith { .. }
				| Part::BadSubst(_)
				| Part::AnsiC(_)
				| Part::Zsh(_)
				| Part::ComsubSyntax { .. } => true,
				Part::Comsub { entry, .. } | Part::ProcSub { entry, .. } => *entry < n,
				Part::Compound(elems) => elems
					.iter()
					.all(|e| e.key.is_none_or(w_ok) && w_ok(e.value)),
				Part::Param(p) => {
					let index_ok = match p.index {
						Some(SubIr::Expr(w)) => w_ok(w),
						_ => true,
					};
					let op_ok = match &p.op {
						OpIr::Default { word, .. }
						| OpIr::Assign { word, .. }
						| OpIr::Alt { word, .. } => w_ok(*word),
						OpIr::Error { word, .. } => word.is_none_or(w_ok),
						OpIr::Trim { pat, .. } => w_ok(*pat),
						OpIr::Replace { pat, rep, .. } => w_ok(*pat) && rep.is_none_or(w_ok),
						OpIr::Case { pat, .. } => pat.is_none_or(w_ok),
						OpIr::None
						| OpIr::Length
						| OpIr::Indirect
						| OpIr::PrefixNames { .. }
						| OpIr::Substr { .. }
						| OpIr::Transform(_) => true,
					};
					index_ok && op_ok
				},
			})
		});
	let lists_ok = u.lists.iter().all(|l| l.iter().all(|&w| w_ok(w)));
	let pats_ok = u.pats.iter().all(|l| l.iter().all(|&w| w_ok(w)));
	let cmds_ok = u.cmds.iter().all(|c| {
		(c.words as usize) < u.lists.len()
			&& c.redirs.is_none_or(|r| (r as usize) < u.redirs.len())
			&& c.assigns.iter().all(|a| {
				a.index.is_none_or(w_ok)
					&& match &a.value {
						AssignVal::Scalar(w) => w_ok(*w),
						AssignVal::Array(elems) => elems
							.iter()
							.all(|e| e.key.is_none_or(w_ok) && w_ok(e.value)),
					}
			})
	});
	let redirs_ok = u.redirs.iter().all(|l| {
		l.iter().all(|r| match r.target {
			RedirTargetIr::Word(w) => w_ok(w),
			RedirTargetIr::HereDoc { .. } => true,
		})
	});
	let spawns_ok = u.spawns.iter().all(|s| {
		s.end < n
			&& !s.stages.is_empty()
			&& s.stages.iter().all(|st| st.entry < n)
			&& match s.kind {
				SpawnKind::Coproc { name } => (name as usize) < u.names.len(),
				SpawnKind::Subshell | SpawnKind::Pipeline | SpawnKind::Background => true,
			}
	});
	let conds_ok = u.conds.iter().all(|c| match c {
		CondIr::Unary { arg, .. } => w_ok(*arg),
		CondIr::Binary { lhs, rhs, .. } => w_ok(*lhs) && w_ok(*rhs),
		CondIr::Word(w) => w_ok(*w),
	});
	let funcs_ok = u.funcs.iter().all(|f| valid(&f.body));
	let ops_ok = u.ops.iter().enumerate().all(|(pc, op)| {
		let node_ok = u.nodes.is_empty()
			|| (op.node as usize) < u.nodes.len()
			|| matches!(op.code, Opcode::Abort | Opcode::Warn);
		let idx = |len: usize| (op.a as usize) < len;
		node_ok
			&& match op.code {
				Opcode::Exec => idx(u.cmds.len()),
				Opcode::Jmp | Opcode::BrOk | Opcode::BrFail | Opcode::LoopBack | Opcode::ForNext => {
					op.a < n
				},
				Opcode::Repeat => idx(u.words.len()) && pc + 1 < u.ops.len(),
				Opcode::TryEnter => op.a < n && op.b <= n,
				Opcode::CallAnon => idx(u.funcs.len()) && (op.b as usize) < u.lists.len(),
				Opcode::LoopEnter => op.a < n && op.b < n,
				Opcode::ForIn => {
					(op.a == Op::POSITIONAL || idx(u.lists.len()))
						&& (op.b as usize) < u.names.len()
						&& pc + 1 < u.ops.len()
				},
				Opcode::Redir => idx(u.redirs.len()) && op.b < n,
				Opcode::Spawn => idx(u.spawns.len()),
				Opcode::CaseWord => idx(u.words.len()),
				Opcode::CaseArm => idx(u.pats.len()) && op.b < n,
				Opcode::Arith => idx(u.ariths.len()),
				Opcode::CondTest => idx(u.conds.len()),
				Opcode::FuncDef => idx(u.funcs.len()) && (op.b as usize) <= u.lists.len(),
				Opcode::Warn => idx(u.strs.len()),
				Opcode::Abort => {
					idx(u.strs.len())
						&& (op.flags & Op::CONTEXT == 0 || (op.a as usize) + 1 < u.strs.len())
				},
				Opcode::Nop
				| Opcode::Not
				| Opcode::SetStatus
				| Opcode::Enter
				| Opcode::Leave
				| Opcode::LoopNote
				| Opcode::LoopExit
				| Opcode::PopRedir
				| Opcode::SubExit
				| Opcode::CaseEnd
				| Opcode::TimeStart
				| Opcode::TimeEnd
				| Opcode::AlwaysEnter
				| Opcode::AlwaysEnd
				| Opcode::End => true,
			}
	});
	n > 0
		&& words_ok
		&& lists_ok
		&& pats_ok
		&& cmds_ok
		&& redirs_ok
		&& spawns_ok
		&& conds_ok
		&& funcs_ok
		&& ops_ok
}

#[cfg(test)]
mod tests {
	use std::task::{Context, Poll, Waker};

	use super::{FdImager, FdRebuild};
	use crate::bash::{fd::FdRef, mem::MemObj};

	#[test]
	fn a_pipe_and_its_shared_ends_survive_an_image() {
		let (r, w) = crate::bash::mem::pipe();
		let (r, w) = (FdRef::mem(r), FdRef::mem(w));
		let w2 = w.dup().unwrap();
		let mut cx = Context::from_waker(Waker::noop());
		assert!(matches!(w.poll_write(&mut cx, b"ab"), Poll::Ready(Ok(2))));
		let mut img = FdImager::default();
		// Slots 1 and 2 share one fd object; `w2` is a duplicate of it.
		let ids = [img.fd(&r), img.fd(&w), img.fd(&w), img.fd(&w2)];
		assert_eq!(ids[1], ids[2], "one fd object has one index");
		assert_ne!(ids[1], ids[3], "a duplicate is its own fd object");
		assert_eq!(img.mems.len(), 1, "every end refers to one pipe");
		drop((r, w, w2));
		let mut stdio = [None, None, None];
		let mut back = FdRebuild {
			built: vec![None; img.objs.len()],
			objs:  img.objs,
			mems:  img
				.mems
				.into_iter()
				.map(|m| MemObj::rebuild(m, Waker::noop()))
				.collect(),
			stdio: &mut stdio,
		};
		let [r, w, w_again, w2] = ids.map(|i| back.build(i, |_| None));
		// The rebuild table holds every built fd until restore ends.
		drop(back);
		assert!(w.same(&w_again), "shared slots stay shared");
		let mut buf = [0; 4];
		assert!(matches!(r.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(2))));
		assert_eq!(&buf[..2], b"ab", "buffered bytes come back");
		drop((w, w_again));
		assert!(r.poll_read(&mut cx, &mut buf).is_pending(), "the duplicate writer keeps it open");
		drop(w2);
		assert!(matches!(r.poll_read(&mut cx, &mut buf), Poll::Ready(Ok(0))), "then EOF");
	}
}
