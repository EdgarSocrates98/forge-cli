import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PORTABLE_DISTRIBUTION_PACK_SCHEMA } from './contracts.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const MAX_PACK_BYTES = 64 * 1024 * 1024;
const SAFE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export interface PortablePackManifest {
  schema: typeof PORTABLE_DISTRIBUTION_PACK_SCHEMA;
  package: string;
  version: string;
  created_at: string;
  node: string;
  files: { path: string; bytes: number; sha256: string }[];
  limitations: string[];
}

export interface PackFile {
  path: string;
  bytes: Uint8Array;
}
export interface PackResult {
  manifest: PortablePackManifest;
  archive: string;
  bytes: number;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}
function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function safePath(value: string): boolean {
  return (
    SAFE.test(value) &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value)
  );
}

function packageIdentity(root: string): { name: string; version: string } {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof packageJson.name === 'string' && typeof packageJson.version === 'string')
      return { name: packageJson.name, version: packageJson.version };
  } catch {
    /* a source checkout may be incomplete; use deterministic fallback */
  }
  return { name: 'theforge-cli', version: 'unknown' };
}

function filesFor(root: string): PackFile[] {
  const candidates = [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'dist/index.js',
    'bin/forge-cli.js',
    'bin/forge-cli.cmd',
    'bin/forge-cli.sh',
  ];
  return candidates.flatMap((relative) => {
    const file = path.join(root, relative);
    if (!existsSync(file) || !statSync(file).isFile()) return [];
    return [{ path: relative, bytes: new Uint8Array(readFileSync(file)) }];
  });
}

function zip(files: PackFile[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = Buffer.from(file.bytes);
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(LOCAL),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    chunks.push(header, data);
    const entry = Buffer.concat([
      u32(CENTRAL),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    central.push(entry);
    offset += header.length + data.length;
  }
  const centralBytes = central.reduce((total, item) => total + item.length, 0);
  const end = Buffer.concat([
    u32(END),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes),
    u32(offset),
    u16(0),
  ]);
  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

function parseZip(data: Uint8Array): PackFile[] {
  if (data.length > MAX_PACK_BYTES) throw new Error('FORGE-PACK-TOO-LARGE');
  const buffer = Buffer.from(data);
  const out: PackFile[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === LOCAL) {
    if (offset + 30 > buffer.length) throw new Error('FORGE-PACK-TRUNCATED');
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const uncompressed = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    if (flags !== 0 || method !== 0 || compressed !== uncompressed)
      throw new Error('FORGE-PACK-UNSUPPORTED-COMPRESSION');
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString('utf8');
    if (!safePath(name) || out.some((file) => file.path === name))
      throw new Error(`FORGE-PACK-UNSAFE-PATH: ${name}`);
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + uncompressed;
    if (dataEnd > buffer.length) throw new Error('FORGE-PACK-TRUNCATED');
    const payload = buffer.subarray(dataStart, dataEnd);
    if (crc32(payload) !== buffer.readUInt32LE(offset + 14))
      throw new Error(`FORGE-PACK-CORRUPT: ${name}`);
    out.push({ path: name, bytes: new Uint8Array(payload) });
    offset = dataEnd;
  }
  if (!out.length) throw new Error('FORGE-PACK-NO-FILES');
  return out;
}

export function createPortablePack(
  root: string,
  archive: string,
  now = new Date().toISOString(),
): PackResult {
  const files = filesFor(root);
  if (!files.some((file) => file.path === 'dist/index.js'))
    throw new Error('FORGE-PACK-BUILD-MISSING: dist/index.js');
  const identity = packageIdentity(root);
  const manifest: PortablePackManifest = {
    schema: PORTABLE_DISTRIBUTION_PACK_SCHEMA,
    package: identity.name,
    version: identity.version,
    created_at: now,
    node: process.version,
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
    limitations: [
      'ZIP usa entradas sem compressão para verificação independente; nenhum script é executado durante import.',
    ],
  };
  const all = [
    ...files,
    {
      path: 'portable-manifest.json',
      bytes: new Uint8Array(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')),
    },
  ];
  const archiveBytes = zip(all);
  mkdirSync(path.dirname(path.resolve(archive)), { recursive: true });
  writeFileSync(archive, archiveBytes);
  return { manifest, archive: path.resolve(archive), bytes: archiveBytes.length };
}

export function inspectPortablePack(archive: string): {
  manifest: PortablePackManifest;
  files: string[];
  bytes: number;
} {
  const parsed = parseZip(new Uint8Array(readFileSync(archive)));
  const entry = parsed.find((file) => file.path === 'portable-manifest.json');
  if (!entry) throw new Error('FORGE-PACK-MANIFEST-MISSING');
  const manifest = JSON.parse(Buffer.from(entry.bytes).toString('utf8')) as PortablePackManifest;
  if (manifest.schema !== PORTABLE_DISTRIBUTION_PACK_SCHEMA || !Array.isArray(manifest.files))
    throw new Error('FORGE-PACK-MANIFEST-INVALID');
  return { manifest, files: parsed.map((file) => file.path).sort(), bytes: statSync(archive).size };
}

export function verifyPortablePack(archive: string): {
  ok: boolean;
  errors: string[];
  manifest: PortablePackManifest | null;
} {
  try {
    const parsed = parseZip(new Uint8Array(readFileSync(archive)));
    const entry = parsed.find((file) => file.path === 'portable-manifest.json');
    if (!entry) return { ok: false, errors: ['portable-manifest.json'], manifest: null };
    const manifest = JSON.parse(Buffer.from(entry.bytes).toString('utf8')) as PortablePackManifest;
    const errors: string[] = [];
    for (const expected of manifest.files ?? []) {
      const actual = parsed.find((file) => file.path === expected.path);
      if (!actual) errors.push(`${expected.path}:missing`);
      else if (
        actual.bytes.length !== expected.bytes ||
        createHash('sha256').update(actual.bytes).digest('hex') !== expected.sha256
      )
        errors.push(`${expected.path}:checksum`);
    }
    return {
      ok: manifest.schema === PORTABLE_DISTRIBUTION_PACK_SCHEMA && errors.length === 0,
      errors,
      manifest,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      manifest: null,
    };
  }
}

export function importPortablePack(
  archive: string,
  destination: string,
): { files: string[]; destination: string } {
  const verification = verifyPortablePack(archive);
  if (!verification.ok)
    throw new Error(`FORGE-PACK-VERIFY-FAILED: ${verification.errors.join(', ')}`);
  const parsed = parseZip(new Uint8Array(readFileSync(archive)));
  const root = path.resolve(destination);
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) throw new Error('FORGE-PACK-DESTINATION-SYMLINK');
    if (readdirSync(root).length) throw new Error('FORGE-PACK-DESTINATION-NOT-EMPTY');
  }
  const parent = path.dirname(root);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(path.join(parent, '.forge-pack-stage-'));
  const written: string[] = [];
  try {
    for (const entry of parsed) {
      const target = path.resolve(stage, ...entry.path.split('/'));
      if (!target.startsWith(`${stage}${path.sep}`))
        throw new Error(`FORGE-PACK-PATH-ESCAPE: ${entry.path}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.bytes, { flag: 'wx' });
      written.push(entry.path);
    }
    if (existsSync(root)) rmSync(root, { recursive: true, force: false });
    renameSync(stage, root);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return { files: written.sort(), destination: root };
}
