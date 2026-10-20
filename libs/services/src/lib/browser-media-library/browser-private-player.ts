let activeDisposer: (() => void) | null = null;

export function openBrowserPrivateMedia(
    file: File,
    title: string,
    closeLabel: string
): void {
    activeDisposer?.();
    const objectUrl = URL.createObjectURL(file);
    const overlay = document.createElement('div');
    overlay.dataset['zenplayOfflinePlayer'] = 'true';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:rgba(3,8,24,.98);padding:clamp(12px,3vw,32px)';

    const surface = document.createElement('section');
    surface.style.cssText =
        'width:min(1100px,100%);max-height:100%;display:grid;gap:12px;color:#fff;font:600 16px system-ui';
    const header = document.createElement('header');
    header.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:16px';
    const heading = document.createElement('span');
    heading.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', closeLabel);
    close.style.cssText =
        'border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:10px 18px;background:rgba(255,255,255,.12);color:#fff;font:inherit;cursor:pointer';
    const video = document.createElement('video');
    video.src = objectUrl;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
        'width:100%;max-height:calc(100vh - 120px);border-radius:20px;background:#000';

    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(objectUrl);
        overlay.remove();
        if (activeDisposer === dispose) activeDisposer = null;
    };
    activeDisposer = dispose;
    close.addEventListener('click', dispose, { once: true });
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) dispose();
    });
    overlay.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dispose();
    });
    header.append(heading, close);
    surface.append(header, video);
    overlay.append(surface);
    document.body.append(overlay);
    close.focus();
}
