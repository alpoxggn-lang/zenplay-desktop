/**
 * Angular waits for the app to become stable before registering the worker,
 * but forces registration after this delay on a busy cold start.
 */
export const PWA_SERVICE_WORKER_REGISTRATION_DELAY_MS = 30_000;

/** Additional time for the downloaded worker to install and become active. */
export const PWA_SERVICE_WORKER_ACTIVATION_GRACE_MS = 15_000;

export const PWA_SERVICE_WORKER_REGISTRATION_STRATEGY = `registerWhenStable:${PWA_SERVICE_WORKER_REGISTRATION_DELAY_MS}`;

/**
 * Keeps first-run notifications waiting through Angular's complete
 * registration window without allowing a broken worker to block forever.
 */
export const PWA_SERVICE_WORKER_READY_TIMEOUT_MS =
    PWA_SERVICE_WORKER_REGISTRATION_DELAY_MS +
    PWA_SERVICE_WORKER_ACTIVATION_GRACE_MS;
