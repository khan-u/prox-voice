import { defineConfig } from "vitest/config";

// Only the pure-logic helpers are unit-tested; the modules that touch WebRTC or
// the DOM keep their side effects behind those helpers, so the suite runs in a
// plain node environment with no browser shims.
export default defineConfig({
  test: {
    include: ["voice/**/*.test.ts"],
    environment: "node",
  },
});
