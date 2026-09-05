# syntax=docker/dockerfile:1.7
# ────────────────────────────────────────────────────────────────────────────
# Single stage — this repo has no build step (no scripts/build.ts, no client
# bundle, no Tailwind): the server renders plain HTML strings and the only
# browser dependency (Leaflet) is loaded from a CDN in the page itself.
# Do not add a `bun run build` stage or COPY a dist/ that does not exist.
#
# Runs on the HF Ville box as the container `truck` (docs/CONTRACTS.md §0/§11).
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine

# The pushed commit, baked in by CI (build-arg GIT_SHA). /healthz echoes it
# verbatim and scripts/verify-live.sh compares it to the sha that was built —
# that comparison is the whole definition of "the deploy is live".
ARG GIT_SHA=unknown

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4100 \
    DATA_DIR=/data \
    GIT_SHA=${GIT_SHA}

LABEL org.opencontainers.image.title="linen-truck" \
      org.opencontainers.image.description="Linen truck GPS audit: stops, trips, detours, outside-hours runs" \
      org.opencontainers.image.source="https://github.com/thehfhotel/linen-truck" \
      org.opencontainers.image.revision=${GIT_SHA} \
      org.opencontainers.image.vendor="The HF Hotel"

# bun:sqlite is built in — production deps only (elysia).
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY tsconfig.json ./
# Copies ALL of src/ (server + domain + shared), not a subset: a new top-level
# src/ directory needs no change here, but a runtime import from OUTSIDE src/,
# scripts/ or config/ does.
COPY src ./src
# scripts/import.ts and scripts/backup.ts are run with `docker exec truck bun
# scripts/<x>.ts`; the in-process nightly backup calls the same code.
COPY scripts ./scripts
# config/sites.json and config/rules.json are checked-in tuning, not data — they
# must ship in the image or the domain layer has no sites/rules to segment
# against on a fresh container. src/server/siteConfig.ts reads them RELATIVE TO
# THE WORKING DIRECTORY, so /app must stay the cwd (see CMD below).
COPY config ./config

# The SinoTrack poller's SQLite DB and its nightly VACUUM INTO backups both live
# on the mounted volume, which on the box is the bind mount ./data (owned by the
# deploying user, uid 1000 — same uid as `bun` below).
# /app/data exists only for the LOCAL docker-compose.yml (which points DATA_DIR
# there so it can run outside production without touching the /data volume).
RUN mkdir -p /data/backups /app/data && chown -R bun:bun /data /app/data
VOLUME ["/data"]

# Non-root at runtime (Trivy config scan in .github/workflows/security.yml
# fails the build on a root-only image). If the host bind mount is not writable
# by uid 1000 the container crash-loops at boot, the deploy shim's healthz loop
# times out and the deploy goes red — loudly, never silently.
USER bun

EXPOSE 4100

# /healthz is database-free by design (docs/CONTRACTS.md §0/§7) so this stays
# fast even while SQLite is busy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["bun", "src/server/server.ts"]
