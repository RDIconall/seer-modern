import { register } from "node:module";

// Test-only loader. Matters and the deep read import the model SDK; the
// close route imports the session helper. Both are redirected before any
// application module loads. The stand-ins live next to this file.
register("./public-suffix-matter-loader.mjs", import.meta.url);
