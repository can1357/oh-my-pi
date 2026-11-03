#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

/* Modes: "in" (the child starts in its own group and joins the parent's
 * group once the parent gets TERM), "out" (the child starts in the parent's
 * group and calls setsid() in its TERM handler), and "exit" (as "out", and
 * the parent exits on TERM, leaving the child outside the tree and group). */
static int notify_fd;
static int move_out;
static int exit_on_term;

static void touch(const char *path) {
	int fd = open(path, O_CREAT | O_WRONLY | O_APPEND, 0600);
	(void)write(fd, "x", 1);
	close(fd);
}

static void append_term(void) {
	touch("terms");
}

static void parent_term(int signal) {
	(void)signal;
	if (exit_on_term) {
		_exit(0);
	}
	(void)write(notify_fd, "x", 1);
}

static void child_term(int signal) {
	(void)signal;
	if (move_out) {
		setsid();
	}
	append_term();
}

int main(int argc, char **argv) {
	move_out = argc > 1 && (argv[1][0] == 'o' || argv[1][0] == 'e');
	exit_on_term = argc > 1 && argv[1][0] == 'e';
	int pipefd[2];
	if (pipe(pipefd) != 0) {
		return 1;
	}
	notify_fd = pipefd[1];
	signal(SIGTERM, parent_term);
	pid_t parent = getpid();
	pid_t child = fork();
	if (child < 0) {
		return 2;
	}
	if (child == 0) {
		if (!move_out && setpgid(0, 0) != 0) {
			_exit(3);
		}
		signal(SIGTERM, child_term);
		touch("ready");
		if (!move_out) {
			char byte;
			while (read(pipefd[0], &byte, 1) != 1) {}
			if (setpgid(0, parent) != 0) {
				_exit(4);
			}
			touch("joined");
		}
		for (;;) {
			pause();
		}
	}
	int fd = open("childpid", O_CREAT | O_WRONLY, 0600);
	char buf[32];
	int n = 0;
	unsigned value = child;
	do {
		buf[n++] = (value % 10) + '0';
		value /= 10;
	} while (value);
	for (int i = 0; i < n / 2; i++) {
		char swap = buf[i];
		buf[i] = buf[n - 1 - i];
		buf[n - 1 - i] = swap;
	}
	(void)write(fd, buf, n);
	close(fd);
	for (;;) {
		pause();
	}
}
