import { defineConfig } from "tsup";

// Next, React and the core are installed beside this package; never bundle them.
const external = ["next", "next/headers", "react", "react/jsx-runtime", "@zwingd-ce/website-kit"];

export default defineConfig([
  {
    entry: ["src/index.ts", "src/server.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    external,
  },
  {
    // The client entry is its own build so its "use client" banner survives bundling.
    entry: ["src/client.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    external,
    banner: { js: '"use client";' },
  },
]);
