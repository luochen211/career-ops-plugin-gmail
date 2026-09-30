import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await import('./smoke.mjs');
const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const suites = fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort();
for (const suite of suites) {
  console.log(`\n${path.basename(suite)}`);
  await import(new URL(`../tests/${suite}`, import.meta.url));
}
console.log(`\nPassed ${suites.length} offline suites and plugin smoke check.`);
