# syntax=docker/dockerfile:1
# check=error=true;skip=SecretsUsedInArgOrEnv
# The one skipped check flags ARG VITE_MAPBOX_TOKEN: a public pk. token that ships inside the web bundle anyway.

# One image for Render: the API serves the SPA, runs the worker and spawns the Garmin service on 127.0.0.1.
# Final layout under /app mirrors the repo so the API finds its paths the same way in dev and production.

FROM ghcr.io/astral-sh/uv:0.12.22 AS uv

FROM node:24.21.0-trixie-slim AS os
# Python's ssl module reads the system trust store; node:slim ships without one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm at the exact packageManager version, through corepack.
FROM os AS pnpm
ENV CI=true \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH
RUN corepack enable pnpm
WORKDIR /app

# Dependencies from the lockfile alone, so this layer survives every source change.
FROM pnpm AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack install && pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

FROM deps AS build
# Render passes service env vars as build args; Vite inlines VITE_* into the bundle.
ARG VITE_MAPBOX_TOKEN=""
RUN pnpm build

# Production node_modules for the API only. --legacy because the workspace does not inject workspace
# packages; tsup bundles them into dist, so the copies deploy puts in node_modules are never loaded.
FROM deps AS api-prod
RUN pnpm --filter @running-coach/api --prod deploy --legacy /prod/api

# Python 3.12 managed by uv in a fixed path, so the venv's interpreter link resolves in the final stage.
FROM os AS python
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python \
  UV_COMPILE_BYTECODE=1 \
  UV_LINK_MODE=copy \
  UV_NO_CACHE=1
WORKDIR /app/services/garmin
COPY services/garmin/.python-version services/garmin/pyproject.toml services/garmin/uv.lock ./
RUN uv python install && uv sync --frozen --no-dev

FROM os AS runtime
ENV NODE_ENV=production \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=python /opt/python /opt/python
COPY --from=python /app/services/garmin/.venv services/garmin/.venv
COPY services/garmin/pyproject.toml services/garmin/
COPY services/garmin/garmin_service services/garmin/garmin_service
COPY --from=api-prod /prod/api/package.json apps/api/
COPY --from=api-prod /prod/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/src/db/migrations apps/api/src/db/migrations
COPY apps/api/src/coach/prompts apps/api/src/coach/prompts
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
CMD ["node", "apps/api/dist/index.js"]
