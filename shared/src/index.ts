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

// Game model
export * from "./game/constants.js";
export * from "./game/types.js";
export * from "./game/arena.js";
export * from "./game/weapons.js";
export * from "./game/CollisionWorld.js";
export * from "./game/physics.js";

// Networking contract
export * from "./net/messages.js";
export * from "./net/stateContract.js";
export * from "./net/inputCodec.js";
export * from "./net/validation.js";
export * from "./net/RateLimiter.js";
