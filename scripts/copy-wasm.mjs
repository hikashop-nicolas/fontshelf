// Copies HarfBuzz's subsetter wasm (from the harfbuzzjs dev dependency) into dist/ beside instance.js.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = createRequire(import.meta.url).resolve("harfbuzzjs/dist/harfbuzz-subset.wasm");
const pkgDir = dirname(dirname(wasm));
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(wasm, join(root, "dist/harfbuzz-subset.wasm"));
writeFileSync(join(root, "dist/harfbuzz-subset.LICENSE.txt"),
  `harfbuzz-subset.wasm comes from harfbuzzjs ${version} (https://github.com/harfbuzz/harfbuzzjs),\n` +
  `a build of HarfBuzz (https://github.com/harfbuzz/harfbuzz, "Old MIT" license, see its COPYING).\n\n` +
  readFileSync(join(pkgDir, "LICENSE"), "utf8"));
