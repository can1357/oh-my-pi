use std::{
	io,
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
};

/// Linux lock held by an abstract Unix-domain socket binding.
pub struct PlatformFileLock {
	socket: Option<UnixDatagram>,
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let name = super::memory_lock_name(path);
	let address = SocketAddr::from_abstract_name(name.as_bytes())?;
	match UnixDatagram::bind_addr(&address) {
		Ok(socket) => Ok(Some(PlatformFileLock { socket: Some(socket) })),
		Err(error) if error.kind() == io::ErrorKind::AddrInUse => Ok(None),
		Err(error) => Err(error),
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.socket.take());
		Ok(())
	}
}
