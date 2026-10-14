import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
    generateChecksumManifest,
    parseChecksumManifest,
    verifyChecksumManifest,
} from './release-checksums.mjs';

function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'zenplay-checksums-'));
    const macDirectory = path.join(root, 'mac');
    const windowsDirectory = path.join(root, 'windows');
    mkdirSync(macDirectory);
    mkdirSync(windowsDirectory);

    const mac = path.join(macDirectory, 'ZenPlay-1.0.0-mac-arm64.dmg');
    const windows = path.join(
        windowsDirectory,
        'ZenPlay-1.0.0-windows-x64-setup.exe'
    );
    writeFileSync(mac, 'mac artifact');
    writeFileSync(windows, 'windows artifact');

    return {
        root,
        files: [windows, mac],
        manifest: path.join(root, 'SHA256SUMS'),
        mac,
    };
}

describe('release checksum manifest', () => {
    it('generates a deterministic basename-only manifest and verifies it', async () => {
        const { root, files, manifest } = fixture();

        const generated = await generateChecksumManifest({
            root,
            output: manifest,
            files,
        });
        const verified = await verifyChecksumManifest({ root, manifest });

        assert.deepEqual(verified, generated);
        assert.deepEqual(
            generated.map(({ name }) => name),
            [
                'ZenPlay-1.0.0-mac-arm64.dmg',
                'ZenPlay-1.0.0-windows-x64-setup.exe',
            ]
        );
        assert.doesNotMatch(readFileSync(manifest, 'utf8'), /[/\\]mac[/\\]/);
    });

    it('rejects a modified artifact', async () => {
        const { root, files, manifest, mac } = fixture();
        await generateChecksumManifest({ root, output: manifest, files });
        writeFileSync(mac, 'tampered artifact');

        await assert.rejects(
            verifyChecksumManifest({ root, manifest }),
            /SHA-256 mismatch/
        );
    });

    it('rejects duplicate basenames that GitHub would flatten', async () => {
        const { root, files, manifest } = fixture();
        const duplicateDirectory = path.join(root, 'duplicate');
        mkdirSync(duplicateDirectory);
        const duplicate = path.join(
            duplicateDirectory,
            path.basename(files[0])
        );
        writeFileSync(duplicate, 'other installer');

        await assert.rejects(
            generateChecksumManifest({
                root,
                output: manifest,
                files: [...files, duplicate],
            }),
            /Duplicate release asset basename/
        );
    });

    it('rejects an empty release asset', async () => {
        const { root, manifest } = fixture();
        const empty = path.join(root, 'empty.zip');
        writeFileSync(empty, '');

        await assert.rejects(
            generateChecksumManifest({
                root,
                output: manifest,
                files: [empty],
            }),
            /Release asset is empty/
        );
    });

    it('rejects malformed and path-bearing manifest entries', () => {
        assert.throws(
            () => parseChecksumManifest(`${'a'.repeat(64)}  mac/file.dmg\n`),
            /Malformed SHA256SUMS line/
        );
    });
});
