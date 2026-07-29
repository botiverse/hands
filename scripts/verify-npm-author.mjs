#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_AUTHOR = Object.freeze({
  name: 'jiacheng',
  email: 'jiacheng@botiverse.dev',
});

export function verifyAuthor(manifest, source) {
  if (manifest.private === true) return;
  const author = manifest.author;
  if (author === null || typeof author !== 'object' || Array.isArray(author)) {
    throw new Error(`${source}: publishable package must use an author object`);
  }
  if (author.name !== EXPECTED_AUTHOR.name || author.email !== EXPECTED_AUTHOR.email) {
    throw new Error(`${source}: author must be ${EXPECTED_AUTHOR.name} <${EXPECTED_AUTHOR.email}>`);
  }
}

function discoverPackageManifests(root) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
  const manifests = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (ignored.has(entry)) continue;
      const path = resolve(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (entry === 'package.json') manifests.push(path);
    }
  };
  visit(root);
  return manifests.sort();
}

function readPackedManifest(tarball) {
  let text;
  try {
    text = execFileSync(
      'tar',
      ['--extract', '--to-stdout', '--file', tarball, 'package/package.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    throw new Error(`${tarball}: cannot read packed package/package.json: ${String(error)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${tarball}: packed package.json is invalid: ${String(error)}`);
  }
  verifyAuthor(manifest, `${tarball}:package/package.json`);
}

function main(args) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (args.length === 1 && args[0] === '--all') {
    let checked = 0;
    for (const path of discoverPackageManifests(root)) {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.private === true) continue;
      verifyAuthor(manifest, path.slice(root.length + 1));
      checked += 1;
    }
    if (checked === 0) throw new Error('no publishable npm package manifests found');
    process.stdout.write(`npm author metadata: ${checked} publishable manifests PASS\n`);
    return;
  }
  if (args.length === 2 && args[0] === '--manifest') {
    const path = resolve(args[1]);
    verifyAuthor(JSON.parse(readFileSync(path, 'utf8')), args[1]);
    process.stdout.write(`npm author metadata: ${args[1]} PASS\n`);
    return;
  }
  if (args.length === 2 && args[0] === '--tarball') {
    const tarball = resolve(args[1]);
    if (!existsSync(tarball)) throw new Error(`${args[1]}: tarball does not exist`);
    readPackedManifest(tarball);
    process.stdout.write(`npm author metadata: ${args[1]} packed manifest PASS\n`);
    return;
  }
  throw new Error('usage: verify-npm-author.mjs --all | --manifest <package.json> | --tarball <package.tgz>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
