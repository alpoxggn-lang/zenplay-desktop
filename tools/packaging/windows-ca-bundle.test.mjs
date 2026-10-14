import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const currentDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(currentDir, '..', '..');
const sourceDir = join(workspaceRoot, 'vendor', 'certs');
const require = createRequire(import.meta.url);
const {
    PINNED_CERTIFICATE_COUNT,
    PINNED_SHA256,
    REQUIRED_FILES,
    validateWindowsCertificateBundle,
} = require('./windows-ca-bundle.cjs');

function copyPinnedBundle(resourceDir) {
    const packagedDir = join(resourceDir, 'certs');
    fs.mkdirSync(packagedDir, { recursive: true });
    for (const fileName of REQUIRED_FILES) {
        fs.copyFileSync(join(sourceDir, fileName), join(packagedDir, fileName));
    }
}

test('accepts the exact pinned CA bundle copied into Windows resources', () => {
    const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'zenplay-ca-bundle-'));
    try {
        copyPinnedBundle(tempDir);
        assert.deepEqual(
            validateWindowsCertificateBundle(tempDir, sourceDir),
            []
        );

        const manifest = JSON.parse(
            fs.readFileSync(join(sourceDir, 'source.json'), 'utf8')
        );
        const pem = fs.readFileSync(join(sourceDir, 'cacert.pem'), 'utf8');
        assert.equal(manifest.bundle.sha256, PINNED_SHA256);
        assert.equal(
            manifest.bundle.certificateCount,
            PINNED_CERTIFICATE_COUNT
        );
        assert.equal(
            (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length,
            PINNED_CERTIFICATE_COUNT
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('fails closed when a packaged certificate resource is missing', () => {
    const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'zenplay-ca-bundle-'));
    try {
        copyPinnedBundle(tempDir);
        fs.rmSync(join(tempDir, 'certs', 'cacert.pem'));

        assert.match(
            validateWindowsCertificateBundle(tempDir, sourceDir).join('\n'),
            /Missing packaged Windows CA bundle file:.*cacert\.pem/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('fails closed when the packaged CA bundle is modified', () => {
    const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'zenplay-ca-bundle-'));
    try {
        copyPinnedBundle(tempDir);
        fs.appendFileSync(join(tempDir, 'certs', 'cacert.pem'), '\nchanged\n');

        const errors = validateWindowsCertificateBundle(tempDir, sourceDir);
        assert.match(errors.join('\n'), /differs from its pinned source/);
        assert.match(errors.join('\n'), /failed SHA-256 validation/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('fails closed when packaged provenance metadata is modified', () => {
    const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'zenplay-ca-bundle-'));
    try {
        copyPinnedBundle(tempDir);
        const manifestPath = join(tempDir, 'certs', 'source.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.bundle.sourceUrl = 'https://example.invalid/cacert.pem';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));

        const errors = validateWindowsCertificateBundle(tempDir, sourceDir);
        assert.match(errors.join('\n'), /differs from its pinned source/);
        assert.match(errors.join('\n'), /invalid sourceUrl/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
