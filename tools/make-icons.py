"""Draws the Gather mark and writes every icon size the site needs.
Run:  python tools/make-icons.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "icons")
G_TOP, G_BOT = (30, 158, 112), (10, 100, 72)   # brand gradient
CREAM, INK, GREEN = (247, 243, 236), (28, 31, 30), (18, 128, 95)

def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        c = tuple(round(G_TOP[i] + (G_BOT[i] - G_TOP[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = c
    return img

def mark(size, radius_frac=0.22, pad_frac=0.0, bg=True, square=True):
    """The logo: gradient rounded square with three overlapping circles."""
    S = 4  # supersample
    n = size * S
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    grad = gradient(n).convert("RGBA")
    mask = Image.new("L", (n, n), 0)
    pad = int(n * pad_frac)
    if bg and square:
        ImageDraw.Draw(mask).rounded_rectangle([pad, pad, n - pad, n - pad], radius=int((n - 2 * pad) * radius_frac), fill=255)
        canvas.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(canvas)
    # circle geometry in a 64-unit box, scaled to the inner area
    inner = n - 2 * pad
    u = inner / 64
    r = 11 * u
    ring = 3.2 * u
    circles = [(32, 25), (22, 42), (42, 42)]
    for cx, cy in circles:
        x, y = pad + cx * u, pad + cy * u
        # ring in the background colour, then the white disc
        ring_box = [x - r - ring, y - r - ring, x + r + ring, y + r + ring]
        ring_mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(ring_mask).ellipse(ring_box, fill=255)
        canvas.paste(grad if bg else Image.new("RGBA", (n, n), CREAM + (255,)), (0, 0), ring_mask)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255) if bg else GREEN + (255,))
    return canvas.resize((size, size), Image.LANCZOS)

def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print("wrote", name, img.size)

os.makedirs(OUT, exist_ok=True)
save(mark(512), "icon-512.png")
save(mark(192), "icon-192.png")
save(mark(180), "apple-touch-icon.png")
save(mark(32), "favicon-32.png")
# Maskable: solid gradient edge to edge, circles inside the safe zone.
m = gradient(512).convert("RGBA")
m.alpha_composite(mark(512, pad_frac=0.14, square=False))
save(m, "icon-maskable-512.png")

# Social preview 1200x630: cream, mark + wordmark + tagline
W, H = 1200, 630
so = Image.new("RGB", (W, H), CREAM)
d = ImageDraw.Draw(so)
so.paste(mark(200), (120, 160), mark(200))
def font(size, bold=True):
    for f in (["segoeuib.ttf"] if bold else ["segoeui.ttf"]):
        p = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", f)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()
d.text((360, 175), "Gather", fill=INK, font=font(112))
d.text((364, 325), "Video calls for friends and family.", fill=(90, 96, 94), font=font(44, bold=False))
d.text((364, 385), "Send a link, tap it, talk.", fill=(90, 96, 94), font=font(44, bold=False))
pill_font = font(26, bold=False)
pill_text = "No accounts, nothing to install"
tw = d.textbbox((0, 0), pill_text, font=pill_font)[2]
d.rounded_rectangle([364, 470, 364 + tw + 56, 530], radius=30, fill=GREEN)
d.text((392, 483), pill_text, fill=(255, 255, 255), font=pill_font)
so.save(os.path.join(OUT, "social.png"), optimize=True)
print("wrote social.png")
