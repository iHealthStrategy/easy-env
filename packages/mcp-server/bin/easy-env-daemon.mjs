#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(here, '..', 'dist', 'src', 'daemon', 'start.js');
const child = spawn(process.execPath, [daemonEntry], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
