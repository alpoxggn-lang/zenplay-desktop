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
    assertWindowsAuthenticodeSignature,
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
    assert.equal(result.requireCodeSigning, false);
    assert.equal(result.root, path.resolve('dist/executables'));

    const signedWindows = parseArguments([
        '--platform',
        'windows',
        '--root',
        'dist/executables',
        '--require-code-signing',
    ]);
    assert.equal(signedWindows.requireCodeSigning, true);
});

test('accepts only trusted and timestamped Windows Authenticode signatures', async () => {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zenplay-signature-test-')
    );
    try {
        const executable = path.join(root, 'ZenPlay.exe');
        writePe(executable);
        const calls = [];
        const validSignature = await assertWindowsAuthenticodeSignature(
            executable,
            async (command, args, options) => {
                calls.push({ command, args, options });
                return {
                    stdout: JSON.stringify({
                        Status: 'Valid',
                        SignerSubject: 'CN=ZenPlay Test Publisher',
                        TimeStamperSubject: 'CN=Test Timestamp Authority',
                    }),
                    stderr: '',
                };
            }
        );

        assert.equal(validSignature.Status, 'Valid');
        assert.equal(calls[0].command, 'powershell.exe');
        assert.match(calls[0].args.at(-1), /FromBase64String/);
        assert.match(
            calls[0].args.at(-1),
            new RegExp(
                Buffer.from(path.resolve(executable), 'utf8').toString('base64')
            )
        );
        assert.match(
            calls[0].options.env.PSModulePath,
            /WindowsPowerShell\\v1\.0\\Modules$/
        );
        assert.equal(calls[0].options.timeoutMs, 30_000);

        await assert.rejects(
            assertWindowsAuthenticodeSignature(executable, async () => ({
                stdout: JSON.stringify({ Status: 'NotSigned' }),
                stderr: '',
            })),
            /not trusted.*NotSigned/
        );
        await assert.rejects(
            assertWindowsAuthenticodeSignature(executable, async () => ({
                stdout: JSON.stringify({
                    Status: 'Valid',
                    SignerSubject: 'CN=ZenPlay Test Publisher',
                }),
                stderr: '',
            })),
            /not timestamped/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
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
    assert.match(workflow, /secrets\.WIN_CSC_LINK/);
    assert.match(workflow, /secrets\.WIN_CSC_KEY_PASSWORD/);
    assert.match(workflow, /--require-code-signing/);
    assert.match(workflow, /name: Create stable desktop download aliases/);
    assert.match(workflow, /download-aliases\/ZenPlay-Windows\.exe/);
    assert.match(workflow, /download-aliases\/ZenPlay-Mac-Intel\.dmg/);
    assert.match(workflow, /download-aliases\/ZenPlay-Mac-Apple-Silicon\.dmg/);
});
