import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);
const sourcePath = path.join(
    workspaceRoot,
    'apps',
    'web',
    'src',
    'assets',
    'branding',
    'zenplay-icon-512.png'
);
const outputPath = path.join(
    workspaceRoot,
    'apps',
    'web',
    'src',
    'assets',
    'branding',
    'zenplay.ico'
);
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

function createIconDirectoryEntry({ image, offset, size }) {
    const entry = Buffer.alloc(16);

    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);

    return entry;
}

export async function generateZenPlayWindowsIcon() {
    const images = await Promise.all(
        iconSizes.map((size) =>
            sharp(sourcePath)
                .resize(size, size, { fit: 'cover' })
                .png({ compressionLevel: 9 })
                .toBuffer()
        )
    );
    const header = Buffer.alloc(6);

    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);

    let imageOffset = header.length + images.length * 16;
    const entries = images.map((image, index) => {
        const entry = createIconDirectoryEntry({
            image,
            offset: imageOffset,
            size: iconSizes[index],
        });

        imageOffset += image.length;
        return entry;
    });

    fs.writeFileSync(
        outputPath,
        Buffer.concat([header, ...entries, ...images])
    );
    return outputPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const generatedPath = await generateZenPlayWindowsIcon();
    console.log(`Wrote ZenPlay Windows icon: ${generatedPath}`);
}
