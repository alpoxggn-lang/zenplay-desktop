import { accessSync, constants as fsConstants, lstatSync } from 'fs';
import path from 'path';

export interface EmbeddedMpvTlsCaOptionContext {
    platform: NodeJS.Platform;
    isPackaged: boolean;
    resourcesPath?: string;
    isReadableRegularFile?: (filePath: string) => boolean;
}

function isReadableRegularFile(filePath: string): boolean {
    try {
        const stats = lstatSync(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            return false;
        }
        accessSync(filePath, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolves the verified CA bundle shipped by the Windows desktop package.
 *
 * The vendored Windows libmpv uses curl but does not provide a system CA
 * fallback. Supplying the release-owned Mozilla bundle keeps HTTPS
 * verification enabled. Development and non-Windows sessions retain their
 * platform defaults instead of trusting a path from the working directory.
 */
export function resolveEmbeddedMpvTlsCaOption({
    platform,
    isPackaged,
    resourcesPath,
    isReadableRegularFile: inspectFile = isReadableRegularFile,
}: EmbeddedMpvTlsCaOptionContext): string | null {
    if (platform !== 'win32' || !isPackaged || !resourcesPath) {
        return null;
    }

    const caBundlePath = path.join(resourcesPath, 'certs', 'cacert.pem');
    return inspectFile(caBundlePath) ? `tls-ca-file=${caBundlePath}` : null;
}
