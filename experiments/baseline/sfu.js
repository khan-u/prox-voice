/**
 * Server-mixed baseline — SFU forwarder for PROX-VOICE.
 *
 * A headless Node WebRTC node (werift) that browser peers connect to. Each
 * peer's audio is FORWARDED to every other peer through this server, so audio
 * traverses client → server → client (the centralized topology
 * that the P2P mesh replaces). The measured quantity is the added network
 * hop: the browser reports its candidate-pair RTT to this SFU, so server-
 * mixed one-way latency ~= RTT_up/2 + RTT_down/2 + forward cost, vs the
 * mesh's direct client↔client RTT/2.
 *
 * Own lightweight JSON-over-WebSocket signaling (browser is the offerer) — NOT
 * the game's op-105 relay, which would require reimplementing the RS login
 * protocol in Node. This is a measurement instrument on the same media path.
 *
 * Serves the minimal client page at http://127.0.0.1:<PORT>/ and signaling at
 * ws://127.0.0.1:<PORT>/ws.  Usage:  node sfu.js [port]   (default 8090)
 */
const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } = require("werift");

const PORT        = parseInt(process.argv[2] || "8090", 10);
const CLIENT_HTML = fs.readFileSync(path.join(__dirname, "client.html"), "utf8");

// Opus, matching the browser's default codec negotiation.
const opus = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 96 });

const peers = new Map();   // id → { pc, sendTrack, ws }
let nextId    = 1;
let forwarded = 0;   // RTP packets forwarded through the server
setInterval(() => { if (peers.size > 0) log(`peers=${peers.size} forwardedRtp=${forwarded}`); }, 2000);

const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/?")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(CLIENT_HTML);
    } else {
        res.writeHead(404); res.end();
    }
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws) => {
    const id = nextId++;
    const pc = new RTCPeerConnection({ codecs: { audio: [opus] } });
    // Outbound track: what THIS peer receives (the mix of everyone else, forwarded).
    const sendTrack = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(sendTrack, { direction: "sendrecv" });
    peers.set(id, { pc, sendTrack, ws });
    log(`peer ${id} connected (${peers.size} total)`);

    // Forward this peer's inbound RTP to every other peer's outbound track.
    pc.onTrack.subscribe((track) => {
        track.onReceiveRtp.subscribe((rtp) => {
            for (const [otherId, p] of peers) {
                if (otherId === id) continue;
                try { p.sendTrack.writeRtp(rtp); forwarded++; } catch (_) { /* peer going away */ }
            }
        });
    });

    pc.onIceCandidate.subscribe((c) => {
        try { ws.send(JSON.stringify({ t: "ice", candidate: c })); } catch (_) {}
    });

    ws.on("message", async (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        try {
            if (m.t === "offer") {
                await pc.setRemoteDescription(m.sdp);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ t: "answer", sdp: pc.localDescription }));
            } else if (m.t === "ice" && m.candidate) {
                await pc.addIceCandidate(m.candidate);
            }
        } catch (e) { log(`peer ${id} signal error: ${String(e).slice(0, 120)}`); }
    });

    ws.on("close", () => {
        peers.delete(id);
        try { pc.close(); } catch (_) {}
        log(`peer ${id} closed (${peers.size} total)`);
    });
});

function log(...a) { console.log(new Date().toISOString().slice(11, 19), "[sfu]", ...a); }

server.listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT} (ws /ws)`));
