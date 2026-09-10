//go:build windows

package collect

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/sg3xhero/alfred/agent/internal/config"
)

var (
	wtsapi32                  = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSEnumerateSessionsW = wtsapi32.NewProc("WTSEnumerateSessionsW")
	procWTSQuerySessionInfoW  = wtsapi32.NewProc("WTSQuerySessionInformationW")
	procWTSFreeMemory         = wtsapi32.NewProc("WTSFreeMemory")
)

func (c *Collector) collectPlatform(snap *Snapshot, cfg *config.Config) {
	snap.Sessions = listSessions()
	snap.RebootRequired = pendingReboot()

	for _, name := range cfg.Checks.Services {
		running, detail := serviceRunning(name)
		snap.Services = append(snap.Services, CheckResult{Name: name, Running: running, Detail: detail})
	}

	// Event Log queries are comparatively heavy; run on a slower cadence and cache
	if time.Since(c.lastEvents) > time.Duration(cfg.Checks.EventLogIntervalSeconds)*time.Second {
		since := c.lastEvents
		if since.IsZero() {
			since = time.Now().Add(-time.Duration(cfg.Checks.EventLogIntervalSeconds) * time.Second)
		}
		c.cachedEv = queryEventLog(since)
		c.lastEvents = time.Now()
	}
	snap.EventErrors = c.cachedEv

	// Dispatched in the background, never awaited here: the Security log
	// query can run long on a busy DC, and this tick must still push
	// CPU/memory/disk on schedule regardless of how slow that query is.
	// Whatever the last completed run found is attached to this snapshot and
	// then drained, so it stays a delta rather than repeating every tick.
	if cfg.Checks.LockoutMonitoring {
		c.lockoutMu.Lock()
		if !c.lockoutBusy {
			since := c.lastLockoutCheck
			if since.IsZero() {
				since = time.Now().Add(-time.Duration(cfg.IntervalSeconds) * time.Second)
			}
			c.lockoutBusy = true
			go func() {
				events := queryLockouts(since)
				c.lockoutMu.Lock()
				c.cachedLockouts = append(c.cachedLockouts, events...)
				c.lastLockoutCheck = time.Now()
				c.lockoutBusy = false
				c.lockoutMu.Unlock()
			}()
		}
		snap.Lockouts = c.cachedLockouts
		c.cachedLockouts = nil
		c.lockoutMu.Unlock()
	}
}

// listSessions enumerates WTS sessions and returns signed-in users.
// Disconnected RDP sessions count as signed in: a service account's
// interactive job keeps running when the RDP window is closed.
func listSessions() []Session {
	type wtsSessionInfo struct {
		SessionID      uint32
		WinStationName *uint16
		State          uint32
	}
	const (
		wtsActive       = 0
		wtsDisconnected = 4
		wtsUserName     = 5
	)

	var count uint32
	var sessPtr uintptr
	r, _, _ := procWTSEnumerateSessionsW.Call(0, 0, 1,
		uintptr(unsafe.Pointer(&sessPtr)), uintptr(unsafe.Pointer(&count)))
	if r == 0 || sessPtr == 0 {
		return nil
	}
	defer procWTSFreeMemory.Call(sessPtr)

	size := unsafe.Sizeof(wtsSessionInfo{})
	var out []Session
	for i := uintptr(0); i < uintptr(count); i++ {
		si := (*wtsSessionInfo)(unsafe.Pointer(sessPtr + i*size))
		if si.State != wtsActive && si.State != wtsDisconnected {
			continue
		}
		var buf *uint16
		var bytesReturned uint32
		r, _, _ := procWTSQuerySessionInfoW.Call(0, uintptr(si.SessionID), wtsUserName,
			uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&bytesReturned)))
		if r == 0 || buf == nil {
			continue
		}
		user := windows.UTF16PtrToString(buf)
		procWTSFreeMemory.Call(uintptr(unsafe.Pointer(buf)))
		if user == "" {
			continue
		}
		state := "active"
		if si.State == wtsDisconnected {
			state = "disconnected"
		}
		out = append(out, Session{User: user, State: state})
	}
	return out
}

func serviceRunning(name string) (bool, string) {
	m, err := mgr.Connect()
	if err != nil {
		return false, "scm: " + err.Error()
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return false, "not installed"
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return false, err.Error()
	}
	return st.State == svc.Running, stateName(st.State)
}

func stateName(s svc.State) string {
	switch s {
	case svc.Running:
		return "running"
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start pending"
	case svc.StopPending:
		return "stop pending"
	case svc.Paused:
		return "paused"
	}
	return fmt.Sprintf("state %d", s)
}

func pendingReboot() bool {
	keys := []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
	}
	for _, path := range keys {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
		if err == nil {
			k.Close()
			return true
		}
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager`, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		if vals, _, err := k.GetStringsValue("PendingFileRenameOperations"); err == nil && len(vals) > 0 {
			return true
		}
	}
	return false
}

type psLockoutEvent struct {
	TimeCreated string `json:"TimeCreated"`
	User        string `json:"User"`
	Caller      string `json:"Caller"`
}

// queryLockouts polls the Security log for event 4740 ("account was locked
// out"). It reads the event's structured Properties rather than the
// locale-dependent Message text: Properties[0] is the locked-out account
// name and Properties[1] is the caller computer — confirmed by dumping the
// property list directly on a 2026-era Windows Server DC (7 properties
// total, 0-6); this does NOT match the 8-property TargetUserName..
// CallerComputerName-at-[7] layout documented for older versions, so don't
// "fix" this back to [7] without re-checking on the actual OS in use.
//
// Unlike queryEventLog, this does NOT use -ErrorAction SilentlyContinue on
// the cmdlet itself: that would hide "access denied" identically to the
// normal "no events matched" case, and a permissions problem on the
// Security log needs to be visible rather than silently producing an
// empty result every poll.
func queryLockouts(since time.Time) []LockoutEvent {
	script := fmt.Sprintf(`$ErrorActionPreference = 'Stop'
try {
  $ev = @(Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4740; StartTime=[datetime]'%s'} -MaxEvents 50 | Select-Object @{n='TimeCreated';e={$_.TimeCreated.ToString('o')}},@{n='User';e={$_.Properties[0].Value}},@{n='Caller';e={$_.Properties[1].Value}})
  ConvertTo-Json $ev -Compress
} catch {
  if ($_.Exception.Message -match 'No events were found') { Write-Output '[]' }
  else { [Console]::Error.WriteLine('LOCKOUT_QUERY_ERROR: ' + $_.Exception.Message); exit 1 }
}`, since.Format("2006-01-02 15:04:05"))

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var buf, errBuf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &errBuf
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		log.Printf("lockout query: failed to start powershell: %v", err)
		return nil
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			log.Printf("lockout query: powershell failed: %v — %s", err, strings.TrimSpace(errBuf.String()))
			return nil
		}
	case <-time.After(2 * time.Minute):
		_ = cmd.Process.Kill()
		<-done
		log.Printf("lockout query: timed out after 2m")
		return nil
	}

	raw := strings.TrimSpace(buf.String())
	if raw == "" || raw == "[]" {
		return nil
	}
	var events []psLockoutEvent
	if err := json.Unmarshal([]byte(raw), &events); err != nil {
		log.Printf("lockout query: could not parse output: %v — raw=%q", err, raw)
		return nil
	}
	var out []LockoutEvent
	for _, e := range events {
		out = append(out, LockoutEvent{Time: e.TimeCreated, User: strings.TrimSpace(e.User), CallerComputer: strings.TrimSpace(e.Caller)})
	}
	if len(out) > 0 {
		log.Printf("lockout query: found %d event(s) since %s", len(out), since.Format(time.RFC3339))
	}
	return out
}

type psEvent struct {
	TimeCreated      string `json:"TimeCreated"`
	LogName          string `json:"LogName"`
	LevelDisplayName string `json:"LevelDisplayName"`
	ProviderName     string `json:"ProviderName"`
	ID               int    `json:"Id"`
	Message          string `json:"Message"`
}

func queryEventLog(since time.Time) []EventEntry {
	script := fmt.Sprintf(`$ev = Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=[datetime]'%s'} -MaxEvents 50 -ErrorAction SilentlyContinue | Select-Object @{n='TimeCreated';e={$_.TimeCreated.ToString('o')}},LogName,LevelDisplayName,ProviderName,Id,@{n='Message';e={if($_.Message){$_.Message.Substring(0,[Math]::Min(500,$_.Message.Length))}else{''}}}; if($ev){ConvertTo-Json @($ev) -Compress}`,
		since.Format("2006-01-02 15:04:05"))
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return nil
	}
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		return nil
	}

	raw := strings.TrimSpace(buf.String())
	if raw == "" {
		return nil
	}
	var events []psEvent
	if err := json.Unmarshal([]byte(raw), &events); err != nil {
		return nil
	}
	var out []EventEntry
	for _, e := range events {
		out = append(out, EventEntry{
			Time: e.TimeCreated, Log: e.LogName, Level: e.LevelDisplayName,
			Source: e.ProviderName, ID: e.ID, Message: strings.TrimSpace(e.Message),
		})
	}
	return out
}
