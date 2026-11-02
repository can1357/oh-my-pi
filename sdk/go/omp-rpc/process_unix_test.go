//go:build unix

package omprpc

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// processGone reports whether pid no longer exists, waiting up to timeout.
func processGone(pid int, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); ; time.Sleep(20 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
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
