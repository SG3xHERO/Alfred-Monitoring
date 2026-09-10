package collect

import (
	"net"
	"net/url"
)

// localIPv4 reports the local IPv4 address of the network interface this
// host would use to reach backendURL. Docker's own port-forwarding (and any
// reverse proxy in front of it) can rewrite the address the backend sees on
// its side of the connection — e.g. Docker Desktop's NAT showing every agent
// as the same internal gateway IP — so the agent reports its own view of
// "which of my NICs talks to Alfred" instead of relying on the network layer.
//
// Dialing UDP never actually sends a packet; it only asks the OS to pick a
// route and a source address for it, so this works even if the backend is
// briefly unreachable and needs no real connectivity beyond routing.
func localIPv4(backendURL string) string {
	host := "8.8.8.8" // fallback target just to force a route decision
	if u, err := url.Parse(backendURL); err == nil && u.Hostname() != "" {
		host = u.Hostname()
	}

	conn, err := net.Dial("udp", net.JoinHostPort(host, "80"))
	if err != nil {
		return firstPrivateIPv4()
	}
	defer conn.Close()

	local, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || local.IP == nil || local.IP.IsUnspecified() {
		return firstPrivateIPv4()
	}
	if v4 := local.IP.To4(); v4 != nil {
		return v4.String()
	}
	return firstPrivateIPv4()
}

// firstPrivateIPv4 is the fallback when routing to the backend can't be
// resolved (e.g. it's offline right now) — picks the first non-loopback
// IPv4 address on an interface that's actually up.
func firstPrivateIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.IsLoopback() {
				continue
			}
			v4 := ipNet.IP.To4()
			if v4 == nil || v4.IsLinkLocalUnicast() {
				continue
			}
			return v4.String()
		}
	}
	return ""
}
