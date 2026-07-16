# Icon source

Vector source for all app icons (assets/icon*.png, android-icon-*.png, splash-icon.png, favicon.png).
Edit gen.py, run `python3 gen.py` to regenerate the SVGs, render each at 1024x1024
(e.g. headless Chrome --screenshot), and export PNGs per the paths in app.json.
Layered per Apple's Icon Composer guidance: background gradient / runner glyph / ball accent.
