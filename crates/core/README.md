# omp-core

`omp-core` provides shared, low-level data structures and encoding utilities used by omp. Its public API includes append-only storage, compact string and byte types, sparse collections, and binary-to-text encodings.

## Structure

- `append_vec` implements the thread-safe, segmented `AppendVec` and its borrowed `AppendSlice` views.
- `cow_bytes` provides `CowBytes`, a borrowed-or-`Bytes` byte container with cheap owned clones and zero-copy slicing.
- `encoding` contains generic base-N machinery and the public hex, Base32, Base32-Hex, Base32-DNS, Base64, and URL-safe Base64 interfaces.
- `qr` implements a self-contained QR (ISO/IEC 18004) symbol encoder: mode selection, versions 1–40, Reed-Solomon error correction, and penalty-scored masking.
- `str` provides immutable and mutable small-string types, clone-on-write strings, formatting helpers, and conversions.
- `sparse_index`, `sparse_map`, and `sparse_set` implement the indexing machinery and public sparse map and set collections.

The crate root re-exports the principal collection, string, byte, and encoding types so callers usually do not need to depend on module layout.

## slopjson

The `slopjson` module parses imperfect JSON commonly produced incrementally by language models, including single-quoted strings, unquoted keys, comments, trailing commas, invalid escapes, and bareword values. It provides tolerant Serde deserialization, strict prefix classification, streaming recovery, text-level repair, and a JSON value model while still rejecting incomplete or untrustworthy final documents.

## Philosophy

The implementations favor predictable, allocation-conscious primitives for frequently used infrastructure. Short strings stay inline, owned bytes remain cheaply shareable, append-only storage grows in segmented buckets, and encoding supports fixed-size and streaming forms. Specialized representations are kept behind conventional collection, iterator, conversion, and Serde interfaces so callers can use these optimizations without carrying their internal bookkeeping.
