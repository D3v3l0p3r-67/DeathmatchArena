/**
 * PM2 process definition.
 *
 * Colyseus Cloud runs its post-deploy hook after `npm run build` and expects to
 * find this file in the project root; without it the deploy fails with
 * "missing ecosystem config file".
 *
 * `.cjs` rather than `.js` on purpose: package.json declares `"type": "module"`,
 * so a plain `.js` file could not use `module.exports`.
 *
 * `instances` is pinned to 1 deliberately. Left unset, the platform defaults it
 * to the host's CPU count, which on a shared-vCPU plan means several Node
 * processes competing for 1 GB of RAM. One process also keeps every room in a
 * single memory space, so matchmaking cannot scatter players who need to meet.
 * Raise this only together with a plan that has the memory for it.
 */
module.exports = {
  apps: [
    {
      name: "deathmatch-arena",
      script: "server/build/index.js",
      instances: 1,
      exec_mode: "fork",
      // `listen()` from @colyseus/tools signals readiness once the port is open.
      wait_ready: true,
      time: true,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
