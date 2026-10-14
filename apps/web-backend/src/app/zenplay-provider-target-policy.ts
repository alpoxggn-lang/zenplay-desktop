import { normalizeXtreamServerUrl } from '@iptvnator/shared/interfaces';

export const ZENPLAY_PROVIDER_NOT_ALLOWED = {
    message: 'Provider URL is not allowed by this ZenPlay deployment',
    status: 403,
} as const;

/**
 * Restricts a managed ZenPlay deployment to its configured Xtream endpoint.
 * An invalid non-empty configuration fails closed instead of turning the
 * backend into an unrestricted public proxy.
 */
export function isZenPlayProviderTargetAllowed(
    configuredUrl: string | null | undefined,
    requestedUrl: string
): boolean {
    if (!configuredUrl?.trim()) {
        return true;
    }

    try {
        return (
            normalizeXtreamServerUrl(configuredUrl) ===
            normalizeXtreamServerUrl(requestedUrl)
        );
    } catch {
        return false;
    }
}
