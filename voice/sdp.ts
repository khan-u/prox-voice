/**
 * SDP munging for the Opus DTX lever (pure).
 *
 * Discontinuous transmission is negotiated with `usedtx=1` on the Opus fmtp
 * line, so the encoder stops sending during silence. mungeDtx inserts it into
 * every Opus payload's fmtp line (adding the line if the offer/answer omitted
 * it), and is idempotent — a description already carrying usedtx is left alone.
 */
export function mungeDtx(sdp: string): string {
    if (!sdp) { return sdp; }
    const payloads: string[] = [];
    const rtpmap = /a=rtpmap:(\d+) opus\//g;
    let m: RegExpExecArray | null;
    while ((m = rtpmap.exec(sdp)) !== null) { payloads.push(m[1]); }

    for (const pt of payloads) {
        const fmtp = new RegExp("(a=fmtp:" + pt + " [^\\r\\n]*)");
        if (fmtp.test(sdp)) {
            if (sdp.indexOf("usedtx") < 0) { sdp = sdp.replace(fmtp, "$1;usedtx=1"); }
        } else {
            sdp = sdp.replace(new RegExp("(a=rtpmap:" + pt + " opus/[^\\r\\n]*)"), "$1\r\na=fmtp:" + pt + " usedtx=1");
        }
    }
    return sdp;
}
