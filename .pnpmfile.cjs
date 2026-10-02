// better-auth declares vitest (for its test-utils) and drizzle-kit (for schema generation) as optional
// peers. pnpm links every optional peer the workspace has, so both, with vite, jsdom, rolldown and four
// esbuild builds behind them, ended up in the API's production node_modules. Nothing at runtime imports
// them. react and react-dom stay: the web client imports better-auth/react.
const DROPPED_PEERS = {
  "better-auth": ["vitest", "drizzle-kit"],
};

function readPackage(pkg) {
  for (const peer of DROPPED_PEERS[pkg.name] ?? []) {
    if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
