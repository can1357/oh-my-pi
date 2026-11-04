//! `PI_SHELL_FS=pending`: every filesystem operation answers `Pending` at
//! least once before completing, so a conformance harness can check that the
//! engine never blocks on (or depends on the timing of) an fs answer.

use std::{
	io,
	task::{Context, Poll},
};

use bstr::{BStr, BString};
use pi_shell::bash::{
	File, Fs, FsPending, FsPoll, OpenFlags, Stat,
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
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		defer(self.0.open(path, flags, mode))
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		defer(self.0.stat(path, follow))
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		defer(self.0.access(path, mode))
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		defer(self.0.read_dir(path))
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		defer(self.0.readlink(path))
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		defer(self.0.realpath(path))
	}

	fn mkfifo_or_temp(&mut self, purpose: TempPurpose) -> FsPoll<TempNode> {
		defer(self.0.mkfifo_or_temp(purpose))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		defer(self.0.chdir_check(path))
	}
}
