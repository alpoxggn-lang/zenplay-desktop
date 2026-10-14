const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FILES = [
    'cacert.pem',
    'LICENSE-MPL-2.0.txt',
    'NOTICE.md',
    'source.json',
];
const PINNED_REVISION = '2026-09-25';
const PINNED_SOURCE_URL = 'https://curl.se/ca/cacert-2026-09-25.pem';
const PINNED_SHA256 =
    'a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505';
const PINNED_CERTIFICATE_COUNT = 121;

function isFile(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function sha256(contents) {
    return crypto.createHash('sha256').update(contents).digest('hex');
}

function readManifest(manifestPath, errors) {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        errors.push(
            `Unable to read Windows CA bundle manifest ${manifestPath}: ${error.message}`
        );
        return null;
    }
}

function validateManifest(manifest, manifestPath, errors) {
    const expected = {
        schemaVersion: 1,
        revision: PINNED_REVISION,
        sourceUrl: PINNED_SOURCE_URL,
        sha256: PINNED_SHA256,
        certificateCount: PINNED_CERTIFICATE_COUNT,
        licenseSpdx: 'MPL-2.0',
        licenseFile: 'LICENSE-MPL-2.0.txt',
    };
    const actual = {
        schemaVersion: manifest?.schemaVersion,
        revision: manifest?.bundle?.revision,
        sourceUrl: manifest?.bundle?.sourceUrl,
        sha256: manifest?.bundle?.sha256,
        certificateCount: manifest?.bundle?.certificateCount,
        licenseSpdx: manifest?.license?.spdx,
        licenseFile: manifest?.license?.file,
    };

    for (const [field, expectedValue] of Object.entries(expected)) {
        if (actual[field] !== expectedValue) {
            errors.push(
                `Windows CA bundle manifest ${manifestPath} has invalid ${field}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(actual[field])}.`
            );
        }
    }

    if (manifest?.bundle?.file !== 'cacert.pem') {
        errors.push(
            `Windows CA bundle manifest ${manifestPath} must name cacert.pem as bundle.file.`
        );
    }
}

function validatePem(pem, pemPath, manifest, errors) {
    const digest = sha256(pem);
    if (digest !== manifest?.bundle?.sha256 || digest !== PINNED_SHA256) {
        errors.push(
            `Windows CA bundle ${pemPath} failed SHA-256 validation: ${digest}.`
        );
    }

    const text = pem.toString('utf8');
    const beginCount = (text.match(/-----BEGIN CERTIFICATE-----/g) ?? [])
        .length;
    const endCount = (text.match(/-----END CERTIFICATE-----/g) ?? []).length;
    if (
        beginCount !== manifest?.bundle?.certificateCount ||
        beginCount !== PINNED_CERTIFICATE_COUNT ||
        endCount !== beginCount
    ) {
        errors.push(
            `Windows CA bundle ${pemPath} has an invalid certificate count: ${beginCount} BEGIN and ${endCount} END markers.`
        );
    }
}

function validateWindowsCertificateBundle(resourceDir, sourceDir) {
    const errors = [];
    const packagedDir = path.join(resourceDir, 'certs');
    const sourceManifestPath = path.join(sourceDir, 'source.json');
    const packagedManifestPath = path.join(packagedDir, 'source.json');

    for (const fileName of REQUIRED_FILES) {
        const sourcePath = path.join(sourceDir, fileName);
        const packagedPath = path.join(packagedDir, fileName);

        if (!isFile(sourcePath)) {
            errors.push(`Missing source Windows CA bundle file: ${sourcePath}`);
        }
        if (!isFile(packagedPath)) {
            errors.push(
                `Missing packaged Windows CA bundle file: ${packagedPath}`
            );
            continue;
        }
        if (
            isFile(sourcePath) &&
            !fs.readFileSync(sourcePath).equals(fs.readFileSync(packagedPath))
        ) {
            errors.push(
                `Packaged Windows CA bundle file differs from its pinned source: ${packagedPath}`
            );
        }
    }

    if (!isFile(sourceManifestPath) || !isFile(packagedManifestPath)) {
        return errors;
    }

    const sourceManifest = readManifest(sourceManifestPath, errors);
    const packagedManifest = readManifest(packagedManifestPath, errors);
    if (!sourceManifest || !packagedManifest) {
        return errors;
    }

    validateManifest(sourceManifest, sourceManifestPath, errors);
    validateManifest(packagedManifest, packagedManifestPath, errors);

    const packagedPemPath = path.join(packagedDir, 'cacert.pem');
    if (isFile(packagedPemPath)) {
        validatePem(
            fs.readFileSync(packagedPemPath),
            packagedPemPath,
            packagedManifest,
            errors
        );
    }

    return errors;
}

module.exports = {
    PINNED_CERTIFICATE_COUNT,
    PINNED_REVISION,
    PINNED_SHA256,
    PINNED_SOURCE_URL,
    REQUIRED_FILES,
    validateWindowsCertificateBundle,
};
