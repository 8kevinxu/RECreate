#!/usr/bin/env python3
"""Generate all RECreate icon SVG variants — multi-activity map-pin design.

Layer structure follows Apple's Icon Composer guidance:
  group 1: background (gradient + faint street grid)
  group 2: pins (white teardrops)
  group 3: activity discs (basketball / swim / pickleball / yoga)

Variants: iOS light/dark/tinted, Android adaptive fg/bg/mono, splash, favicon.
"""
import math
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# disc colors per appearance; "gray" is the iOS tinted (mono) variant
COLORS = {
    "color": {
        "ball": ("#FFB25C", "#F07818", "#B85A10"),
        "pickle": ("#DDF054", "#A2C316", "#82A50A"),
        "swim": ("#4FD9E8", "#0F9EC4"),
        "yoga": ("#C9A2F5", "#9257E0"),
        "skin": "#F6CD9E",
        "cap": "#5FBD6D",
        "goggle": "#53D3E0",
        "sky": "#CFEBFA",
        "water": "#2E86D4",
        "wave": "#6FB6EC",
        "tank": "#E8556A",
        "dark": "#4A4A58",
        "land": "#F6F3EC",
        "street": "#FFFFFF",
        "road": "#F6C94B",
        "park": "#9FD983",
        "mwater": "#90CBF4",
        "slab": ("#1B4FA0", "#2C77D6"),
    },
    "gray": {
        "ball": ("#C2C2C2", "#9A9A9A", "#6E6E6E"),
        "pickle": ("#CCCCCC", "#A6A6A6", "#7d7d7d"),
        "swim": ("#B4B4B4", "#8E8E8E"),
        "yoga": ("#ABABAB", "#858585"),
        "skin": "#D2D2D2",
        "cap": "#8F8F8F",
        "goggle": "#C4C4C4",
        "sky": "#DCDCDC",
        "water": "#9A9A9A",
        "wave": "#B8B8B8",
        "tank": "#9E9E9E",
        "dark": "#6A6A6A",
        "land": "#EFEFEF",
        "street": "#FFFFFF",
        "road": "#C6C6C6",
        "park": "#D8D8D8",
        "mwater": "#BDBDBD",
        "slab": ("#767676", "#8C8C8C"),
    },
}

# Google-Maps-style light map: cream land, white streets, yellow avenue,
# green parks, water in the top-right corner, plus small "more spots" dots.
# brand-blue gradient background; the folded map is the subject on top
BG = '''
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5AA2FF"/>
        <stop offset="1" stop-color="#1D4EC2"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.12" r="0.9">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.25"/>
        <stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <rect width="1024" height="1024" fill="url(#glow)"/>'''

# 3D tilted map slab (per ref): isometric diamond top with street map, blue
# extruded sides. Map art lives in u,v space (0..1000) skewed by _MAT.
_T = (512, 298)   # diamond corners in screen space
_R = (930, 518)
_B = (512, 738)
_L = (94, 518)
_MA, _MB = 0.418, 0.22   # (u,v) -> screen: x = 512 + _MA*(u-v), y = 298 + _MB*(u+v)
_MAT = f"matrix({_MA} {_MB} {-_MA} {_MB} {_T[0]} {_T[1]})"
_THICK = 64              # slab extrusion depth


def iso_map(pal):
    slab_l, slab_r = pal["slab"]
    # top-surface street map in u,v space, clipped to the 1000x1000 sheet
    art = f'''
      <defs><clipPath id="mapClip"><rect width="1000" height="1000"/></clipPath></defs>
      <g transform="{_MAT}" clip-path="url(#mapClip)">
        <rect width="1000" height="1000" fill="{pal['land']}"/>
        <g stroke="{pal['street']}" stroke-width="24" fill="none">
          <path d="M 200 0 L 200 1000"/><path d="M 400 0 L 400 1000"/>
          <path d="M 600 0 L 600 1000"/><path d="M 800 0 L 800 1000"/>
          <path d="M 0 200 L 1000 200"/><path d="M 0 400 L 1000 400"/>
          <path d="M 0 600 L 1000 600"/><path d="M 0 800 L 1000 800"/>
        </g>
        <rect x="618" y="24" width="158" height="152" rx="16" fill="{pal['park']}"/>
        <rect x="24" y="418" width="152" height="158" rx="16" fill="{pal['park']}"/>
        <rect x="818" y="424" width="158" height="146" rx="16" fill="{pal['park']}"/>
        <g stroke="{pal['road']}" stroke-width="46" fill="none">
          <path d="M 500 0 L 500 1000"/>
          <path d="M 0 300 L 1000 300"/>
        </g>
        <path d="M 0 810 Q 250 756 500 822 T 1000 806 L 1000 1000 L 0 1000 Z"
              fill="{pal['mwater']}"/>
      </g>'''
    # extruded sides under the two front edges (L->B and B->R)
    sides = (f'<polygon points="{_L[0]},{_L[1]} {_B[0]},{_B[1]} {_B[0]},{_B[1] + _THICK} '
             f'{_L[0]},{_L[1] + _THICK}" fill="{slab_l}"/>'
             f'<polygon points="{_B[0]},{_B[1]} {_R[0]},{_R[1]} {_R[0]},{_R[1] + _THICK} '
             f'{_B[0]},{_B[1] + _THICK}" fill="{slab_r}"/>')
    return sides + art

SHADOW = '''
    <defs>
      <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#0A2560" flood-opacity="0.35"/>
      </filter>
    </defs>'''


def svg(body, size=1024):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 1024 1024">{body}</svg>')


def pin_shape(cx, cy, r, body="light"):
    """Teardrop map pin; head circle center (cx, cy), radius r."""
    grads = {
        "light": ("#FFFFFF", "#E9EFF9"),
        "blue": ("#3E7BE8", "#2050B8"),
        "gray": ("#8A8A8A", "#6E6E6E"),
        "flat": ("#FFFFFF", "#FFFFFF"),
    }
    top, bot = grads[body]
    gid = f"pinGrad{body}{cx}{cy}"
    return f'''
      <defs><linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bot}"/>
      </linearGradient></defs>
      <path d="M {cx} {cy + 1.95 * r}
               C {cx - 0.21 * r} {cy + 1.51 * r} {cx - 0.88 * r} {cy + 0.80 * r} {cx - 0.98 * r} {cy + 0.22 * r}
               A {r} {r} 0 1 1 {cx + 0.98 * r} {cy + 0.22 * r}
               C {cx + 0.88 * r} {cy + 0.80 * r} {cx + 0.21 * r} {cy + 1.51 * r} {cx} {cy + 1.95 * r} Z"
            fill="url(#{gid})"/>'''


def sheen(cx, cy, r):
    return f'''
      <defs><clipPath id="discClip{cx}{cy}"><circle cx="{cx}" cy="{cy}" r="{r}"/></clipPath></defs>
      <ellipse cx="{cx - 0.32 * r}" cy="{cy - 0.5 * r}" rx="{0.52 * r}" ry="{0.3 * r}"
               fill="#FFFFFF" opacity="0.13" clip-path="url(#discClip{cx}{cy})"/>'''


def ball(cx, cy, r, pal):
    hi, lo, seam = pal["ball"]
    sw = max(10, round(r * 0.14))
    return f'''
      <defs>
        <radialGradient id="ballGrad{cx}{cy}" cx="0.35" cy="0.3" r="1">
          <stop offset="0" stop-color="{hi}"/><stop offset="1" stop-color="{lo}"/>
        </radialGradient>
        <clipPath id="ballClip{cx}{cy}"><circle cx="{cx}" cy="{cy}" r="{r}"/></clipPath>
      </defs>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#ballGrad{cx}{cy})"/>
      <g stroke="{seam}" stroke-width="{sw}" fill="none" clip-path="url(#ballClip{cx}{cy})">
        <path d="M {cx} {cy - r} L {cx} {cy + r}"/>
        <path d="M {cx - r} {cy} L {cx + r} {cy}"/>
        <path d="M {cx - r * 0.63} {cy - r * 0.73} Q {cx} {cy} {cx - r * 0.63} {cy + r * 0.73}"/>
        <path d="M {cx + r * 0.63} {cy - r * 0.73} Q {cx} {cy} {cx + r * 0.63} {cy + r * 0.73}"/>
      </g>
      {sheen(cx, cy, r)}'''


def pickleball(cx, cy, r, pal):
    hi, lo, hole = pal["pickle"]
    holes = f'<circle cx="{cx}" cy="{cy}" r="{0.115 * r}" fill="{hole}"/>'
    for i in range(6):
        a = math.radians(i * 60 - 90)
        holes += (f'<circle cx="{cx + 0.52 * r * math.cos(a)}" cy="{cy + 0.52 * r * math.sin(a)}" '
                  f'r="{0.115 * r}" fill="{hole}"/>')
    return f'''
      <defs><radialGradient id="pkl{cx}{cy}" cx="0.35" cy="0.3" r="1">
        <stop offset="0" stop-color="{hi}"/><stop offset="1" stop-color="{lo}"/>
      </radialGradient></defs>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#pkl{cx}{cy})"/>{holes}{sheen(cx, cy, r)}'''


def swim(cx, cy, r, pal):
    """Cartoon freestyle swimmer (per flaticon ref): big head with cap + goggles,
    bent recovery arm elbow-up, back sliver above wavy water bands."""
    wl = cy + 0.21 * r  # nominal waterline y
    wave_amp = 0.08 * r
    def wavetop(y):
        return (f'M {cx - 1.1 * r} {y} '
                f'q {0.27 * r} {-wave_amp * 2} {0.55 * r} 0 '
                f't {0.55 * r} 0 t {0.55 * r} 0 t {0.55 * r} 0')
    return f'''
      <defs><clipPath id="swmClip{cx}{cy}"><circle cx="{cx}" cy="{cy}" r="{r}"/></clipPath></defs>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="{pal['sky']}"/>
      <g clip-path="url(#swmClip{cx}{cy})">
        <!-- back/shoulder mass connecting arm base to head above the water -->
        <ellipse cx="{cx + 0.1 * r}" cy="{cy + 0.2 * r}" rx="{0.26 * r}" ry="{0.16 * r}" fill="{pal['skin']}"/>
        <!-- head with cap + goggles -->
        <circle cx="{cx + 0.3 * r}" cy="{cy - 0.05 * r}" r="{0.2 * r}" fill="{pal['skin']}"/>
        <path d="M {cx + 0.1 * r} {cy - 0.08 * r} A {0.2 * r} {0.2 * r} 0 0 1 {cx + 0.5 * r} {cy - 0.08 * r} Z"
              fill="{pal['cap']}"/>
        <circle cx="{cx + 0.44 * r}" cy="{cy - 0.06 * r}" r="{0.055 * r}" fill="{pal['goggle']}"/>
        <!-- recovery arm: short arched stroke, hand about to enter the water -->
        <path d="M {cx + 0.02 * r} {cy + 0.12 * r} Q {cx - 0.32 * r} {cy - 0.42 * r} {cx - 0.54 * r} {cy + 0.10 * r}"
              stroke="{pal['skin']}" stroke-width="{0.16 * r}" fill="none" stroke-linecap="round"/>
        <!-- wavy water bands on top -->
        <path d="{wavetop(wl)} L {cx + 1.1 * r} {cy + 1.2 * r} L {cx - 1.1 * r} {cy + 1.2 * r} Z"
              fill="{pal['water']}"/>
        <path d="{wavetop(cy + 0.52 * r)}" stroke="{pal['wave']}" stroke-width="{0.1 * r}"
              fill="none" stroke-linecap="round"/>
      </g>
      {sheen(cx, cy, r)}'''


def yoga(cx, cy, r, pal):
    hi, lo = pal["yoga"]
    return f'''
      <defs><radialGradient id="yog{cx}{cy}" cx="0.35" cy="0.3" r="1">
        <stop offset="0" stop-color="{hi}"/><stop offset="1" stop-color="{lo}"/>
      </radialGradient></defs>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#yog{cx}{cy})"/>
      <!-- flat-illustration lotus: hair bun, face, tank top, skin arms to knees, crossed dark legs -->
      <g>
        <!-- crossed legs (behind torso), shins overlapping -->
        <path d="M {cx - 0.62 * r} {cy + 0.36 * r} Q {cx - 0.28 * r} {cy + 0.14 * r} {cx + 0.08 * r} {cy + 0.42 * r}"
              stroke="{pal['dark']}" stroke-width="{0.18 * r}" fill="none" stroke-linecap="round"/>
        <path d="M {cx + 0.62 * r} {cy + 0.36 * r} Q {cx + 0.28 * r} {cy + 0.14 * r} {cx - 0.08 * r} {cy + 0.42 * r}"
              stroke="{pal['dark']}" stroke-width="{0.18 * r}" fill="none" stroke-linecap="round"/>
        <!-- feet peeking at center -->
        <circle cx="{cx - 0.16 * r}" cy="{cy + 0.47 * r}" r="{0.075 * r}" fill="{pal['skin']}"/>
        <circle cx="{cx + 0.16 * r}" cy="{cy + 0.47 * r}" r="{0.075 * r}" fill="{pal['skin']}"/>
        <!-- arms resting out to the knees -->
        <path d="M {cx - 0.14 * r} {cy - 0.18 * r} Q {cx - 0.42 * r} {cy - 0.04 * r} {cx - 0.48 * r} {cy + 0.28 * r}"
              stroke="{pal['skin']}" stroke-width="{0.11 * r}" fill="none" stroke-linecap="round"/>
        <path d="M {cx + 0.14 * r} {cy - 0.18 * r} Q {cx + 0.42 * r} {cy - 0.04 * r} {cx + 0.48 * r} {cy + 0.28 * r}"
              stroke="{pal['skin']}" stroke-width="{0.11 * r}" fill="none" stroke-linecap="round"/>
        <!-- tank-top torso, slight waist -->
        <path d="M {cx - 0.13 * r} {cy - 0.34 * r}
                 C {cx - 0.2 * r} {cy - 0.14 * r} {cx - 0.22 * r} {cy + 0.02 * r} {cx - 0.19 * r} {cy + 0.3 * r}
                 L {cx + 0.19 * r} {cy + 0.3 * r}
                 C {cx + 0.22 * r} {cy + 0.02 * r} {cx + 0.2 * r} {cy - 0.14 * r} {cx + 0.13 * r} {cy - 0.34 * r}
                 Q {cx} {cy - 0.42 * r} {cx - 0.13 * r} {cy - 0.34 * r} Z"
              fill="{pal['tank']}"/>
        <!-- head: hair behind, face, top-knot bun -->
        <circle cx="{cx}" cy="{cy - 0.52 * r}" r="{0.185 * r}" fill="{pal['dark']}"/>
        <circle cx="{cx}" cy="{cy - 0.76 * r}" r="{0.085 * r}" fill="{pal['dark']}"/>
        <circle cx="{cx}" cy="{cy - 0.49 * r}" r="{0.155 * r}" fill="{pal['skin']}"/>
      </g>
      {sheen(cx, cy, r)}'''


# pin layout: (cx, cy, head_r, glyph_fn) — diamond arrangement echoing the
# map slab (back / left / right / front) so no pin covers another;
# ordered back-to-front (by tip y)
LAYOUT = [
    (500, 252, 90, ball),        # tip lands at (500, 428)
    (340, 352, 84, yoga),        # tip lands at (340, 516) — on land, clear of shore
    (726, 388, 84, swim),        # tip lands at (726, 552)
    (575, 484, 84, pickleball),  # tip lands at (575, 648) — on land, clear of shore
]


def ground(cx, cy, r):
    """Ellipse shadow under the pin tip, grounding it on the map (per ref)."""
    tip = cy + 1.95 * r
    return (f'<ellipse cx="{cx + 0.14 * r}" cy="{tip + 0.02 * r}" rx="{0.58 * r}" ry="{0.17 * r}" '
            f'fill="#1B2B4A" opacity="0.20"/>')


def pins(palette="color", body="light", glyphs=True, shadow=False, grounded=True,
         with_map=True, scale=1.0):
    """The icon subject: 3D tilted map slab with activity pins standing on it."""
    pal = COLORS[palette]
    parts = []
    if with_map:
        parts.append(iso_map(pal))
        for cx, cy, r, _ in LAYOUT:
            if grounded:
                parts.append(ground(cx, cy, r))
    for cx, cy, r, fn in LAYOUT:
        parts.append(pin_shape(cx, cy, r, body))
        if glyphs:
            parts.append(fn(cx, cy, 0.72 * r, pal))
    filt = ' filter="url(#soft)"' if shadow else ''
    tx = 512 * (1 - scale)
    return f'''{SHADOW if shadow else ''}
    <g transform="translate({tx} {tx}) scale({scale})"{filt}>{''.join(parts)}</g>'''


def hero_pin():
    """Single basketball pin — favicon-scale variant."""
    pal = COLORS["color"]
    return ('<g>' + ground(512, 430, 200)
            + pin_shape(512, 430, 200, "light") + ball(512, 430, 148, pal) + '</g>')


variants = {
    # iOS light (full-bleed; alpha flattened to RGB later)
    "icon-light": svg(BG + pins(body="blue", shadow=True)),
    # iOS dark: transparent bg, system supplies dark backdrop
    "icon-dark": svg(pins(body="blue")),
    # iOS tinted: grayscale on transparent, system tints by luminance
    "icon-tinted": svg(pins(palette="gray", body="gray")),
    # Android adaptive foreground: map + pins inside ~66% safe zone
    "android-fg": svg(pins(body="blue", scale=0.66)),
    # Android adaptive background: the gradient
    "android-bg": svg(BG),
    # Android monochrome: white silhouettes (map + pins merge into one mark)
    "android-mono": svg(pins(body="flat", glyphs=False, grounded=False, with_map=False, scale=0.60)),
    # Splash: colored map + blue-bodied pins on transparent (splash bg #E6F4FE)
    "splash": svg(pins(body="blue", scale=0.92)),
    # Favicon source: single basketball pin on gradient (legible at 16-48px)
    "favicon-src": svg(BG + hero_pin()),
}

for name, content in variants.items():
    with open(os.path.join(OUT, name + ".svg"), "w") as f:
        f.write(content)
    print("wrote", name + ".svg")
