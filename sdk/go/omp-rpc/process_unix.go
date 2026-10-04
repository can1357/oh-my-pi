//go:build unix

package omprpc

import (
	"errors"
	"fmt"
	"os/exec"
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

// groupGone probes the group with signal 0: ESRCH means no member is left.
func (p *process) groupGone() bool {
	return errors.Is(syscall.Kill(-p.pgid, 0), syscall.ESRCH)
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
