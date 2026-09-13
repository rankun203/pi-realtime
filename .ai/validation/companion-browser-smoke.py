"""Browser → helper → voice service → actual Pi SDK integration.
Provider/audio are mocked by default. PI_COMPANION_LIVE=1 uses the real provider
and requires PI_COMPANION_AUDIO pointing to a synthetic speech WAV (token charges).
Run: uv run --no-project --with playwright python .ai/validation/companion-browser-smoke.py
"""
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
LIVE = os.environ.get("PI_COMPANION_LIVE") == "1"


def wait_state(request, url, predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = request.get(url).json()
        if predicate(state):
            return state
        time.sleep(0.2)
    raise AssertionError(json.dumps(state)[-15000:])


def exercise(info):
    with sync_playwright() as p:
        args = []
        if LIVE:
            audio = os.environ["PI_COMPANION_AUDIO"]
            args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", f"--use-file-for-fake-audio-capture={audio}%noloop"]
        browser = p.chromium.launch(headless=True, args=args)
        context = browser.new_context(viewport={"width": 390, "height": 844})
        if not LIVE:
            context.add_init_script("""
                window.parent.stoppedTracks ||= 0;
                if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=async()=>({getAudioTracks(){return [this.track]}, getTracks(){return [this.track]},track:{stop(){window.parent.stoppedTracks++}}});
                window.RTCPeerConnection=class {
                    addTrack(){} createDataChannel(){return {close(){}}}
                    async createOffer(){return {sdp:'v=0\\r\\n'}} async setLocalDescription(){} async setRemoteDescription(){} close(){}
                };
            """)
        control = f"http://127.0.0.1:{info['control']}"
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(f"http://127.0.0.1:{info['port']}")
        chat = page.frame_locator("#chat")
        chat.locator("#start").click()
        expect(chat.locator("#status")).to_contain_text("Voice connected", timeout=40000)
        if not LIVE:
            context.request.post(control + "/emit", data={"type":"response.function_call_arguments.done", "name":"post_message", "call_id":"message-1", "arguments":json.dumps({"message":"Inspect the diagnostic directory.","origin":"user"})})
        state = wait_state(context.request, control, lambda s: s["completions"] >= 1, timeout=45)
        assert any(m.get("customType") == "pi-voice.message" for m in state["messages"]), state["messages"]
        wait_state(context.request, control, lambda s: any("pi_observation" in json.dumps(e) for e in s["connections"][0]["sent"]))
        if LIVE:
            state = wait_state(context.request, control, lambda s: any("apple" in str(e.get("transcript", "")).lower() and "pear" in str(e.get("transcript", "")).lower() for e in s["connections"][0]["events"]), timeout=45)
            print("LIVE transcripts:", [e["transcript"] for e in state["connections"][0]["events"] if e.get("transcript")])
            # Take over with a real second WebRTC connection and restore voice context.
            other = context.new_page()
            other.on("dialog", lambda dialog: dialog.accept())
            other.goto(f"http://127.0.0.1:{info['port']}")
            other_chat = other.frame_locator("#chat")
            other_chat.locator("#start").click()
            expect(other_chat.locator("#status")).to_contain_text("Voice connected", timeout=40000)
            expect(chat.locator("#status")).to_contain_text("Voice disconnected", timeout=12000)
            state = wait_state(context.request, control, lambda s: len(s["connections"]) == 2 and s["connections"][0]["closed"])
            assert "apple.txt" in json.dumps(state["connections"][1]["sent"])
            context.request.post(control + "/ask")
            state = wait_state(context.request, control, lambda s: any("apple" in str(e.get("transcript", "")).lower() and "pear" in str(e.get("transcript", "")).lower() for e in s["connections"][1]["events"]), timeout=30)
            print("LIVE resumed transcripts:", [e["transcript"] for e in state["connections"][1]["events"] if e.get("transcript")])
            other_chat.locator("#hangup").click()
            wait_state(context.request, control, lambda s: s["connections"][1]["closed"])
            other.close()
        else:
            # Voice-private memory must survive device takeover and not enter Pi context.
            context.request.post(control + "/emit", data={"type":"response.function_call_arguments.done", "name":"save_voice_memory", "call_id":"memory-1", "arguments":json.dumps({"summary":"Private voice preference: compact explanations."})})
            other = context.new_page()
            other.on("dialog", lambda dialog: dialog.accept())
            other.goto(f"http://127.0.0.1:{info['port']}")
            other_chat = other.frame_locator("#chat")
            other_chat.locator("#start").click()
            expect(other_chat.locator("#status")).to_contain_text("Voice connected", timeout=15000)
            # Give Playwright's page loop time to deliver heartbeat/takeover cleanup.
            expect(chat.locator("#status")).to_contain_text("Voice disconnected", timeout=12000)
            assert page.evaluate("window.stoppedTracks") >= 1
            state = wait_state(context.request, control, lambda s: len(s["connections"]) == 2 and s["connections"][0]["closed"])
            assert "Private voice preference" in json.dumps(state["connections"][1]["sent"])
            assert "Private voice preference" not in json.dumps(state["messages"])
            # Automatic provider restart retains handover without resetting Pi.
            context.request.post(control + "/emit", data={"type":"response.function_call_arguments.done", "name":"restart_voice", "call_id":"restart", "arguments":json.dumps({"summary":"We discussed compact explanations."})})
            context.request.post(control + "/emit", data={"type":"response.done"})
            other.wait_for_timeout(4000)
            state = wait_state(context.request, control, lambda s: len(s["connections"]) == 3 and s["connections"][1]["closed"])
            assert "compact explanations" in json.dumps(state["connections"][2]["sent"])
            # Close the tab while Pi is busy: work completes, provider closes, no ack turn.
            context.request.post(control + "/pi")
            other.close()
            state = wait_state(context.request, control, lambda s: s["connections"][2]["closed"] and s["completions"] >= 2)
            assert state["completions"] == 2, "lifecycle must not trigger additional Pi turns"
            # Original device can reconnect to the same logical companion.
            chat.locator("#start").click()
            expect(chat.locator("#status")).to_contain_text("Voice connected")
            chat.locator("#hangup").click()
            wait_state(context.request, control, lambda s: s["connections"][-1]["closed"])
        assert not errors, errors
        page.screenshot(path="/tmp/pi-companion-browser.png", full_page=True)
        print("PASS:", "LIVE Azure/OpenAI native audio + sideband + Pi SDK + observed result speech + provider hangup" if LIVE else "mocked provider + real Pi SDK queue + takeover + private handover + restart + tab-close + uninterrupted Pi")
        browser.close()


with tempfile.TemporaryDirectory(prefix="pi-companion-browser-") as directory:
    env = {**os.environ, "PI_COMPANION_FIXTURE_DIR": directory}
    fixture = subprocess.Popen(["node", "--import", "tsx", ".ai/validation/companion-browser-fixture.ts"], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
    try:
        if not select.select([fixture.stdout], [], [], 30)[0]:
            raise TimeoutError("Fixture did not start")
        info = json.loads(fixture.stdout.readline())
        exercise(info)
    finally:
        fixture.terminate()
        try:
            fixture.wait(timeout=20)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
