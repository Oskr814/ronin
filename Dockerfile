# syntax=docker/dockerfile:1
# The ronin image (#235, stage 5): the server, the planner and the local
# runner, with every tool its agents and workers call. compose.yml runs it
# next to Postgres, the Tailscale sidecar and its own Docker (DinD).
#   docker compose build
# What it needs at run time:
#   node and pnpm   ronin itself, and the product repos' scripts an agent runs
#   git and gh      worktrees, pushes and the GitHub CLI the agents use
#   claude          Claude Code, for every agent run (`claude -p`)
#   docker          the CLI and its compose and buildx plugins, talking to the
#                   DinD service over TLS: previews, prototypes, reproductions
#   tailscale       only the CLI, for `tailscale serve` through the sidecar's
#                   socket (the dashboard and the previews' public ports)
#   Chromium        Playwright's, for the browser MCP and the screenshots

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# The build: TypeScript into dist/, and the two web apps with Vite.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/dist-aliases.ts ./scripts/
RUN pnpm build

# Only the production dependencies, for the final image.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# The same version as the sidecar's image in compose.yml: its CLI talks to
# that daemon.
FROM tailscale/tailscale:v1.94.1 AS tailscale
FROM docker:29-cli AS docker-cli

FROM base
ARG CLAUDE_CODE_VERSION=2.1.304

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg jq openssh-client procps \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
# Claude Code goes with the image: updating itself inside the container
# half-replaces the global install and leaves `claude` out of the PATH.
ENV DISABLE_AUTOUPDATER=1

# The browsers in the image, not in a volume: they go with ronin's version.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
RUN node_modules/.bin/playwright install --with-deps chromium \
  && node_modules/.bin/playwright-mcp install-browser chrome-for-testing \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY prompts ./prompts
COPY templates ./templates
COPY .env.example repos.json.example ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/ronin-entrypoint

# What ronin writes next to itself (process.cwd()) goes to the data volume:
# the workers' logs and the slot files of an installation without Postgres.
RUN ln -s /data/logs /app/logs && ln -s /data/.ronin-slots /app/.ronin-slots

# RONIN_DOCKER: `ronin init` also asks for the Tailscale sidecar's values.
# IS_SANDBOX: the container runs as root, and Claude Code refuses
# bypassPermissions as root unless told it's in a sandbox — which a
# container with no host socket and its own Docker is.
ENV NODE_ENV=production \
    RONIN_DOCKER=1 \
    IS_SANDBOX=1

ENTRYPOINT ["ronin-entrypoint"]
CMD ["server"]
