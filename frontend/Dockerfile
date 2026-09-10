# This Dockerfile expects the build context to be the repo root (see
# docker-compose.yml), so it can also cross-compile the monitoring agent and
# bundle it for the "Add server" one-line install command.

# Stage 1: cross-compile the agent for Linux and Windows, served for install.
# Version is the checked-in agent/VERSION file (semantic, e.g. "1.3"), not a
# build timestamp — bump it (and add a CHANGELOG.md entry) whenever the agent
# changes meaningfully. The backend fetches VERSION + CHANGELOG.md + the
# binaries straight from this container (see backend/src/routes/agent-releases.ts)
# to offer admin-triggered updates to already-installed agents, showing what
# changed. Forgetting to bump VERSION means a changed agent won't be offered
# as an update — that trade-off buys a human-readable "v1.3" instead of an
# opaque timestamp.
FROM golang:1.23-alpine AS agent-build
WORKDIR /agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ .
RUN AGENT_VERSION="$(cat VERSION)" && \
    mkdir -p /out && \
    echo "$AGENT_VERSION" > /out/VERSION && \
    cp CHANGELOG.md /out/CHANGELOG.md && \
    CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags "-s -w -X main.version=$AGENT_VERSION" -o /out/alfred-agent     ./cmd/alfred-agent && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags "-s -w -X main.version=$AGENT_VERSION" -o /out/alfred-agent.exe ./cmd/alfred-agent

# Stage 2: build the React frontend
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ .
RUN npm run build

# Stage 3: nginx runtime, also serves the agent binaries + install scripts
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=agent-build /out/alfred-agent /usr/share/nginx/html/agent/alfred-agent
COPY --from=agent-build /out/alfred-agent.exe /usr/share/nginx/html/agent/alfred-agent.exe
COPY --from=agent-build /out/VERSION /usr/share/nginx/html/agent/VERSION
COPY --from=agent-build /out/CHANGELOG.md /usr/share/nginx/html/agent/CHANGELOG.md
COPY deploy/install-agent-linux.sh /usr/share/nginx/html/agent/install.sh
COPY deploy/install-agent-windows.ps1 /usr/share/nginx/html/agent/install.ps1
COPY deploy/uninstall-agent-linux.sh /usr/share/nginx/html/agent/uninstall.sh
COPY deploy/uninstall-agent-windows.ps1 /usr/share/nginx/html/agent/uninstall.ps1
EXPOSE 80
