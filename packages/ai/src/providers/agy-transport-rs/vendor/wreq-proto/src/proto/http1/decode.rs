use std::{
    error::Error as StdError,
    fmt, io,
    task::{ready, Context, Poll},
};

use bytes::{BufMut, Bytes, BytesMut};
use http::{HeaderMap, HeaderName, HeaderValue};
use http_body::Frame;

use self::Kind::{Chunked, Eof, Length};
use super::{io::MemRead, role::DEFAULT_MAX_HEADERS, DecodedLength};

/// Maximum amount of bytes allowed in chunked extensions.
///
/// This limit is currentlty applied for the entire body, not per chunk.
const CHUNKED_EXTENSIONS_LIMIT: u64 = 1024 * 16;

/// Maximum number of bytes allowed for all trailer fields.
///
/// TODO: remove this when we land h1_max_header_size support
const TRAILER_LIMIT: usize = 1024 * 16;

/// Decoders to handle different Transfer-Encodings.
///
/// If a message body does not include a Transfer-Encoding, it *should*
/// include a Content-Length header.
#[derive(Clone, PartialEq)]
pub(crate) struct Decoder {
    kind: Kind,
}

#[derive(Debug, Clone, PartialEq)]
enum Kind {
    /// A Reader used when a Content-Length header is passed with a positive integer.
    Length(u64),
    /// A Reader used when Transfer-Encoding is `chunked`.
    Chunked {
        state: ChunkedState,
        chunk_len: u64,
        extensions_cnt: u64,
        trailers_buf: Option<BytesMut>,
        trailers_cnt: usize,
        h1_max_headers: Option<usize>,
        h1_max_header_size: Option<usize>,
    },
    /// A Reader used for responses that don't indicate a length or chunked.
    ///
    /// The bool tracks when EOF is seen on the transport.
    ///
    /// Note: This should only used for `Response`s. It is illegal for a
    /// `Request` to be made with both `Content-Length` and
    /// `Transfer-Encoding: chunked` missing, as explained from the spec:
    ///
    /// > If a Transfer-Encoding header field is present in a response and
    /// > the chunked transfer coding is not the final encoding, the
    /// > message body length is determined by reading the connection until
    /// > it is closed by the server.  If a Transfer-Encoding header field
    /// > is present in a request and the chunked transfer coding is not
    /// > the final encoding, the message body length cannot be determined
    /// > reliably; the server MUST respond with the 400 (Bad Request)
    /// > status code and then close the connection.
    Eof(bool),
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum ChunkedState {
    Start,
    Size,
    SizeLws,
    Extension,
    SizeLf,
    Body,
    BodyCr,
    BodyLf,
    Trailer,
    TrailerLf,
    EndCr,
    EndLf,
    End,
}

struct StepArgs<'a> {
    chunk_size: &'a mut u64,
    chunk_buf: &'a mut Option<Bytes>,
    extensions_cnt: &'a mut u64,
    trailers_buf: &'a mut Option<BytesMut>,
    trailers_cnt: &'a mut usize,
    max_headers_cnt: usize,
    max_headers_bytes: usize,
}

// ===== impl Decoder =====

impl Decoder {
    #[inline]
    fn length(x: u64) -> Decoder {
        Decoder {
            kind: Kind::Length(x),
        }
    }

    #[inline]
    fn eof() -> Decoder {
        Decoder {
            kind: Kind::Eof(false),
        }
    }

    #[inline]
    fn chunked(h1_max_headers: Option<usize>, h1_max_header_size: Option<usize>) -> Decoder {
        Decoder {
            kind: Kind::Chunked {
                state: ChunkedState::new(),
                chunk_len: 0,
                extensions_cnt: 0,
                trailers_buf: None,
                trailers_cnt: 0,
                h1_max_headers,
                h1_max_header_size,
            },
        }
    }

    pub(super) fn new(
        len: DecodedLength,
        h1_max_headers: Option<usize>,
        h1_max_header_size: Option<usize>,
    ) -> Self {
        match len {
            DecodedLength::CHUNKED => Decoder::chunked(h1_max_headers, h1_max_header_size),
            DecodedLength::CLOSE_DELIMITED => Decoder::eof(),
            length => Decoder::length(length.danger_len()),
        }
    }

    #[inline]
    pub(crate) fn is_eof(&self) -> bool {
        matches!(
            self.kind,
            Length(0)
                | Chunked {
                    state: ChunkedState::End,
                    ..
                }
                | Eof(true)
        )
    }

    pub(crate) fn decode<R: MemRead>(
        &mut self,
        cx: &mut Context<'_>,
        body: &mut R,
    ) -> Poll<Result<Frame<Bytes>, io::Error>> {
        trace!("decode; state={:?}", self.kind);
        match self.kind {
            Length(ref mut remaining) => {
                if *remaining == 0 {
                    Poll::Ready(Ok(Frame::data(Bytes::new())))
                } else {
                    let to_read = usize::try_from(*remaining).unwrap_or(usize::MAX);
                    let buf = ready!(body.read_mem(cx, to_read))?;
                    let num = buf.as_ref().len() as u64;
                    if num > *remaining {
                        *remaining = 0;
                    } else if num == 0 {
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            IncompleteBody,
                        )));
                    } else {
                        *remaining -= num;
                    }
                    Poll::Ready(Ok(Frame::data(buf)))
                }
            }
            Chunked {
                ref mut state,
                ref mut chunk_len,
                ref mut extensions_cnt,
                ref mut trailers_buf,
                ref mut trailers_cnt,
                ref h1_max_headers,
                ref h1_max_header_size,
            } => {
                let h1_max_headers = h1_max_headers.unwrap_or(DEFAULT_MAX_HEADERS);
                let h1_max_header_size = h1_max_header_size.unwrap_or(TRAILER_LIMIT);
                loop {
                    let mut buf = None;
                    // advances the chunked state
                    *state = ready!(state.step(
                        cx,
                        body,
                        StepArgs {
                            chunk_size: chunk_len,
                            extensions_cnt,
                            chunk_buf: &mut buf,
                            trailers_buf,
                            trailers_cnt,
                            max_headers_cnt: h1_max_headers,
                            max_headers_bytes: h1_max_header_size,
                        }
                    ))?;
                    if *state == ChunkedState::End {
                        trace!("end of chunked");

                        if trailers_buf.is_some() {
                            trace!("found possible trailers");

                            // decoder enforces that trailers count will not exceed h1_max_headers
                            if *trailers_cnt >= h1_max_headers {
                                return Poll::Ready(Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "chunk trailers count overflow",
                                )));
                            }
                            match decode_trailers(
                                &mut trailers_buf.take().expect("Trailer is None"),
                                *trailers_cnt,
                            ) {
                                Ok(headers) => {
                                    return Poll::Ready(Ok(Frame::trailers(headers)));
                                }
                                Err(e) => {
                                    return Poll::Ready(Err(e));
                                }
                            }
                        }

                        return Poll::Ready(Ok(Frame::data(Bytes::new())));
                    }
                    if let Some(buf) = buf {
                        return Poll::Ready(Ok(Frame::data(buf)));
                    }
                }
            }
            Eof(ref mut is_eof) => {
                if *is_eof {
                    Poll::Ready(Ok(Frame::data(Bytes::new())))
                } else {
                    // 8192 chosen because its about 2 packets, there probably
                    // won't be that much available, so don't have MemReaders
                    // allocate buffers to big
                    body.read_mem(cx, 8192).map_ok(|slice| {
                        *is_eof = slice.is_empty();
                        Frame::data(slice)
                    })
                }
            }
        }
    }

    #[cfg(test)]
    async fn decode_fut<R: MemRead>(&mut self, body: &mut R) -> Result<Frame<Bytes>, io::Error> {
        std::future::poll_fn(move |cx| self.decode(cx, body)).await
    }
}

impl fmt::Debug for Decoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.kind, f)
    }
}

macro_rules! byte (
    ($rdr:ident, $cx:expr) => ({
        let buf = ready!($rdr.read_mem($cx, 1))?;
        if !buf.is_empty() {
            buf[0]
        } else {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::UnexpectedEof,
                                      "unexpected EOF during chunk size line")));
        }
    })
);

macro_rules! or_overflow {
    ($e:expr) => (
        match $e {
            Some(val) => val,
            None => return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk size: overflow",
            ))),
        }
    )
}

macro_rules! put_u8 {
    ($trailers_buf:expr, $byte:expr, $limit:expr) => {
        $trailers_buf.put_u8($byte);

        if $trailers_buf.len() >= $limit {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "chunk trailers bytes over limit",
            )));
        }
    };
}

// ===== impl ChunkedState =====

impl ChunkedState {
    fn new() -> ChunkedState {
        ChunkedState::Start
    }

    #[allow(clippy::too_many_arguments)]
    fn step<R: MemRead>(
        &self,
        cx: &mut Context<'_>,
        body: &mut R,
        step: StepArgs<'_>,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        use self::ChunkedState::*;
        match *self {
            Start => ChunkedState::read_start(cx, body, step.chunk_size),
            Size => ChunkedState::read_size(cx, body, step.chunk_size),
            SizeLws => ChunkedState::read_size_lws(cx, body),
            Extension => ChunkedState::read_extension(cx, body, step.extensions_cnt),
            SizeLf => ChunkedState::read_size_lf(cx, body, *step.chunk_size),
            Body => ChunkedState::read_body(cx, body, step.chunk_size, step.chunk_buf),
            BodyCr => ChunkedState::read_body_cr(cx, body),
            BodyLf => ChunkedState::read_body_lf(cx, body),
            Trailer => {
                ChunkedState::read_trailer(cx, body, step.trailers_buf, step.max_headers_bytes)
            }
            TrailerLf => ChunkedState::read_trailer_lf(
                cx,
                body,
                step.trailers_buf,
                step.trailers_cnt,
                step.max_headers_cnt,
                step.max_headers_bytes,
            ),
            EndCr => ChunkedState::read_end_cr(cx, body, step.trailers_buf, step.max_headers_bytes),
            EndLf => ChunkedState::read_end_lf(cx, body, step.trailers_buf, step.max_headers_bytes),
            End => Poll::Ready(Ok(ChunkedState::End)),
        }
    }

    fn read_start<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        size: &mut u64,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("Read chunk start");

        let radix = 16;
        match byte!(rdr, cx) {
            b @ b'0'..=b'9' => {
                *size = or_overflow!(size.checked_mul(radix));
                *size = or_overflow!(size.checked_add((b - b'0') as u64));
            }
            b @ b'a'..=b'f' => {
                *size = or_overflow!(size.checked_mul(radix));
                *size = or_overflow!(size.checked_add((b + 10 - b'a') as u64));
            }
            b @ b'A'..=b'F' => {
                *size = or_overflow!(size.checked_mul(radix));
                *size = or_overflow!(size.checked_add((b + 10 - b'A') as u64));
            }
            _ => {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid chunk size line: missing size digit",
                )));
            }
        }

        Poll::Ready(Ok(ChunkedState::Size))
    }

    fn read_size<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        size: &mut u64,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("Read chunk hex size");

        let radix = 16;
        match byte!(rdr, cx) {
            b @ b'0'..=b'9' => {
                *size = or_overflow!(size.checked_mul(radix));
                *size = or_overflow!(size.checked_add((b - b'0') as u64));
            }
            b @ b'a'..=b'f' => {
                *size = or_overflow!(size.checked_mul(radix));
                *size = or_overflow!(size.checked_add((b + 10 - b'a') as u64));
            }
            b @ b'A'..=b'F' => {
                *size = or_overflow!(size.checked_mul(radix));
                *size = or_overflow!(size.checked_add((b + 10 - b'A') as u64));
            }
            b'\t' | b' ' => return Poll::Ready(Ok(ChunkedState::SizeLws)),
            b';' => return Poll::Ready(Ok(ChunkedState::Extension)),
            b'\r' => return Poll::Ready(Ok(ChunkedState::SizeLf)),
            _ => {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid chunk size line: Invalid Size",
                )));
            }
        }
        Poll::Ready(Ok(ChunkedState::Size))
    }
    fn read_size_lws<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("read_size_lws");
        match byte!(rdr, cx) {
            // LWS can follow the chunk size, but no more digits can come
            b'\t' | b' ' => Poll::Ready(Ok(ChunkedState::SizeLws)),
            b';' => Poll::Ready(Ok(ChunkedState::Extension)),
            b'\r' => Poll::Ready(Ok(ChunkedState::SizeLf)),
            _ => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid chunk size linear white space",
            ))),
        }
    }
    fn read_extension<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        extensions_cnt: &mut u64,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("read_extension");
        // We don't care about extensions really at all. Just ignore them.
        // They "end" at the next CRLF.
        //
        // However, some implementations may not check for the CR, so to save
        // them from themselves, we reject extensions containing plain LF as
        // well.
        match byte!(rdr, cx) {
            b'\r' => Poll::Ready(Ok(ChunkedState::SizeLf)),
            b'\n' => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid chunk extension contains newline",
            ))),
            _ => {
                *extensions_cnt += 1;
                if *extensions_cnt >= CHUNKED_EXTENSIONS_LIMIT {
                    Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "chunk extensions over limit",
                    )))
                } else {
                    Poll::Ready(Ok(ChunkedState::Extension))
                }
            } // no supported extensions
        }
    }
    fn read_size_lf<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        size: u64,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("Chunk size is {:?}", size);
        match byte!(rdr, cx) {
            b'\n' => {
                if size == 0 {
                    Poll::Ready(Ok(ChunkedState::EndCr))
                } else {
                    debug!("incoming chunked header: {0:#X} ({0} bytes)", size);
                    Poll::Ready(Ok(ChunkedState::Body))
                }
            }
            _ => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid chunk size LF",
            ))),
        }
    }

    fn read_body<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        rem: &mut u64,
        buf: &mut Option<Bytes>,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("Chunked read, remaining={:?}", rem);

        // cap remaining bytes at the max capacity of usize
        let to_read = usize::try_from(*rem).unwrap_or(usize::MAX);
        let slice = ready!(rdr.read_mem(cx, to_read))?;
        let count = slice.len();

        if count == 0 {
            *rem = 0;
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                IncompleteBody,
            )));
        }
        *buf = Some(slice);
        *rem -= count as u64;

        if *rem > 0 {
            Poll::Ready(Ok(ChunkedState::Body))
        } else {
            Poll::Ready(Ok(ChunkedState::BodyCr))
        }
    }
    fn read_body_cr<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        match byte!(rdr, cx) {
            b'\r' => Poll::Ready(Ok(ChunkedState::BodyLf)),
            _ => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid chunk body CR",
            ))),
        }
    }
    fn read_body_lf<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        match byte!(rdr, cx) {
            b'\n' => Poll::Ready(Ok(ChunkedState::Start)),
            _ => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid chunk body LF",
            ))),
        }
    }

    fn read_trailer<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        trailers_buf: &mut Option<BytesMut>,
        h1_max_header_size: usize,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        trace!("read_trailer");
        let byte = byte!(rdr, cx);

        put_u8!(
            trailers_buf.as_mut().expect("trailers_buf is None"),
            byte,
            h1_max_header_size
        );

        match byte {
            b'\r' => Poll::Ready(Ok(ChunkedState::TrailerLf)),
            _ => Poll::Ready(Ok(ChunkedState::Trailer)),
        }
    }

    fn read_trailer_lf<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        trailers_buf: &mut Option<BytesMut>,
        trailers_cnt: &mut usize,
        h1_max_headers: usize,
        h1_max_header_size: usize,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        let byte = byte!(rdr, cx);
        match byte {
            b'\n' => {
                if *trailers_cnt >= h1_max_headers {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "chunk trailers count overflow",
                    )));
                }
                *trailers_cnt += 1;

                put_u8!(
                    trailers_buf.as_mut().expect("trailers_buf is None"),
                    byte,
                    h1_max_header_size
                );

                Poll::Ready(Ok(ChunkedState::EndCr))
            }
            _ => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid trailer end LF",
            ))),
        }
    }

    fn read_end_cr<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        trailers_buf: &mut Option<BytesMut>,
        h1_max_header_size: usize,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        let byte = byte!(rdr, cx);
        match byte {
            b'\r' => {
                if let Some(trailers_buf) = trailers_buf {
                    put_u8!(trailers_buf, byte, h1_max_header_size);
                }
                Poll::Ready(Ok(ChunkedState::EndLf))
            }
            byte => {
                match trailers_buf {
                    None => {
                        // 64 will fit a single Expires header without reallocating
                        let mut buf = BytesMut::with_capacity(64);
                        buf.put_u8(byte);
                        *trailers_buf = Some(buf);
                    }
                    Some(trailers_buf) => {
                        put_u8!(trailers_buf, byte, h1_max_header_size);
                    }
                }

                Poll::Ready(Ok(ChunkedState::Trailer))
            }
        }
    }
    fn read_end_lf<R: MemRead>(
        cx: &mut Context<'_>,
        rdr: &mut R,
        trailers_buf: &mut Option<BytesMut>,
        h1_max_header_size: usize,
    ) -> Poll<Result<ChunkedState, io::Error>> {
        let byte = byte!(rdr, cx);
        match byte {
            b'\n' => {
                if let Some(trailers_buf) = trailers_buf {
                    put_u8!(trailers_buf, byte, h1_max_header_size);
                }
                Poll::Ready(Ok(ChunkedState::End))
            }
            _ => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid chunk end LF",
            ))),
        }
    }
}

// TODO: disallow Transfer-Encoding, Content-Length, Trailer, etc in trailers ??
fn decode_trailers(buf: &mut BytesMut, count: usize) -> Result<HeaderMap, io::Error> {
    let mut trailers = HeaderMap::new();
    let mut headers = vec![httparse::EMPTY_HEADER; count];
    let res = httparse::parse_headers(buf, &mut headers);
    match res {
        Ok(httparse::Status::Complete((_, headers))) => {
            for header in headers.iter() {
                use std::convert::TryFrom;
                let name = match HeaderName::try_from(header.name) {
                    Ok(name) => name,
                    Err(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            format!("Invalid header name: {:?}", &header),
                        ));
                    }
                };

                let value = match HeaderValue::from_bytes(header.value) {
                    Ok(value) => value,
                    Err(_) => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            format!("Invalid header value: {:?}", &header),
                        ));
                    }
                };

                trailers.insert(name, value);
            }

            Ok(trailers)
        }
        Ok(httparse::Status::Partial) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Partial header",
        )),
        Err(e) => Err(io::Error::new(io::ErrorKind::InvalidInput, e)),
    }
}

#[derive(Debug)]
struct IncompleteBody;

// === impl IncompleteBody ===

impl fmt::Display for IncompleteBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "end of file before message length reached")
    }
}

impl StdError for IncompleteBody {}

#[cfg(test)]
mod tests {
    use std::{pin::Pin, time::Duration};

    use tokio::io::{AsyncRead, ReadBuf};

    use super::*;

    impl MemRead for &[u8] {
        fn read_mem(&mut self, _: &mut Context<'_>, len: usize) -> Poll<io::Result<Bytes>> {
            let n = std::cmp::min(len, self.len());
            if n > 0 {
                let (a, b) = self.split_at(n);
                let buf = Bytes::copy_from_slice(a);
                *self = b;
                Poll::Ready(Ok(buf))
            } else {
                Poll::Ready(Ok(Bytes::new()))
            }
        }
    }

    impl MemRead for &mut (dyn AsyncRead + Unpin) {
        fn read_mem(&mut self, cx: &mut Context<'_>, len: usize) -> Poll<io::Result<Bytes>> {
            let mut v = vec![0; len];
            let mut buf = ReadBuf::new(&mut v);
            ready!(Pin::new(self).poll_read(cx, &mut buf)?);
            Poll::Ready(Ok(Bytes::copy_from_slice(buf.filled())))
        }
    }

    impl MemRead for Bytes {
        fn read_mem(&mut self, _: &mut Context<'_>, len: usize) -> Poll<io::Result<Bytes>> {
            let n = std::cmp::min(len, self.len());
            let ret = self.split_to(n);
            Poll::Ready(Ok(ret))
        }
    }

    #[tokio::test]
    async fn test_read_chunk_size() {
        use std::io::ErrorKind::{InvalidData, InvalidInput, UnexpectedEof};

        async fn read(s: &str) -> u64 {
            let mut state = ChunkedState::new();
            let rdr = &mut s.as_bytes();
            let mut size = 0;
            let mut ext_cnt = 0;
            let mut trailers_cnt = 0;
            loop {
                let result = std::future::poll_fn(|cx| {
                    state.step(
                        cx,
                        rdr,
                        StepArgs {
                            chunk_size: &mut size,
                            extensions_cnt: &mut ext_cnt,
                            chunk_buf: &mut None,
                            trailers_buf: &mut None,
                            trailers_cnt: &mut trailers_cnt,
                            max_headers_cnt: DEFAULT_MAX_HEADERS,
                            max_headers_bytes: TRAILER_LIMIT,
                        },
                    )
                })
                .await;
                let desc = format!("read_size failed for {s:?}");
                state = result.expect(&desc);
                if state == ChunkedState::Body || state == ChunkedState::EndCr {
                    break;
                }
            }
            size
        }

        async fn read_err(s: &str, expected_err: io::ErrorKind) {
            let mut state = ChunkedState::new();
            let rdr = &mut s.as_bytes();
            let mut size = 0;
            let mut ext_cnt = 0;
            let mut trailers_cnt = 0;
            loop {
                let result = std::future::poll_fn(|cx| {
                    state.step(
                        cx,
                        rdr,
                        StepArgs {
                            chunk_size: &mut size,
                            extensions_cnt: &mut ext_cnt,
                            chunk_buf: &mut None,
                            trailers_buf: &mut None,
                            trailers_cnt: &mut trailers_cnt,
                            max_headers_cnt: DEFAULT_MAX_HEADERS,
                            max_headers_bytes: TRAILER_LIMIT,
                        },
                    )
                })
                .await;
                state = match result {
                    Ok(s) => s,
                    Err(e) => {
                        assert!(
                            expected_err == e.kind(),
                            "Reading {:?}, expected {:?}, but got {:?}",
                            s,
                            expected_err,
                            e.kind()
                        );
                        return;
                    }
                };
                if state == ChunkedState::Body || state == ChunkedState::End {
                    panic!("Was Ok. Expected Err for {s:?}");
                }
            }
        }

        assert_eq!(1, read("1\r\n").await);
        assert_eq!(1, read("01\r\n").await);
        assert_eq!(0, read("0\r\n").await);
        assert_eq!(0, read("00\r\n").await);
        assert_eq!(10, read("A\r\n").await);
        assert_eq!(10, read("a\r\n").await);
        assert_eq!(255, read("Ff\r\n").await);
        assert_eq!(255, read("Ff   \r\n").await);
        // Missing LF or CRLF
        read_err("F\rF", InvalidInput).await;
        read_err("F", UnexpectedEof).await;
        // Missing digit
        read_err("\r\n\r\n", InvalidInput).await;
        read_err("\r\n", InvalidInput).await;
        // Invalid hex digit
        read_err("X\r\n", InvalidInput).await;
        read_err("1X\r\n", InvalidInput).await;
        read_err("-\r\n", InvalidInput).await;
        read_err("-1\r\n", InvalidInput).await;
        // Acceptable (if not fully valid) extensions do not influence the size
        assert_eq!(1, read("1;extension\r\n").await);
        assert_eq!(10, read("a;ext name=value\r\n").await);
        assert_eq!(1, read("1;extension;extension2\r\n").await);
        assert_eq!(1, read("1;;;  ;\r\n").await);
        assert_eq!(2, read("2; extension...\r\n").await);
        assert_eq!(3, read("3   ; extension=123\r\n").await);
        assert_eq!(3, read("3   ;\r\n").await);
        assert_eq!(3, read("3   ;   \r\n").await);
        // Invalid extensions cause an error
        read_err("1 invalid extension\r\n", InvalidInput).await;
        read_err("1 A\r\n", InvalidInput).await;
        read_err("1;no CRLF", UnexpectedEof).await;
        read_err("1;reject\nnewlines\r\n", InvalidData).await;
        // Overflow
        read_err("f0000000000000003\r\n", InvalidData).await;
    }

    #[tokio::test]
    async fn test_read_sized_early_eof() {
        let mut bytes = &b"foo bar"[..];
        let mut decoder = Decoder::length(10);
        assert_eq!(
            decoder
                .decode_fut(&mut bytes)
                .await
                .unwrap()
                .data_ref()
                .unwrap()
                .len(),
            7
        );
        let e = decoder.decode_fut(&mut bytes).await.unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn test_read_chunked_early_eof() {
        let mut bytes = &b"\
            9\r\n\
            foo bar\
        "[..];
        let mut decoder = Decoder::chunked(None, None);
        assert_eq!(
            decoder
                .decode_fut(&mut bytes)
                .await
                .unwrap()
                .data_ref()
                .unwrap()
                .len(),
            7
        );
        let e = decoder.decode_fut(&mut bytes).await.unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn test_read_chunked_single_read() {
        let mut mock_buf = &b"10\r\n1234567890abcdef\r\n0\r\n"[..];
        let buf = Decoder::chunked(None, None)
            .decode_fut(&mut mock_buf)
            .await
            .expect("decode")
            .into_data()
            .expect("unknown frame type");
        assert_eq!(16, buf.len());
        let result = String::from_utf8(buf.as_ref().to_vec()).expect("decode String");
        assert_eq!("1234567890abcdef", &result);
    }

    #[tokio::test]
    async fn test_read_chunked_with_missing_zero_digit() {
        // After reading a valid chunk, the ending is missing a zero.
        let mut mock_buf = &b"1\r\nZ\r\n\r\n\r\n"[..];
        let mut decoder = Decoder::chunked(None, None);
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect("decode")
            .into_data()
            .expect("unknown frame type");
        assert_eq!("Z", buf);

        let err = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect_err("decode 2");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn test_read_chunked_extensions_over_limit() {
        // construct a chunked body where each individual chunked extension
        // is totally fine, but combined is over the limit.
        let per_chunk = super::CHUNKED_EXTENSIONS_LIMIT * 2 / 3;
        let mut scratch = vec![];
        for _ in 0..2 {
            scratch.extend(b"1;");
            scratch.extend(b"x".repeat(per_chunk as usize));
            scratch.extend(b"\r\nA\r\n");
        }
        scratch.extend(b"0\r\n\r\n");
        let mut mock_buf = Bytes::from(scratch);

        let mut decoder = Decoder::chunked(None, None);
        let buf1 = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect("decode1")
            .into_data()
            .expect("unknown frame type");
        assert_eq!(&buf1[..], b"A");

        let err = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect_err("decode2");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(err.to_string(), "chunk extensions over limit");
    }

    #[tokio::test]
    async fn test_read_chunked_trailer_with_missing_lf() {
        let mut mock_buf = &b"10\r\n1234567890abcdef\r\n0\r\nbad\r\r\n"[..];
        let mut decoder = Decoder::chunked(None, None);
        decoder.decode_fut(&mut mock_buf).await.expect("decode");
        let e = decoder.decode_fut(&mut mock_buf).await.unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn test_read_chunked_after_eof() {
        let mut mock_buf = &b"10\r\n1234567890abcdef\r\n0\r\n\r\n"[..];
        let mut decoder = Decoder::chunked(None, None);

        // normal read
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .unwrap()
            .into_data()
            .expect("unknown frame type");
        assert_eq!(16, buf.len());
        let result = String::from_utf8(buf.as_ref().to_vec()).expect("decode String");
        assert_eq!("1234567890abcdef", &result);

        // eof read
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect("decode")
            .into_data()
            .expect("unknown frame type");
        assert_eq!(0, buf.len());

        // ensure read after eof also returns eof
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect("decode")
            .into_data()
            .expect("unknown frame type");
        assert_eq!(0, buf.len());
    }

    // perform an async read using a custom buffer size and causing a blocking
    // read at the specified byte
    async fn read_async(mut decoder: Decoder, content: &[u8], block_at: usize) -> String {
        let mut outs = Vec::new();

        let mut ins = if block_at == 0 {
            tokio_test::io::Builder::new()
                .wait(Duration::from_millis(10))
                .read(content)
                .build()
        } else {
            tokio_test::io::Builder::new()
                .read(&content[..block_at])
                .wait(Duration::from_millis(10))
                .read(&content[block_at..])
                .build()
        };

        let mut ins = &mut ins as &mut (dyn AsyncRead + Unpin);

        loop {
            let buf = decoder
                .decode_fut(&mut ins)
                .await
                .expect("unexpected decode error")
                .into_data()
                .expect("unexpected frame type");
            if buf.is_empty() {
                break; // eof
            }
            outs.extend(buf.as_ref());
        }

        String::from_utf8(outs).expect("decode String")
    }

    // iterate over the different ways that this async read could go.
    // tests blocking a read at each byte along the content - The shotgun approach
    async fn all_async_cases(content: &str, expected: &str, decoder: Decoder) {
        let content_len = content.len();
        for block_at in 0..content_len {
            let actual = read_async(decoder.clone(), content.as_bytes(), block_at).await;
            assert_eq!(expected, &actual) //, "Failed async. Blocking at {}", block_at);
        }
    }

    #[tokio::test]
    async fn test_read_length_async() {
        let content = "foobar";
        all_async_cases(content, content, Decoder::length(content.len() as u64)).await;
    }

    #[tokio::test]
    async fn test_read_chunked_async() {
        let content = "3\r\nfoo\r\n3\r\nbar\r\n0\r\n\r\n";
        let expected = "foobar";
        all_async_cases(content, expected, Decoder::chunked(None, None)).await;
    }

    #[tokio::test]
    async fn test_read_eof_async() {
        let content = "foobar";
        all_async_cases(content, content, Decoder::eof()).await;
    }

    #[test]
    fn test_decode_trailers() {
        let mut buf = BytesMut::new();
        buf.extend_from_slice(
            b"Expires: Wed, 21 Oct 2015 07:28:00 GMT\r\nX-Stream-Error: failed to decode\r\n\r\n",
        );
        let headers = decode_trailers(&mut buf, 2).expect("decode_trailers");
        assert_eq!(headers.len(), 2);
        assert_eq!(
            headers.get("Expires").unwrap(),
            "Wed, 21 Oct 2015 07:28:00 GMT"
        );
        assert_eq!(headers.get("X-Stream-Error").unwrap(), "failed to decode");
    }

    #[tokio::test]
    async fn test_trailer_max_headers_enforced() {
        let h1_max_headers = 10;
        let mut scratch = vec![];
        scratch.extend(b"10\r\n1234567890abcdef\r\n0\r\n");
        for i in 0..h1_max_headers {
            scratch.extend(format!("trailer{i}: {i}\r\n").as_bytes());
        }
        scratch.extend(b"\r\n");
        let mut mock_buf = Bytes::from(scratch);

        let mut decoder = Decoder::chunked(Some(h1_max_headers), None);

        // ready chunked body
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .unwrap()
            .into_data()
            .expect("unknown frame type");
        assert_eq!(16, buf.len());

        // eof read
        let err = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect_err("trailer fields over limit");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn test_trailer_max_header_size_huge_trailer() {
        let max_header_size = 1024;
        let mut scratch = vec![];
        scratch.extend(b"10\r\n1234567890abcdef\r\n0\r\n");
        scratch.extend(format!("huge_trailer: {}\r\n", "x".repeat(max_header_size)).as_bytes());
        scratch.extend(b"\r\n");
        let mut mock_buf = Bytes::from(scratch);

        let mut decoder = Decoder::chunked(None, Some(max_header_size));

        // ready chunked body
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .unwrap()
            .into_data()
            .expect("unknown frame type");
        assert_eq!(16, buf.len());

        // eof read
        let err = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect_err("trailers over limit");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn test_trailer_max_header_size_many_small_trailers() {
        let max_headers = 10;
        let header_size = 64;
        let mut scratch = vec![];
        scratch.extend(b"10\r\n1234567890abcdef\r\n0\r\n");

        for i in 0..max_headers {
            scratch.extend(format!("trailer{}: {}\r\n", i, "x".repeat(header_size)).as_bytes());
        }

        scratch.extend(b"\r\n");
        let mut mock_buf = Bytes::from(scratch);

        let mut decoder = Decoder::chunked(None, Some(max_headers * header_size));

        // ready chunked body
        let buf = decoder
            .decode_fut(&mut mock_buf)
            .await
            .unwrap()
            .into_data()
            .expect("unknown frame type");
        assert_eq!(16, buf.len());

        // eof read
        let err = decoder
            .decode_fut(&mut mock_buf)
            .await
            .expect_err("trailers over limit");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
