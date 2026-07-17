/**
 * Host-application debug-flag registry.
 *
 * In the deployed client this is a larger object wired to a live console toggle
 * (`::voice`); the voice modules only ever read `.voice` to gate their `[rtc]` /
 * `[voice]` logging, so the reproduction bundle exposes only that seam.
 */
export const DebugFlags = {
    voice: false,
};
