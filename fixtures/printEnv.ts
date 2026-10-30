/** Prints SOURCES_JSON for the deployed fixtures: `npm run fixtures:env >> .env` */
import { readFileSync } from "node:fs";
import { fixtureSources } from "./sources.js";
const d = JSON.parse(readFileSync(new URL("./deployed.json", import.meta.url), "utf8"));
console.log(`SOURCES_JSON=${JSON.stringify(fixtureSources(d.token, d.staking))}`);
