//go:build unix

package omprpc

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// processGone reports whether pid is dead, waiting up to timeout. Dead means
// kill(pid, 0) fails with ESRCH or, on Linux, /proc proves the process and
// each of its threads dead (a zombie its parent has not reaped yet). A /proc
// read that fails for any other reason proves nothing, so it keeps waiting.
func processGone(pid int, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); ; time.Sleep(20 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) || procProvesDead(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}

// procProvesDead reports whether /proc proves pid dead: its entry is gone, or
// it and every one of its threads are in a dead state. Off Linux it is false.
func procProvesDead(pid int) bool {
	if runtime.GOOS != "linux" {
		return false
	}
	name := strconv.Itoa(pid)
	state, _, err := readProcStat(procFS, name)
	if errors.Is(err, errProcVanished) {
		return true
	}
	if err != nil || !procDead(state) {
		return false
	}
	dead, err := procThreadsDead(procFS, name)
	return err == nil && dead
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
