//! User, group, network and service databases (perlfunc, perlport).

use std::{
	io,
	net::{IpAddr, Ipv4Addr, ToSocketAddrs as _},
	sync::mpsc::{RecvTimeoutError, channel},
	time::Duration,
};

use crate::perl::{ast::{Builtin, Call}, interp::{Cx, Flow, Interp, PResult, Ret}, value::{PStr, Value}};

use super::{list, one, yes};

#[derive(Default)]
pub(super) struct State { cursors: [Option<Cursor>; 6] }

struct Cursor { data: Vec<u8>, offset: usize }

#[repr(usize)]
#[derive(Clone, Copy)]
enum Db { Passwd, Group, Hosts, Networks, Protocols, Services }

impl Db {
	fn path(self) -> &'static [u8] {
		match self {
			Self::Passwd => b"/etc/passwd", Self::Group => b"/etc/group", Self::Hosts => b"/etc/hosts",
			Self::Networks => b"/etc/networks", Self::Protocols => b"/etc/protocols", Self::Services => b"/etc/services",
		}
	}
}

/// Resolve `host` with the system resolver (getaddrinfo) on a helper thread, polling for
/// cancellation and `alarm` meanwhile: a slow resolver must not hold the shell. On
/// cancellation the thread is abandoned; it ends by itself when the lookup returns.
pub(in crate::perl) fn resolve_host(interp: &mut Interp<'_>, host: &str) -> PResult<io::Result<Vec<IpAddr>>> {
	if let Ok(ip) = host.parse::<IpAddr>() { return Ok(Ok(vec![ip])); }
	let (tx, rx) = channel();
	let name = host.to_owned();
	let spawned = std::thread::Builder::new().name("perl-resolve".into()).spawn(move || {
		let found = (name.as_str(), 0).to_socket_addrs().map(|addrs| {
			let mut ips: Vec<IpAddr> = Vec::new();
			for addr in addrs { if !ips.contains(&addr.ip()) { ips.push(addr.ip()); } }
			ips
		});
		let _ = tx.send(found);
	});
	if let Err(e) = spawned { return Ok(Err(e)); }
	loop {
		match rx.recv_timeout(Duration::from_millis(20)) {
			Ok(found) => return Ok(found),
			Err(RecvTimeoutError::Timeout) => {},
			Err(RecvTimeoutError::Disconnected) => return Ok(Err(io::ErrorKind::NotFound.into())),
		}
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		// A handler that returns lets the lookup continue (perl restarts it); one that dies abandons it.
		interp.poll_alarm()?;
	}
}

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	use Builtin as B;
	let values = list(interp, call)?;
	let first = values.first().unwrap_or(&Value::Undef);
	let second = values.get(1).unwrap_or(&Value::Undef);
	let db = match b {
		B::Getlogin | B::Getpwnam | B::Getpwuid | B::Getpwent | B::Setpwent | B::Endpwent => Db::Passwd,
		B::Getgrnam | B::Getgrgid | B::Getgrent | B::Setgrent | B::Endgrent => Db::Group,
		B::Gethostbyname | B::Gethostbyaddr | B::Gethostent | B::Sethostent | B::Endhostent => Db::Hosts,
		B::Getnetbyname | B::Getnetbyaddr | B::Getnetent | B::Setnetent | B::Endnetent => Db::Networks,
		B::Getprotobyname | B::Getprotobynumber | B::Getprotoent | B::Setprotoent | B::Endprotoent => Db::Protocols,
		B::Getservbyname | B::Getservbyport | B::Getservent | B::Setservent | B::Endservent => Db::Services,
		_ => return Ok(one(Value::Undef)),
	};
	let entry = match b {
		B::Setpwent | B::Setgrent | B::Sethostent | B::Setnetent | B::Setprotoent | B::Setservent => {
			let data = load(interp, db);
			interp.sys.users.cursors[db as usize] = Some(Cursor { data, offset: 0 });
			return Ok(yes());
		},
		B::Endpwent | B::Endgrent | B::Endhostent | B::Endnetent | B::Endprotoent | B::Endservent => {
			interp.sys.users.cursors[db as usize] = None;
			return Ok(yes());
		},
		B::Getpwent | B::Getgrent | B::Gethostent | B::Getnetent | B::Getprotoent | B::Getservent => {
			if interp.sys.users.cursors[db as usize].is_none() {
				let data = load(interp, db);
				interp.sys.users.cursors[db as usize] = Some(Cursor { data, offset: 0 });
			}
			interp.sys.users.cursors[db as usize].as_mut().and_then(|cursor| {
				while let Some(rest) = cursor.data.get(cursor.offset..).filter(|b| !b.is_empty()) {
					let end = memchr::memchr(b'\n', rest).unwrap_or(rest.len());
					cursor.offset += end + usize::from(end < rest.len());
					if let Some(entry) = parse(db, &rest[..end]) { return Some(entry); }
				}
				None
			})
		},
		B::Getlogin => {
			let name = interp.env_pairs().into_iter().find(|(k, v)| k == b"LOGNAME" && !v.is_empty()).map(|(_, v)| v);
			return Ok(one(name.map_or_else(login, |n| Value::Str(PStr::new(n, false)))));
		},
		B::Getpwnam | B::Getpwuid | B::Getgrnam | B::Getgrgid => {
			let by_name = matches!(b, B::Getpwnam | B::Getgrnam);
			let name = if by_name { Some(interp.stringify(first)?) } else { None };
			user_group(db, name.as_ref(), first.to_u64() as u32)
		},
		B::Gethostbyname => {
			let name = interp.stringify(first)?;
			let data = load(interp, db);
			let entry = lookup(db, &data, |e| e.name_matches(&name.bytes));
			if entry.is_some() { entry } else {
				let name = name.to_string_lossy();
				let mut addresses = Vec::new();
				if let Ok(found) = resolve_host(interp, &name)? {
					for ip in found {
						if let std::net::IpAddr::V4(ip) = ip && !addresses.contains(&ip) { addresses.push(ip); }
					}
				}
				if addresses.is_empty() { None } else { Some(host_entry(name.as_bytes(), b"", addresses)) }
			}
		},
		B::Gethostbyaddr => {
			let addr = interp.stringify(first)?;
			let addr = if addr.utf8 {
				addr.downgraded().ok_or_else(|| interp.die_msg("Wide character in gethostbyaddr"))?
			} else { addr.bytes };
			let data = load(interp, db);
			if second.to_i64() != 2 || addr.len() != 4 { None }
			else { lookup(db, &data, |e| e.fields.iter().skip(4).any(|v| v.to_pstr().bytes == addr)) }
		},
		B::Getnetbyname | B::Getprotobyname | B::Getservbyname => {
			let name = interp.stringify(first)?;
			let proto = interp.stringify(second)?;
			let data = load(interp, db);
			lookup(db, &data, |e| e.name_matches(&name.bytes) && (b != B::Getservbyname || e.protocol_matches(&proto.bytes)))
		},
		B::Getnetbyaddr | B::Getprotobynumber | B::Getservbyport => {
			let proto = interp.stringify(second)?;
			let n = first.to_i64();
			let data = load(interp, db);
			let field = if b == B::Getnetbyaddr { 3 } else { 2 };
			lookup(db, &data, |e| e.fields.get(field).is_some_and(|v| v.to_i64() == n)
				&& (b != B::Getnetbyaddr || second.to_i64() == 2)
				&& (b != B::Getservbyport || e.protocol_matches(&proto.bytes)))
		},
		_ => None,
	};
	if cx == Cx::List { return Ok(Ret::Many(entry.map_or_else(Vec::new, |e| e.fields))); }
	let scalar = match b {
		B::Getpwnam | B::Getgrnam | B::Getprotobyname | B::Getservbyname => 2,
		B::Getnetbyname => 3,
		B::Gethostbyname => 4,
		_ => 0,
	};
	Ok(one(entry.and_then(|e| e.fields.into_iter().nth(scalar)).unwrap_or(Value::Undef)))
}

fn load(interp: &mut Interp<'_>, db: Db) -> Vec<u8> {
	let path = interp.resolve_path(db.path());
	interp.host().fs().read(path).unwrap_or_default()
}

fn lookup(db: Db, bytes: &[u8], predicate: impl FnMut(&Entry) -> bool) -> Option<Entry> {
	bytes.split(|&b| b == b'\n').filter_map(|line| parse(db, line)).find(predicate)
}

struct Entry { fields: Vec<Value> }

impl Entry {
	fn new(fields: Vec<Value>) -> Self { Self { fields } }
	fn name_matches(&self, name: &[u8]) -> bool {
		self.fields.first().is_some_and(|s| s.to_pstr().bytes.eq_ignore_ascii_case(name)) ||
		self.fields.get(1).is_some_and(|s| s.to_pstr().bytes.split(u8::is_ascii_whitespace).any(|a| a.eq_ignore_ascii_case(name)))
	}
	fn protocol_matches(&self, proto: &[u8]) -> bool {
		proto.is_empty() || self.fields.get(3).is_some_and(|s| s.to_pstr().bytes == proto)
	}
}

fn parse(db: Db, line: &[u8]) -> Option<Entry> {
	let line = line.split(|&b| b == b'#').next()?.trim_ascii();
	if line.is_empty() { return None; }
	let s = Value::bytes;
	let n = |v: &[u8]| std::str::from_utf8(v).ok()?.parse::<i64>().ok().map(Value::Int);
	match db {
		Db::Passwd | Db::Group => {
			let mut parts = line.split(|&b| b == b':');
			let (name, pass, id) = (parts.next()?, parts.next()?, n(parts.next()?)?);
			if matches!(db, Db::Group) {
				let mut members = parts.next().unwrap_or_default().to_vec();
				for byte in &mut members { if *byte == b',' { *byte = b' '; } }
				return Some(Entry::new(vec![s(name), s(pass), id, Value::Str(PStr::new(members, false))]));
			}
			let (gid, gecos, dir, sh) = (n(parts.next()?)?, parts.next()?, parts.next()?, parts.next()?);
			Some(Entry::new(vec![s(name), s(pass), id, gid, Value::Int(0), s(b""), s(gecos), s(dir), s(sh), Value::Int(0)]))
		},
		_ => {
			let mut parts = line.split(u8::is_ascii_whitespace).filter(|s| !s.is_empty());
			let (a, b) = (parts.next()?, parts.next()?);
			let aliases = parts.collect::<Vec<_>>().join(&b' ');
			let common = |name: &[u8]| vec![s(name), s(&aliases)];
			match db {
				Db::Hosts => {
					let ip = std::str::from_utf8(a).ok()?.parse().ok()?;
					Some(host_entry(b, &aliases, std::iter::once(ip)))
				},
				Db::Networks => {
					let mut number = 0u32;
					for part in b.split(|&b| b == b'.') {
						let octet = std::str::from_utf8(part).ok()?.parse::<u8>().ok()?;
						number = number.checked_mul(256)?.checked_add(u32::from(octet))?;
					}
					let mut fields = common(a);
					fields.extend([Value::Int(2), Value::Int(i64::from(number))]);
					Some(Entry::new(fields))
				},
				Db::Protocols => {
					let mut fields = common(a);
					fields.push(n(b)?);
					Some(Entry::new(fields))
				},
				Db::Services => {
					let slash = memchr::memchr(b'/', b)?;
					let mut fields = common(a);
					fields.extend([n(&b[..slash])?, s(&b[slash + 1..])]);
					Some(Entry::new(fields))
				},
				_ => None,
			}
		},
	}
}

fn host_entry(name: &[u8], aliases: &[u8], addrs: impl IntoIterator<Item = Ipv4Addr>) -> Entry {
	let mut fields = vec![Value::bytes(name), Value::bytes(aliases), Value::Int(2), Value::Int(4)];
	fields.extend(addrs.into_iter().map(|a| Value::bytes(&a.octets())));
	Entry::new(fields)
}

fn login() -> Value {
	#[cfg(unix)]
	{ nix::unistd::User::from_uid(nix::unistd::getuid()).ok().flatten().map_or(Value::Undef, |u| Value::str(&u.name)) }
	#[cfg(not(unix))]
	{ Value::Undef }
}

fn user_group(db: Db, name: Option<&PStr>, id: u32) -> Option<Entry> {
	#[cfg(unix)]
	{
		use nix::unistd::{Gid, Group, Uid, User};
		let name = name.map(PStr::to_string_lossy);
		if matches!(db, Db::Passwd) {
			let u = match name { Some(n) => User::from_name(&n), None => User::from_uid(Uid::from_raw(id)) }.ok()??;
			let s = Value::bytes;
			#[cfg(any(target_vendor = "apple", target_os = "freebsd", target_os = "dragonfly", target_os = "openbsd", target_os = "netbsd"))]
			let (class, change, expire) = (s(u.class.as_bytes()), Value::Int(u.change as i64), Value::Int(u.expire as i64));
			#[cfg(not(any(target_vendor = "apple", target_os = "freebsd", target_os = "dragonfly", target_os = "openbsd", target_os = "netbsd")))]
			let (class, change, expire) = (s(b""), Value::Int(0), Value::Int(0));
			#[cfg(not(all(target_os = "android", target_pointer_width = "32")))]
			let gecos = s(u.gecos.as_bytes());
			#[cfg(all(target_os = "android", target_pointer_width = "32"))]
			let gecos = s(b"");
			Some(Entry::new(vec![Value::str(&u.name), s(u.passwd.as_bytes()), Value::Int(i64::from(u.uid.as_raw())), Value::Int(i64::from(u.gid.as_raw())),
				change, class, gecos, s(u.dir.as_os_str().as_encoded_bytes()), s(u.shell.as_os_str().as_encoded_bytes()), expire]))
		} else {
			let g = match name { Some(n) => Group::from_name(&n), None => Group::from_gid(Gid::from_raw(id)) }.ok()??;
			Some(Entry::new(vec![Value::str(&g.name), Value::bytes(g.passwd.as_bytes()), Value::Int(i64::from(g.gid.as_raw())), Value::str(&g.mem.join(" "))]))
		}
	}
	#[cfg(not(unix))]
	{ let _ = (db, name, id); None }
}
