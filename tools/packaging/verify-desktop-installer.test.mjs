import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertInstalledWindowsPayload,
    assertMachOExecutable,
    assertMsiPackage,
    assertMountedMacPayload,
    assertPortableExecutable,
    discoverMacDiskImage,
    discoverMountedMacApp,
    discoverWindowsInstallers,
    parseArguments,
} from './verify-desktop-installer.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '..', '..');

function withTempDirectory(callback) {
    const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zenplay-installer-test-')
    );
    try {
        return callback(tempRoot);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function writePe(filePath) {
    const payload = Buffer.alloc(132);
    payload.write('MZ', 0, 'ascii');
    payload.writeUInt32LE(128, 0x3c);
    payload.write('PE\0\0', 128, 'binary');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, payload);
}

function writeMachO(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from('cffaedfe00000000', 'hex'));
    fs.chmodSync(filePath, 0o755);
}

test('discovers one NSIS setup and validates optional MSI packages', () => {
    withTempDirectory((root) => {
        const setupPath = path.join(
            root,
            'ZenPlay-1.2.3-windows-x64-setup.exe'
        );
        const msiPath = path.join(root, 'ZenPlay-1.2.3-windows-x64.msi');
        writePe(setupPath);
        fs.writeFileSync(msiPath, Buffer.from('d0cf11e0a1b11ae10000', 'hex'));

        assert.deepEqual(discoverWindowsInstallers(root), {
            setupExecutable: setupPath,
            msiPackages: [msiPath],
        });
    });
});

test('rejects malformed PE and MSI headers', () => {
    withTempDirectory((root) => {
        const exe = path.join(root, 'broken.exe');
        const msi = path.join(root, 'broken.msi');
        fs.writeFileSync(exe, Buffer.alloc(80));
        fs.writeFileSync(msi, Buffer.alloc(8));
        assert.throws(() => assertPortableExecutable(exe), /MZ header/);
        assert.throws(() => assertMsiPackage(msi), /compound-file signature/);
    });
});

test('validates the installed Electron Windows payload', () => {
    withTempDirectory((root) => {
        const exe = path.join(root, 'ZenPlay.exe');
        writePe(exe);
        fs.mkdirSync(path.join(root, 'resources'));
        fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'fixture');

        assert.equal(assertInstalledWindowsPayload(root).executablePath, exe);
    });
});

test('discovers and validates one mounted macOS app payload', () => {
    withTempDirectory((root) => {
        const dmg = path.join(root, 'ZenPlay-1.2.3-mac-arm64.dmg');
        fs.writeFileSync(dmg, 'fixture');
        assert.equal(discoverMacDiskImage(root), dmg);

        const mountRoot = path.join(root, 'mount');
        const appPath = path.join(mountRoot, 'ZenPlay.app');
        const executable = path.join(appPath, 'Contents', 'MacOS', 'ZenPlay');
        writeMachO(executable);
        fs.mkdirSync(path.join(appPath, 'Contents', 'Resources'));
        fs.writeFileSync(
            path.join(appPath, 'Contents', 'Resources', 'app.asar'),
            'fixture'
        );

        assert.equal(discoverMountedMacApp(mountRoot), appPath);
        assert.equal(assertMountedMacPayload(appPath, 'ZenPlay'), executable);
        assert.doesNotThrow(() => assertMachOExecutable(executable));
    });
});

test('rejects ambiguous release artifacts', () => {
    withTempDirectory((root) => {
        writePe(path.join(root, 'ZenPlay-a-setup.exe'));
        writePe(path.join(root, 'ZenPlay-b-setup.exe'));
        assert.throws(
            () => discoverWindowsInstallers(root),
            /exactly one NSIS/
        );
    });
    withTempDirectory((root) => {
        fs.writeFileSync(path.join(root, 'one.dmg'), 'one');
        fs.writeFileSync(path.join(root, 'two.dmg'), 'two');
        assert.throws(
            () => discoverMacDiskImage(root),
            /exactly one macOS DMG/
        );
    });
});

test('parses platform-specific installer smoke arguments', () => {
    const result = parseArguments([
        '--',
        '--platform',
        'macos',
        '--root',
        'dist/executables',
        '--expected-arch',
        'arm64',
    ]);
    assert.equal(result.platform, 'macos');
    assert.equal(result.expectedArch, 'arm64');
    assert.equal(result.expectedAppId, 'com.zenplay.app');
    assert.equal(result.root, path.resolve('dist/executables'));
});

test('workflow gates Windows and macOS artifact uploads on installer smoke', () => {
    const workflow = fs.readFileSync(
        path.join(
            repositoryRoot,
            '.github',
            'workflows',
            'build-and-make.yaml'
        ),
        'utf8'
    );
    const windowsSmoke = workflow.indexOf(
        'name: Smoke-test Windows installer payload'
    );
    const macosSmoke = workflow.indexOf('name: Smoke-test macOS DMG payload');
    const macosUpload = workflow.indexOf('name: Upload artifacts (macOS)');
    const windowsUpload = workflow.indexOf('name: Upload artifacts (Windows)');

    assert.ok(windowsSmoke >= 0);
    assert.ok(macosSmoke >= 0);
    assert.ok(macosSmoke < macosUpload);
    assert.ok(windowsSmoke < windowsUpload);
    assert.match(
        workflow,
        /verify:desktop-installer -- --platform macos[\s\S]*?--expected-app-id com\.zenplay\.app/
    );
});
