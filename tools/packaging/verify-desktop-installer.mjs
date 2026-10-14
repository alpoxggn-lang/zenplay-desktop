#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_APP_ID = 'com.zenplay.app';
const WINDOWS_EXECUTABLE = 'ZenPlay.exe';

function fail(message) {
    throw new Error(message);
}

function ensureDirectory(directoryPath, label) {
    if (
        !fs.existsSync(directoryPath) ||
        !fs.statSync(directoryPath).isDirectory()
    ) {
        fail(`${label} does not exist: ${directoryPath}`);
    }
}

function ensureFile(filePath, label) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        fail(`${label} does not exist: ${filePath}`);
    }
}

function readPrefix(filePath, length) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(descriptor, buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function walkFiles(rootPath) {
    const result = [];
    const pending = [path.resolve(rootPath)];

    while (pending.length > 0) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            } else if (entry.isFile()) {
                result.push(entryPath);
            }
        }
    }

    return result.sort((left, right) => left.localeCompare(right));
}

export function assertPortableExecutable(filePath) {
    ensureFile(filePath, 'Windows executable');
    const descriptor = fs.openSync(filePath, 'r');

    try {
        const dosHeader = Buffer.alloc(64);
        if (
            fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !==
            dosHeader.length
        ) {
            fail(`Windows executable is too small: ${filePath}`);
        }
        if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
            fail(`Windows executable is missing the MZ header: ${filePath}`);
        }

        const peOffset = dosHeader.readUInt32LE(0x3c);
        const signature = Buffer.alloc(4);
        if (
            fs.readSync(
                descriptor,
                signature,
                0,
                signature.length,
                peOffset
            ) !== signature.length
        ) {
            fail(`Windows executable has an invalid PE offset: ${filePath}`);
        }
        if (!signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
            fail(`Windows executable is missing the PE signature: ${filePath}`);
        }
    } finally {
        fs.closeSync(descriptor);
    }
}

export function assertMsiPackage(filePath) {
    ensureFile(filePath, 'Windows MSI package');
    const header = readPrefix(filePath, 8);
    const compoundFileHeader = Buffer.from([
        0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    if (!header.equals(compoundFileHeader)) {
        fail(`Windows MSI is missing the compound-file signature: ${filePath}`);
    }
}

export function discoverWindowsInstallers(rootPath) {
    ensureDirectory(rootPath, 'Windows artifact root');
    const files = walkFiles(rootPath);
    const setupExecutables = files.filter((filePath) =>
        /-setup\.exe$/i.test(path.basename(filePath))
    );
    const msiPackages = files.filter((filePath) => /\.msi$/i.test(filePath));

    if (setupExecutables.length !== 1) {
        fail(
            `Expected exactly one NSIS setup executable, found ${setupExecutables.length} under ${rootPath}`
        );
    }

    assertPortableExecutable(setupExecutables[0]);
    for (const msiPath of msiPackages) assertMsiPackage(msiPath);

    return { setupExecutable: setupExecutables[0], msiPackages };
}

export function assertInstalledWindowsPayload(installRoot) {
    ensureDirectory(installRoot, 'Installed Windows payload');
    const executableCandidates = walkFiles(installRoot).filter(
        (filePath) =>
            path.basename(filePath).toLowerCase() ===
            WINDOWS_EXECUTABLE.toLowerCase()
    );
    if (executableCandidates.length !== 1) {
        fail(
            `Expected one installed ${WINDOWS_EXECUTABLE}, found ${executableCandidates.length} under ${installRoot}`
        );
    }

    const executablePath = executableCandidates[0];
    assertPortableExecutable(executablePath);
    const resourcesPath = path.join(path.dirname(executablePath), 'resources');
    ensureFile(
        path.join(resourcesPath, 'app.asar'),
        'Installed Electron app.asar'
    );

    return { executablePath, resourcesPath };
}

export function assertMachOExecutable(filePath) {
    ensureFile(filePath, 'macOS app executable');
    const header = readPrefix(filePath, 4).toString('hex');
    const supportedHeaders = new Set([
        'cafebabe',
        'bebafeca',
        'feedface',
        'cefaedfe',
        'feedfacf',
        'cffaedfe',
    ]);
    if (!supportedHeaders.has(header)) {
        fail(`macOS executable has an invalid Mach-O header: ${filePath}`);
    }
}

export function discoverMacDiskImage(rootPath) {
    ensureDirectory(rootPath, 'macOS artifact root');
    const diskImages = walkFiles(rootPath).filter((filePath) =>
        /\.dmg$/i.test(filePath)
    );
    if (diskImages.length !== 1) {
        fail(
            `Expected exactly one macOS DMG, found ${diskImages.length} under ${rootPath}`
        );
    }
    if (fs.statSync(diskImages[0]).size === 0) {
        fail(`macOS DMG is empty: ${diskImages[0]}`);
    }
    return diskImages[0];
}

export function discoverMountedMacApp(mountRoot) {
    ensureDirectory(mountRoot, 'Mounted macOS disk image');
    const appBundles = fs
        .readdirSync(mountRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
        .map((entry) => path.join(mountRoot, entry.name));
    if (appBundles.length !== 1) {
        fail(
            `Expected exactly one .app bundle in the DMG, found ${appBundles.length}`
        );
    }
    return appBundles[0];
}

export function assertMountedMacPayload(appPath, executableName) {
    ensureDirectory(appPath, 'Mounted macOS app bundle');
    const executablePath = path.join(
        appPath,
        'Contents',
        'MacOS',
        executableName
    );
    assertMachOExecutable(executablePath);
    fs.accessSync(executablePath, fs.constants.X_OK);
    ensureFile(
        path.join(appPath, 'Contents', 'Resources', 'app.asar'),
        'Mounted Electron app.asar'
    );
    return executablePath;
}

export function runCommand(command, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`${command} timed out after ${timeoutMs}ms`));
                return;
            }
            if (code !== 0) {
                reject(
                    new Error(
                        `${command} exited with ${code ?? signal ?? 'unknown'}\n${stdout}${stderr}`
                    )
                );
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function verifyWindows(rootPath, dependencies = {}) {
    if (process.platform !== 'win32') {
        fail('Windows installer smoke must run on a Windows host');
    }
    const commandRunner = dependencies.runCommand ?? runCommand;
    const { setupExecutable, msiPackages } =
        discoverWindowsInstallers(rootPath);
    const temporaryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zenplay-installer-smoke-')
    );

    try {
        const nsisInstallRoot = path.join(temporaryRoot, 'nsis');
        fs.mkdirSync(nsisInstallRoot);
        await commandRunner(setupExecutable, ['/S', `/D=${nsisInstallRoot}`], {
            timeoutMs: 180_000,
        });
        const installed = assertInstalledWindowsPayload(nsisInstallRoot);
        console.log(
            `Verified NSIS installer payload: ${installed.executablePath}`
        );

        for (const [index, msiPath] of msiPackages.entries()) {
            const msiExtractRoot = path.join(temporaryRoot, `msi-${index}`);
            fs.mkdirSync(msiExtractRoot);
            await commandRunner(
                'msiexec.exe',
                [
                    '/a',
                    msiPath,
                    '/qn',
                    '/norestart',
                    `TARGETDIR=${msiExtractRoot}`,
                ],
                { timeoutMs: 180_000 }
            );
            const msiPayload = assertInstalledWindowsPayload(msiExtractRoot);
            console.log(
                `Verified MSI administrative payload: ${msiPayload.executablePath}`
            );
        }
    } finally {
        fs.rmSync(temporaryRoot, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 250,
        });
    }
}

async function readPlistValue(plistPath, key, commandRunner) {
    const result = await commandRunner(
        '/usr/bin/plutil',
        ['-extract', key, 'raw', '-o', '-', plistPath],
        { timeoutMs: 30_000 }
    );
    return result.stdout.trim();
}

async function verifyMacos(
    rootPath,
    expectedArch,
    expectedAppId,
    dependencies = {}
) {
    if (process.platform !== 'darwin') {
        fail('macOS installer smoke must run on a macOS host');
    }
    const commandRunner = dependencies.runCommand ?? runCommand;
    const diskImage = discoverMacDiskImage(rootPath);
    const mountRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'zenplay-dmg-smoke-')
    );
    let mounted = false;

    try {
        await commandRunner(
            '/usr/bin/hdiutil',
            [
                'attach',
                '-nobrowse',
                '-readonly',
                '-mountpoint',
                mountRoot,
                diskImage,
            ],
            { timeoutMs: 120_000 }
        );
        mounted = true;

        const appPath = discoverMountedMacApp(mountRoot);
        const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
        ensureFile(infoPlist, 'Mounted macOS Info.plist');
        const appId = await readPlistValue(
            infoPlist,
            'CFBundleIdentifier',
            commandRunner
        );
        if (appId !== expectedAppId) {
            fail(`Expected macOS bundle id ${expectedAppId}, found ${appId}`);
        }
        const executableName = await readPlistValue(
            infoPlist,
            'CFBundleExecutable',
            commandRunner
        );
        const executablePath = assertMountedMacPayload(appPath, executableName);
        const archResult = await commandRunner(
            '/usr/bin/lipo',
            ['-archs', executablePath],
            {
                timeoutMs: 30_000,
            }
        );
        const architectures = archResult.stdout
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        const expectedLipoArch =
            expectedArch === 'x64' ? 'x86_64' : expectedArch;
        if (expectedLipoArch && !architectures.includes(expectedLipoArch)) {
            fail(
                `Expected macOS executable architecture ${expectedLipoArch}, found ${architectures.join(', ')}`
            );
        }
        console.log(
            `Verified mounted DMG payload: ${appPath} (${architectures.join(', ')})`
        );
    } finally {
        if (mounted) {
            await commandRunner('/usr/bin/hdiutil', ['detach', mountRoot], {
                timeoutMs: 60_000,
            });
        }
        fs.rmSync(mountRoot, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 250,
        });
    }
}

export function parseArguments(argv) {
    const args = argv[0] === '--' ? argv.slice(1) : argv;
    const values = { expectedAppId: DEFAULT_APP_ID };

    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (
            ![
                '--platform',
                '--root',
                '--expected-arch',
                '--expected-app-id',
            ].includes(option)
        ) {
            fail(`Unknown option: ${option}`);
        }
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
            fail(`Missing value for ${option}`);
        index += 1;
        if (option === '--platform') values.platform = value;
        if (option === '--root') values.root = value;
        if (option === '--expected-arch') values.expectedArch = value;
        if (option === '--expected-app-id') values.expectedAppId = value;
    }

    if (!['windows', 'macos'].includes(values.platform)) {
        fail('--platform must be windows or macos');
    }
    if (!values.root) fail('--root is required');
    values.root = path.resolve(values.root);
    return values;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.platform === 'windows') {
        await verifyWindows(options.root);
        return;
    }
    await verifyMacos(
        options.root,
        options.expectedArch,
        options.expectedAppId
    );
}

const isCli =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
