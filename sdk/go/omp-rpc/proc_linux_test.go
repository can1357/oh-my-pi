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
	switch os.Getenv(helperEnv) {
	case "main-thread-exits":
		mainThreadExitsHelper()
	case "join-group":
		joinGroupHelper()
	}
	os.Exit(m.Run())
}

// joinGroupHelper joins process group OMPRPC_TEST_PGID once a line arrives on
// stdin, reports it, then idles.
func joinGroupHelper() {
	pgid, err := strconv.Atoi(os.Getenv("OMPRPC_TEST_PGID"))
	if err != nil {
		os.Exit(2)
	}
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	if err := syscall.Setpgid(0, pgid); err != nil {
		os.Exit(3)
	}
	_, _ = os.Stdout.WriteString("joined\n")
	time.Sleep(time.Hour)
	os.Exit(0)
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
		// released, if set, is the stat of one more listed task.
		released string
		want     bool
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
		// A mount over a process's /proc entry hides it: the entry reads as gone.
		{name: "a /proc with a process entry mounted over", pgid: dead, files: map[string]func() ([]byte, error){
			"self/mountinfo": func() ([]byte, error) {
				return []byte("29 34 0:26 / /proc rw,nosuid - proc proc rw\n" +
					"40 29 0:50 / /proc/" + deadPid + " rw - tmpfs tmpfs rw\n"), nil
			},
		}},
		// binfmt_misc and a container's masks mount beneath /proc, not over an entry.
		{name: "a /proc with another mount beneath it", pgid: dead, want: true, files: map[string]func() ([]byte, error){
			"self/mountinfo": func() ([]byte, error) {
				return []byte("29 34 0:26 / /proc rw,nosuid - proc proc rw\n" +
					"41 29 0:51 / /proc/sys/fs/binfmt_misc rw - binfmt_misc b rw\n"), nil
			},
		}},
		// A task the kernel is releasing, anywhere on the host, reads state X
		// and pgrp -1: it has left every group.
		{name: "an unrelated task being released", pgid: dead, want: true,
			released: "4194301 (git) X 0 -1 -1 0 -1 4227084 424 93 0 0\n"},
		{name: "a live task without a process group", pgid: dead,
			released: "4194301 (git) S 0 -1 -1 0 -1 4227084 424 93 0 0\n"},
		{name: "a dead member SIGKILL could not reach", pgid: dead, probe: func(pid int) error {
			if pid == dead {
				return syscall.EPERM
			}
			return syscall.Kill(pid, 0)
		}},
	}
	// /proc lists only the fixtures, so no unrelated process on the host can
	// turn the dead-member control false.
	only := func() ([]fs.DirEntry, error) {
		entries, err := fs.ReadDir(procFS, ".")
		var fixtures []fs.DirEntry
		for _, entry := range entries {
			if name := entry.Name(); name == deadPid || name == livePid || name == strconv.Itoa(mainExited) {
				fixtures = append(fixtures, entry)
			}
		}
		return fixtures, err
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			if row.probe != nil {
				realProbe := probeMember
				probeMember = row.probe
				defer func() { probeMember = realProbe }()
			}
			dirs := map[string]func() ([]fs.DirEntry, error){".": only}
			files := map[string]func() ([]byte, error){}
			if row.released != "" {
				dirs["."] = func() ([]fs.DirEntry, error) {
					entries, err := only()
					return append(entries, fakeEntry("4194301")), err
				}
				files["4194301/stat"] = func() ([]byte, error) { return []byte(row.released), nil }
			}
			for name, read := range row.dirs {
				dirs[name] = read
			}
			for name, read := range row.files {
				files[name] = read
			}
			fsys := riggedFS{FS: procFS, dirs: dirs, files: files}
			if got := procGroupDead(fsys, row.pgid); got != row.want {
				t.Fatalf("procGroupDead = %v, want %v", got, row.want)
			}
		})
	}
}

// fakeEntry is a /proc directory entry no real process backs.
type fakeEntry string

func (e fakeEntry) Name() string             { return string(e) }
func (fakeEntry) IsDir() bool                { return true }
func (fakeEntry) Type() fs.FileMode          { return fs.ModeDir }
func (fakeEntry) Info() (fs.FileInfo, error) { return nil, fs.ErrNotExist }

// startAnchor starts a member of group pgid that exits at once and is not
// reaped until the test ends: it keeps the group joinable once the leader dies.
func startAnchor(t *testing.T, pgid int) {
	t.Helper()
	anchor := exec.Command("sh", "-c", "exit 0")
	anchor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: pgid}
	anchorOut, err := anchor.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := anchor.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = anchor.Wait() })
	if _, err := io.ReadAll(anchorOut); err != nil {
		t.Fatal(err)
	}
}

// startJoiner starts a process in a group of its own; join makes it join group
// pgid and returns once it has.
func startJoiner(t *testing.T, pgid int) (pid int, join func()) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	joiner := exec.Command(self, "-test.run=^$")
	joiner.Env = append(os.Environ(), helperEnv+"=join-group", "OMPRPC_TEST_PGID="+strconv.Itoa(pgid))
	joiner.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	joinerIn, err := joiner.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	joinerOut, err := joiner.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := joiner.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = joiner.Process.Kill()
		_ = joiner.Wait()
	})
	return joiner.Process.Pid, func() {
		_, _ = io.WriteString(joinerIn, "join\n")
		if line, err := bufio.NewReader(joinerOut).ReadString('\n'); line != "joined\n" {
			t.Errorf("joiner did not join: %q, %v", line, err)
		}
	}
}

// While a dead-but-unreaped member keeps the group id in use, a process in the
// same session can join the group at any time, also after the scan has read it
// as an outsider. Close must not report success while that process runs.
func TestCloseKillsAProcessThatJoinedTheGroupDuringTheScan(t *testing.T) {
	leader := exec.Command("sh", "-c", `echo '{"type":"ready"}'; exec sleep 30`)
	leader.Stderr = os.Stderr
	c, err := Start(context.Background(), leader)
	if err != nil {
		t.Fatal(err)
	}
	pgid := leader.Process.Pid
	startAnchor(t, pgid)
	joiner, join := startJoiner(t, pgid)
	name := strconv.Itoa(joiner)

	joined := false
	realProc := procFS
	procFS = riggedFS{FS: realProc, files: map[string]func() ([]byte, error){
		name + "/stat": func() ([]byte, error) {
			stat, err := fs.ReadFile(realProc, name+"/stat")
			if !joined {
				// Behind the read: the process, read as outside the group, joins it.
				joined = true
				join()
			}
			return stat, err
		},
	}}
	defer func() { procFS = realProc }()

	closeErr := c.Close()
	if !joined {
		t.Fatal("Close never read the joining process")
	}
	if closeErr == nil && !processGone(joiner, 2*time.Second) {
		t.Fatalf("Close returned nil while process %d, which joined the group during the scan, runs", joiner)
	}
}

// The final proof reads a process as outside the group, and the process joins
// before the proof ends. The proof must read it again and see a live member:
// Close must not report success while it runs.
func TestCloseSeesAProcessThatJoinedDuringTheFinalProof(t *testing.T) {
	leader := exec.Command("sh", "-c", `echo '{"type":"ready"}'; exec sleep 30`)
	leader.Stderr = os.Stderr
	c, err := Start(context.Background(), leader)
	if err != nil {
		t.Fatal(err)
	}
	pgid := leader.Process.Pid
	startAnchor(t, pgid)
	joiner, join := startJoiner(t, pgid)
	name := strconv.Itoa(joiner)

	kills := 0
	realSignal := signalGroup
	signalGroup = func(target int, sig syscall.Signal) error {
		err := realSignal(target, sig)
		if target == pgid && sig == syscall.SIGKILL {
			kills++
		}
		return err
	}
	defer func() { signalGroup = realSignal }()
	joined := false
	realProc := procFS
	procFS = riggedFS{FS: realProc, files: map[string]func() ([]byte, error){
		name + "/stat": func() ([]byte, error) {
			stat, err := fs.ReadFile(realProc, name+"/stat")
			// After the last SIGKILL, behind this read: the process, read as
			// outside the group, joins it.
			if kills >= 2 && !joined {
				joined = true
				join()
			}
			return stat, err
		},
	}}
	defer func() { procFS = realProc }()

	closeErr := c.Close()
	if !joined {
		t.Fatal("the final proof never read the joining process")
	}
	if closeErr == nil && !procProvesDead(joiner) {
		t.Fatalf("Close returned nil while process %d, which joined during the final proof, runs", joiner)
	}
}

// The last SIGKILL does not end the race: a process can join the group right
// after it, or be one the signal cannot reach. Close must check the group
// after its last signal and not report success while such a process runs.
func TestCloseSeesAProcessThatJoinedAfterTheLastSIGKILL(t *testing.T) {
	leader := exec.Command("sh", "-c", `echo '{"type":"ready"}'; exec sleep 30`)
	leader.Stderr = os.Stderr
	c, err := Start(context.Background(), leader)
	if err != nil {
		t.Fatal(err)
	}
	pgid := leader.Process.Pid
	startAnchor(t, pgid)
	joiner, join := startJoiner(t, pgid)

	kills := 0
	realSignal := signalGroup
	signalGroup = func(target int, sig syscall.Signal) error {
		err := realSignal(target, sig)
		if target == pgid && sig == syscall.SIGKILL {
			kills++
			// The first SIGKILL escalates; the second follows the first /proc
			// proof. Join right after it.
			if kills == 2 {
				join()
			}
		}
		return err
	}
	defer func() { signalGroup = realSignal }()

	closeErr := c.Close()
	if kills < 2 {
		t.Fatal("Close never proved the group dead")
	}
	if closeErr == nil && !procProvesDead(joiner) {
		t.Fatalf("Close returned nil while process %d, which joined after the last SIGKILL, runs", joiner)
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
