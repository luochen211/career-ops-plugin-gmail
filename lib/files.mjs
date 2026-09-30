import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('gmail: expected a regular local file');
}

export function privateDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('gmail: refusing a symlinked local directory');
    return;
  }
  const parent = path.dirname(directory);
  if (parent !== directory) privateDirectory(parent);
  fs.mkdirSync(directory, { mode: 0o700 });
}

export function readJson(filename) {
  regularFile(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); }
  finally { fs.closeSync(fd); }
}

export function atomicJson(filename, value) {
  privateDirectory(path.dirname(filename));
  if (fs.existsSync(filename)) regularFile(filename);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
