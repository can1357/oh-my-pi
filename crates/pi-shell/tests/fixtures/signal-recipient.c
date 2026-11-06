#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/signalfd.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Raw kernel masks also cover 32/33, which glibc reserves for threads. */
static const int numbers[] = {15, 32, 33, 34};

static long milliseconds(void) {
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now)) exit(90);
	return now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void observe(const char *root, const char *role, uint64_t mask) {
	int fd = signalfd(-1, (const sigset_t *)&mask, SFD_CLOEXEC | SFD_NONBLOCK);
	if (fd < 0) exit(91);
	char ready[4096], events[4096], release[4096];
	snprintf(ready, sizeof ready, "%s/%s-ready", root, role);
	snprintf(events, sizeof events, "%s/%s-events", root, role);
	snprintf(release, sizeof release, "%s/release", root);
	FILE *file = fopen(ready, "w");
	if (!file) exit(92);
	fprintf(file, "%ld\n", (long)getpid());
	if (fclose(file)) exit(93);

	unsigned counts[4] = {0};
	unsigned wrong = 0;
	long deadline = milliseconds() + 5000;
	long finish = 0;
	for (;;) {
		struct signalfd_siginfo event;
		ssize_t size;
		while ((size = read(fd, &event, sizeof event)) == sizeof event) {
			size_t index = 0;
			while (index < 4 && event.ssi_signo != (unsigned)numbers[index]) ++index;
			if (index < 4) ++counts[index]; else ++wrong;
		}
		if (size != -1 || (errno != EAGAIN && errno != EINTR)) exit(94);
		long now = milliseconds();
		if (!finish && access(release, F_OK) == 0) finish = now + 100;
		if (finish && now >= finish) break;
		if (now >= deadline) exit(95);
		struct pollfd input = {fd, POLLIN, 0};
		if (poll(&input, 1, 10) < 0 && errno != EINTR) exit(96);
	}
	file = fopen(events, "w");
	if (!file) exit(97);
	fprintf(file, "15=%u 32=%u 33=%u 34=%u wrong=%u\n",
		counts[0], counts[1], counts[2], counts[3], wrong);
	if (fclose(file)) exit(98);
	close(fd);
}

int main(int argc, char **argv) {
	if (argc != 3) return 80;
	uint64_t mask = 0;
	for (size_t i = 0; i < 4; ++i) mask |= UINT64_C(1) << (numbers[i] - 1);
	if (syscall(SYS_rt_sigprocmask, 0, &mask, NULL, sizeof mask)) return 81;
	if (strcmp(argv[2], "tree") == 0) {
		pid_t child = fork();
		if (child < 0) return 82;
		if (child == 0) {
			observe(argv[1], "child", mask);
			_exit(0);
		}
		observe(argv[1], "parent", mask);
		int status;
		if (waitpid(child, &status, 0) != child) return 83;
		return WIFEXITED(status) ? WEXITSTATUS(status) : 84;
	}
	observe(argv[1], argv[2], mask);
	return 0;
}
