/**
 * What the compiler cannot say.
 *
 * The codebase already has a strong, consistent style, but until now it was
 * held entirely by discipline: nothing stopped a shadowed variable, a floating
 * promise or a stray `any` from landing. These rules encode the conventions the
 * code already follows, so the linter mostly agrees with what is there and only
 * speaks up when something drifts.
 *
 * Deliberately *not* type-aware (`projectService`) for the whole tree: that
 * doubles lint time on a workspace this size, and the type errors it would find
 * are already found by `npm run typecheck`. The rules here are the syntactic
 * ones a typechecker does not have an opinion about.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output, dependencies and generated data are nobody's to lint.
    ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "data/**", "client/dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      /*
       * TypeScript already resolves every name against the right lib, and does
       * it far better than a lint rule with a hand-written globals list --
       * `no-undef` here only ever reported `document` and `console` as
       * undefined. Turned off deliberately, not by accident.
       */
      "no-undef": "off",

      /*
       * Shadowing is how a rename goes quietly wrong -- an inner `spawn` in a
       * loop hid an outer one in the thumbnail renderer, and the code still
       * compiled and still worked, which is exactly the sort of thing worth
       * being told about.
       */
      "@typescript-eslint/no-shadow": "error",
      "no-shadow": "off",

      // An unawaited promise in a game loop is a bug that shows up as "nothing
      // happened", minutes later and somewhere else.
      "no-async-promise-executor": "error",

      // Unused code is either a mistake or a leftover; both want removing. The
      // leading-underscore escape hatch matches the existing convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],

      // `any` is allowed only where it is spelled out on purpose.
      "@typescript-eslint/no-explicit-any": "warn",

      "eqeqeq": ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Test and tooling files reach into internals on purpose.
    files: ["tests/**/*.ts", "tools/**/*.{ts,mjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      /*
       * A test that names its local harness `harness` inside a `describe` that
       * also has one is reading perfectly well. Shadowing is a hazard where a
       * long function hides an outer name; in a five-line test body it is just
       * the obvious word for the thing.
       */
      "@typescript-eslint/no-shadow": "off",
    },
  },
);
