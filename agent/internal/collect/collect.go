package collect

import (
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"

	"github.com/sg3xhero/alfred/agent/internal/config"
)

type CPUInfo struct {
	Percent float64   `json:"percent"`
	PerCore []float64 `json:"per_core,omitempty"`
	Load1   float64   `json:"load1,omitempty"`
	Load5   float64   `json:"load5,omitempty"`
	Load15  float64   `json:"load15,omitempty"`
}

type MemInfo struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Percent     float64 `json:"percent"`
	SwapTotal   uint64  `json:"swap_total"`
	SwapUsed    uint64  `json:"swap_used"`
	SwapPercent float64 `json:"swap_percent"`
}

type DiskInfo struct {
	Mount       string  `json:"mount"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	UsedPercent float64 `json:"used_percent"`
}

type DiskIOInfo struct {
	ReadBps  float64 `json:"read_bps"`
	WriteBps float64 `json:"write_bps"`
}

type NetInfo struct {
	RxBps   float64 `json:"rx_bps"`
	TxBps   float64 `json:"tx_bps"`
	RxBytes uint64  `json:"rx_bytes"`
	TxBytes uint64  `json:"tx_bytes"`
	ErrIn   uint64  `json:"err_in"`
	ErrOut  uint64  `json:"err_out"`
}

type CheckResult struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
	Detail  string `json:"detail,omitempty"`
}

type Session struct {
	User  string `json:"user"`
	State string `json:"state"` // active | disconnected
}

type EventEntry struct {
	Time    string `json:"time"`
	Log     string `json:"log"`
	Level   string `json:"level"`
	Source  string `json:"source"`
	ID      int    `json:"id"`
	Message string `json:"message"`
}

type SmartResult struct {
	Device string `json:"device"`
	Passed bool   `json:"passed"`
}

// LockoutEvent is a Windows Security-log "account locked out" event (ID 4740)
// seen since the previous poll — a delta, not cumulative state, so a rule
// evaluating it clears again once no new lockout has happened.
type LockoutEvent struct {
	Time           string `json:"time"`
	User           string `json:"user"`
	CallerComputer string `json:"caller_computer"`
}

type Snapshot struct {
	Hostname           string         `json:"hostname"`
	IPAddress          string         `json:"ip_address,omitempty"`
	OS                 string         `json:"os"`
	Platform           string         `json:"platform"`
	AgentVersion       string         `json:"agent_version"`
	UptimeSeconds      uint64         `json:"uptime_seconds"`
	BootTime           uint64         `json:"boot_time"`
	CPU                CPUInfo        `json:"cpu"`
	Memory             MemInfo        `json:"memory"`
	Disks              []DiskInfo     `json:"disks"`
	DiskIO             *DiskIOInfo    `json:"disk_io,omitempty"`
	Network            NetInfo        `json:"network"`
	Services           []CheckResult  `json:"services,omitempty"`
	Processes          []CheckResult  `json:"processes,omitempty"`
	Sessions           []Session      `json:"sessions,omitempty"`
	SystemdFailedUnits []string       `json:"systemd_failed_units,omitempty"`
	PendingUpdates     int            `json:"pending_updates"`
	RebootRequired     bool           `json:"reboot_required"`
	EventErrors        []EventEntry   `json:"event_errors,omitempty"`
	Smart              []SmartResult  `json:"smart,omitempty"`
	Lockouts           []LockoutEvent `json:"lockouts,omitempty"`
}

type Collector struct {
	mu      sync.Mutex
	cfg     *config.Config
	version string

	prevNetAt        time.Time
	prevRx           uint64
	prevTx           uint64
	prevDiskAt       time.Time
	prevRead         uint64
	prevWrite        uint64
	lastEvents       time.Time
	cachedEv         []EventEntry
	lastUpdates      time.Time
	cachedUpd        int
	lastSmart        time.Time
	cachedSmart      []SmartResult
	lastLockoutCheck time.Time

	// The Security-log query can run long on a busy DC (observed timing out
	// at 30s+ on every poll) — it must never block the main collection tick
	// the way the throttled System/App query does, or it delays every metric
	// push by however long it takes, which can make the server look
	// intermittently offline. Guarded by lockoutMu, separate from mu (which
	// only guards cfg) so a stuck query can't contend with config reloads.
	lockoutMu      sync.Mutex
	lockoutBusy    bool
	cachedLockouts []LockoutEvent
}

func New(cfg *config.Config, version string) *Collector {
	return &Collector{cfg: cfg, version: version}
}

func (c *Collector) UpdateConfig(cfg *config.Config) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cfg = cfg
}

func (c *Collector) Collect() (*Snapshot, error) {
	c.mu.Lock()
	cfg := c.cfg
	c.mu.Unlock()

	snap := &Snapshot{OS: runtime.GOOS, AgentVersion: c.version}

	if cfg.Hostname != "" {
		snap.Hostname = cfg.Hostname
	} else if hn, err := os.Hostname(); err == nil {
		snap.Hostname = hn
	}
	snap.IPAddress = localIPv4(cfg.BackendURL)

	if info, err := host.Info(); err == nil {
		snap.Platform = strings.TrimSpace(info.Platform + " " + info.PlatformVersion)
		snap.UptimeSeconds = info.Uptime
		snap.BootTime = info.BootTime
	}

	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		snap.CPU.Percent = round1(pcts[0])
	}
	if per, err := cpu.Percent(0, true); err == nil {
		for _, p := range per {
			snap.CPU.PerCore = append(snap.CPU.PerCore, round1(p))
		}
	}
	if avg, err := load.Avg(); err == nil {
		snap.CPU.Load1, snap.CPU.Load5, snap.CPU.Load15 = avg.Load1, avg.Load5, avg.Load15
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		snap.Memory.Total = vm.Total
		snap.Memory.Used = vm.Used
		snap.Memory.Percent = round1(vm.UsedPercent)
	}
	if sw, err := mem.SwapMemory(); err == nil {
		snap.Memory.SwapTotal = sw.Total
		snap.Memory.SwapUsed = sw.Used
		snap.Memory.SwapPercent = round1(sw.UsedPercent)
	}

	if parts, err := disk.Partitions(false); err == nil {
		for _, p := range parts {
			if skipFs(p.Fstype) {
				continue
			}
			u, err := disk.Usage(p.Mountpoint)
			if err != nil || u.Total == 0 {
				continue
			}
			snap.Disks = append(snap.Disks, DiskInfo{
				Mount: p.Mountpoint, Total: u.Total, Used: u.Used, Free: u.Free,
				UsedPercent: round1(u.UsedPercent),
			})
		}
	}

	c.collectNet(snap)
	c.collectDiskIO(snap)
	c.collectProcesses(snap, cfg.Checks.Processes)

	// platform-specific: services, sessions, systemd, updates, event log, reboot flag
	c.collectPlatform(snap, cfg)

	return snap, nil
}

func (c *Collector) collectNet(snap *Snapshot) {
	counters, err := gnet.IOCounters(false)
	if err != nil || len(counters) == 0 {
		return
	}
	now := time.Now()
	io := counters[0]
	snap.Network.RxBytes = io.BytesRecv
	snap.Network.TxBytes = io.BytesSent
	snap.Network.ErrIn = io.Errin
	snap.Network.ErrOut = io.Errout
	if !c.prevNetAt.IsZero() && io.BytesRecv >= c.prevRx && io.BytesSent >= c.prevTx {
		dt := now.Sub(c.prevNetAt).Seconds()
		if dt > 0 {
			snap.Network.RxBps = float64(io.BytesRecv-c.prevRx) / dt
			snap.Network.TxBps = float64(io.BytesSent-c.prevTx) / dt
		}
	}
	c.prevNetAt, c.prevRx, c.prevTx = now, io.BytesRecv, io.BytesSent
}

func (c *Collector) collectDiskIO(snap *Snapshot) {
	counters, err := disk.IOCounters()
	if err != nil {
		return
	}
	var read, write uint64
	for _, io := range counters {
		read += io.ReadBytes
		write += io.WriteBytes
	}
	now := time.Now()
	if !c.prevDiskAt.IsZero() && read >= c.prevRead && write >= c.prevWrite {
		dt := now.Sub(c.prevDiskAt).Seconds()
		if dt > 0 {
			snap.DiskIO = &DiskIOInfo{
				ReadBps:  float64(read-c.prevRead) / dt,
				WriteBps: float64(write-c.prevWrite) / dt,
			}
		}
	}
	c.prevDiskAt, c.prevRead, c.prevWrite = now, read, write
}

func (c *Collector) collectProcesses(snap *Snapshot, watch []string) {
	if len(watch) == 0 {
		return
	}
	running := map[string]bool{}
	procs, err := process.Processes()
	if err == nil {
		for _, p := range procs {
			if name, err := p.Name(); err == nil {
				running[normalizeProcName(name)] = true
			}
		}
	}
	for _, w := range watch {
		snap.Processes = append(snap.Processes, CheckResult{
			Name: w, Running: running[normalizeProcName(w)],
		})
	}
}

func normalizeProcName(n string) string {
	n = strings.ToLower(strings.TrimSpace(n))
	return strings.TrimSuffix(n, ".exe")
}

func skipFs(fstype string) bool {
	switch strings.ToLower(fstype) {
	case "tmpfs", "devtmpfs", "devfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "efivarfs", "iso9660":
		return true
	}
	return false
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}
