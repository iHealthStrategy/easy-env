#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '..', 'dist', 'src', 'server.js');
const child = spawn(process.execPath, [serverEntry], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
