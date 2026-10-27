import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // The core is a dependency, installed beside this package; never bundle it.
  external: ["@zwingd-ce/website-kit"],
});
