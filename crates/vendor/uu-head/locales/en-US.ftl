head-about = Print the first 10 lines of each FILE to standard output.
  With more than one FILE, precede each with a header giving the file name.
  With no FILE, or when FILE is -, read standard input.

  Mandatory arguments to long flags are mandatory for short flags too.
head-usage = head [FLAG]... [FILE]...

# Help messages
head-help-bytes = print the first NUM bytes of each file;
 with a leading '-', print all but the last
 NUM bytes of each file
head-help-lines = print the first NUM lines instead of the first 10;
 with a leading '-', print all but the last
 NUM lines of each file
head-help-quiet = never print headers giving file names
head-help-verbose = always print headers giving file names
head-help-zero-terminated = line delimiter is NUL, not newline

# Error messages
head-error-reading-file = error reading {$name}: {$err}
head-error-parse-error = parse error: {$err}
head-error-num-too-large = number of -bytes or -lines is too large
head-error-clap = clap error: {$err}
head-error-invalid-bytes = invalid number of bytes: {$err}
head-error-invalid-lines = invalid number of lines: {$err}
head-error-bad-argument-format = bad argument format: {$arg}
head-error-writing-stdout = error writing 'standard output': {$err}
head-error-cannot-open = cannot open {$name} for reading

# Output headers
head-header-stdin = ==> standard input <==
