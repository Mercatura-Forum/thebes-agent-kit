#!/usr/bin/env python3
"""The phone half of a device-link sign-in, for the live sign-in test.

Opens the approve link on the live Memphis connect page in a phone-sized
browser with a virtual passkey, creates a new identity there (one passkey and
the recovery phrase, as a person new to Thebes does), types the code and
approves. Prints one JSON line: {"ok": bool, "said": <the page's last message>,
"handle": <the identity's handle>}.

    python3 phone.py <approve_url> <code>

Needs Playwright for Python with Chromium. The steps and element ids are the
ones memphis-connect's own end-to-end test drives (e2e_device_link.py D2-D5).
Attribution: Thebes Core Team. Licence: Apache 2.0.
"""
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

APP_ORIGIN = "https://thebesprotocol.com"


def main():
    url, code = sys.argv[1], sys.argv[2]
    if not re.fullmatch(r"https://memphis\.mercaturaforum\.com/connect/#link=[0-9a-f]{64}", url):
        print(json.dumps({"ok": False, "said": "not a connect link: " + url}))
        return 2
    stem = f"mcp-live-{int(time.time()) % 1000000}"
    out = {"ok": False, "said": "", "handle": stem + ".thebes"}
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        s = ctx.new_cdp_session(page)
        s.send("WebAuthn.enable", {"enableUI": False})
        s.send("WebAuthn.addVirtualAuthenticator", {"options": {
            "protocol": "ctap2", "transport": "internal", "hasResidentKey": True, "hasUserVerification": True,
            "isUserVerified": True, "automaticPresenceSimulation": True}})

        def said(pattern, seconds=150):
            for _ in range(seconds * 2):
                cls, text = page.evaluate("() => { const m = document.getElementById('msg'); return m ? [m.className, m.innerText] : ['', ''] }")
                if re.search(pattern, text, re.I) and "msg--busy" not in cls:
                    return text
                page.wait_for_timeout(500)
            return text

        page.goto(url, wait_until="load", timeout=60000)
        page.wait_for_function("() => document.getElementById('linkOrigin').innerText.startsWith('https://')", timeout=60000)
        origin = page.inner_text("#linkOrigin")
        if origin != APP_ORIGIN:
            out["said"] = "the phone shows origin " + origin
            print(json.dumps(out))
            return 1
        page.click("#linkCreate")
        page.fill("#linkHandle", stem)
        page.click("#linkNewGo")
        page.wait_for_selector("#phraseStep:not([hidden])", timeout=60000)
        page.check("#phraseOk")
        page.click("#phraseGo")
        created = said(r"is created|nothing was created|error|refused")
        if "is created" not in created:
            out["said"] = created
            print(json.dumps(out))
            return 1
        page.fill("#linkCode", code)
        page.click("#linkGo")
        out["said"] = said(r"approved|does not match|ended|refused")
        out["ok"] = out["said"].startswith("Approved") and APP_ORIGIN in out["said"]
        b.close()
    print(json.dumps(out))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
