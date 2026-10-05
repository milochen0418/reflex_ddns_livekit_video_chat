"""Two browsers join one room and see and hear each other through the embedded server.

Chromium's fake devices publish a test pattern (camera) and a beep (microphone),
so we can check real media flow: the remote tracks' inbound RTP byte counters
must grow, the other person's tile must play decoded video frames, and the
selected ICE pairs show which server port carries the media.
"""

import os
import secrets
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

# Bytes received on the remote tracks of one kind ("audio" or "video").
_INBOUND_BYTES = """async (kind) => {
    const room = window.livekitClient && window.livekitClient.room;
    if (!room) return -1;
    let total = 0;
    for (const p of room.remoteParticipants.values()) {
        const pubs = kind === 'video' ? p.videoTrackPublications : p.audioTrackPublications;
        for (const pub of pubs.values()) {
            const track = pub.track;
            if (!track || !track.receiver) continue;
            const stats = await track.receiver.getStats();
            stats.forEach((r) => { if (r.type === 'inbound-rtp') total += r.bytesReceived || 0; });
        }
    }
    return total;
}"""

# The <video> in someone's tile: decoded frame size and playback position.
_TILE_VIDEO = """(name) => {
    const tile = [...document.querySelectorAll('.participant-tile')]
        .find((t) => t.textContent.includes(name));
    const video = tile && tile.querySelector('video[data-lk-identity]');
    if (!video) return null;
    return {
        has_video: tile.dataset.hasVideo,
        width: video.videoWidth,
        height: video.videoHeight,
        time: video.currentTime,
        attached: !!video.srcObject,
    };
}"""

# State of our own camera's capture track ("live", or "ended" once released).
_CAMERA_CAPTURE = """() => {
    const room = window.livekitClient && window.livekitClient.room;
    const pub = room && room.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Camera);
    return pub && pub.track ? pub.track.mediaStreamTrack.readyState : 'none';
}"""

# Selected ICE pair per peer connection (publisher = our uplink, chosen by the
# browser; subscriber = downlink, chosen by the server). Behind Docker Desktop
# the downlink may run over the host's outbound NAT and show up as a
# peer-reflexive candidate (Chrome hides its IP); the uplink goes to the
# published node_ip:port.
_SELECTED_PAIRS = """async () => {
    const room = window.livekitClient && window.livekitClient.room;
    const mgr = room && room.engine && room.engine.pcManager;
    if (!mgr) return [];
    const out = [];
    for (const [label, transport] of [['publisher', mgr.publisher], ['subscriber', mgr.subscriber]]) {
        const pc = transport && transport.pc;
        if (!pc) continue;
        const stats = await pc.getStats();
        const byId = new Map();
        stats.forEach((s) => byId.set(s.id, s));
        let pair = null;
        stats.forEach((s) => {
            if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
        });
        if (!pair) continue;
        const local = byId.get(pair.localCandidateId) || {};
        const remote = byId.get(pair.remoteCandidateId) || {};
        out.push({
            label: label,
            local: `${local.candidateType}/${local.protocol} ${local.address || '?'}:${local.port}`,
            remote: `${remote.candidateType}/${remote.protocol} ${remote.address || '?'}:${remote.port}`,
            remote_port: String(remote.port),
            bytes: (pair.bytesSent || 0) + (pair.bytesReceived || 0),
        });
    }
    return out;
}"""


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def join(page: Page, base_url: str, name: str, room: str) -> None:
    page.goto(base_url + "/", wait_until="domcontentloaded")
    page.locator('#server-status[data-phase="running"]').wait_for(timeout=120_000)
    page.get_by_placeholder("Enter your name").fill(name)
    page.get_by_placeholder("Enter room to join").fill(room)
    page.get_by_role("button", name="Join Room").click()
    page.wait_for_function(
        "() => document.getElementById('connection-status')?.textContent === 'Connected'"
    )


def wait_for_tiles(page: Page, count: int) -> None:
    page.wait_for_function(
        f"() => document.querySelectorAll('.participant-tile').length === {count}"
    )


def wait_for_bytes(page: Page, kind: str, label: str, timeout_s: float = 20.0) -> int:
    """Wait until inbound media of ``kind`` is flowing (and still growing)."""
    deadline = time.time() + timeout_s
    previous = -1
    while time.time() < deadline:
        current = page.evaluate(_INBOUND_BYTES, kind)
        if previous > 2000 and current > previous:
            print(f"[{label}] inbound {kind} bytes: {previous} -> {current}")
            return current
        previous = current
        time.sleep(1.0)
    raise AssertionError(f"[{label}] no inbound {kind} (last byte count {previous})")


def wait_for_playing(page: Page, name: str, label: str, timeout_s: float = 20.0) -> dict:
    """Wait until ``name``'s tile shows decoded frames and keeps playing."""
    deadline = time.time() + timeout_s
    previous = None
    while time.time() < deadline:
        current = page.evaluate(_TILE_VIDEO, name)
        if (
            previous
            and current
            and current["has_video"] == "true"
            and current["width"] > 0
            and current["time"] > previous["time"]
        ):
            print(f"[{label}] {name}'s video: {current['width']}x{current['height']}, "
                  f"playing ({previous['time']:.1f}s -> {current['time']:.1f}s)")
            return current
        previous = current
        time.sleep(1.0)
    raise AssertionError(f"[{label}] {name}'s video is not playing (last {previous})")


def wait_for_tile_video(page: Page, name: str, has_video: bool) -> None:
    flag = "true" if has_video else "false"
    page.locator(f'.participant-tile[data-has-video="{flag}"]', has_text=name).wait_for()


def main() -> int:
    base_url = os.getenv("BASE_URL", "http://127.0.0.1:3000").rstrip("/")
    output_dir = Path(os.getenv("OUTPUT_DIR", "testcases/two_users_video/output"))
    output_dir.mkdir(parents=True, exist_ok=True)

    headless = env_bool("HEADLESS", True)
    timeout_ms = int(os.getenv("PW_TIMEOUT_MS", "30000"))
    expect_port = os.getenv("EXPECT_MEDIA_PORT", "")
    room = f"e2e-{secrets.token_hex(3)}"

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            slow_mo=int(os.getenv("PW_SLOWMO_MS", "0")),
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        contexts = [
            browser.new_context(
                viewport={"width": 1100, "height": 800},
                ignore_https_errors=True,
                permissions=["microphone", "camera"],
            )
            for _ in range(2)
        ]
        alice, bob = (ctx.new_page() for ctx in contexts)
        for page in (alice, bob):
            page.set_default_timeout(timeout_ms)
            page.on("console", lambda msg: msg.type == "error" and print("console:", msg.text))

        try:
            join(alice, base_url, "Alice", room)
            join(bob, base_url, "Bob", room)
            wait_for_tiles(alice, 2)
            wait_for_tiles(bob, 2)
            print(f"room {room}: both participants visible")

            wait_for_bytes(bob, "audio", "bob hears alice")
            wait_for_bytes(alice, "audio", "alice hears bob")
            wait_for_bytes(bob, "video", "bob sees alice")
            wait_for_bytes(alice, "video", "alice sees bob")
            wait_for_playing(bob, "Alice", "bob")
            wait_for_playing(alice, "Bob", "alice")
            # Our own camera shows in our own tile too.
            wait_for_playing(alice, "Alice", "alice (self view)")

            for label, page in (("alice", alice), ("bob", bob)):
                pairs = page.evaluate(_SELECTED_PAIRS)
                for pair in pairs:
                    print(f"[{label}] {pair['label']}: {pair['local']} -> {pair['remote']} "
                          f"({pair['bytes']} bytes)")
                if expect_port and not any(
                    pair["remote_port"] == expect_port and pair["bytes"] > 0 for pair in pairs
                ):
                    raise AssertionError(f"[{label}] no media over server port {expect_port}")

            alice.screenshot(path=str(output_dir / "alice_in_room.png"), full_page=True)
            bob.screenshot(path=str(output_dir / "bob_in_room.png"), full_page=True)

            # Camera off: the other side gets the avatar, and the camera is released.
            alice.get_by_title("Turn off camera").click()
            wait_for_tile_video(bob, "Alice", has_video=False)
            wait_for_tile_video(alice, "Alice", has_video=False)
            alice.get_by_title("Turn on camera").wait_for()
            capture = alice.evaluate(_CAMERA_CAPTURE)
            print("bob sees alice's camera off; alice's capture track:", capture)
            if capture == "live":
                raise AssertionError("camera still capturing after turning it off")
            bob.screenshot(path=str(output_dir / "bob_alice_camera_off.png"), full_page=True)

            alice.get_by_title("Turn on camera").click()
            wait_for_playing(bob, "Alice", "bob (camera back on)")

            # Mute shows up on the other side.
            alice.get_by_title("Mute").click()
            bob.locator(".participant-tile", has_text="Alice").locator(
                "svg.lucide-mic-off"
            ).wait_for()
            print("bob sees alice muted")
            alice.get_by_title("Unmute").click()
            bob.locator(".participant-tile", has_text="Alice").locator(
                "svg.lucide-mic-off"
            ).wait_for(state="detached")
            print("bob sees alice unmuted")

            # Leaving removes the participant for the other side.
            alice.get_by_title("Leave room").click()
            alice.get_by_role("button", name="Join Room").wait_for()
            wait_for_tiles(bob, 1)
            print("bob sees alice leave")

            bob.screenshot(path=str(output_dir / "bob_after_leave.png"), full_page=True)
            return 0
        except Exception:
            for label, page in (("alice", alice), ("bob", bob)):
                try:
                    page.screenshot(path=str(output_dir / f"failure_{label}.png"), full_page=True)
                except Exception:
                    pass
            raise
        finally:
            for ctx in contexts:
                ctx.close()
            browser.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception as exc:
        print(f"two_users_video failed: {exc}", file=sys.stderr)
        raise
