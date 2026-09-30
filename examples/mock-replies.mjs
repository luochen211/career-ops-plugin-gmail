import fs from 'node:fs';
import { classifyMessage } from '../lib/classify.mjs';

// Synthetic fixtures only: no OAuth, network access, or filesystem writes.
const fixtures = JSON.parse(fs.readFileSync(new URL('./messages.json', import.meta.url), 'utf8'));
const candidates = fixtures.messages.map(message => classifyMessage(message, fixtures.applications)).filter(Boolean);
console.log(JSON.stringify(candidates, null, 2));
