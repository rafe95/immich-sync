/**
 * Bun plugin so `bun test` can import Svelte components and `.svelte.ts` rune modules.
 * - `.svelte` is compiled with svelte/compiler for the browser (client output).
 * - `.svelte.ts` is transpiled to JS, then run through compileModule (runes outside components).
 * - `svelte`, `svelte/store` and `svelte/reactivity` resolve to their client builds (their "browser"
 *   export condition), so mount() exists; Bun would otherwise pick the server builds.
 * It affects nothing else, so core/ and backend/ tests are unaffected.
 */
import { plugin } from "bun";
import { compile, compileModule } from "svelte/compiler";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(import.meta.dir, "../package.json"));
const svelteDir = dirname(require.resolve("svelte/package.json"));
// @zag-js/svelte (used by Skeleton) only exports a "svelte" condition, which Bun's resolver does not use.
const skeletonRequire = createRequire(require.resolve("@skeletonlabs/skeleton-svelte/package.json"));
const zagSvelte = join(dirname(skeletonRequire.resolve("@zag-js/svelte/package.json")), "dist/index.js");
const transpiler = new Bun.Transpiler({ loader: "ts" });

const CLIENT: Record<string, string> = {
  svelte: "src/index-client.js",
  "svelte/store": "src/store/index-client.js",
  "svelte/reactivity": "src/reactivity/index-client.js",
};

plugin({
  name: "svelte",
  setup(build) {
    // Bare specifiers are not routed through onResolve under `bun test`, so register virtual modules instead.
    for (const [name, rel] of Object.entries(CLIENT)) {
      build.module(name, async () => ({ exports: await import(join(svelteDir, rel)), loader: "object" }));
    }
    build.module("@zag-js/svelte", async () => ({ exports: await import(zagSvelte), loader: "object" }));
    // Rune modules shipped as plain JS by Svelte libraries (Skeleton).
    build.onLoad({ filter: /\.svelte\.js$/ }, (args) => {
      const out = compileModule(readFileSync(args.path, "utf8"), { filename: args.path, generate: "client", dev: false });
      return { contents: out.js.code, loader: "js" };
    });
    build.onLoad({ filter: /\.svelte$/ }, (args) => {
      // Components only use lang="ts" with erasable syntax, which Svelte strips itself (no preprocessor needed).
      const out = compile(readFileSync(args.path, "utf8"), { filename: args.path, generate: "client", dev: false, css: "external" });
      return { contents: out.js.code, loader: "js" };
    });
    build.onLoad({ filter: /\.svelte\.ts$/ }, (args) => {
      const js = transpiler.transformSync(readFileSync(args.path, "utf8"));
      const out = compileModule(js, { filename: args.path, generate: "client", dev: false });
      return { contents: out.js.code, loader: "js" };
    });
  },
});
