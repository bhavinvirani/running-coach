# syntax=docker/dockerfile:1
# check=error=true

# The coach service's image, built from the repo root: docker build -f apps/coach/Dockerfile .
# Its own Render service, so Claude Code's 200 to 250 MB process never shares the main service's 512 MB.
# Holds only the coach's production node_modules (the Agent SDK and its native Claude Code binary for
# this platform), the bundled server and nothing else from the repo.

FROM node:24.21.0-trixie-slim AS os
# Claude Code calls Claude over TLS; node:slim ships without the system trust store.
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

# The coach's dependencies from the lockfile and the two manifests it needs, so this layer survives
# every source change. pnpm installs only this platform's Claude Code binary.
FROM pnpm AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/coach/package.json apps/coach/
RUN corepack install && pnpm install --frozen-lockfile --filter @running-coach/coach...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/coach apps/coach
RUN pnpm --filter @running-coach/coach build
# Production node_modules only. --legacy because the workspace does not inject workspace packages; tsup
# bundles shared into dist, so the copy deploy puts in node_modules is never loaded.
RUN pnpm --filter @running-coach/coach --prod deploy --legacy /prod/coach
# Fail the build unless the SDK finds Claude Code's native binary for this platform and it starts.
WORKDIR /prod/coach
RUN DISABLE_AUTOUPDATER=1 node --input-type=module <<'EOF'
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
const sdk = realpathSync(createRequire(`${process.cwd()}/`).resolve("@anthropic-ai/claude-agent-sdk"));
const binary = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`);
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
console.log(`Claude Code ${version} at ${binary}`);
EOF

FROM os AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod/coach/package.json ./
COPY --from=build /prod/coach/node_modules node_modules
COPY --from=build /app/apps/coach/dist dist
# Claude Code writes its config under the node user's home (/home/node); runs keep no session.
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
