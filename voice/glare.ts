/**
 * Perfect-negotiation glare decision (pure).
 *
 * Both peers may offer at once. On an incoming offer the "polite" side — the one
 * with the lower nonce — yields and accepts (with an implicit rollback); the
 * "impolite" side ignores the colliding offer so exactly one link survives.
 */

/** The lower nonce is polite and yields on a collision. */
export function isPolite(myNonce: number, remoteNonce: number): boolean {
    return myNonce < remoteNonce;
}

/** We are mid-negotiation if we have an offer out or are not back to stable. */
export function isColliding(makingOffer: boolean, signalingState: string): boolean {
    return makingOffer || signalingState !== "stable";
}

/** Ignore an incoming offer only when we are impolite AND colliding. */
export function shouldIgnoreOffer(
    myNonce: number, remoteNonce: number, makingOffer: boolean, signalingState: string,
): boolean {
    return !isPolite(myNonce, remoteNonce) && isColliding(makingOffer, signalingState);
}
