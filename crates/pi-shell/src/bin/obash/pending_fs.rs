//! `PI_SHELL_FS=pending`: every filesystem operation answers `Pending` at
//! least once before completing, so a conformance harness can check that the
//! engine never blocks on (or depends on the timing of) an fs answer.

use std::{
	io,
	task::{Context, Poll},
};

use bstr::BString;
use pi_shell::bash::{
	At, File, Fs, FsPending, FsPoll, HeldDir, OpenFlags, Stat,
	fs::{Access, DirIter, TempNode, TempPurpose},
};

/// An answer that is `Pending` on its first poll (waking at once), then
/// whatever the wrapped answer is.
struct Deferred<T> {
	inner:  Inner<T>,
	waited: bool,
}

enum Inner<T> {
	Ready(Option<io::Result<T>>),
	Pending(Box<dyn FsPending<T>>),
}

impl<T: Send> FsPending<T> for Deferred<T> {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
		if !self.waited {
			self.waited = true;
			cx.waker().wake_by_ref();
			return Poll::Pending;
		}
		match &mut self.inner {
			Inner::Ready(res) => Poll::Ready(
				res.take()
					.unwrap_or_else(|| Err(io::ErrorKind::Other.into())),
			),
			Inner::Pending(p) => p.poll(cx),
		}
	}
}

fn defer<T: Send + 'static>(poll: FsPoll<T>) -> FsPoll<T> {
	let inner = match poll {
		FsPoll::Ready(res) => Inner::Ready(Some(res)),
		FsPoll::Pending(p) => Inner::Pending(p),
	};
	FsPoll::Pending(Box::new(Deferred { inner, waited: false }))
}

/// A filesystem whose every operation is deferred once.
pub struct PendingFs<F>(pub F);

impl<F: Fs> Fs for PendingFs<F> {
	fn open(&mut self, at: At<'_>, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		defer(self.0.open(at, flags, mode))
	}

	fn stat(&mut self, at: At<'_>, follow: bool) -> FsPoll<Stat> {
		defer(self.0.stat(at, follow))
	}

	fn access(&mut self, at: At<'_>, mode: Access) -> FsPoll<()> {
		defer(self.0.access(at, mode))
	}

	fn read_dir(&mut self, at: At<'_>) -> FsPoll<Box<dyn DirIter>> {
		defer(self.0.read_dir(at))
	}

	fn readlink(&mut self, at: At<'_>) -> FsPoll<BString> {
		defer(self.0.readlink(at))
	}

	fn realpath(&mut self, at: At<'_>) -> FsPoll<BString> {
		defer(self.0.realpath(at))
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		defer(self.0.mkfifo_or_temp(purpose))
	}

	fn open_dir(&mut self, at: At<'_>) -> FsPoll<Option<HeldDir>> {
		defer(self.0.open_dir(at))
	}

	fn dir_path(&mut self, dir: &HeldDir) -> FsPoll<BString> {
		defer(self.0.dir_path(dir))
	}
}
