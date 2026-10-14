---
type: fix
area: playback
---

En instalaciones nuevas de Windows y macOS, ZenPlay usa Embedded MPV solo cuando el motor nativo está disponible; si no, mantiene el reproductor web y respeta siempre cualquier selección manual. También prioriza audio en español, conserva la cabecera Origin y, en Windows, verifica HTTPS con el paquete de certificados incluido sin desactivar TLS.
