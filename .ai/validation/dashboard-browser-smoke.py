"""Opt-in browser smoke; synthetic Pi messages and mocked WebRTC, no provider charges.
Run with uv run --no-project --with playwright python <this-file>.
Install Chromium with the same uv environment's `python -m playwright install chromium`.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def exercise(port):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("""
          window.parent.stoppedTracks ||= 0;
          if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
            const track = { stop(){window.parent.stoppedTracks++}, getSettings(){return {echoCancellation:true,noiseSuppression:true,autoGainControl:true}} };
            return { getAudioTracks(){return [track]}, getTracks(){return [track]} };
          };
          window.RTCPeerConnection = class {
            connectionState='connected'; addTrack(){} async createOffer(){return {sdp:'test'}} async setLocalDescription(){}
            createDataChannel(){this.dc=new EventTarget();this.dc.readyState='connecting';this.dc.send=()=>{};this.dc.close=()=>{this.dc.readyState='closed';this.dc.dispatchEvent(new Event('close'))};return this.dc;}
            async setRemoteDescription(){this.dc.readyState='open';this.dc.dispatchEvent(new Event('open'));} close(){}
          };
        """)
        held = []
        pause = False
        def answer(route):
            if pause:
                held.append(route)
            else:
                route.fulfill(status=200, body="test-sdp")
        page.route("https://voice.invalid/calls", answer)
        page.goto(f"http://127.0.0.1:{port}")
        page.locator("#agents option").nth(1).wait_for(state="attached")
        chat = page.frame_locator("#chat")
        chat.locator(".message").first.wait_for()
        assert chat.locator("details").evaluate_all("elements => elements.every(e => !e.open)")
        assert "unsafe()" in chat.locator("#messages").inner_text()
        chat.locator("#message").fill("A typed message without a call")
        chat.locator("#send").click()
        chat.locator(".message").filter(has_text="Received: A typed message without a call").wait_for()
        assert "voice off" in chat.locator("#status").inner_text()
        assert page.evaluate("window.stoppedTracks") == 0
        chat.locator("#start").click()
        chat.get_by_text("Voice connected · test-mini", exact=True).wait_for()
        assert chat.locator("#start").is_disabled()
        options = page.locator("#agents option").evaluate_all("options => options.map(o => o.value)")
        selected = page.locator("#agents").input_value()
        target = next(value for value in options if value != selected)
        page.on("dialog", lambda dialog: dialog.accept())
        page.locator("#agents").select_option(target)
        chat.locator(".message").first.wait_for()
        page.wait_for_timeout(300)
        assert page.evaluate("window.stoppedTracks") >= 1
        assert "voice off" in chat.locator("#status").inner_text()
        assert chat.locator("details").evaluate_all("elements => elements.every(e => !e.open)")
        # A delayed SDP response must not revive a call after the user ends it.
        pause = True
        with page.expect_request("https://voice.invalid/calls"):
            chat.locator("#start").click()
        page.wait_for_timeout(100)
        assert chat.locator("#start").is_disabled()
        chat.locator("#hangup").click()
        assert page.evaluate("window.stoppedTracks") >= 2
        held[0].fulfill(status=200, body="test-sdp")
        page.wait_for_timeout(100)
        assert "voice off" in chat.locator("#status").inner_text()
        assert chat.locator("#start").is_enabled()
        page.screenshot(path=os.environ.get("PI_AGENTS_SCREENSHOT", "/tmp/pi-agents-mobile.png"), full_page=True)
        assert not errors, errors
        browser.close()


with tempfile.TemporaryDirectory(prefix="pi-agents-browser-") as directory:
    env = {**os.environ, "PI_CODING_AGENT_DIR": directory, "PI_REALTIME_WEB_PORT": "0"}
    fixture = subprocess.Popen(
        ["node", "--import", "tsx", ".ai/validation/dashboard-browser-fixture.mjs"],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True,
    )
    try:
        port = json.loads(fixture.stdout.readline())["port"]
        exercise(port)
        print("PASS: mobile chat, safe text, typed chat without mic, mocked call, switching releases mic, debug collapsed")
    finally:
        fixture.terminate()
        try:
            fixture.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fixture.kill()
            fixture.wait()
