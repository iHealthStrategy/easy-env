// Hard Node.js version gate, run as an import side effect. Imported FIRST
// by both entrypoints (daemon/start.ts and server.ts) so it fires before any
// dependency that assumes a modern runtime is evaluated.
//
// Why a runtime check and not just package.json "engines": on an end-user
// machine the app spawns the system `node` from PATH and never runs `npm
// install`, so the engines field is never enforced. Without this guard, an
// old Node fails deep inside the code with a cryptic `ReferenceError: fetch
// is not defined` (the daemon relies on the global fetch API, Node 18+).
const MIN_MAJOR = 18;
const major = Number(process.versions.node.split('.')[0]);

if (Number.isFinite(major) && major < MIN_MAJOR) {
  process.stderr.write(
    `[easy-env] Node.js ${MIN_MAJOR}+ is required, but this process is running ${process.version}.\n` +
      `easy-env's daemon uses the global fetch API and other Node ${MIN_MAJOR}+ features. ` +
      `Install Node ${MIN_MAJOR} or newer (LTS 20 / 22 recommended) and make sure it's the \`node\` on your PATH, then retry.\n`,
  );
  process.exit(1);
}
