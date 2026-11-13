//go:build unix

package omprpc

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
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

// processGroup is the group prepareCommand put the server in: its own, whose
// id is its pid, unless the caller's SysProcAttr named another with Pgid. It
// is derived, not read back with getpgid: a read that fails must not leave
// teardown with no group to check, which would confirm it once the leader
// alone exited while the rest of the group runs.
func processGroup(cmd *exec.Cmd) int {
	if attr := cmd.SysProcAttr; !attr.Setsid && attr.Pgid != 0 {
		return attr.Pgid
	}
	return cmd.Process.Pid
}

// terminate stops the server and every process in its group: SIGTERM, up to
// processGrace for the leader, then SIGKILL and up to processGrace each for
// the leader and the group to die. It errors unless its last check of the
// group found positive evidence that no member, process or thread, was alive.
func (p *process) terminate() error {
	if p.exitedWithin(0) && p.groupEmpty() {
		return nil
	}
	_ = signalGroup(p.pgid, syscall.SIGTERM)
	if p.exitedWithin(processGrace) && p.groupEmpty() {
		return nil
	}
	_ = signalGroup(p.pgid, syscall.SIGKILL)
	if !p.exitedWithin(processGrace) {
		return errors.New("omprpc: server process survived SIGKILL")
	}
	for deadline := time.Now().Add(processGrace); !p.groupDead(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			return fmt.Errorf("omprpc: process group %d still has members after SIGKILL", p.pgid)
		}
	}
	return nil
}

// groupEmpty reports whether the group has no member at all, live or dead:
// kill(-pgid, 0) fails with ESRCH. Before SIGKILL this is the only evidence
// teardown accepts. A member that is still alive can start a process or a
// thread while /proc is read, so a scan then proves nothing.
func (p *process) groupEmpty() bool {
	return errors.Is(syscall.Kill(-p.pgid, 0), syscall.ESRCH)
}

// groupEvidence is what one check after SIGKILL found.
type groupEvidence int

const (
	groupUnproven    groupEvidence = iota // a member may be alive
	groupEmptied                          // no member at all: nothing can join any more
	groupMembersDead                      // /proc shows every member dead
)

// checkGroup reports, after SIGKILL, what proves the group dead. kill(-pgid, 0)
// succeeds while any member exists, including a dead member its parent has not
// reaped yet (a zombie), so on success only /proc can show that every member is
// dead. Off Linux there is no /proc: such a member counts as alive until it is
// reaped, bounded by processGrace.
func (p *process) checkGroup() groupEvidence {
	switch err := syscall.Kill(-p.pgid, 0); {
	case errors.Is(err, syscall.ESRCH):
		return groupEmptied
	case err != nil:
		return groupUnproven // EPERM: a member SIGKILL could not reach
	}
	if runtime.GOOS == "linux" && procGroupDead(procFS, p.pgid) {
		return groupMembersDead
	}
	return groupUnproven
}

// groupDead reports, after SIGKILL, whether no member of the group is alive.
//
// While a dead member keeps the group id in use, a process of the same
// session can still join the group, also after /proc read it as an outsider.
// So once /proc proves the members dead, the group gets SIGKILL once more,
// and the members are proven dead again after that signal: a process that
// joined and that the signal could not reach, or that joined after it, is
// seen then. One that joins after this last check is not seen, as one that
// joins after teardown returns.
func (p *process) groupDead() bool {
	switch p.checkGroup() {
	case groupEmptied:
		return true
	case groupUnproven:
		return false
	}
	_ = signalGroup(p.pgid, syscall.SIGKILL)
	return p.checkGroup() != groupUnproven
}
