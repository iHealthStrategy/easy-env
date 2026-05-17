#!/usr/bin/env node
// Install the bundled easy-env skill into the user's Claude Code skills
// directory. Claude Code's current skill format is one DIRECTORY per skill,
// containing a SKILL.md file:
//
//   ~/.claude/skills/<skill-name>/SKILL.md
//
// (Previous versions allowed a loose <skill-name>.md at the root of skills/
// but the current loader ignores those, so this installer creates the
// directory layout and also cleans up any stale loose file from older runs.)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(here, '..', 'skills');

const targetRoot = process.env.CLAUDE_SKILLS_DIR
  ?? path.join(os.homedir(), '.claude', 'skills');

if (!fs.existsSync(sourceDir)) {
  console.error(`Skill source dir not found: ${sourceDir}`);
  process.exit(1);
}

fs.mkdirSync(targetRoot, { recursive: true });

const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
let copied = 0;
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

  const skillName = entry.name.replace(/\.md$/, '');
  const src = path.join(sourceDir, entry.name);
  const dstDir = path.join(targetRoot, skillName);
  const dst = path.join(dstDir, 'SKILL.md');

  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`installed: ${dst}`);
  copied += 1;

  // Clean up legacy loose .md left over from older installer versions.
  const legacy = path.join(targetRoot, entry.name);
  if (fs.existsSync(legacy)) {
    try {
      fs.rmSync(legacy);
      console.log(`removed legacy: ${legacy}`);
    } catch {
      // non-fatal
    }
  }
}

if (copied === 0) {
  console.error(`No skills found in ${sourceDir}`);
  process.exit(1);
}

console.log(`\nDone. ${copied} skill(s) installed to ${targetRoot}.`);
console.log('Restart Claude Code (or run /skills reload) to pick them up.');
