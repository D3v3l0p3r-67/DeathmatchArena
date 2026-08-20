/**
 * Production build for the Colyseus server.
 *
 * The server is bundled with esbuild rather than emitted file-by-file by tsc so
 * that `@deathmatch/shared` (a TypeScript-source workspace package) is inlined into
 * the output. The result is a single `build/index.js` that only needs the runtime
 * dependencies from package.json -- which is exactly what Colyseus Cloud expects.
 */
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8"));

const WORKSPACE_PACKAGES = new Set(["@deathmatch/shared"]);

/** Keep node_modules external, but bundle workspace sources into the output. */
const externalizeNodeModules = {
  name: "externalize-node-modules",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      const isRelative = args.path.startsWith(".") || path.isAbsolute(args.path);
      if (isRelative || WORKSPACE_PACKAGES.has(args.path)) return null;
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      return { path: args.path, external: true };
    });
  },
};

await build({
  absWorkingDir: serverRoot,
  entryPoints: ["src/index.ts"],
  outfile: "build/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  plugins: [externalizeNodeModules],
  define: {
    "process.env.APP_VERSION": JSON.stringify(packageJson.version),
  },
  // Some transitive dependencies still use CommonJS `require`; provide a shim.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
