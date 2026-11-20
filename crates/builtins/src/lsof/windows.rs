//! Open files on Windows: each process's executable (`txt`) and its TCP/UDP
//! endpoints from the IP Helper owner-PID tables (`GetExtendedTcpTable`,
//! `GetExtendedUdpTable`). Handle enumeration is not attempted, so regular
//! files and the working directory are never listed.

use std::{
	collections::HashMap,
	ffi::c_void,
	net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

use super::{Entry, Fd, Inet, Listing, Node, Proto};
use crate::proc_snapshot::{ProcInfo, sys};

/// `MIB_TCP_STATE` names in code order (1-based).
pub(super) const TCP_STATES: &[&str] = &[
	"CLOSED",
	"LISTEN",
	"SYN_SENT",
	"SYN_RCVD",
	"ESTABLISHED",
	"FIN_WAIT1",
	"FIN_WAIT2",
	"CLOSE_WAIT",
	"CLOSING",
	"LAST_ACK",
	"TIME_WAIT",
	"DELETE_TCB",
];

/// UDP endpoints have no states.
pub(super) const UDP_STATES: &[&str] = &[];

pub(super) fn command_name(process: &ProcInfo) -> String {
	process.command_name()
}

pub(super) const fn normalize_dev(dev: u64) -> u64 {
	dev
}

const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;
const TCP_TABLE_OWNER_PID_ALL: u32 = 5;
const UDP_TABLE_OWNER_PID: u32 = 1;
const NO_ERROR: u32 = 0;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const MIB_TCP_STATE_LISTEN: u32 = 2;

#[link(name = "iphlpapi")]
unsafe extern "system" {
	fn GetExtendedTcpTable(
		table: *mut c_void,
		size: *mut u32,
		order: i32,
		family: u32,
		class: u32,
		reserved: u32,
	) -> u32;
	fn GetExtendedUdpTable(
		table: *mut c_void,
		size: *mut u32,
		order: i32,
		family: u32,
		class: u32,
		reserved: u32,
	) -> u32;
}

/// `MIB_TCPROW_OWNER_PID`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "IP Helper ABI record; only some fields are read")]
struct TcpRow {
	state:       u32,
	local_addr:  u32,
	local_port:  u32,
	remote_addr: u32,
	remote_port: u32,
	pid:         u32,
}

/// `MIB_TCP6ROW_OWNER_PID`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "IP Helper ABI record; only some fields are read")]
struct Tcp6Row {
	local_addr:   [u8; 16],
	local_scope:  u32,
	local_port:   u32,
	remote_addr:  [u8; 16],
	remote_scope: u32,
	remote_port:  u32,
	state:        u32,
	pid:          u32,
}

/// `MIB_UDPROW_OWNER_PID`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "IP Helper ABI record; only some fields are read")]
struct UdpRow {
	local_addr: u32,
	local_port: u32,
	pid:        u32,
}

/// `MIB_UDP6ROW_OWNER_PID`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "IP Helper ABI record; only some fields are read")]
struct Udp6Row {
	local_addr:  [u8; 16],
	local_scope: u32,
	local_port:  u32,
	pid:         u32,
}

type TableFn = unsafe extern "system" fn(*mut c_void, *mut u32, i32, u32, u32, u32) -> u32;

/// The rows of one owner-PID table: a `u32` count, then `R` records.
fn table<R: Copy>(query: TableFn, family: u32, class: u32) -> Vec<R> {
	let mut size = 0u32;
	let mut buffer: Vec<u64> = Vec::new();
	for _ in 0..8 {
		let bytes = size_of_val(buffer.as_slice()) as u32;
		size = size.max(bytes);
		// SAFETY: buffer is writable for `bytes` bytes (null when empty); the
		// call writes at most `size`, and reports the size it needs.
		let status = unsafe {
			query(
				if buffer.is_empty() { std::ptr::null_mut() } else { buffer.as_mut_ptr().cast() },
				&raw mut size,
				0,
				family,
				class,
				0,
			)
		};
		match status {
			NO_ERROR if !buffer.is_empty() => {
				let bytes = buffer.as_ptr().cast::<u8>();
				let available = size_of_val(buffer.as_slice());
				// SAFETY: the table starts with its entry count.
				let count = unsafe { bytes.cast::<u32>().read_unaligned() } as usize;
				let fits = available.saturating_sub(4) / size_of::<R>();
				return (0..count.min(fits))
					.map(|index| {
						// SAFETY: row `index` lies inside the buffer (bounded by `fits`).
						unsafe { bytes.add(4 + index * size_of::<R>()).cast::<R>().read_unaligned() }
					})
					.collect();
			},
			NO_ERROR | ERROR_INSUFFICIENT_BUFFER => {
				buffer = vec![0u64; (size as usize).div_ceil(8) + 1];
			},
			_ => return Vec::new(),
		}
	}
	Vec::new()
}

/// A port kept in network order in the low 16 bits of a `DWORD`.
fn port(value: u32) -> u16 {
	u16::from_be(value as u16)
}

fn v4(address: u32) -> IpAddr {
	IpAddr::V4(Ipv4Addr::from(address.to_ne_bytes()))
}

fn v6(address: [u8; 16]) -> IpAddr {
	IpAddr::V6(Ipv6Addr::from(address))
}

fn tcp_state(code: u32) -> Option<&'static str> {
	TCP_STATES.get(usize::try_from(code).ok()?.checked_sub(1)?).copied()
}

/// The endpoint tables, read once per run and grouped by owning pid.
pub(super) struct Scanner {
	endpoints: HashMap<i32, Vec<(bool, Inet)>>,
}

impl Scanner {
	pub(super) fn new() -> Self {
		let mut endpoints: HashMap<i32, Vec<(bool, Inet)>> = HashMap::new();
		let mut add = |pid: u32, is_v6: bool, inet: Inet| {
			if let Ok(pid) = i32::try_from(pid) {
				endpoints.entry(pid).or_default().push((is_v6, inet));
			}
		};
		for row in table::<TcpRow>(GetExtendedTcpTable, AF_INET, TCP_TABLE_OWNER_PID_ALL) {
			let remote = if row.state == MIB_TCP_STATE_LISTEN {
				(v4(0), 0)
			} else {
				(v4(row.remote_addr), port(row.remote_port))
			};
			let mut inet = Inet::new(Proto::Tcp, (v4(row.local_addr), port(row.local_port)), remote);
			inet.state = tcp_state(row.state);
			add(row.pid, false, inet);
		}
		for row in table::<Tcp6Row>(GetExtendedTcpTable, AF_INET6, TCP_TABLE_OWNER_PID_ALL) {
			let remote = if row.state == MIB_TCP_STATE_LISTEN {
				(v6([0; 16]), 0)
			} else {
				(v6(row.remote_addr), port(row.remote_port))
			};
			let mut inet = Inet::new(Proto::Tcp, (v6(row.local_addr), port(row.local_port)), remote);
			inet.state = tcp_state(row.state);
			add(row.pid, true, inet);
		}
		for row in table::<UdpRow>(GetExtendedUdpTable, AF_INET, UDP_TABLE_OWNER_PID) {
			add(row.pid, false, Inet::new(Proto::Udp, (v4(row.local_addr), port(row.local_port)), (v4(0), 0)));
		}
		for row in table::<Udp6Row>(GetExtendedUdpTable, AF_INET6, UDP_TABLE_OWNER_PID) {
			add(row.pid, true, Inet::new(Proto::Udp, (v6(row.local_addr), port(row.local_port)), (v6([0; 16]), 0)));
		}
		Self { endpoints }
	}

	/// The executable of `pid`, then its network endpoints.
	pub(super) fn files(&self, pid: i32, sockets_only: bool) -> Listing {
		let mut entries = Vec::new();
		if !sockets_only
			&& let Some(path) = executable(pid)
		{
			let mut entry = Entry::new(Fd::Txt, "REG");
			if let Ok(metadata) = std::fs::metadata(&path) {
				entry.size = Some(metadata.len());
			}
			entry.name = path;
			entries.push(entry);
		}
		for (is_v6, inet) in self.endpoints.get(&pid).into_iter().flatten() {
			let mut entry = Entry::new(Fd::NoFd, if *is_v6 { "IPv6" } else { "IPv4" });
			entry.offset = Some(0);
			entry.node = Some(Node::Protocol(inet.proto.name()));
			entry.inet = Some(inet.clone());
			entries.push(entry);
		}
		Listing { entries, denied: false }
	}
}

fn executable(pid: i32) -> Option<String> {
	let process = sys::open_process(u32::try_from(pid).ok()?, sys::PROCESS_QUERY_LIMITED_INFORMATION)?;
	let mut buffer = vec![0u16; 32_768];
	let path = sys::image_path(&process, &mut buffer)?;
	Some(String::from_utf16_lossy(path))
}
