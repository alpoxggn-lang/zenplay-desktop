#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
    createReadStream,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLI_USAGE = [
    'Usage:',
    '  release-checksums.mjs generate --root <dir> --output <file> -- <files...>',
    '  release-checksums.mjs verify --root <dir> --manifest <file>',
].join('\n');

function assertRegularFile(filePath) {
    const stat = lstatSync(filePath);

    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Expected a regular file: ${filePath}`);
    }

    if (stat.size === 0) {
        throw new Error(`Release asset is empty: ${filePath}`);
    }
}

function assertInsideRoot(root, filePath) {
    const relative = path.relative(root, filePath);

    if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`Release asset is outside ${root}: ${filePath}`);
    }
}

/** @param {string} filePath */
export async function sha256File(filePath) {
    const hash = createHash('sha256');

    await new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
    });

    return hash.digest('hex');
}

/**
 * GitHub release assets are flattened to their basenames, so the manifest is
 * intentionally basename-only and rejects collisions before upload.
 *
 * @param {{ root: string, output: string, files: string[] }} options
 */
export async function generateChecksumManifest({ root, output, files }) {
    const absoluteRoot = path.resolve(root);
    const absoluteOutput = path.resolve(output);
    const entries = [];
    const seenNames = new Set();

    if (files.length === 0) {
        throw new Error('At least one release asset is required.');
    }

    assertInsideRoot(absoluteRoot, absoluteOutput);

    for (const file of files) {
        const absoluteFile = path.resolve(file);
        assertInsideRoot(absoluteRoot, absoluteFile);
        assertRegularFile(absoluteFile);

        const name = path.basename(absoluteFile);
        if (seenNames.has(name)) {
            throw new Error(`Duplicate release asset basename: ${name}`);
        }

        seenNames.add(name);
        entries.push({ name, hash: await sha256File(absoluteFile) });
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    mkdirSync(path.dirname(absoluteOutput), { recursive: true });
    writeFileSync(
        absoluteOutput,
        `${entries.map(({ hash, name }) => `${hash}  ${name}`).join('\n')}\n`,
        'utf8'
    );

    return entries;
}

/** @param {string} text */
export function parseChecksumManifest(text) {
    const entries = [];
    const seenNames = new Set();

    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line === '') {
            continue;
        }

        const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
        if (!match) {
            throw new Error(`Malformed SHA256SUMS line ${index + 1}.`);
        }

        const [, hash, name] = match;
        if (seenNames.has(name)) {
            throw new Error(`Duplicate SHA256SUMS entry: ${name}`);
        }

        seenNames.add(name);
        entries.push({ hash, name });
    }

    if (entries.length === 0) {
        throw new Error('SHA256SUMS contains no release assets.');
    }

    return entries;
}

function indexFilesByBasename(directory, files = new Map()) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            indexFilesByBasename(entryPath, files);
        } else if (entry.isFile() && entry.name !== 'SHA256SUMS') {
            const paths = files.get(entry.name) ?? [];
            paths.push(entryPath);
            files.set(entry.name, paths);
        }
    }

    return files;
}

/** @param {{ root: string, manifest: string }} options */
export async function verifyChecksumManifest({ root, manifest }) {
    const absoluteRoot = path.resolve(root);
    const absoluteManifest = path.resolve(manifest);
    assertInsideRoot(absoluteRoot, absoluteManifest);
    assertRegularFile(absoluteManifest);

    const entries = parseChecksumManifest(
        readFileSync(absoluteManifest, 'utf8')
    );
    const files = indexFilesByBasename(absoluteRoot);

    for (const { hash, name } of entries) {
        const matches = files.get(name) ?? [];

        if (matches.length !== 1) {
            throw new Error(
                `Expected exactly one release asset named ${name}; found ${matches.length}.`
            );
        }

        const actual = await sha256File(matches[0]);
        if (actual !== hash) {
            throw new Error(
                `SHA-256 mismatch for ${name}: expected ${hash}, got ${actual}.`
            );
        }
    }

    return entries;
}

function optionValue(args, name) {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] ?? null;
}

export async function runCli(args) {
    const [command, ...rest] = args;
    const root = optionValue(rest, '--root');

    if (command === 'generate') {
        const output = optionValue(rest, '--output');
        const separator = rest.indexOf('--');
        const files = separator === -1 ? [] : rest.slice(separator + 1);

        if (!root || !output || files.length === 0) {
            throw new Error(CLI_USAGE);
        }

        const entries = await generateChecksumManifest({
            root,
            output,
            files,
        });
        process.stdout.write(
            `Generated ${output} for ${entries.length} release asset(s).\n`
        );
        return;
    }

    if (command === 'verify') {
        const manifest = optionValue(rest, '--manifest');

        if (!root || !manifest) {
            throw new Error(CLI_USAGE);
        }

        const entries = await verifyChecksumManifest({ root, manifest });
        process.stdout.write(
            `Verified ${entries.length} release asset checksum(s).\n`
        );
        return;
    }

    throw new Error(CLI_USAGE);
}

const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    runCli(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
