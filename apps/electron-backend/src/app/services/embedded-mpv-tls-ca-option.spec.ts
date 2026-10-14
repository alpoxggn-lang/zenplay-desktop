import path from 'path';
import { resolveEmbeddedMpvTlsCaOption } from './embedded-mpv-tls-ca-option';

describe('resolveEmbeddedMpvTlsCaOption', () => {
    const resourcesPath = path.join(
        'C:',
        'Program Files',
        'ZenPlay',
        'resources'
    );
    const caBundlePath = path.join(resourcesPath, 'certs', 'cacert.pem');

    it('uses the packaged Windows CA bundle without disabling TLS', () => {
        const inspectFile = jest.fn(() => true);

        expect(
            resolveEmbeddedMpvTlsCaOption({
                platform: 'win32',
                isPackaged: true,
                resourcesPath,
                isReadableRegularFile: inspectFile,
            })
        ).toBe(`tls-ca-file=${caBundlePath}`);
        expect(inspectFile).toHaveBeenCalledWith(caBundlePath);
    });

    it.each([
        ['darwin', true, resourcesPath],
        ['linux', true, resourcesPath],
        ['win32', false, resourcesPath],
        ['win32', true, undefined],
    ] as const)(
        'does not inject a CA option for %s packaged=%s resources=%s',
        (platform, isPackaged, candidateResourcesPath) => {
            const inspectFile = jest.fn(() => true);

            expect(
                resolveEmbeddedMpvTlsCaOption({
                    platform,
                    isPackaged,
                    resourcesPath: candidateResourcesPath,
                    isReadableRegularFile: inspectFile,
                })
            ).toBeNull();
            expect(inspectFile).not.toHaveBeenCalled();
        }
    );

    it('does not point libmpv at a missing or invalid packaged bundle', () => {
        expect(
            resolveEmbeddedMpvTlsCaOption({
                platform: 'win32',
                isPackaged: true,
                resourcesPath,
                isReadableRegularFile: () => false,
            })
        ).toBeNull();
    });
});
