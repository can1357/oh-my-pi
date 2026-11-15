use std::{fmt, fmt::Write};

use bytes::Bytes;

use crate::header::{Entry, HeaderMap, HeaderValue, OccupiedEntry};

/// Removes the square brackets around an IPv6 host literal as required by
/// [RFC 3986, Section 3.2.2](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.2.2).
pub(crate) fn strip_ipv6_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
}

pub(crate) fn basic_auth<U, P>(username: U, password: Option<P>) -> HeaderValue
where
    U: fmt::Display,
    P: fmt::Display,
{
    let encoded = {
        let mut buf = b"Basic ".to_vec();
        let mut buf_str = String::with_capacity(32);
        let _ = write!(buf_str, "{username}:");
        if let Some(password) = password {
            let _ = write!(buf_str, "{password}");
        }

        let encoded = btls::base64::encode_block(buf_str.as_bytes());
        buf.extend(encoded.into_bytes());
        buf
    };

    let mut header = HeaderValue::from_maybe_shared(Bytes::from(encoded))
        .expect("base64 is always valid HeaderValue");
    header.set_sensitive(true);
    header
}

pub(crate) fn fast_random() -> u64 {
    use std::{
        cell::Cell,
        collections::hash_map::RandomState,
        hash::{BuildHasher, Hasher},
    };

    thread_local! {
        static KEY: RandomState = RandomState::new();
        static COUNTER: Cell<u64> = const { Cell::new(0) };
    }

    KEY.with(|key| {
        COUNTER.with(|ctr| {
            let n = ctr.get().wrapping_add(1);
            ctr.set(n);

            let mut h = key.build_hasher();
            h.write_u64(n);
            h.finish()
        })
    })
}

pub(crate) fn replace_headers(dst: &mut HeaderMap, src: HeaderMap) {
    // IntoIter of HeaderMap yields (Option<HeaderName>, HeaderValue).
    // The first time a name is yielded, it will be Some(name), and if
    // there are more values with the same name, the next yield will be
    // None.

    let mut prev_entry: Option<OccupiedEntry<_>> = None;
    for (key, value) in src {
        match key {
            Some(key) => match dst.entry(key) {
                Entry::Occupied(mut e) => {
                    e.insert(value);
                    prev_entry = Some(e);
                }
                Entry::Vacant(e) => {
                    let e = e.insert_entry(value);
                    prev_entry = Some(e);
                }
            },
            None => match prev_entry {
                Some(ref mut entry) => {
                    entry.append(value);
                }
                None => unreachable!("HeaderMap::into_iter yielded None first"),
            },
        }
    }
}

pub(crate) struct Escape<'a>(&'a [u8]);

impl<'a> Escape<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Escape(bytes)
    }
}

impl fmt::Debug for Escape<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "b\"{self}\"")?;
        Ok(())
    }
}

impl fmt::Display for Escape<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for &c in self.0 {
            // https://doc.rust-lang.org/reference.html#byte-escapes
            if c == b'\n' {
                write!(f, "\\n")?;
            } else if c == b'\r' {
                write!(f, "\\r")?;
            } else if c == b'\t' {
                write!(f, "\\t")?;
            } else if c == b'\\' || c == b'"' {
                write!(f, "\\{}", c as char)?;
            } else if c == b'\0' {
                write!(f, "\\0")?;
            // ASCII printable
            } else if (0x20..0x7f).contains(&c) {
                write!(f, "{}", c as char)?;
            } else {
                write!(f, "\\x{c:02x}")?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::strip_ipv6_brackets;

    #[test]
    fn strips_ipv6_brackets() {
        assert_eq!(strip_ipv6_brackets("[::1]"), "::1");
        assert_eq!(strip_ipv6_brackets("::1"), "::1");
        assert_eq!(strip_ipv6_brackets("example.com"), "example.com");
        assert_eq!(strip_ipv6_brackets("[example.com"), "[example.com");
        assert_eq!(strip_ipv6_brackets("example.com]"), "example.com]");
        assert_eq!(strip_ipv6_brackets("[[::1]]"), "[::1]");
    }
}
