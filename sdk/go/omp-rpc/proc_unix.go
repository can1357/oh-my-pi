//go:build unix

package omprpc

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// Teardown confirms a process group gone only when its last check of the group
// finds positive evidence that no member, process or thread, is alive.
// Anything it cannot read or prove counts as alive. The Go, Python and Rust
// SDKs apply the same rules.
//
// Teardown trusts /proc as the kernel presents it to the calling thread. A
// process with CAP_SYS_ADMIN in the client's mount namespace can make /proc
// show what it wants (a mount over an entry, a copy over mountinfo, a mount
// that comes and goes between reads), and it can also kill or ptrace the
// client: teardown does not defend against it. The checks below are for real
// setups: hidepid, another pid namespace, a task being released, a mount over
// /proc/<pid>.

// procFS is /proc, probeMember is kill(pid, 0) and signalGroup is
// kill(-pgid, sig). Teardown reaches them through these variables so tests
// can make chosen reads and probes fail, and act when a signal is sent.
var (
	procFS      fs.FS = os.DirFS("/proc")
	probeMember       = func(pid int) error { return syscall.Kill(pid, 0) }
	signalGroup       = func(pgid int, sig syscall.Signal) error { return syscall.Kill(-pgid, sig) }
)

// errProcVanished reports a /proc entry that is gone (ENOENT or ESRCH): the
// process or thread exited and was reaped while it was being read.
var errProcVanished = errors.New("omprpc: /proc entry vanished")

// procDead reports whether a /proc task state is dead: Z (zombie), X or x.
func procDead(state byte) bool {
	return state == 'Z' || state == 'X' || state == 'x'
}

// readProcStat reads the state and process group of the task at name (a pid,
// or pid/task/tid). It returns errProcVanished when the task is gone, and an
// error when the file cannot be read or parsed. A task the kernel is
// releasing (state X or x) has left its group and reads pgrp -1; that is
// accepted only with such a state.
func readProcStat(fsys fs.FS, name string) (state byte, pgid int, err error) {
	stat, err := fs.ReadFile(fsys, name+"/stat")
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
		return 0, 0, errProcVanished
	}
	if err != nil {
		return 0, 0, err
	}
	// `pid (comm) state ppid pgrp ...`: comm can contain spaces and ')', so
	// the fields are read after the final ')'.
	malformed := fmt.Errorf("omprpc: malformed /proc/%s/stat", name)
	rparen := bytes.LastIndexByte(stat, ')')
	if rparen < 0 {
		return 0, 0, malformed
	}
	fields := bytes.Fields(stat[rparen+1:])
	if len(fields) < 3 || len(fields[0]) != 1 {
		return 0, 0, malformed
	}
	state, pgrp := fields[0][0], string(fields[2])
	if isPid(pgrp) {
		if pgid, err = strconv.Atoi(pgrp); err != nil {
			return 0, 0, malformed
		}
		return state, pgid, nil
	}
	if pgrp == "-1" && (state == 'X' || state == 'x') {
		return state, -1, nil
	}
	return 0, 0, malformed
}

// procThreadsDead reports whether every thread of process pid is dead or
// gone. A process whose main thread exited reads Z in /proc/<pid>/stat while
// its other threads run; only /proc/<pid>/task lists them.
func procThreadsDead(fsys fs.FS, pid string) (bool, error) {
	tasks, err := fs.ReadDir(fsys, pid+"/task")
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
		return true, nil // the whole process was reaped
	}
	if err != nil {
		return false, err
	}
	for _, task := range tasks {
		state, _, err := readProcStat(fsys, pid+"/task/"+task.Name())
		if errors.Is(err, errProcVanished) {
			continue
		}
		if err != nil {
			return false, err
		}
		if !procDead(state) {
			return false, nil
		}
	}
	return true, nil
}

// procGroupDead reports whether /proc proves that no member of group pgid, no
// process and no thread, is alive. Call it only after kill(-pgid, SIGKILL):
// the kernel lets no member that signal reached start a process or a thread,
// so the scan cannot miss a member created behind it unless a member the
// signal did not reach created it. The checks below rule that case out.
//
// It returns false, proving nothing, when:
//   - /proc is not this pid namespace's procfs, is mounted with hidepid
//     (which hides other users' and non-dumpable processes), or has a
//     process entry mounted over, before the sweeps or after them;
//   - /proc cannot be listed, or a stat or a task list cannot be read or
//     parsed for any reason but ENOENT or ESRCH, which mean the task is gone;
//   - a member, or any thread of one, is in a state other than Z, X or x;
//   - kill(member, 0) fails with anything but ESRCH: SIGKILL did not reach
//     that member (EPERM), so it may still start processes or threads;
//   - the second of two sweeps, each a fresh listing of /proc with every
//     entry read, finds any of the above. A process the first sweep read as
//     outside the group that joins it before the second sweep reads it again
//     is seen. One that joins after the second sweep's listing, created after
//     it or already read by it, is not, as one that joins after teardown
//     returns: no finite scan of /proc can see it.
func procGroupDead(fsys fs.FS, pgid int) bool {
	return procListsEveryProcess(fsys) &&
		procSweepDead(fsys, pgid) &&
		procSweepDead(fsys, pgid) &&
		procListsEveryProcess(fsys)
}

// procSweepDead lists /proc and reads every entry: whether each member of
// group pgid, and each of its threads, is dead, and SIGKILL reached it.
func procSweepDead(fsys fs.FS, pgid int) bool {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := entry.Name()
		pid, err := strconv.Atoi(name)
		if err != nil {
			continue // not a process
		}
		state, memberPgid, err := readProcStat(fsys, name)
		if errors.Is(err, errProcVanished) {
			continue
		}
		if err != nil {
			return false
		}
		if memberPgid != pgid {
			continue
		}
		if !procDead(state) {
			return false
		}
		if dead, err := procThreadsDead(fsys, name); err != nil || !dead {
			return false
		}
		if err := probeMember(pid); err != nil && !errors.Is(err, syscall.ESRCH) {
			return false
		}
	}
	return true
}

// procListsEveryProcess reports whether /proc shows every process of this pid
// namespace: its self entry is this process, its mount at /proc carries no
// hidepid option other than 0 or off, and nothing is mounted over a process
// entry (/proc/<pid> or below it), which would make a live process's entry
// read as gone.
func procListsEveryProcess(fsys fs.FS) bool {
	self, err := fs.ReadFile(fsys, "self/stat")
	if err != nil {
		return false
	}
	if pid, _, _ := bytes.Cut(self, []byte(" ")); string(pid) != strconv.Itoa(os.Getpid()) {
		return false
	}
	mountinfo, err := fs.ReadFile(fsys, "self/mountinfo")
	if err != nil {
		return false
	}
	// `id parent major:minor root mountpoint options [optional...] - fstype
	// source superoptions`. The last mount at /proc is the one on top.
	var mount, super []string
	for _, line := range strings.Split(string(mountinfo), "\n") {
		before, after, found := strings.Cut(line, " - ")
		fields := strings.Fields(before)
		if !found || len(fields) < 6 {
			continue
		}
		if fields[4] == "/proc" {
			mount, super = fields, strings.Fields(after)
		} else if rest, under := strings.CutPrefix(fields[4], "/proc/"); under {
			if entry, _, _ := strings.Cut(rest, "/"); isPid(entry) {
				return false
			}
		}
	}
	if len(mount) == 0 || len(super) < 3 || super[0] != "proc" {
		return false
	}
	for _, option := range strings.Split(mount[5]+","+super[2], ",") {
		if value, found := strings.CutPrefix(option, "hidepid="); found && value != "0" && value != "off" {
			return false
		}
	}
	return true
}

// isPid reports whether name is a /proc process entry: all decimal digits.
func isPid(name string) bool {
	if name == "" {
		return false
	}
	for _, c := range name {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
