//go:build unix

package omprpc

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// processGone reports whether pid is dead, waiting up to timeout. A zombie —
// dead but not yet reaped by init — counts as gone: kill(pid, 0) keeps
// succeeding on a zombie, so on Linux we also treat state Z/X in /proc as gone.
func processGone(pid int, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); ; time.Sleep(20 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) || pidIsDead(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}

// pidIsDead reports whether pid is a zombie or already gone, read from /proc on
// Linux. Elsewhere it returns false, leaving the kill(pid, 0) probe to decide.
func pidIsDead(pid int) bool {
	if runtime.GOOS != "linux" {
		return false
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true // gone from /proc
	}
	state, _, ok := parseStatGroup(stat)
	return ok && (state == 'Z' || state == 'X' || state == 'x')
}

// A server that ignores SIGTERM and leaves a background child: Close escalates
// to SIGKILL for the group, reaps both, and stays bounded.
func TestCloseKillsTheProcessGroup(t *testing.T) {
	script := `sleep 30 >/dev/null 2>&1 &
child=$!
trap "" TERM
echo '{"type":"ready"}'
echo "{\"type\":\"command_output\",\"text\":\"$child\"}"
while :; do sleep 1; done`
	cmd := exec.Command("sh", "-c", script)
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: false}
	c, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatal("Start did not merge Setpgid into the caller's SysProcAttr")
	}
	child, err := strconv.Atoi(nextFrame[CommandOutputEvent](t, c).Text)
	if err != nil {
		t.Fatal(err)
	}
	leader := cmd.Process.Pid
	started := time.Now()
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 4*processGrace {
		t.Fatalf("Close took %s", elapsed)
	}
	if !processGone(child, 3*time.Second) || !processGone(leader, time.Second) {
		t.Fatalf("leader %d or child %d survived Close", leader, child)
	}
}

// TestCloseConfirmsWhenGroupHasOnlyAZombie: a group member that is already dead
// but not yet reaped — a zombie reparented to init — must not be read as a
// survivor. The zombie is built deliberately so the test does not depend on
// init's reap latency.
func TestCloseConfirmsWhenGroupHasOnlyAZombie(t *testing.T) {
	leader := exec.Command("sh", "-c", `echo '{"type":"ready"}'; exec sleep 30`)
	leader.Stderr = os.Stderr
	leader.SysProcAttr = &syscall.SysProcAttr{Setpgid: false}
	c, err := Start(context.Background(), leader)
	if err != nil {
		t.Fatal(err)
	}
	pgid := leader.Process.Pid // Start made the leader its own group's leader

	// A member that joins the leader's group, exits at once, and is never
	// reaped here, so it lingers as a dead-but-unreaped member of the group.
	zombie := exec.Command("sh", "-c", "exit 0")
	zombie.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: pgid}
	stdout, err := zombie.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := zombie.Start(); err != nil {
		t.Fatal(err)
	}
	// EOF means the member has exited; we deliberately do not Wait before the
	// assertion, so it stays a zombie in the group.
	if _, err := io.ReadAll(stdout); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = zombie.Wait() }()

	if err := c.Close(); err != nil {
		t.Fatalf("Close reported failure with only a zombie left in the group: %v", err)
	}
	if !processGone(pgid, time.Second) {
		t.Fatalf("leader %d survived Close", pgid)
	}
}

// A server that exits on stdin EOF is torn down without waiting out the grace periods.
func TestCloseOfACooperativeServerIsQuick(t *testing.T) {
	cmd := exec.Command("sh", "-c", `echo '{"type":"ready"}'; cat >/dev/null`)
	c, err := Start(context.Background(), cmd)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if elapsed := time.Since(started); elapsed > processGrace {
		t.Fatalf("Close took %s", elapsed)
	}
	if !errors.Is(c.Err(), ErrClosed) {
		t.Fatalf("Err after Close: %v", c.Err())
	}
}
