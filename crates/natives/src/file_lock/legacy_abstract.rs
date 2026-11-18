use std::{
	io,
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
};

pub fn is_bound(path: &str) -> io::Result<bool> {
	let address = SocketAddr::from_abstract_name(super::memory_lock_name(path).as_bytes())?;
	match UnixDatagram::unbound()?.connect_addr(&address) {
		Ok(()) => Ok(true),
		Err(error)
			if matches!(
				error.kind(),
				io::ErrorKind::ConnectionRefused | io::ErrorKind::PermissionDenied
			) =>
		{
			Ok(false)
		},
		Err(error) => Err(error),
	}
}
