/**
 * `@deathmatch/shared` -- the contract between client and server.
 *
 * Holds gameplay constants, the deterministic movement simulation, arena data,
 * weapon definitions, network message names and validation helpers. Both packages
 * import from here, so a tuning change can never desynchronise client prediction
 * from the authoritative server simulation.
 */

// Core utilities
export * from "./core/math.js";
export * from "./core/geometry.js";

// Configuration (data an administration interface will eventually own)
export * from "./config/types.js";
export * from "./config/defaults.js";
export * from "./config/registry.js";

// Game model
export * from "./game/constants.js";
export * from "./game/types.js";
export * from "./game/arena.js";
export * from "./game/weapons.js";
export * from "./game/powerups.js";
export * from "./game/CollisionWorld.js";
export * from "./game/physics.js";

// Debug protocol (authorization is enforced server-side)
export * from "./debug/types.js";

// Networking contract
export * from "./net/messages.js";
export * from "./net/stateContract.js";
export * from "./net/inputCodec.js";
export * from "./net/validation.js";
export * from "./net/RateLimiter.js";
