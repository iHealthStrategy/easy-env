#!/usr/bin/env node
// Copy the easy-env skill bundled with this package into the user's
// ~/.claude/skills directory so Claude Code can load it. Idempotent:
// overwrites the destination if it exists.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(here, '..', 'skills');

const targetDir = process.env.CLAUDE_SKILLS_DIR
  ?? path.join(os.homedir(), '.claude', 'skills');

if (!fs.existsSync(sourceDir)) {
  console.error(`Skill source dir not found: ${sourceDir}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
let copied = 0;
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
  const src = path.join(sourceDir, entry.name);
  const dst = path.join(targetDir, entry.name);
  fs.copyFileSync(src, dst);
  console.log(`installed: ${dst}`);
  copied += 1;
}

if (copied === 0) {
  console.error(`No skills found in ${sourceDir}`);
  process.exit(1);
}

console.log(`\nDone. ${copied} skill(s) installed to ${targetDir}.`);
console.log('Restart Claude Code (or run /skills reload) to pick them up.');
