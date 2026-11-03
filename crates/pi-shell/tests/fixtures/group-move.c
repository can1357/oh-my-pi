#include <fcntl.h>
#include <string.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

/* Modes: "in" (the child starts in its own group and joins the parent's
 * group once the parent gets TERM), "out" (the child starts in the parent's
 * group and calls setsid() in its TERM handler), "exit" (as "out", and the
 * parent exits on TERM, leaving the child outside the tree and group),
 * "orphan" (as "exit", but the group member is a grandchild whose own parent
 * exited at once, so it is not a descendant of the leader before TERM), and
 * "spawn" (as "exit", and the member's TERM handler also forks a child that
 * writes its pid to "grandpid"). */
static int notify_fd;
static int move_out;
static int exit_on_term;
static int orphan;
static int spawn_on_term;

static void touch(const char *path) {
	int fd = open(path, O_CREAT | O_WRONLY | O_APPEND, 0600);
	(void)write(fd, "x", 1);
	close(fd);
}

static void append_term(void) {
	touch("terms");
}

/* Writes `pid` in decimal to `path`, in one write. */
static void write_pid_to(const char *path, pid_t pid) {
	char buf[32];
	int n = 0;
	unsigned value = pid;
	do {
		buf[n++] = (value % 10) + '0';
		value /= 10;
	} while (value);
	for (int i = 0; i < n / 2; i++) {
		char swap = buf[i];
		buf[i] = buf[n - 1 - i];
		buf[n - 1 - i] = swap;
	}
	int fd = open(path, O_CREAT | O_WRONLY, 0600);
	(void)write(fd, buf, n);
	close(fd);
}

static void write_pid(pid_t pid) {
	write_pid_to("childpid", pid);
}

static void parent_term(int signal) {
	(void)signal;
	if (exit_on_term) {
		_exit(0);
	}
	(void)write(notify_fd, "x", 1);
}

static void child_term(int signo) {
	(void)signo;
	if (move_out) {
		setsid();
	}
	append_term();
	if (spawn_on_term && fork() == 0) {
		signal(SIGTERM, SIG_DFL);
		write_pid_to("grandpid", getpid());
		for (;;) {
			pause();
		}
	}
}

int main(int argc, char **argv) {
	const char *mode = argc > 1 ? argv[1] : "";
	exit_on_term = !strcmp(mode, "exit") || !strcmp(mode, "orphan") || !strcmp(mode, "spawn");
	move_out = exit_on_term || !strcmp(mode, "out");
	orphan = !strcmp(mode, "orphan");
	spawn_on_term = !strcmp(mode, "spawn");
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
	if (child == 0 && orphan) {
		/* Double fork: the intermediate exits, the grandchild is reparented
		 * away from the leader but stays in its process group. */
		pid_t grandchild = fork();
		if (grandchild != 0) {
			_exit(grandchild < 0 ? 5 : 0);
		}
	}
	if (child == 0) {
		if (!move_out && setpgid(0, 0) != 0) {
			_exit(3);
		}
		signal(SIGTERM, child_term);
		if (orphan) {
			write_pid(getpid());
		}
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
	if (orphan) {
		/* The grandchild writes its own pid; reap the intermediate. */
		(void)waitpid(child, NULL, 0);
	} else {
		write_pid(child);
	}
	for (;;) {
		pause();
	}
}
