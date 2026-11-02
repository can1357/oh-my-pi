//go:build linux

package omprpc

import (
	"bufio"
	"context"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// helperEnv makes the test binary run as a helper process instead of tests.
const helperEnv = "OMPRPC_TEST_HELPER"

func init() {
	if os.Getenv(helperEnv) != "" {
		// Keeps the main goroutine, and so TestMain, on the main thread.
		runtime.LockOSThread()
	}
}

func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "main-thread-exits" {
		mainThreadExitsHelper()
	}
	os.Exit(m.Run())
}

// mainThreadExitsHelper ignores SIGTERM, reports ready, then ends the main
// thread alone with exit(2), not exit_group(2): /proc/<pid>/stat then reads Z
// while the Go runtime's other threads keep the process alive.
func mainThreadExitsHelper() {
	signal.Ignore(syscall.SIGTERM)
	_, _ = os.Stdout.WriteString("ready\n")
	for {
		_, _, _ = syscall.Syscall(syscall.SYS_EXIT, 0, 0, 0)
	}
}

// startMainThreadExited starts a process in group pgid (0: a group of its
// own) whose main thread has exited while its other threads run, and that
// ignores SIGTERM. It fails the test unless /proc shows exactly that.
func startMainThreadExited(t *testing.T, pgid int) *exec.Cmd {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self, "-test.run=^$")
	cmd.Env = append(os.Environ(), helperEnv+"=main-thread-exits")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: pgid}
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	if line, err := bufio.NewReader(stdout).ReadString('\n'); line != "ready\n" {
		t.Fatalf("helper did not report ready: %q, %v", line, err)
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	waitForProcState(t, pid, 'Z')
	if dead, err := procThreadsDead(procFS, pid); err != nil || dead {
		t.Fatalf("helper %s has no live thread left (err %v)", pid, err)
	}
	return cmd
}

// startUnreapedDead starts a process in a group of its own that exits at once
// and is not reaped until the test ends: a dead-but-unreaped member.
func startUnreapedDead(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("sh", "-c", "exit 0")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Wait() })
	if _, err := io.ReadAll(stdout); err != nil {
		t.Fatal(err)
	}
	waitForProcState(t, strconv.Itoa(cmd.Process.Pid), 'Z')
	return cmd.Process.Pid
}

// startSleeper starts `sleep 30` in group pgid (0: a group of its own).
func startSleeper(t *testing.T, pgid int) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: pgid}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd
}

func waitForProcState(t *testing.T, pid string, want byte) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		state, _, err := readProcStat(procFS, pid)
		if err == nil && state == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("process %s never reached state %c (state %c, err %v)", pid, want, state, err)
		}
	}
}

// riggedFS answers the reads named in its maps itself and passes every other
// read to the real file system.
type riggedFS struct {
	fs.FS
	dirs  map[string]func() ([]fs.DirEntry, error)
	files map[string]func() ([]byte, error)
}

func (r riggedFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if read, ok := r.dirs[name]; ok {
		return read()
	}
	return fs.ReadDir(r.FS, name)
}

func (r riggedFS) ReadFile(name string) ([]byte, error) {
	if read, ok := r.files[name]; ok {
		return read()
	}
	return fs.ReadFile(r.FS, name)
}

func denied(name string) error {
	return &fs.PathError{Op: "open", Path: name, Err: syscall.EACCES}
}

// Teardown confirms a group dead only on positive evidence that no member,
// process or thread, is alive: each row is a group /proc must not prove dead.
func TestProcGroupDeadNeedsPositiveEvidence(t *testing.T) {
	dead := startUnreapedDead(t)
	deadPid := strconv.Itoa(dead)
	live := startSleeper(t, 0).Process.Pid
	livePid := strconv.Itoa(live)
	mainExited := startMainThreadExited(t, 0).Process.Pid

	rows := []struct {
		name  string
		pgid  int
		dirs  map[string]func() ([]fs.DirEntry, error)
		files map[string]func() ([]byte, error)
		probe func(pid int) error
		want  bool
	}{
		{name: "only a dead, unreaped member", pgid: dead, want: true},
		{name: "a member whose main thread exited while another thread runs", pgid: mainExited},
		{name: "a live member whose stat is unreadable", pgid: live, files: map[string]func() ([]byte, error){
			livePid + "/stat": func() ([]byte, error) { return nil, denied(livePid + "/stat") },
		}},
		{name: "a live member whose stat is malformed", pgid: live, files: map[string]func() ([]byte, error){
			livePid + "/stat": func() ([]byte, error) { return []byte("garbage"), nil },
		}},
		{name: "a dead member whose thread list is unreadable", pgid: dead, dirs: map[string]func() ([]fs.DirEntry, error){
			deadPid + "/task": func() ([]fs.DirEntry, error) { return nil, denied(deadPid + "/task") },
		}},
		{name: "a dead member whose thread stat is unreadable", pgid: dead, files: map[string]func() ([]byte, error){
			deadPid + "/task/" + deadPid + "/stat": func() ([]byte, error) { return nil, denied(deadPid + "/task/" + deadPid + "/stat") },
		}},
		{name: "an unlistable /proc", pgid: dead, dirs: map[string]func() ([]fs.DirEntry, error){
			".": func() ([]fs.DirEntry, error) {
				return nil, &fs.PathError{Op: "readdirent", Path: ".", Err: syscall.EIO}
			},
		}},
		{name: "a /proc mounted with hidepid", pgid: dead, files: map[string]func() ([]byte, error){
			"self/mountinfo": func() ([]byte, error) {
				return []byte("29 34 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw,hidepid=invisible\n"), nil
			},
		}},
		{name: "a /proc of another pid namespace", pgid: dead, files: map[string]func() ([]byte, error){
			"self/stat": func() ([]byte, error) { return []byte("1 (init) S 0 1 1 0 -1 4194560\n"), nil },
		}},
		{name: "a dead member SIGKILL could not reach", pgid: dead, probe: func(pid int) error {
			if pid == dead {
				return syscall.EPERM
			}
			return syscall.Kill(pid, 0)
		}},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			if row.probe != nil {
				realProbe := probeMember
				probeMember = row.probe
				defer func() { probeMember = realProbe }()
			}
			fsys := riggedFS{FS: procFS, dirs: row.dirs, files: row.files}
			if got := procGroupDead(fsys, row.pgid); got != row.want {
				t.Fatalf("procGroupDead = %v, want %v", got, row.want)
			}
		})
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

// A member whose main thread exited reads Z in /proc although its other
// threads run. It ignores SIGTERM, so only SIGKILL ends it: Close must not
// report success while one of its threads is alive.
func TestCloseKillsAMemberWhoseMainThreadExited(t *testing.T) {
	leader := exec.Command("sh", "-c", `echo '{"type":"ready"}'; exec sleep 30`)
	leader.Stderr = os.Stderr
	c, err := Start(context.Background(), leader)
	if err != nil {
		t.Fatal(err)
	}
	member := startMainThreadExited(t, leader.Process.Pid).Process.Pid

	closeErr := c.Close()
	if closeErr == nil && !procProvesDead(member) {
		t.Fatalf("Close returned nil while member %d still has a live thread", member)
	}
	if closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}
}

// A /proc scan is not a snapshot: a member can join the group after the
// listing and the member that the listing holds can then die. Close must not
// confirm a group whose new member it never saw while that member runs.
func TestCloseRejectsAMemberThatJoinedDuringTheScan(t *testing.T) {
	leader := exec.Command("sh", "-c", `echo '{"type":"ready"}'; exec sleep 30`)
	leader.Stderr = os.Stderr
	c, err := Start(context.Background(), leader)
	if err != nil {
		t.Fatal(err)
	}
	pgid := leader.Process.Pid

	member := exec.Command("sh", "-c", `trap '' TERM; echo ready; exec sleep 30`)
	member.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: pgid}
	stdout, err := member.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := member.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = member.Process.Kill()
		_ = member.Wait()
	})
	if line, err := bufio.NewReader(stdout).ReadString('\n'); line != "ready\n" {
		t.Fatalf("member did not report ready: %q, %v", line, err)
	}

	var late *exec.Cmd
	realProc := procFS
	procFS = riggedFS{FS: realProc, dirs: map[string]func() ([]fs.DirEntry, error){
		".": func() ([]fs.DirEntry, error) {
			entries, err := fs.ReadDir(realProc, ".")
			if late == nil {
				// Behind the listing: a new member joins, then the member the
				// listing holds dies.
				late = startSleeper(t, pgid)
				_ = member.Process.Signal(syscall.SIGKILL)
				waitForProcState(t, strconv.Itoa(member.Process.Pid), 'Z')
			}
			return entries, err
		},
	}}
	defer func() { procFS = realProc }()

	closeErr := c.Close()
	if late == nil {
		t.Fatal("Close never listed /proc")
	}
	if closeErr == nil && !procProvesDead(late.Process.Pid) {
		t.Fatalf("Close returned nil while member %d, which joined during the scan, runs", late.Process.Pid)
	}
}
