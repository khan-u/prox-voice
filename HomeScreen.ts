/**
 * Host-application home-screen app registry (integration seam).
 *
 * The deployed client renders a draggable "Voice" app whose icon reflects live
 * mesh state; VoiceRTC pushes updated renders through updateAppIcon on every
 * arm/link change. The reproduction bundle stubs it so the mesh links and runs
 * standalone — updateAppIcon is a no-op until the game wires the real screen.
 */
export class HomeScreen {
    static updateAppIcon(_appId: string, _iconDataUrl: string): void {
        /* wired by the game client; no-op in the reproduction bundle */
    }
}
