// Inlines the two coin SVGs into the showcase page, and mirrors them into
// public/ for the ::coin card on the About page — so the page, the site and
// the source files can never drift apart. Run: node design/coin/build.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (f) => readFileSync(join(here, f), "utf8").trim();

const obverse = read("arisaka-coin-obverse.svg");
const reverse = read("arisaka-coin-reverse.svg");

const html = read("showcase.template.html")
  .replace("<!--OBVERSE-->", obverse)
  .replace("<!--REVERSE-->", reverse);

writeFileSync(join(here, "showcase.html"), html + "\n");
console.log(`showcase.html written — ${(html.length / 1024).toFixed(1)} kB`);

// The site only ever ships the vectors. The GLBs stay out of dist/ on purpose:
// every file in the build is uploaded to Arweave permanently, and three 5.6 MB
// models is not a bill worth paying for a decorative card.
const publicDir = join(repo, "public", "coin");
mkdirSync(publicDir, { recursive: true });
writeFileSync(join(publicDir, "obverse.svg"), `${obverse}\n`);
writeFileSync(join(publicDir, "reverse.svg"), `${reverse}\n`);
console.log(
  `public/coin/*.svg synced — ${((obverse.length + reverse.length) / 1024).toFixed(1)} kB total`,
);
