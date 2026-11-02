//go:build unix

package omprpc

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// prepareCommand runs the server in its own process group (merged into the
// caller's SysProcAttr). Setsid already creates one, and setpgid would fail
// for a session leader.
func prepareCommand(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	if !cmd.SysProcAttr.Setsid {
		cmd.SysProcAttr.Setpgid = true
	}
}

func processGroup(cmd *exec.Cmd) int {
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		return 0
	}
	return pgid
}

// terminate stops the server and every process in its group: SIGTERM, up to
// processGrace for the leader, then SIGKILL and up to processGrace each for
// the leader and the group to disappear. It errors when a member survives.
func (p *process) terminate() error {
	if p.pgid <= 0 {
		return p.terminateLeader()
	}
	if p.exitedWithin(0) && p.groupGone() {
		return nil
	}
	_ = syscall.Kill(-p.pgid, syscall.SIGTERM)
	if p.exitedWithin(processGrace) && p.groupGone() {
		return nil
	}
	_ = syscall.Kill(-p.pgid, syscall.SIGKILL)
	if !p.exitedWithin(processGrace) {
		return errors.New("omprpc: server process survived SIGKILL")
	}
	for deadline := time.Now().Add(processGrace); !p.groupGone(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			return fmt.Errorf("omprpc: process group %d still has members after SIGKILL", p.pgid)
		}
	}
	return nil
}

// groupGone reports whether the process group has no live member left. A
// zombie — a member already dead but not yet reaped by its (new) parent — is
// not a survivor, so it does not count. kill(-pgid, 0) alone cannot tell them
// apart: ESRCH means the group is empty, but success means ANY member exists,
// including a zombie it keeps reporting until init reaps it. So probe first (an
// empty group answers in one syscall), then on Linux read /proc and ignore
// members in state Z/X. Off Linux the probe is all we have.
func (p *process) groupGone() bool {
	switch err := syscall.Kill(-p.pgid, 0); {
	case errors.Is(err, syscall.ESRCH):
		return true // no member, live or dead, remains
	case err != nil:
		return false // EPERM etc.: a member we cannot signal is present
	}
	// A member exists (live or zombie). On Linux ignore already-dead zombies;
	// if /proc cannot be read, keep the probe's "present" answer.
	if runtime.GOOS == "linux" {
		if alive, ok := groupHasLiveMemberProc(p.pgid); ok {
			return !alive
		}
	}
	return false
}

// groupHasLiveMemberProc scans /proc for a live member of group pgid, ignoring
// members in state Z (zombie) or X/x (dead). ok is false when /proc cannot be
// listed, so the caller falls back to the signal probe.
func groupHasLiveMemberProc(pgid int) (alive, ok bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, false
	}
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		stat, err := os.ReadFile("/proc/" + entry.Name() + "/stat")
		if err != nil {
			continue // the process vanished between ReadDir and ReadFile
		}
		state, memberPgid, parsed := parseStatGroup(stat)
		if !parsed || memberPgid != pgid {
			continue
		}
		if state != 'Z' && state != 'X' && state != 'x' {
			return true, true
		}
	}
	return false, true
}

// parseStatGroup extracts a process's state and process-group id from the
// contents of /proc/<pid>/stat: `pid (comm) state ppid pgrp ...`, where comm
// can contain spaces and ')', so the fields are read after the final ')'.
func parseStatGroup(stat []byte) (state byte, pgid int, ok bool) {
	rparen := bytes.LastIndexByte(stat, ')')
	if rparen < 0 {
		return 0, 0, false
	}
	fields := strings.Fields(string(stat[rparen+1:]))
	if len(fields) < 3 {
		return 0, 0, false
	}
	pg, err := strconv.Atoi(fields[2])
	if err != nil {
		return 0, 0, false
	}
	return fields[0][0], pg, true
}

func (p *process) terminateLeader() error {
	if p.exitedWithin(0) {
		return nil
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	if p.exitedWithin(processGrace) {
		return nil
	}
	_ = p.cmd.Process.Kill()
	if !p.exitedWithin(processGrace) {
		return errors.New("omprpc: server process survived SIGKILL")
	}
	return nil
}
