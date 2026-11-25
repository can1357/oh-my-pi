//! Export names published by Perl POSIX. Platform support is resolved in posix.rs.

pub(super) const HEADERS: &[(&str, &str)] = &[
	("assert_h", "assert NDEBUG"),
	("ctype_h", ""),
	("dirent_h", ""),
	("errno_h", "E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EALREADY EBADF EBADMSG EBUSY ECANCELED \
		ECHILD ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK EDESTADDRREQ EDOM EDQUOT EEXIST EFAULT EFBIG EHOSTDOWN \
		EHOSTUNREACH EIDRM EILSEQ EINPROGRESS EINTR EINVAL EIO EISCONN EISDIR ELOOP EMFILE EMLINK EMSGSIZE \
		ENAMETOOLONG ENETDOWN ENETRESET ENETUNREACH ENFILE ENOBUFS ENODATA ENODEV ENOENT ENOEXEC ENOLCK ENOLINK \
		ENOMEM ENOMSG ENOPROTOOPT ENOSPC ENOSR ENOSTR ENOSYS ENOTBLK ENOTCONN ENOTDIR ENOTEMPTY ENOTRECOVERABLE \
		ENOTSOCK ENOTSUP ENOTTY ENXIO EOPNOTSUPP EOTHER EOVERFLOW EOWNERDEAD EPERM EPFNOSUPPORT EPIPE EPROCLIM \
		EPROTO EPROTONOSUPPORT EPROTOTYPE ERANGE EREMOTE ERESTART EROFS ESHUTDOWN ESOCKTNOSUPPORT ESPIPE ESRCH \
		ESTALE ETIME ETIMEDOUT ETOOMANYREFS ETXTBSY EUSERS EWOULDBLOCK EXDEV errno"),
	("fcntl_h", "FD_CLOEXEC F_DUPFD F_GETFD F_GETFL F_GETLK F_RDLCK F_SETFD F_SETFL F_SETLK F_SETLKW F_UNLCK F_WRLCK \
		O_ACCMODE O_APPEND O_CREAT O_EXCL O_NOCTTY O_NONBLOCK O_RDONLY O_RDWR O_TRUNC O_WRONLY creat SEEK_CUR \
		SEEK_END SEEK_SET S_IRGRP S_IROTH S_IRUSR S_IRWXG S_IRWXO S_IRWXU S_ISBLK S_ISCHR S_ISDIR S_ISFIFO S_ISGID \
		S_ISREG S_ISUID S_IWGRP S_IWOTH S_IWUSR"),
	("fenv_h", "FE_DOWNWARD FE_TONEAREST FE_TOWARDZERO FE_UPWARD fegetround fesetround"),
	("float_h", "DBL_DIG DBL_EPSILON DBL_MANT_DIG DBL_MAX DBL_MAX_10_EXP DBL_MAX_EXP DBL_MIN DBL_MIN_10_EXP \
		DBL_MIN_EXP FLT_DIG FLT_EPSILON FLT_MANT_DIG FLT_MAX FLT_MAX_10_EXP FLT_MAX_EXP FLT_MIN FLT_MIN_10_EXP \
		FLT_MIN_EXP FLT_RADIX FLT_ROUNDS LDBL_DIG LDBL_EPSILON LDBL_MANT_DIG LDBL_MAX LDBL_MAX_10_EXP LDBL_MAX_EXP \
		LDBL_MIN LDBL_MIN_10_EXP LDBL_MIN_EXP"),
	("grp_h", ""),
	("limits_h", "ARG_MAX CHAR_BIT CHAR_MAX CHAR_MIN CHILD_MAX INT_MAX INT_MIN LINK_MAX LONG_MAX LONG_MIN MAX_CANON \
		MAX_INPUT MB_LEN_MAX NAME_MAX NGROUPS_MAX OPEN_MAX PATH_MAX PIPE_BUF SCHAR_MAX SCHAR_MIN SHRT_MAX SHRT_MIN \
		SSIZE_MAX STREAM_MAX TZNAME_MAX UCHAR_MAX UINT_MAX ULONG_MAX USHRT_MAX _POSIX_ARG_MAX _POSIX_CHILD_MAX \
		_POSIX_LINK_MAX _POSIX_MAX_CANON _POSIX_MAX_INPUT _POSIX_NAME_MAX _POSIX_NGROUPS_MAX _POSIX_OPEN_MAX \
		_POSIX_PATH_MAX _POSIX_PIPE_BUF _POSIX_SSIZE_MAX _POSIX_STREAM_MAX _POSIX_TZNAME_MAX"),
	("locale_h", "LC_ALL LC_COLLATE LC_CTYPE LC_MESSAGES LC_MONETARY LC_NUMERIC LC_TIME LC_IDENTIFICATION \
		LC_MEASUREMENT LC_PAPER LC_TELEPHONE LC_ADDRESS LC_SYNTAX LC_TOD NULL localeconv setlocale LC_NAME"),
	("math_h", "FP_ILOGB0 FP_ILOGBNAN FP_INFINITE FP_NAN FP_NORMAL FP_SUBNORMAL FP_ZERO M_1_PI M_2_PI M_2_SQRTPI M_E \
		M_LN10 M_LN2 M_LOG10E M_LOG2E M_PI M_PI_2 M_PI_4 M_SQRT1_2 M_SQRT2 HUGE_VAL INFINITY NAN acos asin atan ceil \
		cosh fabs floor fmod frexp ldexp log10 modf pow sinh tan tanh"),
	("math_h_c99", "FP_ILOGB0 FP_ILOGBNAN FP_INFINITE FP_NAN FP_NORMAL FP_SUBNORMAL FP_ZERO M_1_PI M_2_PI M_2_SQRTPI \
		M_E M_LN10 M_LN2 M_LOG10E M_LOG2E M_PI M_PI_2 M_PI_4 M_SQRT1_2 M_SQRT2 HUGE_VAL INFINITY NAN acos asin atan \
		ceil cosh fabs floor fmod frexp ldexp log10 modf pow sinh tan tanh Inf NaN acosh asinh atanh cbrt copysign \
		erf erfc exp2 expm1 fdim fma fmax fmin fpclassify hypot ilogb isfinite isgreater isgreaterequal isinf isless \
		islessequal islessgreater isnan isnormal isunordered j0 j1 jn lgamma log1p log2 logb lrint lround nan \
		nearbyint nextafter nexttoward remainder remquo rint round scalbn signbit tgamma trunc y0 y1 yn"),
	("nan_payload", "getpayload setpayload setpayloadsig issignaling"),
	("netdb_h", "EAI_AGAIN EAI_BADFLAGS EAI_FAIL EAI_FAMILY EAI_MEMORY EAI_NONAME EAI_OVERFLOW EAI_SERVICE \
		EAI_SOCKTYPE EAI_SYSTEM"),
	("pwd_h", ""),
	("setjmp_h", "longjmp setjmp siglongjmp sigsetjmp"),
	("signal_h", "SA_NOCLDSTOP SA_NOCLDWAIT SA_NODEFER SA_ONSTACK SA_RESETHAND SA_RESTART SA_SIGINFO SIGABRT SIGALRM \
		SIGCHLD SIGCONT SIGFPE SIGHUP SIGILL SIGINT SIGKILL SIGPIPE %SIGRT SIGRTMIN SIGRTMAX SIGQUIT SIGSEGV SIGSTOP \
		SIGTERM SIGTSTP SIGTTIN SIGTTOU SIGUSR1 SIGUSR2 SIGBUS SIGPOLL SIGPROF SIGSYS SIGTRAP SIGURG SIGVTALRM \
		SIGXCPU SIGXFSZ SIG_BLOCK SIG_DFL SIG_ERR SIG_IGN SIG_SETMASK SIG_UNBLOCK raise sigaction signal sigpending \
		sigprocmask sigsuspend"),
	("signal_h_si_code", "ILL_ILLOPC ILL_ILLOPN ILL_ILLADR ILL_ILLTRP ILL_PRVOPC ILL_PRVREG ILL_COPROC ILL_BADSTK \
		FPE_INTDIV FPE_INTOVF FPE_FLTDIV FPE_FLTOVF FPE_FLTUND FPE_FLTRES FPE_FLTINV FPE_FLTSUB SEGV_MAPERR \
		SEGV_ACCERR BUS_ADRALN BUS_ADRERR BUS_OBJERR TRAP_BRKPT TRAP_TRACE CLD_EXITED CLD_KILLED CLD_DUMPED \
		CLD_TRAPPED CLD_STOPPED CLD_CONTINUED POLL_IN POLL_OUT POLL_MSG POLL_ERR POLL_PRI POLL_HUP SI_USER SI_QUEUE \
		SI_TIMER SI_ASYNCIO SI_MESGQ"),
	("stdarg_h", ""),
	("stddef_h", "NULL offsetof"),
	("stdio_h", "BUFSIZ EOF FILENAME_MAX L_ctermid L_cuserid NULL SEEK_CUR SEEK_END SEEK_SET STREAM_MAX TMP_MAX stderr \
		stdin stdout clearerr fclose fdopen feof ferror fflush fgetc fgetpos fgets fopen fprintf fputc fputs fread \
		freopen fscanf fseek fsetpos ftell fwrite getchar gets perror putc putchar puts remove rewind scanf setbuf \
		setvbuf sscanf tmpfile tmpnam ungetc vfprintf vprintf vsprintf"),
	("stdlib_h", "EXIT_FAILURE EXIT_SUCCESS MB_CUR_MAX NULL RAND_MAX abort atexit atof atoi atol bsearch calloc div \
		free getenv labs ldiv malloc mblen mbstowcs mbtowc qsort realloc strtod strtol strtoul wcstombs wctomb"),
	("stdlib_h_c99", "EXIT_FAILURE EXIT_SUCCESS MB_CUR_MAX NULL RAND_MAX abort atexit atof atoi atol bsearch calloc \
		div free getenv labs ldiv malloc mblen mbstowcs mbtowc qsort realloc strtod strtol strtoul wcstombs wctomb \
		strtold"),
	("string_h", "NULL memchr memcmp memcpy memmove memset strcat strchr strcmp strcoll strcpy strcspn strerror strlen \
		strncat strncmp strncpy strpbrk strrchr strspn strstr strtok strxfrm"),
	("sys_resource_h", "PRIO_PROCESS PRIO_PGRP PRIO_USER"),
	("sys_socket_h", "MSG_CTRUNC MSG_DONTROUTE MSG_EOR MSG_OOB MSG_PEEK MSG_TRUNC MSG_WAITALL"),
	("sys_stat_h", "S_IRGRP S_IROTH S_IRUSR S_IRWXG S_IRWXO S_IRWXU S_ISBLK S_ISCHR S_ISDIR S_ISFIFO S_ISGID S_ISREG \
		S_ISUID S_IWGRP S_IWOTH S_IWUSR S_IXGRP S_IXOTH S_IXUSR fstat mkfifo"),
	("sys_times_h", ""),
	("sys_types_h", ""),
	("sys_utsname_h", "uname"),
	("sys_wait_h", "WEXITSTATUS WIFEXITED WIFSIGNALED WIFSTOPPED WNOHANG WSTOPSIG WTERMSIG WUNTRACED"),
	("termios_h", "B0 B110 B1200 B134 B150 B1800 B19200 B200 B2400 B300 B38400 B4800 B50 B600 B75 B9600 BRKINT CLOCAL \
		CREAD CS5 CS6 CS7 CS8 CSIZE CSTOPB ECHO ECHOE ECHOK ECHONL HUPCL ICANON ICRNL IEXTEN IGNBRK IGNCR IGNPAR \
		INLCR INPCK ISIG ISTRIP IXOFF IXON NCCS NOFLSH OPOST PARENB PARMRK PARODD TCIFLUSH TCIOFF TCIOFLUSH TCION \
		TCOFLUSH TCOOFF TCOON TCSADRAIN TCSAFLUSH TCSANOW TOSTOP VEOF VEOL VERASE VINTR VKILL VMIN VQUIT VSTART \
		VSTOP VSUSP VTIME cfgetispeed cfgetospeed cfsetispeed cfsetospeed tcdrain tcflow tcflush tcgetattr \
		tcsendbreak tcsetattr"),
	("time_h", "CLK_TCK CLOCKS_PER_SEC NULL asctime clock ctime difftime mktime strftime tzset tzname"),
	("unistd_h", "F_OK NULL R_OK SEEK_CUR SEEK_END SEEK_SET STDERR_FILENO STDIN_FILENO STDOUT_FILENO W_OK X_OK \
		_PC_CHOWN_RESTRICTED _PC_LINK_MAX _PC_MAX_CANON _PC_MAX_INPUT _PC_NAME_MAX _PC_NO_TRUNC _PC_PATH_MAX \
		_PC_PIPE_BUF _PC_VDISABLE _POSIX_CHOWN_RESTRICTED _POSIX_JOB_CONTROL _POSIX_NO_TRUNC _POSIX_SAVED_IDS \
		_POSIX_VDISABLE _POSIX_VERSION _SC_ARG_MAX _SC_CHILD_MAX _SC_CLK_TCK _SC_JOB_CONTROL _SC_NGROUPS_MAX \
		_SC_OPEN_MAX _SC_PAGESIZE _SC_SAVED_IDS _SC_STREAM_MAX _SC_TZNAME_MAX _SC_VERSION _exit access ctermid \
		cuserid dup2 dup execl execle execlp execv execve execvp fpathconf fsync getcwd getegid geteuid getgid \
		getgroups getpid getuid isatty lseek pathconf pause setgid setpgid setsid setuid sysconf tcgetpgrp tcsetpgrp \
		ttyname"),
	("utime_h", ""),
];

pub(super) const OPTIONAL_TAGGED: &[&str] = &[
	"BUS_ADRALN", "BUS_ADRERR", "BUS_OBJERR", "CLD_CONTINUED", "CLD_DUMPED", "CLD_EXITED", "CLD_KILLED",
	"CLD_STOPPED", "CLD_TRAPPED", "EAI_AGAIN", "EAI_BADFLAGS", "EAI_FAIL", "EAI_FAMILY", "EAI_MEMORY",
	"EAI_NONAME", "EAI_OVERFLOW", "EAI_SERVICE", "EAI_SOCKTYPE", "EAI_SYSTEM", "FE_DOWNWARD", "FE_TONEAREST",
	"FE_TOWARDZERO", "FE_UPWARD", "FPE_FLTDIV", "FPE_FLTINV", "FPE_FLTOVF", "FPE_FLTRES", "FPE_FLTSUB",
	"FPE_FLTUND", "FPE_INTDIV", "FPE_INTOVF", "ILL_BADSTK", "ILL_COPROC", "ILL_ILLADR", "ILL_ILLOPC",
	"ILL_ILLOPN", "ILL_ILLTRP", "ILL_PRVOPC", "ILL_PRVREG", "Inf", "LC_NAME", "MSG_CTRUNC", "MSG_DONTROUTE",
	"MSG_EOR", "MSG_OOB", "MSG_PEEK", "MSG_TRUNC", "MSG_WAITALL", "NaN", "POLL_ERR", "POLL_HUP", "POLL_IN",
	"POLL_MSG", "POLL_OUT", "POLL_PRI", "PRIO_PGRP", "PRIO_PROCESS", "PRIO_USER", "SEGV_ACCERR", "SEGV_MAPERR",
	"SI_ASYNCIO", "SI_MESGQ", "SI_QUEUE", "SI_TIMER", "SI_USER", "TRAP_BRKPT", "TRAP_TRACE", "acosh", "asinh",
	"atanh", "cbrt", "copysign", "erf", "erfc", "exp2", "expm1", "fdim", "fegetround", "fesetround", "fma",
	"fmax", "fmin", "fpclassify", "getpayload", "hypot", "ilogb", "isfinite", "isgreater", "isgreaterequal",
	"isinf", "isless", "islessequal", "islessgreater", "isnan", "isnormal", "issignaling", "isunordered", "j0",
	"j1", "jn", "lgamma", "log1p", "log2", "logb", "lrint", "lround", "nan", "nearbyint", "nextafter",
	"nexttoward", "remainder", "remquo", "rint", "round", "scalbn", "setpayload", "setpayloadsig", "signbit",
	"strtold", "tgamma", "trunc", "y0", "y1", "yn",
];

pub(super) const OPTIONAL_UNTAGGED: &[&str] = &[
	"L_tmpnam", "abs", "alarm", "atan2", "chdir", "chmod", "chown", "close", "closedir", "cos", "exit", "exp",
	"fcntl", "fileno", "fork", "getc", "getgrgid", "getgrnam", "getlogin", "getpgrp", "getppid", "getpwnam",
	"getpwuid", "gmtime", "kill", "lchown", "link", "localtime", "log", "mkdir", "nice", "open", "opendir",
	"pipe", "printf", "rand", "read", "readdir", "rename", "rewinddir", "rmdir", "sin", "sleep", "sprintf",
	"sqrt", "srand", "stat", "system", "time", "times", "umask", "unlink", "utime", "wait", "waitpid", "write",
];
