// Copies the Bryntum Scheduler trial bundle from node_modules into public/vendor,
// where the page loads it from. The bundle is not committed: a fresh checkout
// gets it from npm install plus this script (npm start and npm run deploy run it).
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "@bryntum", "scheduler");
const dst = join(root, "public", "vendor", "scheduler");

if (!existsSync(join(src, "scheduler.module.js"))) {
  console.log("vendor: @bryntum/scheduler is not installed; the plain schedule board will be used");
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
for (const name of ["scheduler.module.js", "scheduler.css", "stockholm-light.css", "fontawesome"]) {
  cpSync(join(src, name), join(dst, name), { recursive: true });
}
console.log("vendor: Bryntum Scheduler copied to public/vendor/scheduler");
