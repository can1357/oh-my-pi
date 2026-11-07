use std::{cell::RefMut, cmp};

use {
    encoding_rs::{CoderResult, Decoder, Encoding, UTF_8},
    grep_matcher::Matcher,
};

use crate::{
    line_buffer::{LineBuffer, alloc_error},
    searcher::{Config, ConfigError, Searcher, core::Core, glue::MultiLine},
    sink::{Sink, SinkError},
};

impl Searcher {
    /// Start a search over input that arrives in chunks and write the results
    /// to the given sink.
    ///
    /// The search has exactly the semantics of [`Searcher::search_reader`]:
    /// BOM sniffing and transcoding, binary detection, line-by-line or
    /// multi-line matching, context, line numbers, absolute byte offsets,
    /// passthru, inverted matching and stopping when the sink says so. Each
    /// chunk handed to [`PushSearch::push`] plays the part of one `read` of a
    /// reader, so a search over chunks produces the same sink calls as
    /// `search_reader` over a reader returning those same chunks. (Where binary
    /// detection is enabled, the sink calls depend on how the input is split
    /// into reads, for readers as well as for chunks.)
    ///
    /// A configuration or matcher that `search_reader` would reject is
    /// reported by the first call to `push` or `finish`.
    pub fn search_push<'s, M: Matcher, S: Sink>(
        &'s mut self,
        matcher: M,
        write_to: S,
    ) -> PushSearch<'s, M, S> {
        let searcher: &'s Searcher = self;
        let config_error = searcher.check_config(&matcher).err();
        let engine = if searcher.multi_line_with_matcher(&matcher) {
            let mut buf = searcher.multi_line_buffer.borrow_mut();
            buf.clear();
            Engine::Multi(Multi {
                searcher,
                matcher,
                sink: write_to,
                buf,
                started: false,
            })
        } else {
            let mut buf = searcher.line_buffer.borrow_mut();
            buf.clear();
            Engine::Lines(Lines {
                config: &searcher.config,
                core: Core::new(searcher, matcher, write_to, false),
                buf,
                phase: Phase::Fresh,
                fill: FillStart::default(),
            })
        };
        PushSearch {
            config_error,
            failed: false,
            decode: Decode::new(&searcher.config),
            engine,
        }
    }
}

/// An incremental search; `push` each chunk, then `finish`.
///
/// Created by [`Searcher::search_push`].
pub struct PushSearch<'s, M, S> {
    config_error: Option<ConfigError>,
    failed: bool,
    decode: Decode,
    engine: Engine<'s, M, S>,
}

// SAFETY: a `PushSearch` holds the searcher's exclusive borrow (`search_push`
// takes `&'s mut Searcher`), so the `RefCell` buffers behind its `RefMut`s and
// the `&'s Searcher` it keeps are reachable from the owner only; sending it
// sends the whole exclusive borrow. The sink only sees the `&Searcher` it is
// handed for the duration of a call. The matcher and the sink move with it,
// hence the bounds.
unsafe impl<'s, M: Send, S: Send> Send for PushSearch<'s, M, S> {}

impl<'s, M: Matcher, S: Sink> PushSearch<'s, M, S> {
    /// Searches the lines `chunk` completes; `Ok(false)` once the search is
    /// over (sink stopped, binary quit): feed nothing more and call `finish`.
    ///
    /// After an error the search is dead: further calls return `Ok(false)` and
    /// `finish` reports nothing, as `search_reader` reports nothing after an
    /// error.
    pub fn push(&mut self, chunk: &[u8]) -> Result<bool, S::Error> {
        if let Some(err) = self.config_error.take() {
            self.failed = true;
            return Err(S::Error::error_config(err));
        }
        if self.failed {
            return Ok(false);
        }
        let result = self.push_chunk(chunk);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn push_chunk(&mut self, chunk: &[u8]) -> Result<bool, S::Error> {
        let mut open = self.engine.start()?;
        if !open {
            return Ok(false);
        }
        for read in self.decode.feed(chunk) {
            if !open {
                break;
            }
            open = self.engine.read(read)?;
        }
        Ok(open)
    }

    /// Ends the input: searches what remains and reports the finish to the
    /// sink.
    pub fn finish(mut self) -> Result<(), S::Error> {
        if let Some(err) = self.config_error.take() {
            return Err(S::Error::error_config(err));
        }
        if self.failed {
            return Ok(());
        }
        match self.engine {
            Engine::Lines(mut lines) => {
                let mut open = lines.start()?;
                for read in self.decode.flush() {
                    if !open {
                        break;
                    }
                    open = lines.read(read)?;
                }
                if open {
                    lines.drive(&[], true)?;
                }
                lines.core.finish(
                    lines.buf.absolute_byte_offset(),
                    lines.buf.binary_byte_offset(),
                )
            }
            Engine::Multi(mut multi) => {
                multi.start()?;
                for read in self.decode.flush() {
                    multi.read(read)?;
                }
                multi.run()
            }
        }
    }
}

enum Engine<'s, M, S> {
    Lines(Lines<'s, M, S>),
    Multi(Multi<'s, M, S>),
}

impl<'s, M: Matcher, S: Sink> Engine<'s, M, S> {
    /// Begins the search if it has not begun. Returns false if the search is
    /// over.
    fn start(&mut self) -> Result<bool, S::Error> {
        match self {
            Engine::Lines(lines) => lines.start(),
            Engine::Multi(multi) => multi.start().map(|()| true),
        }
    }

    /// Searches one read. Returns false if the search is over.
    fn read(&mut self, data: &[u8]) -> Result<bool, S::Error> {
        match self {
            Engine::Lines(lines) => lines.read(data),
            Engine::Multi(multi) => multi.read(data).map(|()| true),
        }
    }
}

/// The phase of a line-by-line search.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    /// The sink has not been told that the search begins.
    Fresh,
    /// A fill of the line buffer is under way.
    Filling,
    /// Nothing more is read or searched.
    Over,
}

/// What `ReadByLine::fill` knows before it reads, kept for after it has.
#[derive(Clone, Copy, Debug, Default)]
struct FillStart {
    already_binary: bool,
    old_buf_len: usize,
    consumed: usize,
}

/// The line-by-line search: `ReadByLine` run as a state machine whose fills
/// wait for input instead of blocking on a reader.
struct Lines<'s, M, S> {
    config: &'s Config,
    core: Core<'s, M, S>,
    buf: RefMut<'s, LineBuffer>,
    phase: Phase,
    fill: FillStart,
}

impl<'s, M: Matcher, S: Sink> Lines<'s, M, S> {
    fn start(&mut self) -> Result<bool, S::Error> {
        if self.phase == Phase::Fresh {
            if self.core.begin()? {
                self.begin_fill();
                self.phase = Phase::Filling;
            } else {
                self.phase = Phase::Over;
            }
        }
        Ok(self.phase != Phase::Over)
    }

    fn read(&mut self, data: &[u8]) -> Result<bool, S::Error> {
        if data.is_empty() {
            return Ok(self.phase != Phase::Over);
        }
        self.drive(data, false)
    }

    /// Runs the search over `src`, which is one read of the input, or over the
    /// end of the input if `eof` is set. Returns false if the search is over.
    fn drive(&mut self, mut src: &[u8], eof: bool) -> Result<bool, S::Error> {
        loop {
            if self.phase == Phase::Over {
                return Ok(false);
            }
            let didread =
                match self.buf.push_fill(&mut src).map_err(S::Error::error_io)?
                {
                    Some(didread) => didread,
                    None if eof => self.buf.push_eof(),
                    None => return Ok(true),
                };
            if !self.end_fill(didread)? {
                self.phase = Phase::Over;
                return Ok(false);
            }
            if !self.core.match_by_line(self.buf.buffer())? {
                let consumed = self.core.pos();
                self.buf.consume(consumed);
                self.phase = Phase::Over;
                return Ok(false);
            }
            self.begin_fill();
        }
    }

    /// The part of `ReadByLine::fill` that precedes the reads.
    fn begin_fill(&mut self) {
        assert!(self.buf.buffer()[self.core.pos()..].is_empty());

        let already_binary = self.buf.binary_byte_offset().is_some();
        let old_buf_len = self.buf.buffer().len();
        let consumed = self.core.roll(self.buf.buffer());
        self.buf.consume(consumed);
        self.buf.roll();
        self.fill = FillStart { already_binary, old_buf_len, consumed };
    }

    /// The part of `ReadByLine::fill` that follows the reads. Returns whether
    /// the buffer is to be searched and the search to go on.
    fn end_fill(&mut self, didread: bool) -> Result<bool, S::Error> {
        let FillStart { already_binary, old_buf_len, consumed } = self.fill;
        if !already_binary
            && let Some(offset) = self.buf.binary_byte_offset()
            && !self.core.binary_data(offset)?
        {
            return Ok(false);
        }
        if !didread || self.should_binary_quit() {
            return Ok(false);
        }
        // If rolling the buffer didn't result in consuming anything and if
        // re-filling the buffer didn't add any bytes, then the only thing in
        // our buffer is leftover context, which we no longer need since there
        // is nothing left to search. So forcefully quit.
        if consumed == 0 && old_buf_len == self.buf.buffer().len() {
            self.buf.consume(old_buf_len);
            return Ok(false);
        }
        Ok(true)
    }

    fn should_binary_quit(&self) -> bool {
        self.buf.binary_byte_offset().is_some()
            && self.config.binary.quit_byte().is_some()
    }
}

/// The multi-line search, which has to hold all of its input before it can
/// start.
struct Multi<'s, M, S> {
    searcher: &'s Searcher,
    matcher: M,
    sink: S,
    buf: RefMut<'s, Vec<u8>>,
    started: bool,
}

impl<'s, M: Matcher, S: Sink> Multi<'s, M, S> {
    fn start(&mut self) -> Result<(), S::Error> {
        if !self.started {
            self.started = true;
            if self.searcher.config.heap_limit == Some(0) {
                return Err(S::Error::error_io(alloc_error(0)));
            }
        }
        Ok(())
    }

    fn read(&mut self, data: &[u8]) -> Result<(), S::Error> {
        self.buf.extend_from_slice(data);
        match self.searcher.config.heap_limit {
            Some(limit) if self.buf.len() >= limit => {
                Err(S::Error::error_io(alloc_error(limit)))
            }
            _ => Ok(()),
        }
    }

    fn run(self) -> Result<(), S::Error> {
        MultiLine::new(self.searcher, self.matcher, &self.buf, self.sink).run()
    }
}

/// The bytes at the start of the input that may be a byte-order mark.
#[derive(Clone, Copy, Debug)]
struct Peek {
    bytes: [u8; 3],
    len: usize,
}

/// A streaming equivalent of `encoding_rs_io::DecodeReaderBytes` as the
/// searcher configures it: the first three bytes are held back to detect a
/// byte-order mark, then the input is passed through or transcoded to UTF-8.
///
/// Each call hands out the reads the reader would have produced for the same
/// chunk: the (possibly stripped) byte-order mark as a read of its own, then
/// the rest of the chunk.
struct Decode {
    decoder: Option<Decoder>,
    /// Whether a byte-order mark may replace the decoder.
    detect: bool,
    /// Whether a byte-order mark is passed on rather than stripped.
    with_bom: bool,
    peek: Option<Peek>,
    head: Vec<u8>,
    body: Vec<u8>,
}

impl Decode {
    fn new(config: &Config) -> Decode {
        let encoding = config.encoding.as_ref().map(|e| e.0);
        Decode {
            decoder: encoding.map(|e| e.new_decoder_with_bom_removal()),
            detect: config.bom_sniffing,
            with_bom: !config.bom_sniffing,
            peek: Some(Peek { bytes: [0; 3], len: 0 }),
            head: vec![],
            body: vec![],
        }
    }

    fn feed<'a>(&'a mut self, chunk: &'a [u8]) -> [&'a [u8]; 2] {
        self.head.clear();
        let mut rest = chunk;
        if let Some(peek) = self.peek.as_mut() {
            let take = cmp::min(3 - peek.len, rest.len());
            peek.bytes[peek.len..peek.len + take]
                .copy_from_slice(&rest[..take]);
            peek.len += take;
            rest = &rest[take..];
            if peek.len < 3 {
                return [&[], &[]];
            }
            self.resolve();
        }
        let body: &[u8] = match self.decoder.as_mut() {
            Some(decoder) => {
                decode(decoder, rest, false, &mut self.body);
                &self.body
            }
            None => rest,
        };
        [&self.head, body]
    }

    fn flush(&mut self) -> [&[u8]; 2] {
        self.head.clear();
        self.resolve();
        let body: &[u8] = match self.decoder.as_mut() {
            Some(decoder) => {
                decode(decoder, &[], true, &mut self.body);
                &self.body
            }
            None => &[],
        };
        [&self.head, body]
    }

    /// Decides on the byte-order mark and puts what it leaves of the first
    /// bytes in `head`.
    fn resolve(&mut self) {
        let Some(Peek { bytes, len }) = self.peek.take() else {
            return;
        };
        if self.detect
            && len == 3
            && let Some((encoding, _)) = Encoding::for_bom(&bytes)
        {
            log::trace!("found byte-order mark (BOM) for encoding {encoding:?}");
            // A UTF-8 byte-order mark is stripped without transcoding.
            if encoding != UTF_8 {
                self.decoder = Some(encoding.new_decoder_with_bom_removal());
            }
        }
        let slice = bom_slice(&bytes[..len], self.with_bom);
        match self.decoder.as_mut() {
            Some(decoder) => {
                if !slice.is_empty() {
                    decode(decoder, slice, false, &mut self.head);
                }
            }
            None => self.head.extend_from_slice(slice),
        }
    }
}

/// The part of the first bytes that is passed on: all of them if a
/// byte-order mark is kept, otherwise all but a byte-order mark.
fn bom_slice(slice: &[u8], with_bom: bool) -> &[u8] {
    if with_bom || slice.len() <= 1 {
        slice
    } else if slice.starts_with(b"\xFF\xFE") || slice.starts_with(b"\xFE\xFF")
    {
        &slice[2..]
    } else if slice == b"\xEF\xBB\xBF" {
        &[]
    } else {
        slice
    }
}

/// Transcodes `src` to UTF-8 in `out`, replacing malformed sequences.
fn decode(decoder: &mut Decoder, mut src: &[u8], last: bool, out: &mut Vec<u8>) {
    out.clear();
    loop {
        let start = out.len();
        let room = decoder
            .max_utf8_buffer_length(src.len())
            .unwrap_or_else(|| src.len().saturating_mul(3).saturating_add(4));
        out.resize(start + room, 0);
        let (result, nin, nout, _) =
            decoder.decode_to_utf8(src, &mut out[start..], last);
        out.truncate(start + nout);
        src = &src[nin..];
        if result == CoderResult::InputEmpty {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Read};

    use grep_matcher::LineTerminator;

    use crate::{
        searcher::{BinaryDetection, Encoding, Searcher, SearcherBuilder},
        sink::{Sink, SinkContext, SinkContextKind, SinkFinish, SinkMatch},
        testutil::RegexMatcher,
    };

    /// Everything a sink is told, in order.
    #[derive(Clone, Debug, Eq, PartialEq)]
    enum Event {
        Begin,
        Matched { line: Option<u64>, offset: u64, bytes: Vec<u8> },
        Context {
            kind: SinkContextKind,
            line: Option<u64>,
            offset: u64,
            bytes: Vec<u8>,
        },
        ContextBreak,
        Binary(u64),
        Finish { byte_count: u64, binary_offset: Option<u64> },
    }

    /// A sink that records its calls and stops the search after `stop`
    /// matches.
    struct Recorder {
        events: Vec<Event>,
        matches: usize,
        stop: Option<usize>,
    }

    impl Recorder {
        fn new(stop: Option<usize>) -> Recorder {
            Recorder { events: vec![], matches: 0, stop }
        }
    }

    impl Sink for Recorder {
        type Error = io::Error;

        fn matched(
            &mut self,
            _searcher: &Searcher,
            mat: &SinkMatch<'_>,
        ) -> Result<bool, io::Error> {
            self.events.push(Event::Matched {
                line: mat.line_number(),
                offset: mat.absolute_byte_offset(),
                bytes: mat.bytes().to_vec(),
            });
            self.matches += 1;
            Ok(self.stop.is_none_or(|stop| self.matches < stop))
        }

        fn context(
            &mut self,
            _searcher: &Searcher,
            context: &SinkContext<'_>,
        ) -> Result<bool, io::Error> {
            self.events.push(Event::Context {
                kind: context.kind().clone(),
                line: context.line_number(),
                offset: context.absolute_byte_offset(),
                bytes: context.bytes().to_vec(),
            });
            Ok(true)
        }

        fn context_break(
            &mut self,
            _searcher: &Searcher,
        ) -> Result<bool, io::Error> {
            self.events.push(Event::ContextBreak);
            Ok(true)
        }

        fn binary_data(
            &mut self,
            _searcher: &Searcher,
            binary_byte_offset: u64,
        ) -> Result<bool, io::Error> {
            self.events.push(Event::Binary(binary_byte_offset));
            Ok(true)
        }

        fn begin(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
            self.events.push(Event::Begin);
            Ok(true)
        }

        fn finish(
            &mut self,
            _searcher: &Searcher,
            finish: &SinkFinish,
        ) -> Result<(), io::Error> {
            self.events.push(Event::Finish {
                byte_count: finish.byte_count(),
                binary_offset: finish.binary_byte_offset(),
            });
            Ok(())
        }
    }

    /// A reader whose reads never cross a multiple of `chunk`, so that it
    /// delivers its data in the pieces a push search is fed.
    struct ChunkReader<'a> {
        data: &'a [u8],
        pos: usize,
        chunk: usize,
    }

    impl Read for ChunkReader<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let boundary = (self.pos / self.chunk + 1) * self.chunk;
            let end = boundary.min(self.data.len()).min(self.pos + buf.len());
            let n = end - self.pos;
            buf[..n].copy_from_slice(&self.data[self.pos..end]);
            self.pos = end;
            Ok(n)
        }
    }

    type Outcome = (Result<(), String>, Vec<Event>);

    fn by_reader(case: &Case, data: &[u8], chunk: usize) -> Outcome {
        let mut searcher = case.builder.build();
        let mut recorder = Recorder::new(case.stop);
        let reader = ChunkReader { data, pos: 0, chunk };
        let result =
            searcher.search_reader(&case.matcher, reader, &mut recorder);
        (result.map_err(|err| err.to_string()), recorder.events)
    }

    fn by_push(case: &Case, data: &[u8], chunk: usize) -> Outcome {
        let mut searcher = case.builder.build();
        let mut recorder = Recorder::new(case.stop);
        let result = {
            let mut search =
                searcher.search_push(&case.matcher, &mut recorder);
            let mut result = Ok(());
            for piece in data.chunks(chunk) {
                match search.push(piece) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(err) => {
                        result = Err(err.to_string());
                        break;
                    }
                }
            }
            match result {
                Ok(()) => search.finish().map_err(|err| err.to_string()),
                err => err,
            }
        };
        (result, recorder.events)
    }

    fn assert_same(label: &str, want: &Outcome, got: &Outcome) {
        if want == got {
            return;
        }
        let n = want.1.iter().zip(&got.1).take_while(|(a, b)| a == b).count();
        panic!(
            "{label}: outcomes differ at event {n}\n\
             reader: {:?} ({} events, result {:?})\n\
             push:   {:?} ({} events, result {:?})",
            want.1.get(n),
            want.1.len(),
            want.0,
            got.1.get(n),
            got.1.len(),
            got.0,
        );
    }

    struct Case {
        label: String,
        builder: SearcherBuilder,
        matcher: RegexMatcher,
        stop: Option<usize>,
        /// Whether the sink calls are the same however the input is split.
        /// (Binary detection and heap limits see the splits.)
        independent: bool,
    }

    fn case(
        label: impl Into<String>,
        builder: &SearcherBuilder,
        matcher: RegexMatcher,
        stop: Option<usize>,
        independent: bool,
    ) -> Case {
        Case {
            label: label.into(),
            builder: builder.clone(),
            matcher,
            stop,
            independent,
        }
    }

    fn cases(full: bool) -> Vec<Case> {
        let line = || RegexMatcher::new("foo|baz");
        let multi = || RegexMatcher::new("foo\\nbar|baz");
        let binaries = [
            ("nobinary", BinaryDetection::none()),
            ("quit", BinaryDetection::quit(0)),
            ("convert", BinaryDetection::convert(0)),
        ];
        let contexts: &[(usize, usize)] =
            if full { &[(0, 0), (2, 0), (0, 2), (1, 3)] } else { &[(0, 0), (2, 2)] };
        let numbers: &[bool] = if full { &[true, false] } else { &[true] };

        let mut cases = vec![];
        for &number in numbers {
            for &(before, after) in contexts {
                for invert in [false, true] {
                    for (name, binary) in &binaries {
                        let mut builder = SearcherBuilder::new();
                        builder
                            .line_number(number)
                            .before_context(before)
                            .after_context(after)
                            .invert_match(invert)
                            .binary_detection(binary.clone());
                        let label = format!(
                            "line-number={number} before={before} \
                             after={after} invert={invert} {name}"
                        );
                        let independent = *binary == BinaryDetection::none();
                        let multi_label = format!("multi-line {label}");
                        cases.push(case(
                            label,
                            &builder,
                            line(),
                            None,
                            independent,
                        ));

                        builder.multi_line(true);
                        let label = multi_label;
                        cases.push(case(
                            label,
                            &builder,
                            multi(),
                            None,
                            independent,
                        ));
                    }
                }
            }
        }

        // Stopping from the sink and from the searcher.
        for stop in [1, 2] {
            for (before, after) in [(0, 0), (1, 2)] {
                let mut builder = SearcherBuilder::new();
                builder.before_context(before).after_context(after);
                let label = format!("sink-stop={stop} {before}/{after}");
                cases.push(case(label, &builder, line(), Some(stop), true));
                builder.multi_line(true);
                let label = format!("multi-line sink-stop={stop} {before}/{after}");
                cases.push(case(label, &builder, multi(), Some(stop), true));
                builder.multi_line(false).max_matches(Some(stop as u64));
                let label = format!("max-matches={stop} {before}/{after}");
                cases.push(case(label, &builder, line(), None, true));
            }
        }

        // Passthru.
        for invert in [false, true] {
            let mut builder = SearcherBuilder::new();
            builder.passthru(true).invert_match(invert);
            let label = format!("passthru invert={invert}");
            cases.push(case(label, &builder, line(), None, true));
            builder.multi_line(true);
            let label = format!("multi-line passthru invert={invert}");
            cases.push(case(label, &builder, multi(), None, true));
        }

        // Line terminators.
        let mut builder = SearcherBuilder::new();
        builder.line_terminator(LineTerminator::crlf()).after_context(1);
        cases.push(case("crlf", &builder, line(), None, true));
        let mut builder = SearcherBuilder::new();
        builder.line_terminator(LineTerminator::byte(b'\x00'));
        cases.push(case("nul-terminated", &builder, line(), None, true));
        let mut matcher = line();
        matcher.set_line_term(Some(LineTerminator::byte(b'\n')));
        let mut builder = SearcherBuilder::new();
        builder.before_context(1);
        cases.push(case("matcher-terminator", &builder, matcher.clone(), None, true));
        matcher.every_line_is_candidate(true);
        cases.push(case("matcher-candidates", &builder, matcher, None, true));
        let mut builder = SearcherBuilder::new();
        builder.stop_on_nonmatch(true).after_context(1);
        cases.push(case("stop-on-nonmatch", &builder, line(), None, true));

        // Encodings.
        let mut builder = SearcherBuilder::new();
        builder.encoding(Some(Encoding::new("utf-16le").unwrap()));
        cases.push(case("encoding-utf-16le", &builder, line(), None, true));
        builder.before_context(1).after_context(1);
        cases.push(case("encoding-utf-16le-context", &builder, line(), None, true));
        let mut builder = SearcherBuilder::new();
        builder.encoding(Some(Encoding::new("utf-16be").unwrap())).bom_sniffing(false);
        cases.push(case("encoding-utf-16be-nosniff", &builder, line(), None, true));
        let mut builder = SearcherBuilder::new();
        builder.bom_sniffing(false);
        cases.push(case("no-bom-sniffing", &builder, line(), None, true));
        builder.binary_detection(BinaryDetection::quit(0));
        cases.push(case("no-bom-sniffing-quit", &builder, line(), None, false));

        // Heap limits, which make long lines and big inputs errors.
        let mut builder = SearcherBuilder::new();
        builder.heap_limit(Some(80)).before_context(1);
        cases.push(case("heap-limit", &builder, line(), None, false));
        builder.multi_line(true).heap_limit(Some(200));
        cases.push(case("multi-line heap-limit", &builder, multi(), None, false));
        cases
    }

    fn utf16(text: &str, bom: &[u8], big_endian: bool) -> Vec<u8> {
        let mut out = bom.to_vec();
        for unit in text.encode_utf16() {
            let bytes =
                if big_endian { unit.to_be_bytes() } else { unit.to_le_bytes() };
            out.extend_from_slice(&bytes);
        }
        out
    }

    fn small_inputs() -> Vec<(&'static str, Vec<u8>)> {
        let text = "foo\nbar\nbaz\nfoo bar\n";
        let mut utf16_odd = utf16(text, b"\xFF\xFE", false);
        utf16_odd.push(b'A');
        let mut binary_late = b"foo\nbar\nbaz\n".repeat(40);
        binary_late.extend_from_slice(b"\0foo\n");
        vec![
            ("empty", vec![]),
            ("newline", b"\n".to_vec()),
            ("one-byte", b"f".to_vec()),
            ("no-newline", b"foo".to_vec()),
            ("lines", b"foo\nbar\nbaz\n".to_vec()),
            (
                "gaps",
                b"bar\nfoo\nbaz bar\nbar\nbar\nbar\nfoo\nbar\nbar\nbaz\n".to_vec(),
            ),
            ("tail", b"bar\nbaz\nbar\nfoo".to_vec()),
            ("crlf", b"foo\r\nbar\r\nbaz foo\r\nbar\r\n".to_vec()),
            ("nul-lines", b"foo\0bar\0baz\0foo".to_vec()),
            ("multi-line", b"foo\nbar\nbaz\nfoo\nbar\nbar\nfoo".to_vec()),
            ("blank-lines", b"\n\nfoo\n\n\nbar\n\n".to_vec()),
            ("binary-middle", b"foo\nba\0r\nbaz\nfoo\n".to_vec()),
            ("binary-tail", b"foo\nbar\nbaz\nfoo\n\0".to_vec()),
            ("binary-first", b"\0foo\nbar\n".to_vec()),
            ("binary-late", binary_late),
            ("utf8-bom", b"\xEF\xBB\xBFfoo\nbar\nbaz\n".to_vec()),
            ("utf8-bom-only", b"\xEF\xBB\xBF".to_vec()),
            ("utf16le-bom", utf16(text, b"\xFF\xFE", false)),
            ("utf16be-bom", utf16(text, b"\xFE\xFF", true)),
            ("utf16-bom-only", b"\xFF\xFE".to_vec()),
            ("utf16-odd", utf16_odd),
            ("utf16le-raw", utf16(text, b"", false)),
            ("utf16be-raw", utf16(text, b"", true)),
        ]
    }

    fn large_inputs() -> Vec<(&'static str, Vec<u8>)> {
        let long = format!(
            "{}foo\nbar\n{}baz\nfoo\n",
            "x".repeat(70_000),
            "y".repeat(70_000)
        );
        let mut many = String::new();
        for i in 0..9_000 {
            many.push_str(&format!("line {i}"));
            if i % 5 == 0 {
                many.push_str(" foo");
            }
            if i % 17 == 0 {
                many.push_str(" baz");
            }
            many.push('\n');
        }
        let mut many_binary = many.clone().into_bytes();
        let at = many_binary.len() * 3 / 4;
        many_binary.insert(at, 0);
        let utf16_many = utf16(&many[..many.len() / 3], b"\xFF\xFE", false);
        vec![
            ("long-lines", long.into_bytes()),
            ("many-lines", many.into_bytes()),
            ("many-lines-binary", many_binary),
            ("utf16-many-lines", utf16_many),
        ]
    }

    fn check(cases: &[Case], inputs: &[(&str, Vec<u8>)]) {
        for case in cases {
            for (name, data) in inputs {
                let whole = data.len().max(1);
                let unsplit = by_reader(case, data, whole);
                for chunk in [1, 2, 3, 7, 64, 4096, whole] {
                    let label = format!(
                        "{} on {name} in chunks of {chunk}",
                        case.label
                    );
                    let want = by_reader(case, data, chunk);
                    let got = by_push(case, data, chunk);
                    assert_same(&label, &want, &got);
                    if case.independent {
                        assert_same(
                            &format!("{label} against one read"),
                            &unsplit,
                            &got,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn push_matches_reader() {
        check(&cases(true), &small_inputs());
    }

    #[test]
    fn push_matches_reader_on_large_inputs() {
        check(&cases(false), &large_inputs());
    }

    #[test]
    fn push_stops_when_the_sink_stops() {
        let data = b"bar\nfoo\nfoo\nbar\n";
        let case =
            case("stop", &SearcherBuilder::new(), RegexMatcher::new("foo"), Some(1), true);

        let mut searcher = case.builder.build();
        let mut recorder = Recorder::new(case.stop);
        let mut search = searcher.search_push(&case.matcher, &mut recorder);
        assert!(search.push(&data[..6]).unwrap());
        assert!(!search.push(&data[6..12]).unwrap());
        assert!(!search.push(&data[12..]).unwrap());
        search.finish().unwrap();

        let (result, events) = by_reader(&case, data, 6);
        assert_eq!(result, Ok(()));
        assert_eq!(recorder.events, events);
        assert_eq!(events.iter().filter(|e| matches!(e, Event::Matched { .. })).count(), 1);
    }

    #[test]
    fn push_reports_mismatched_line_terminators() {
        let mut searcher = SearcherBuilder::new().build();
        let mut matcher = RegexMatcher::new("foo");
        matcher.set_line_term(Some(LineTerminator::byte(b'\x00')));
        let mut recorder = Recorder::new(None);
        let mut search = searcher.search_push(&matcher, &mut recorder);
        assert!(search.push(b"foo\n").is_err());
        assert!(!search.push(b"foo\n").unwrap());
        search.finish().unwrap();
        assert!(recorder.events.is_empty());
    }
}
