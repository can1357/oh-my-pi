Use `read` for static web; browser only if needed.

Path suffixes: :50 or :50- starts at line 50; :50-200 inclusive; :50+150 counts lines; :-60 last 60; commas join ranges (:5-16,960-973) or individual lines (:19,59). :raw verbatim without anchors/prefixes; combine :2-4:raw or :raw:2-4. :conflicts lists one line per unresolved merge block. SVG/SVGZ default text; :img PNG, :raw original. Video requires ffmpeg/ffprobe: bare preview grid+metadata, :412 frame, :1h5m42s/:90s/:01:23 time.

Sources:
- Bare code: declarations only; re-read ONLY footer-named omissions, NEVER guess `..`/`…`.
{{#if IS_HL_MODE}}- Selected file: `[foo.ts#1A2B]` snapshot+lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER invent tag.
{{/if}}- Directory: complete root; child listings cap at 12 (`… N more`), read child; page via :N-M/:-N.
- SQLite: file.db tables; :table schema/rows; :table:key by primary key; ?limit=, ?where=, ?q=SELECT.
- Archives: ZIP/JAR/APK/WHL, compressed TAR, RAR/7z/ISO/CAB/DEB/RPM/CPIO/AR/LZH/ARJ/ASAR, compressed streams; member via archive.ext:member/path.
- PDF/documents: extracted text; notebooks: editable cells; images: decoded inline. URLs: reader text/markdown, :raw original HTML; bare host:port needs trailing slash.
- Internal URI selectors: artifact://<id> spilled output (page :N-M or :raw:N-M); agent://<id> output, NOT agent://all; proc:// jobs/services, proc://<id> status/output.
- ssh://host/<path> reads UTF-8 remote file/dir (max 1 MiB); ssh:// lists hosts; write and grep also work. Encode literal `:` `?` `#` as %3A %3F %23. Requires verified POSIX shell; Windows/unsupported: bash remote SSH command or sshfs.
