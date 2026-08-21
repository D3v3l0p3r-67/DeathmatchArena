import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NAME_RULES,
  createInputCommand,
  decodeInput,
  decodeInputBatch,
  encodeInput,
  encodeInputBatch,
  angleDelta,
  makeNameUnique,
  normalizeAngle,
  validatePlayerName,
  RateLimiter,
} from "@deathmatch/shared";

describe("input codec", () => {
  it("round-trips every button combination", () => {
    for (let bits = 0; bits < 32; bits++) {
      const input = createInputCommand(bits + 1);
      input.moveLeft = (bits & 1) !== 0;
      input.moveRight = (bits & 2) !== 0;
      input.jump = (bits & 4) !== 0;
      input.fire = (bits & 8) !== 0;
      input.reload = (bits & 16) !== 0;
      input.aimAngle = normalizeAngle(bits * 0.2 - Math.PI);

      const decoded = decodeInput(encodeInput(input));
      assert.ok(decoded, "decode should succeed");
      assert.equal(decoded.seq, input.seq);
      assert.equal(decoded.moveLeft, input.moveLeft);
      assert.equal(decoded.moveRight, input.moveRight);
      assert.equal(decoded.jump, input.jump);
      assert.equal(decoded.fire, input.fire);
      assert.equal(decoded.reload, input.reload);
      // Compare angular distance, so the wrap-around at +/-PI is not a false failure.
      assert.ok(
        Math.abs(angleDelta(input.aimAngle, decoded.aimAngle)) < 0.002,
        "aim angle within quantisation error",
      );
    }
  });

  it("rejects malformed payloads rather than coercing them", () => {
    assert.equal(decodeInput(null), null);
    assert.equal(decodeInput([1, 2]), null);
    assert.equal(decodeInput([1, 2, 3, 4]), null);
    assert.equal(decodeInput(["1", 2, 3]), null);
    assert.equal(decodeInput([-1, 0, 0]), null, "negative sequence");
    assert.equal(decodeInput([1.5, 0, 0]), null, "fractional sequence");
    assert.equal(decodeInput([1, 999, 0]), null, "bitmask out of range");
    assert.equal(decodeInput([1, 0, 1e9]), null, "angle out of range");
    assert.equal(decodeInput([1, 0, Number.NaN]), null, "NaN angle");
  });

  it("caps batch size and drops malformed entries", () => {
    const inputs = Array.from({ length: 50 }, (_, i) => createInputCommand(i + 1));
    const batch = encodeInputBatch(inputs);
    assert.ok(batch.length <= 8, "batch must respect MAX_INPUTS_PER_MESSAGE");
    // The newest commands are the ones that matter, so the tail is kept.
    assert.equal(batch.at(-1)![0], 50);

    assert.equal(decodeInputBatch("nope"), null);
    assert.equal(decodeInputBatch([]), null);
    assert.equal(decodeInputBatch(new Array(20).fill([1, 0, 0])), null, "oversized batch");
    assert.equal(decodeInputBatch([[1, 0, 0], "garbage"])?.length, 1, "valid entries survive");
  });
});

describe("name validation", () => {
  it("accepts ordinary names", () => {
    for (const name of ["Ana", "player_1", "Big Bird", "x-9"]) {
      const result = validatePlayerName(name);
      assert.equal(result.valid, true, `${name} should be valid`);
      assert.equal(result.name, name);
    }
  });

  it("rejects empty, short, long and unsafe names but always returns a usable fallback", () => {
    const cases: unknown[] = [
      "",
      "   ",
      "a",
      "x".repeat(NAME_RULES.MAX_LENGTH + 1),
      "<script>",
      "bad$name",
      "naive\u00e9",
      42,
      null,
      undefined,
    ];

    for (const raw of cases) {
      const result = validatePlayerName(raw, "abc123");
      assert.equal(result.valid, false, `${String(raw)} should be rejected`);
      assert.ok(result.name.length >= NAME_RULES.MIN_LENGTH, "fallback name must be usable");
      assert.ok(result.reason, "rejection should explain itself");
    }
  });

  it("strips control characters and collapses whitespace", () => {
    assert.equal(validatePlayerName("  Big    Bird  ").name, "Big Bird");
    // Control characters are removed outright rather than rejected.
    assert.equal(validatePlayerName("tab\tname").name, "tabname");
    assert.equal(validatePlayerName("null\u0000byte").name, "nullbyte");
  });

  it("disambiguates duplicate names", () => {
    assert.equal(makeNameUnique("Ana", ["Bob"]), "Ana");
    assert.equal(makeNameUnique("Ana", ["ana"]), "Ana(2)");
    assert.equal(makeNameUnique("Ana", ["Ana", "Ana(2)"]), "Ana(3)");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window and then drops", () => {
    const limiter = new RateLimiter({ maxEvents: 3, windowMs: 1000 });

    assert.equal(limiter.tryConsume(0), true);
    assert.equal(limiter.tryConsume(10), true);
    assert.equal(limiter.tryConsume(20), true);
    assert.equal(limiter.tryConsume(30), false);
    assert.equal(limiter.dropped, 1);

    // New window: the budget resets.
    assert.equal(limiter.tryConsume(1100), true);
  });
});
