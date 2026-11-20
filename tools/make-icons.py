"""Draw GetLow's app icons (a speaker cone on a dark tile) as PNG and SVG.

No imaging library needed: every pixel's colour comes from its distance to
each ring, with a one-pixel soft edge. Run from anywhere:

    python tools/make-icons.py

Writes icons/icon-192.png, icon-512.png, maskable-512.png (full bleed, the
cone inside the 80% safe zone), apple-touch-icon.png (180, full bleed) and
icon.svg (for the browser tab).
"""
import math, os, struct, zlib

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'icons')

BG = (13, 13, 13)          # --page (dark)
TILE = (26, 26, 25)        # --surface-1 (dark)
BLUE = (57, 135, 229)      # --accent (dark)
CONE = (44, 44, 42)
CONE_LIT = (70, 70, 66)
CAP = (57, 135, 229)

# rings from the outside in: (radius as a fraction of the tile, colour)
def rings(scale):
    s = scale
    return [
        (0.40 * s, BLUE),       # surround
        (0.345 * s, CONE_LIT),  # cone edge
        (0.33 * s, CONE),       # cone
        (0.13 * s, BLUE),       # dust cap edge
        (0.115 * s, CAP),       # dust cap
    ]


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw(size, full_bleed, scale):
    """RGBA rows. full_bleed: square background; otherwise a rounded tile on transparent."""
    rows = []
    c = (size - 1) / 2
    rad = size * 0.22               # tile corner radius
    half = size / 2
    rs = rings(scale)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            dx, dy = x - c, y - c
            # background tile coverage
            if full_bleed:
                a_bg = 1.0
            else:
                qx, qy = max(abs(dx) - (half - rad), 0), max(abs(dy) - (half - rad), 0)
                d = math.hypot(qx, qy) - rad
                a_bg = min(1.0, max(0.0, 0.5 - d))
            col = BG if full_bleed else TILE
            r = math.hypot(dx, dy) / size
            # cone shading: a little lighter toward the top left
            for R, rc in rs:
                edge = (R - r) * size          # pixels inside the ring
                t = min(1.0, max(0.0, edge + 0.5))
                if t > 0:
                    cc = rc
                    if rc is CONE:
                        lit = max(0.0, min(1.0, 0.5 - (dx + dy) / (size * 0.9)))
                        cc = mix(CONE, CONE_LIT, lit * 0.6)
                    col = mix(col, cc, t)
            row += bytes((col[0], col[1], col[2], round(255 * a_bg)))
        rows.append(bytes(row))
    return rows


def png(path, size, rows):
    raw = b''.join(b'\x00' + r for r in rows)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + \
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(data)


def svg(path):
    rs = rings(1.0)
    circles = ''.join(f'<circle cx="50" cy="50" r="{R * 100:.2f}" fill="rgb{col}"/>' for R, col in rs)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
                f'<rect width="100" height="100" rx="22" fill="rgb{TILE}"/>{circles}</svg>\n')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    png(os.path.join(OUT, 'icon-192.png'), 192, draw(192, False, 1.0))
    png(os.path.join(OUT, 'icon-512.png'), 512, draw(512, False, 1.0))
    # maskable: the platform crops to its own shape, so keep the cone inside the middle 80%
    png(os.path.join(OUT, 'maskable-512.png'), 512, draw(512, True, 0.8))
    png(os.path.join(OUT, 'apple-touch-icon.png'), 180, draw(180, True, 0.9))
    svg(os.path.join(OUT, 'icon.svg'))
    print('icons written to', OUT)
