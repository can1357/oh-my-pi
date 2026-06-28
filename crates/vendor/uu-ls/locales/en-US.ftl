ls-about = List directory contents.
  Ignore files and directories starting with a '.' by default
dir-about = List directory contents.
  Ignore files and directories starting with a '.' by default
vdir-about = List directory contents.
  Ignore files and directories starting with a '.' by default

  Mandatory arguments to long options are mandatory for short options too.
ls-usage = ls [OPTION]... [FILE]...
dir-usage = dir [OPTION]... [FILE]...
vdir-usage = vdir [OPTION]... [FILE]...
ls-after-help = The TIME_STYLE argument can be full-iso, long-iso, iso, locale or +FORMAT. FORMAT is interpreted like in date. Also the TIME_STYLE environment variable sets the default style to use.

# Error messages
ls-error-invalid-line-width = invalid line width: {$width}
ls-error-general-io = general io error: {$error}
ls-error-cannot-access-no-such-file = cannot access {$path}: No such file or directory
ls-error-cannot-access-operation-not-permitted = cannot access {$path}: Operation not permitted
ls-error-cannot-open-directory-permission-denied = cannot open directory {$path}: Permission denied
ls-error-cannot-open-file-permission-denied = cannot open file {$path}: Permission denied
ls-error-cannot-open-directory-bad-descriptor = cannot open directory {$path}: Bad file descriptor
ls-error-unknown-io-error = unknown io error: {$path}, '{$error}'
ls-error-invalid-block-size = invalid --block-size argument {$size}
ls-error-dired-and-zero-incompatible = --dired and --zero are incompatible
ls-error-not-directory = cannot access {$path}: Not a directory
ls-error-not-listing-already-listed = {$path}: not listing already-listed directory
ls-error-invalid-time-style = invalid --time-style argument {$style}
  Possible values are:
    - [posix-]full-iso
    - [posix-]long-iso
    - [posix-]iso
    - [posix-]locale
    - +FORMAT (e.g., +%H:%M) for a 'date'-style format

  For more information try --help

# Help messages
ls-help-print-help = Print help information.
ls-help-set-display-format = Set the display format.
ls-help-display-files-columns = Display the files in columns.
ls-help-display-detailed-info = Display detailed information.
ls-help-list-entries-rows = List entries in rows instead of in columns.
ls-help-assume-tab-stops = Assume tab stops at each COLS instead of 8
ls-help-list-entries-commas = List entries separated by commas.
ls-help-list-entries-nul = List entries separated by ASCII NUL characters.
ls-help-generate-dired-output = generate output designed for Emacs' dired (Directory Editor) mode
ls-help-hyperlink-filenames = hyperlink file names WHEN
ls-help-list-one-file-per-line = List one file per line.
ls-help-long-format-no-group = Long format without group information.
  Identical to --format=long with --no-group.
ls-help-long-no-owner = Long format without owner information.
ls-help-long-numeric-uid-gid = -l with numeric UIDs and GIDs.
ls-help-set-quoting-style = Set quoting style.
ls-help-literal-quoting-style = Use literal quoting style. Equivalent to `--quoting-style=literal`
ls-help-escape-quoting-style = Use escape quoting style. Equivalent to `--quoting-style=escape`
ls-help-c-quoting-style = Use C quoting style. Equivalent to `--quoting-style=c`
ls-help-replace-control-chars = Replace control characters with '?' if they are not escaped.
ls-help-show-control-chars = Show control characters 'as is' if they are not escaped.
ls-help-show-time-field = Show time in `<field>`:
    access time (-u): atime, access, use;
    change time (-t): ctime, status.
    modification time: mtime, modification.
    birth time: birth, creation;
ls-help-time-change = If the long listing format (e.g., -l, -o) is being used, print the
  status change time (the 'ctime' in the inode) instead of the modification
  time. When explicitly sorting by time (--sort=time or -t) or when not
  using a long listing format, sort according to the status change time.
ls-help-time-access = If the long listing format (e.g., -l, -o) is being used, print the
  status access time instead of the modification time. When explicitly
  sorting by time (--sort=time or -t) or when not using a long listing
  format, sort according to the access time.
ls-help-hide-pattern = do not list implied entries matching shell PATTERN (overridden by -a or -A)
ls-help-ignore-pattern = do not list implied entries matching shell PATTERN
ls-help-ignore-backups = Ignore entries which end with ~.
ls-help-sort-by-field = Sort by `<field>`: name, none (-U), time (-t), size (-S), extension (-X) or width
ls-help-sort-by-size = Sort by file size, largest first.
ls-help-sort-by-time = Sort by modification time (the 'mtime' in the inode), newest first.
ls-help-sort-by-version = Natural sort of (version) numbers in the filenames.
ls-help-sort-by-extension = Sort alphabetically by entry extension.
ls-help-sort-none = Do not sort; list the files in whatever order they are stored in the
  directory.  This is especially useful when listing very large directories,
  since not doing any sorting can be noticeably faster.
ls-help-dereference-all = When showing file information for a symbolic link, show information for the
  file the link references rather than the link itself.
ls-help-dereference-dir-args = Do not follow symlinks except when they link to directories and are
  given as command line arguments.
ls-help-dereference-args = Do not follow symlinks except when given as command line arguments.
ls-help-no-group = Do not show group in long format.
ls-help-author = Show author in long format. On the supported platforms,
  the author always matches the file owner.
ls-help-all-files = Do not ignore hidden files (files with names that start with '.').
ls-help-almost-all = In a directory, do not ignore all file names that start with '.',
  only ignore '.' and '..'.
ls-help-unsorted-all = List all files in directory order, unsorted. Equivalent to -aU. Disables --color unless explicitly specified.
ls-help-directory = Only list the names of directories, rather than listing directory contents.
  This will not follow symbolic links unless one of `--dereference-command-line
  (-H)`, `--dereference (-L)`, or `--dereference-command-line-symlink-to-dir` is
  specified.
ls-help-human-readable = Print human readable file sizes (e.g. 1K 234M 56G).
ls-help-kibibytes = default to 1024-byte blocks for file system usage; used only with -s and per
  directory totals
ls-help-si = Print human readable file sizes using powers of 1000 instead of 1024.
ls-help-block-size = scale sizes by BLOCK_SIZE when printing them
ls-help-print-inode = print the index number of each file
ls-help-reverse-sort = Reverse whatever the sorting method is e.g., list files in reverse
  alphabetical order, youngest first, smallest first, or whatever.
ls-help-recursive = List the contents of all directories recursively.
ls-help-terminal-width = Assume that the terminal is COLS columns wide.
ls-help-allocation-size = print the allocated size of each file, in blocks
ls-help-color-output = Color output based on file type.
ls-help-indicator-style = Append indicator with style WORD to entry names:
  none (default),  slash (-p), file-type (--file-type), classify (-F)
ls-help-classify = Append a character to each file name indicating the file type. Also, for
  regular files that are executable, append '*'. The file type indicators are
  '/' for directories, '@' for symbolic links, '|' for FIFOs, '=' for sockets,
  '>' for doors, and nothing for regular files. when may be omitted, or one of:
      none - Do not classify. This is the default.
      auto - Only classify if standard output is a terminal.
      always - Always classify.
  Specifying --classify and no when is equivalent to --classify=always. This will
  not follow symbolic links listed on the command line unless the
  --dereference-command-line (-H), --dereference (-L), or
  --dereference-command-line-symlink-to-dir options are specified.
ls-help-file-type = Same as --classify, but do not append '*'
ls-help-slash-directories = Append / indicator to directories.
ls-help-time-style = time/date format with -l; see TIME_STYLE below
ls-help-full-time = like -l --time-style=full-iso
ls-help-context = print any security context of each file
ls-help-group-directories-first = group directories before files; can be augmented with
  a --sort option, but any use of --sort=none (-U) disables grouping
ls-invalid-quoting-style = {$program}: Ignoring invalid value of environment variable QUOTING_STYLE: '{$style}'
ls-invalid-columns-width = ignoring invalid width in environment variable COLUMNS: {$width}
ls-invalid-ignore-pattern = Invalid pattern for ignore: {$pattern}
ls-invalid-hide-pattern = Invalid pattern for hide: {$pattern}
ls-warning-unrecognized-ls-colors-prefix = unrecognized prefix: {$prefix}
ls-warning-unparsable-ls-colors = unparsable value for LS_COLORS environment variable
ls-total = total {$size}

# Security context warnings
ls-warning-failed-to-get-security-context = failed to get security context of: {$path}
ls-warning-getting-security-context = getting security context of: {$path}: {$error}

# SMACK error messages (used by uucore::smack when called from ls)
smack-error-not-enabled = SMACK is not enabled on this system
smack-error-label-retrieval-failure = failed to get SMACK label: { $error }
smack-error-label-set-failure = failed to set SMACK label to '{ $context }': { $error }
smack-error-no-label-set = no SMACK label set
