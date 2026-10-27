// `node --import ./test/tsx-loader.mjs`: registers tsx-hooks.mjs (tests only).
import { register } from "node:module";

register("./tsx-hooks.mjs", import.meta.url);
