package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/kardianos/service"

	"github.com/sg3xhero/alfred/agent/internal/collect"
	"github.com/sg3xhero/alfred/agent/internal/config"
	"github.com/sg3xhero/alfred/agent/internal/send"
	"github.com/sg3xhero/alfred/agent/internal/update"
)

// maxLogBytes bounds agent.log so a quiet failure mode (e.g. a check erroring
// every poll) can't fill the disk; it's a debug aid, not an audit trail.
const maxLogBytes = 10 * 1024 * 1024

// setupLogging routes the standard "log" package to a file next to the
// config, since a Windows service has no console — log.Printf output would
// otherwise vanish into nothing, which is exactly what made a real Security
// log permissions problem indistinguishable from "no lockouts happened".
// Falls back to the default (stderr) if the file can't be opened, which is
// fine for interactive/dev runs.
func setupLogging(cfgPath string) {
	path := filepath.Join(filepath.Dir(cfgPath), "agent.log")
	if info, err := os.Stat(path); err == nil && info.Size() > maxLogBytes {
		_ = os.Rename(path, path+".old")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	log.SetOutput(f)
}

// version is overridden at build time via -ldflags "-X main.version=<v>"
// (see deploy/build-agents.ps1) so a running agent reports its real build.
var version = "dev"

type program struct {
	cfgPath string
	stop    chan struct{}
	done    chan struct{}
}

func (p *program) Start(s service.Service) error {
	p.stop = make(chan struct{})
	p.done = make(chan struct{})
	go p.run()
	return nil
}

func (p *program) Stop(s service.Service) error {
	close(p.stop)
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
	}
	return nil
}

func (p *program) run() {
	defer close(p.done)

	cfg, err := config.Load(p.cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("alfred-agent %s starting, backend=%s interval=%ds", version, cfg.BackendURL, cfg.IntervalSeconds)
	update.CleanupStale() // remove a leftover .old binary from a prior update, if any

	collector := collect.New(cfg, version)
	sender := send.New(cfg)
	cfgMtime := config.Mtime(p.cfgPath)

	ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
	defer ticker.Stop()

	// send one immediately on start
	p.tick(collector, sender)

	for {
		select {
		case <-p.stop:
			log.Println("alfred-agent stopping")
			return
		case <-ticker.C:
			// hot-reload config when the file changes on disk
			if m := config.Mtime(p.cfgPath); m.After(cfgMtime) {
				if newCfg, err := config.Load(p.cfgPath); err == nil {
					cfg = newCfg
					cfgMtime = m
					collector.UpdateConfig(cfg)
					sender.UpdateConfig(cfg)
					ticker.Reset(time.Duration(cfg.IntervalSeconds) * time.Second)
					log.Printf("config reloaded, interval=%ds", cfg.IntervalSeconds)
				} else {
					log.Printf("config reload failed, keeping previous: %v", err)
				}
			}
			p.tick(collector, sender)
		}
	}
}

func (p *program) tick(collector *collect.Collector, sender *send.Sender) {
	snap, err := collector.Collect()
	if err != nil {
		log.Printf("collect: %v", err)
		return
	}
	resp, err := sender.Push(snap)
	if err != nil {
		log.Printf("push: %v", err)
		return
	}
	if resp == nil {
		return
	}
	if resp.PendingSnapshot != nil {
		if sender.Config().Checks.SqlMonitoring {
			// fire-and-forget: must not block the next tick's push
			go runSqlSnapshot(sender, resp.PendingSnapshot.ID)
		} else {
			log.Printf("sql snapshot requested but sql_monitoring is disabled in config — ignoring")
			if err := sender.PushSnapshot(resp.PendingSnapshot.ID, nil,
				fmt.Errorf("sql_monitoring is disabled in this agent's config")); err != nil {
				log.Printf("sql snapshot push: %v", err)
			}
		}
	}
	if resp.Update != nil && atomic.CompareAndSwapInt32(&updating, 0, 1) {
		// guarded so an update that's still downloading on a slow link
		// doesn't get re-triggered by the next tick's ingest response
		go runUpdate(sender, resp.Update)
	}
	if resp.Config != nil {
		changed, err := config.ApplyPushed(p.cfgPath, sender.Config(),
			resp.Config.LockoutMonitoring, resp.Config.SqlMonitoring, resp.Config.SignedInUsersPanel)
		if err != nil {
			log.Printf("config push: %v", err)
		} else if changed {
			log.Printf("config push: applied a remote config change, will hot-reload next tick")
		}
	}
}

func runSqlSnapshot(sender *send.Sender, id int) {
	snap, err := collect.CaptureSqlSnapshot(30 * time.Second)
	if err != nil {
		log.Printf("sql snapshot capture: %v", err)
	}
	if err := sender.PushSnapshot(id, snap, err); err != nil {
		log.Printf("sql snapshot push: %v", err)
	}
}

var updating int32

func runUpdate(sender *send.Sender, u *send.PendingUpdate) {
	defer atomic.StoreInt32(&updating, 0)
	log.Printf("applying agent update to version %s", u.Version)
	applyErr := update.Apply(sender.Config(), u.URL, u.SHA256)
	if pushErr := sender.PushUpdateResult(applyErr == nil, applyErr); pushErr != nil {
		log.Printf("update result push: %v", pushErr)
	}
	if applyErr != nil {
		log.Printf("agent update failed: %v", applyErr)
		return
	}
	log.Println("update applied, exiting so the service manager restarts into the new binary")
	os.Exit(0)
}

func main() {
	cfgPath := flag.String("config", config.DefaultPath(), "path to config file")
	svcCmd := flag.String("service", "", "control the system service: install | uninstall | start | stop")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	svcConfig := &service.Config{
		Name:        "alfred-agent",
		DisplayName: "Alfred Monitoring Agent",
		Description: "Pushes host metrics and heartbeats to the Alfred monitoring backend.",
		Arguments:   []string{"-config", *cfgPath},
	}

	prg := &program{cfgPath: *cfgPath}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatal(err)
	}

	if *svcCmd != "" {
		if err := service.Control(s, *svcCmd); err != nil {
			log.Fatalf("service %s: %v", *svcCmd, err)
		}
		fmt.Printf("service %s: ok\n", *svcCmd)
		return
	}

	setupLogging(*cfgPath)
	if err := s.Run(); err != nil {
		log.Fatal(err)
	}
	_ = os.Stdout.Sync()
}
