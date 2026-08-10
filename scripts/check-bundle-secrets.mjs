#!/usr/bin/env node
/**
 * Acceptance criterion: zero secrets in the client bundle.
 *
 * This greps the built client output for anything that looks like a credential.
 * It runs in CI before deploy, so a key that leaks into the bundle fails the
 * build rather than shipping.
 *
 * Two independent checks:
 *   1. Named secrets — every secret this project uses is listed in SECRET_NAMES.
 *      If the *name* appears in the bundle, a client-side code path is reaching
 *      for it, which means the value would be needed in the browser.
 *   2. Shape heuristics — tokens that look like credentials regardless of name.
 *
 * Usage: node scripts/check-bundle-secrets.mjs [dir]   (default: dist/client)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'dist/client';

/**
 * Secret names used by this project. Add a name here in the same commit that
 * adds the `wrangler secret put` for it — that is what keeps this check honest.
 */
const SECRET_NAMES = [
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'FINNHUB_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
];

/** Credential-shaped strings, independent of any name we know about. */
const SHAPE_PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'assigned api key literal', re: /\b(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
];

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.svg', '.txt', '.webmanifest']);

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = walk(ROOT).filter((f) => TEXT_EXTENSIONS.has(extname(f)));

if (files.length === 0) {
  console.error(`FAIL: no build output found under ${ROOT}. Run \`npm run build\` first.`);
  process.exit(1);
}

const findings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  for (const name of SECRET_NAMES) {
    const index = lines.findIndex((line) => line.includes(name));
    if (index !== -1) {
      findings.push({ file, line: index + 1, what: `secret name "${name}" is referenced in the client bundle` });
    }
  }

  for (const { name, re } of SHAPE_PATTERNS) {
    const index = lines.findIndex((line) => re.test(line));
    if (index !== -1) {
      findings.push({ file, line: index + 1, what: `looks like a ${name}` });
    }
  }
}

if (findings.length > 0) {
  console.error(`FAIL: ${findings.length} potential secret(s) in the client bundle:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.what}`);
  console.error('\nKeys belong in `wrangler secret put` and must only ever be read inside worker/.');
  process.exit(1);
}

console.log(`OK: scanned ${files.length} built file(s) under ${ROOT}; no secrets found.`);
