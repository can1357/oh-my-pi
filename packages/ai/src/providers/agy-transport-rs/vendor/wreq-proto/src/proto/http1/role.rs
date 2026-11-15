use std::{
    fmt::{self, Write as _},
    mem::MaybeUninit,
};

use bytes::{Bytes, BytesMut};
use http::{
    header::{self, Entry, HeaderMap, HeaderName, HeaderValue},
    Method, StatusCode, Version,
};
use smallvec::{smallvec, smallvec_inline, SmallVec};

use super::{Encode, Encoder, Http1Transaction, ParseContext, ParsedMessage};
use crate::{
    body::DecodedLength,
    error::Parse,
    ext::{OnPreserveHeader, ReasonPhrase},
    proto::{headers, BodyLength, MessageHead, RequestHead, RequestLine},
    Error, Result,
};

/// totally scientific
const AVERAGE_HEADER_SIZE: usize = 30;
pub(crate) const DEFAULT_MAX_HEADERS: usize = 100;

macro_rules! header_name {
    ($bytes:expr) => {{
        {
            match HeaderName::from_bytes($bytes) {
                Ok(name) => name,
                Err(e) => maybe_panic!(e),
            }
        }
    }};
}

macro_rules! header_value {
    ($bytes:expr) => {{
        {
            #[allow(unsafe_code)]
            unsafe {
                HeaderValue::from_maybe_shared_unchecked($bytes)
            }
        }
    }};
}

macro_rules! maybe_panic {
    ($($arg:tt)*) => ({
        let _err = ($($arg)*);
        if cfg!(debug_assertions) {
            panic!("{:?}", _err);
        } else {
            error!("Internal core error, please report {:?}", _err);
            return Err(Parse::Internal)
        }
    })
}

pub(super) fn parse_headers<T>(
    bytes: &mut BytesMut,
    prev_len: Option<usize>,
    ctx: ParseContext<'_>,
) -> Result<Option<ParsedMessage<T::Incoming>>, Parse>
where
    T: Http1Transaction,
{
    // If the buffer is empty, don't bother entering the span, it's just noise.
    if bytes.is_empty() {
        return Ok(None);
    }

    trace_span!("parse_headers");

    if let Some(prev_len) = prev_len {
        if !is_complete_fast(bytes, prev_len) {
            return Ok(None);
        }
    }

    T::parse(bytes, ctx)
}

/// A fast scan for the end of a message.
/// Used when there was a partial read, to skip full parsing on a
/// a slow connection.
fn is_complete_fast(bytes: &[u8], prev_len: usize) -> bool {
    let start = prev_len.saturating_sub(3);
    let bytes = &bytes[start..];

    for (i, b) in bytes.iter().copied().enumerate() {
        if b == b'\r' {
            if bytes[i + 1..].chunks(3).next() == Some(&b"\n\r\n"[..]) {
                return true;
            }
        } else if b == b'\n' && bytes.get(i + 1) == Some(&b'\n') {
            return true;
        }
    }

    false
}

pub(crate) enum Client {}

impl Http1Transaction for Client {
    type Incoming = StatusCode;

    type Outgoing = RequestLine;

    #[cfg(feature = "tracing")]
    const LOG: &'static str = "{role=client}";

    fn parse(
        buf: &mut BytesMut,
        ctx: ParseContext<'_>,
    ) -> Result<Option<ParsedMessage<Self::Incoming>>, Parse> {
        debug_assert!(!buf.is_empty(), "parse called with empty buf");

        // Loop to skip information status code headers (100 Continue, etc).
        loop {
            let mut headers_indices: SmallVec<[MaybeUninit<HeaderIndices>; DEFAULT_MAX_HEADERS]> =
                match ctx.h1_max_headers {
                    Some(cap) => smallvec![MaybeUninit::uninit(); cap],
                    None => smallvec_inline![MaybeUninit::uninit(); DEFAULT_MAX_HEADERS],
                };

            let (len, status, reason, version, headers_len) = {
                let mut headers: SmallVec<
                    [MaybeUninit<httparse::Header<'_>>; DEFAULT_MAX_HEADERS],
                > = match ctx.h1_max_headers {
                    Some(cap) => smallvec![MaybeUninit::uninit(); cap],
                    None => smallvec_inline![MaybeUninit::uninit(); DEFAULT_MAX_HEADERS],
                };

                trace!(bytes = buf.len(), "Response.parse");

                let mut res = httparse::Response::new(&mut []);
                let bytes = buf.as_ref();
                match ctx.h1_parser_config.parse_response_with_uninit_headers(
                    &mut res,
                    bytes,
                    &mut headers,
                ) {
                    Ok(httparse::Status::Complete(len)) => {
                        trace!("Response.parse Complete({})", len);
                        let status = StatusCode::from_u16(res.code.unwrap())?;

                        let reason = {
                            let reason = res.reason.unwrap();
                            // Only save the reason phrase if it isn't the canonical reason
                            if Some(reason) != status.canonical_reason() {
                                Some(Bytes::copy_from_slice(reason.as_bytes()))
                            } else {
                                None
                            }
                        };

                        let version = if res.version.expect("httparse completed") == 1 {
                            Version::HTTP_11
                        } else {
                            Version::HTTP_10
                        };
                        record_header_indices(bytes, res.headers, &mut headers_indices)?;
                        let headers_len = res.headers.len();
                        (len, status, reason, version, headers_len)
                    }
                    Ok(httparse::Status::Partial) => return Ok(None),
                    Err(httparse::Error::Version) if ctx.h09_responses => {
                        trace!("Response.parse accepted HTTP/0.9 response");

                        (0, StatusCode::OK, None, Version::HTTP_09, 0)
                    }
                    Err(e) => return Err(e.into()),
                }
            };

            let mut slice = buf.split_to(len);

            if ctx
                .h1_parser_config
                .obsolete_multiline_headers_in_responses_are_allowed()
            {
                for header in &mut headers_indices[..headers_len] {
                    // SAFETY: array is valid up to `headers_len`
                    #[allow(unsafe_code)]
                    let header = unsafe { header.assume_init_mut() };
                    Client::obs_fold_line(&mut slice, header);
                }
            }

            let slice = slice.freeze();

            let mut headers = ctx.cached_headers.take().unwrap_or_default();

            let mut keep_alive = version == Version::HTTP_11;

            headers.reserve(headers_len);
            for header in &headers_indices[..headers_len] {
                // SAFETY: array is valid up to `headers_len`
                #[allow(unsafe_code)]
                let header = unsafe { header.assume_init_ref() };
                let name = header_name!(&slice[header.name.0..header.name.1]);
                let value = header_value!(slice.slice(header.value.0..header.value.1));

                if let header::CONNECTION = name {
                    // keep_alive was previously set to default for Version
                    if keep_alive {
                        // HTTP/1.1
                        keep_alive = !headers::connection_close(&value);
                    } else {
                        // HTTP/1.0
                        keep_alive = headers::connection_keep_alive(&value);
                    }
                }

                headers.append(name, value);
            }

            let mut extensions = http::Extensions::default();

            if let Some(reason) = reason {
                // Safety: httparse ensures that only valid reason phrase bytes are present in this
                // field.
                let reason = ReasonPhrase::from_bytes_unchecked(reason);
                extensions.insert(reason);
            }

            let head = MessageHead {
                version,
                subject: status,
                headers,
                extensions,
            };

            if let Some((decode, is_upgrade)) = Client::decoder(&head, ctx.req_method)? {
                return Ok(Some(ParsedMessage {
                    head,
                    decode,
                    expect_continue: false,
                    // a client upgrade means the connection can't be used
                    // again, as it is definitely upgrading.
                    keep_alive: keep_alive && !is_upgrade,
                    wants_upgrade: is_upgrade,
                }));
            }

            if head.subject.is_informational() {
                if let Some(callback) = ctx.on_informational {
                    callback.call(head.into_response(()));
                }
            }

            // Parsing a 1xx response could have consumed the buffer, check if
            // it is empty now...
            if buf.is_empty() {
                return Ok(None);
            }
        }
    }

    fn encode(msg: Encode<'_, Self::Outgoing>, dst: &mut Vec<u8>) -> Result<Encoder> {
        trace!(
            "Client::encode method={:?}, body={:?}",
            msg.head.subject.0,
            msg.body
        );

        *msg.req_method = Some(msg.head.subject.0.clone());

        let body = Client::set_length(msg.head, msg.body);

        let init_cap = 30 + msg.head.headers.len() * AVERAGE_HEADER_SIZE;
        dst.reserve(init_cap);

        extend(dst, msg.head.subject.0.as_str().as_bytes());
        extend(dst, b" ");
        //TODO: add API to http::Uri to encode without std::fmt
        let _ = write!(FastWrite(dst), "{} ", msg.head.subject.1);

        match msg.head.version {
            Version::HTTP_10 => extend(dst, b"HTTP/1.0"),
            Version::HTTP_11 => extend(dst, b"HTTP/1.1"),
            Version::HTTP_2 => {
                debug!("request with HTTP2 version coerced to HTTP/1.1");
                extend(dst, b"HTTP/1.1");
            }
            other => panic!("unexpected request version: {other:?}"),
        }
        extend(dst, b"\r\n");

        if let Some(header_sort) = &msg.head.extensions.get::<OnPreserveHeader>() {
            header_sort.call_visit(&mut msg.head.headers, &mut |name, value| {
                extend(dst, name.as_ref());

                // Wanted for curl test cases that send `X-Custom-Header:\r\n`
                if value.is_empty() {
                    extend(dst, b":\r\n");
                } else {
                    extend(dst, b": ");
                    extend(dst, value.as_bytes());
                    extend(dst, b"\r\n");
                }
            });
        } else {
            write_headers(&msg.head.headers, dst);
        }

        extend(dst, b"\r\n");
        msg.head.headers.clear(); //TODO: remove when switching to drain()

        Ok(body)
    }

    fn on_error(_err: &Error) -> Option<MessageHead<Self::Outgoing>> {
        // we can't tell the server about any errors it creates
        None
    }
}

impl Client {
    /// Returns Some(length, wants_upgrade) if successful.
    ///
    /// Returns None if this message head should be skipped (like a 100 status).
    fn decoder(
        inc: &MessageHead<StatusCode>,
        method: &mut Option<Method>,
    ) -> Result<Option<(DecodedLength, bool)>, Parse> {
        // According to https://tools.ietf.org/html/rfc7230#section-3.3.3
        // 1. HEAD responses, and Status 1xx, 204, and 304 cannot have a body.
        // 2. Status 2xx to a CONNECT cannot have a body.
        // 3. Transfer-Encoding: chunked has a chunked body.
        // 4. If multiple differing Content-Length headers or invalid, close connection.
        // 5. Content-Length header has a sized body.
        // 6. (irrelevant to Response)
        // 7. Read till EOF.

        match inc.subject.as_u16() {
            101 => {
                return Ok(Some((DecodedLength::ZERO, true)));
            }
            100 | 102..=199 => {
                trace!("ignoring informational response: {}", inc.subject.as_u16());
                return Ok(None);
            }
            204 | 304 => return Ok(Some((DecodedLength::ZERO, false))),
            _ => (),
        }
        match *method {
            Some(Method::HEAD) => {
                return Ok(Some((DecodedLength::ZERO, false)));
            }
            Some(Method::CONNECT) => {
                if let 200..=299 = inc.subject.as_u16() {
                    return Ok(Some((DecodedLength::ZERO, true)));
                }
            }
            Some(_) => {}
            None => {
                trace!("Client::decoder is missing the Method");
            }
        }

        if inc.headers.contains_key(header::TRANSFER_ENCODING) {
            // https://tools.ietf.org/html/rfc7230#section-3.3.3
            // If Transfer-Encoding header is present, and 'chunked' is
            // not the final encoding, and this is a Request, then it is
            // malformed. A server should respond with 400 Bad Request.
            return if inc.version == Version::HTTP_10 {
                debug!("HTTP/1.0 cannot have Transfer-Encoding header");
                Err(Parse::transfer_encoding_unexpected())
            } else if headers::transfer_encoding_is_chunked(&inc.headers) {
                Ok(Some((DecodedLength::CHUNKED, false)))
            } else {
                trace!("not chunked, read till eof");
                Ok(Some((DecodedLength::CLOSE_DELIMITED, false)))
            };
        }

        if let Some(len) = headers::content_length_parse_all(&inc.headers) {
            return Ok(Some((DecodedLength::checked_new(len)?, false)));
        }

        if inc.headers.contains_key(header::CONTENT_LENGTH) {
            debug!("illegal Content-Length header");
            return Err(Parse::content_length_invalid());
        }

        trace!("neither Transfer-Encoding nor Content-Length");
        Ok(Some((DecodedLength::CLOSE_DELIMITED, false)))
    }

    fn set_length(head: &mut RequestHead, body: Option<BodyLength>) -> Encoder {
        let body = if let Some(body) = body {
            body
        } else {
            head.headers.remove(header::TRANSFER_ENCODING);
            return Encoder::length(0);
        };

        // HTTP/1.0 doesn't know about chunked
        let can_chunked = head.version == Version::HTTP_11;
        let headers = &mut head.headers;

        // If the user already set specific headers, we should respect them, regardless
        // of what the Body knows about itself. They set them for a reason.

        // Because of the borrow checker, we can't check the for an existing
        // Content-Length header while holding an `Entry` for the Transfer-Encoding
        // header, so unfortunately, we must do the check here, first.

        let existing_con_len = headers::content_length_parse_all(headers);
        let mut should_remove_con_len = false;

        if !can_chunked {
            // Chunked isn't legal, so if it is set, we need to remove it.
            if headers.remove(header::TRANSFER_ENCODING).is_some() {
                trace!("removing illegal transfer-encoding header");
            }

            return if let Some(len) = existing_con_len {
                Encoder::length(len)
            } else if let BodyLength::Known(len) = body {
                set_content_length(headers, len)
            } else {
                // HTTP/1.0 client requests without a content-length
                // cannot have any body at all.
                Encoder::length(0)
            };
        }

        // If the user set a transfer-encoding, respect that. Let's just
        // make sure `chunked` is the final encoding.
        let encoder = match headers.entry(header::TRANSFER_ENCODING) {
            Entry::Occupied(te) => {
                should_remove_con_len = true;
                if headers::is_chunked(te.iter()) {
                    Some(Encoder::chunked())
                } else {
                    warn!("user provided transfer-encoding does not end in 'chunked'");

                    // There's a Transfer-Encoding, but it doesn't end in 'chunked'!
                    // An example that could trigger this:
                    //
                    //     Transfer-Encoding: gzip
                    //
                    // This can be bad, depending on if this is a request or a
                    // response.
                    //
                    // - A request is illegal if there is a `Transfer-Encoding` but it doesn't end
                    //   in `chunked`.
                    // - A response that has `Transfer-Encoding` but doesn't end in `chunked` isn't
                    //   illegal, it just forces this to be close-delimited.
                    //
                    // We can try to repair this, by adding `chunked` ourselves.

                    headers::add_chunked(te);
                    Some(Encoder::chunked())
                }
            }
            Entry::Vacant(te) => {
                if let Some(len) = existing_con_len {
                    Some(Encoder::length(len))
                } else if let BodyLength::Unknown = body {
                    // GET, HEAD, and CONNECT almost never have bodies.
                    //
                    // So instead of sending a "chunked" body with a 0-chunk,
                    // assume no body here. If you *must* send a body,
                    // set the headers explicitly.
                    match head.subject.0 {
                        Method::GET | Method::HEAD | Method::CONNECT => Some(Encoder::length(0)),
                        _ => {
                            te.insert(HeaderValue::from_static("chunked"));
                            Some(Encoder::chunked())
                        }
                    }
                } else {
                    None
                }
            }
        };

        let encoder = encoder.map(|enc| {
            if enc.is_chunked() {
                // Parse Trailer header values into HeaderNames.
                // Each Trailer header value may contain comma-separated names.
                // HeaderName normalizes to lowercase, enabling case-insensitive matching.
                let allowed_trailer_fields: Vec<HeaderName> = headers
                    .get_all(header::TRAILER)
                    .iter()
                    .filter_map(|hv| hv.to_str().ok())
                    .flat_map(|s| s.split(','))
                    .filter_map(|s| HeaderName::from_bytes(s.trim().as_bytes()).ok())
                    .collect();

                if !allowed_trailer_fields.is_empty() {
                    return enc.into_chunked_with_trailing_fields(allowed_trailer_fields);
                }
            }

            enc
        });

        // This is because we need a second mutable borrow to remove
        // content-length header.
        if let Some(encoder) = encoder {
            if should_remove_con_len && existing_con_len.is_some() {
                headers.remove(header::CONTENT_LENGTH);
            }
            return encoder;
        }

        // User didn't set transfer-encoding, AND we know body length,
        // so we can just set the Content-Length automatically.

        let len = if let BodyLength::Known(len) = body {
            len
        } else {
            unreachable!("BodyLength::Unknown would set chunked");
        };

        set_content_length(headers, len)
    }

    fn obs_fold_line(all: &mut [u8], idx: &mut HeaderIndices) {
        // If the value has obs-folded text, then in-place shift the bytes out
        // of here.
        //
        // https://httpwg.org/specs/rfc9112.html#line.folding
        //
        // > A user agent that receives an obs-fold MUST replace each received
        // > obs-fold with one or more SP octets prior to interpreting the
        // > field value.
        //
        // This means strings like "\r\n\t foo" must replace the "\r\n\t " with
        // a single space.

        let buf = &mut all[idx.value.0..idx.value.1];

        // look for a newline, otherwise bail out
        let first_nl = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => i,
            None => return,
        };

        // not on standard slices because whatever, sigh
        fn trim_start(mut s: &[u8]) -> &[u8] {
            while let [first, rest @ ..] = s {
                if first.is_ascii_whitespace() {
                    s = rest;
                } else {
                    break;
                }
            }
            s
        }

        fn trim_end(mut s: &[u8]) -> &[u8] {
            while let [rest @ .., last] = s {
                if last.is_ascii_whitespace() {
                    s = rest;
                } else {
                    break;
                }
            }
            s
        }

        fn trim(s: &[u8]) -> &[u8] {
            trim_start(trim_end(s))
        }

        // TODO(perf): we could do the moves in-place, but this is so uncommon
        // that it shouldn't matter.
        let mut unfolded = trim_end(&buf[..first_nl]).to_vec();
        for line in buf[first_nl + 1..].split(|b| *b == b'\n') {
            unfolded.push(b' ');
            unfolded.extend_from_slice(trim(line));
        }
        buf[..unfolded.len()].copy_from_slice(&unfolded);
        idx.value.1 = idx.value.0 + unfolded.len();
    }
}

fn set_content_length(headers: &mut HeaderMap, len: u64) -> Encoder {
    // At this point, there should not be a valid Content-Length
    // header. However, since we'll be indexing in anyways, we can
    // warn the user if there was an existing illegal header.
    //
    // Or at least, we can in theory. It's actually a little bit slower,
    // so perhaps only do that while the user is developing/testing.

    if cfg!(debug_assertions) {
        match headers.entry(header::CONTENT_LENGTH) {
            Entry::Occupied(mut cl) => {
                // Internal sanity check, we should have already determined
                // that the header was illegal before calling this function.
                debug_assert!(headers::content_length_parse_all_values(cl.iter()).is_none());
                // Uh oh, the user set `Content-Length` headers, but set bad ones.
                // This would be an illegal message anyways, so let's try to repair
                // with our known good length.
                error!("user provided content-length header was invalid");

                cl.insert(HeaderValue::from(len));
                Encoder::length(len)
            }
            Entry::Vacant(cl) => {
                cl.insert(HeaderValue::from(len));
                Encoder::length(len)
            }
        }
    } else {
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
        Encoder::length(len)
    }
}

#[derive(Clone, Copy)]
struct HeaderIndices {
    name: (usize, usize),
    value: (usize, usize),
}

fn record_header_indices(
    bytes: &[u8],
    headers: &[httparse::Header<'_>],
    indices: &mut [MaybeUninit<HeaderIndices>],
) -> Result<(), Parse> {
    let bytes_ptr = bytes.as_ptr() as usize;

    for (header, indices) in headers.iter().zip(indices.iter_mut()) {
        if header.name.len() >= (1 << 16) {
            debug!("header name larger than 64kb: {:?}", header.name);
            return Err(Parse::TooLarge);
        }
        let name_start = header.name.as_ptr() as usize - bytes_ptr;
        let name_end = name_start + header.name.len();
        let value_start = header.value.as_ptr() as usize - bytes_ptr;
        let value_end = value_start + header.value.len();

        indices.write(HeaderIndices {
            name: (name_start, name_end),
            value: (value_start, value_end),
        });
    }

    Ok(())
}

pub(crate) fn write_headers(headers: &HeaderMap, dst: &mut Vec<u8>) {
    for (name, value) in headers {
        extend(dst, name.as_ref());
        extend(dst, b": ");
        extend(dst, value.as_bytes());
        extend(dst, b"\r\n");
    }
}

struct FastWrite<'a>(&'a mut Vec<u8>);

impl fmt::Write for FastWrite<'_> {
    #[inline]
    fn write_str(&mut self, s: &str) -> fmt::Result {
        extend(self.0, s.as_bytes());
        Ok(())
    }

    #[inline]
    fn write_fmt(&mut self, args: fmt::Arguments<'_>) -> fmt::Result {
        fmt::write(self, args)
    }
}

#[inline]
fn extend(dst: &mut Vec<u8>, data: &[u8]) {
    dst.extend_from_slice(data);
}
