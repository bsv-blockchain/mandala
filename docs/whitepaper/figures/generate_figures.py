#!/usr/bin/env python3
"""Geometric figures for the Mandala whitepaper. Exact labels, no decoration."""
from math import cos, sin, pi
from PIL import Image, ImageDraw, ImageFont

INK = (28, 20, 12, 255)
GOLD = (138, 106, 42, 255)
GOLD_SOFT = (196, 163, 90, 255)
PAPER = (255, 255, 255, 255)
CREAM = (247, 241, 227, 255)
RULE = (90, 70, 36, 255)
MUTED = (90, 78, 64, 255)
ADMIT = (45, 90, 61, 255)

W_PAGE = 1800  # ~6.5in at 277 dpi


def font(size, bold=False):
    path = "/System/Library/Fonts/Supplemental/Palatino.ttc"
    idx = 1 if bold else 0
    try:
        return ImageFont.truetype(path, size=size, index=idx)
    except OSError:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", size=size)


def text_size(draw, s, f):
    b = draw.textbbox((0, 0), s, font=f)
    return b[2] - b[0], b[3] - b[1]


def center_text(draw, xy, s, f, fill=INK):
    w, h = text_size(draw, s, f)
    draw.text((xy[0] - w / 2, xy[1] - h / 2), s, font=f, fill=fill)


def rounded_rect(draw, box, r, fill=None, outline=INK, width=2):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def draw_mandala(draw, cx, cy, r, rings=4, spokes=12, color=GOLD, width=2):
    for i in range(1, rings + 1):
        rr = r * i / rings
        draw.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=color, width=width)
    for i in range(spokes):
        a = 2 * pi * i / spokes
        draw.line((cx, cy, cx + r * cos(a), cy + r * sin(a)), fill=color, width=1)
    # inner diamond
    d = r * 0.28
    pts = [(cx, cy - d), (cx + d, cy), (cx, cy + d), (cx - d, cy)]
    draw.polygon(pts, outline=color)
    draw.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=color)


def emblem():
    s = 512
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = cy = s / 2
    draw_mandala(d, cx, cy, 210, rings=5, spokes=16, color=GOLD, width=3)
    draw_mandala(d, cx, cy, 210, rings=5, spokes=8, color=GOLD_SOFT, width=1)
    im.save("emblem.png")


def split_figure():
    w, h = W_PAGE, 720
    im = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(im)
    f_h = font(28, True)
    f_b = font(22)
    f_s = font(18)
    f_c = font(16)

    # Title
    center_text(d, (w / 2, 36), "What consensus decides, and what it does not", f_h)

    # Transaction in the middle
    tx = (w / 2 - 140, 90, w / 2 + 140, 190)
    rounded_rect(d, tx, 12, fill=CREAM, outline=GOLD, width=3)
    center_text(d, (w / 2, 122), "Transaction T", f_h, GOLD)
    center_text(d, (w / 2, 158), "scripts  ·  satoshis  ·  tokens", f_s, MUTED)

    # Two columns
    left = (48, 240, w / 2 - 36, 680)
    right = (w / 2 + 36, 240, w - 48, 680)
    rounded_rect(d, left, 16, fill=CREAM, outline=INK, width=2)
    rounded_rect(d, right, 16, fill=CREAM, outline=GOLD, width=3)

    center_text(d, ((left[0] + left[2]) / 2, 280), "Bitcoin SV consensus", f_h)
    center_text(d, ((right[0] + right[2]) / 2, 280), "Mandala overlay", f_h, GOLD)

    left_items = [
        "Unlocking scripts evaluate true",
        "Each satoshi is spent at most once",
        "Merkle inclusion in a block",
        "",
        "Does not read assetId or amount",
        "Will mine an inflationary token tx",
    ]
    right_items = [
        "Σ a_out  =  Σ a_in  +  Δ_auth",
        "Specific linkage binds identity",
        "Registration admit / revoke",
        "Pause, freeze, sanctions",
        "Threshold issuance spend",
        "Signs σ_I over txid(T) on admit",
    ]
    y0 = 330
    for i, line in enumerate(left_items):
        if not line:
            continue
        d.text((left[0] + 36, y0 + i * 48), "·  " + line, font=f_b, fill=INK)
    for i, line in enumerate(right_items):
        d.text((right[0] + 36, y0 + i * 48), "·  " + line, font=f_b, fill=INK)

    # arrows from T
    d.line((w / 2 - 80, 190, (left[0] + left[2]) / 2, 240), fill=INK, width=2)
    d.line((w / 2 + 80, 190, (right[0] + right[2]) / 2, 240), fill=GOLD, width=2)

    im.save("fig-split.png")


def chains_figure():
    w, h = W_PAGE, 780
    im = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(im)
    f_h = font(26, True)
    f_b = font(20)
    f_s = font(16)

    center_text(d, (w / 2, 32), "Two hash-linked administrative chains", f_h)

    def chain(y, title, subtitle, nodes, accent):
        d.text((48, y), title, font=f_h, fill=accent)
        d.text((48, y + 36), subtitle, font=f_s, fill=MUTED)
        n = len(nodes)
        x0, x1 = 48, w - 48
        box_w = 250
        gap = (x1 - x0 - n * box_w) / (n - 1)
        by = y + 80
        bh = 88
        centers = []
        for i, (name, sub) in enumerate(nodes):
            x = x0 + i * (box_w + gap)
            rounded_rect(d, (x, by, x + box_w, by + bh), 10, fill=CREAM, outline=accent, width=2)
            center_text(d, (x + box_w / 2, by + 28), name, f_b, accent)
            center_text(d, (x + box_w / 2, by + 60), sub, f_s, MUTED)
            centers.append(x + box_w / 2)
            if i:
                px = x0 + (i - 1) * (box_w + gap) + box_w
                d.line((px, by + bh / 2, x, by + bh / 2), fill=accent, width=2)
                # arrow head
                d.polygon(
                    [(x, by + bh / 2), (x - 12, by + bh / 2 - 7), (x - 12, by + bh / 2 + 7)],
                    fill=accent,
                )
        # n → n+1 caption
        d.text((x0, by + bh + 16), "each spend consumes authorized outpoint n and produces n + 1", font=f_s, fill=MUTED)

    chain(
        70,
        "Issuance  (per asset)",
        "Public function of supply. Genesis outpoint is the assetId.",
        [
            ("Genesis", "assetId = txid || vout"),
            ("Issue / redeem", "Δ_auth = ± amount"),
            ("Freeze / reissue", "evict, then mint equal"),
            ("Rotation", "new threshold at height h"),
        ],
        GOLD,
    )
    chain(
        430,
        "Registration  (per issuer)",
        "Public function of membership. Identity keys are not pushed on-chain.",
        [
            ("Admit", "bound key, keyID = H(event)"),
            ("Revoke", "same form, opposite event"),
            ("Replay", "database is a cache"),
            ("Open", "regulator + event object"),
        ],
        INK,
    )
    im.save("fig-chains.png")


def keys_figure():
    w, h = W_PAGE, 820
    im = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(im)
    f_h = font(26, True)
    f_b = font(20)
    f_s = font(17)
    f_m = font(22)

    center_text(d, (w / 2, 32), "From identity keys to a one-time output key", f_h)

    # three stages as columns
    stages = [
        ("1. Identities", "A = aG\nB = bG\nι agreed"),
        ("2. Shared secret", "S = aB = bA\n= (ab)G"),
        ("3. Per-invoice offset", "k = HMAC(S, ι)  mod n\nH = kG"),
        ("4. Output key", "P_out = B + H\nb_out = b + k"),
    ]
    n = len(stages)
    box_w = 360
    x0 = 40
    gap = (w - 80 - n * box_w) / (n - 1)
    by, bh = 90, 170
    for i, (title, body) in enumerate(stages):
        x = x0 + i * (box_w + gap)
        rounded_rect(d, (x, by, x + box_w, by + bh), 12, fill=CREAM, outline=GOLD if i == 3 else INK, width=2)
        center_text(d, (x + box_w / 2, by + 28), title, f_h, GOLD if i == 3 else INK)
        lines = body.split("\n")
        for j, line in enumerate(lines):
            center_text(d, (x + box_w / 2, by + 78 + j * 32), line, f_m)
        if i:
            px = x0 + (i - 1) * (box_w + gap) + box_w
            d.line((px, by + bh / 2, x, by + bh / 2), fill=GOLD, width=2)
            d.polygon([(x, by + bh / 2), (x - 12, by + bh / 2 - 7), (x - 12, by + bh / 2 + 7)], fill=GOLD)

    # bottom: what is revealed
    rounded_rect(d, (40, 300, w - 40, 780), 14, fill=CREAM, outline=INK, width=2)
    d.text((64, 320), "What the mined output reveals, and what it does not", font=f_h, fill=INK)

    cols = [
        ("On the chain", INK, [
            "HASH160(P_out)  — a fingerprint of a one-time key",
            "amount a  and  assetId  (dropped, then P2PKH)",
            "one satoshi",
        ]),
        ("To the overlay, encrypted", GOLD, [
            "k  — the offset for this output only",
            "counterparty identity B",
            "Never S. S would re-derive every child.",
        ]),
        ("To the recipient", MUTED, [
            "Blinded sender key  A′ = A + rG",
            "invoice ι, so they can compute b_out",
            "Not A. Consecutive payments do not join.",
        ]),
    ]
    cw = (w - 80 - 48) / 3
    for i, (title, color, items) in enumerate(cols):
        x = 64 + i * (cw + 16)
        d.text((x, 380), title, font=f_h, fill=color)
        for j, it in enumerate(items):
            d.text((x, 430 + j * 90), it, font=f_b, fill=INK)

    im.save("fig-keys.png")


def transfer_figure():
    w, h = W_PAGE, 700
    im = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(im)
    f_h = font(26, True)
    f_b = font(20)
    f_s = font(16)

    center_text(d, (w / 2, 32), "A transfer: who learns the sender", f_h)

    # Alice box, overlay box, Bob box
    boxes = [
        (48, 90, 560, 280, "Alice  (sender)", "Spends coins already bound to her.\nPresents A′ = A + rG to Bob.\nEncrypts k to the overlay."),
        (620, 90, 1180, 280, "Overlay", "Input linkage already names Alice.\nOutput linkage names Bob, checks\nHASH160(B + kG) = h.  Signs σ_I."),
        (1240, 90, 1752, 280, "Bob  (recipient)", "Derives against A′, not A.\nUnlocks with b_out = b + k.\nCannot join Alice’s later payments."),
    ]
    for x0, y0, x1, y1, title, body in boxes:
        rounded_rect(d, (x0, y0, x1, y1), 12, fill=CREAM, outline=GOLD if "Overlay" in title else INK, width=2)
        center_text(d, ((x0 + x1) / 2, y0 + 32), title, f_h, GOLD if "Overlay" in title else INK)
        lines = body.split("\n")
        for j, line in enumerate(lines):
            center_text(d, ((x0 + x1) / 2, y0 + 84 + j * 36), line, f_b)

    # arrows
    d.line((560, 185, 620, 185), fill=GOLD, width=2)
    d.polygon([(620, 185), (608, 178), (608, 192)], fill=GOLD)
    d.line((1180, 185, 1240, 185), fill=GOLD, width=2)
    d.polygon([(1240, 185), (1228, 178), (1228, 192)], fill=GOLD)

    # table
    d.text((48, 330), "If Bob is shown A, he can recompute every future child against Alice. Blinding A′ breaks that join without hiding Alice from the overlay.", font=f_b, fill=INK)

    headers = ["", "Chain", "Overlay", "Bob", "Alice"]
    rows = [
        ["A  (Alice’s identity)", "—", "from input linkage", "no, sees A′", "yes"],
        ["B  (Bob’s identity)", "—", "from output linkage", "yes", "yes"],
        ["k  (this output)", "—", "yes, encrypted", "computes it", "yes"],
        ["S = aB  (root secret)", "—", "no", "no (uses A′)", "yes, with r"],
        ["σ_I  (admit signature)", "—", "produces it", "carries it offline", "receives it"],
    ]
    col_w = [420, 220, 380, 300, 280]
    x0, y0 = 48, 390
    # header
    x = x0
    for i, hd in enumerate(headers):
        d.rectangle((x, y0, x + col_w[i], y0 + 44), fill=CREAM)
        d.text((x + 10, y0 + 10), hd, font=f_s, fill=GOLD)
        x += col_w[i]
    for r, row in enumerate(rows):
        y = y0 + 44 + r * 48
        x = x0
        if r % 2 == 0:
            d.rectangle((x0, y, x0 + sum(col_w), y + 48), fill=(252, 249, 242))
        for i, cell in enumerate(row):
            d.text((x + 10, y + 12), cell, font=f_s, fill=INK)
            x += col_w[i]
    d.line((x0, y0, x0 + sum(col_w), y0), fill=GOLD, width=2)
    d.line((x0, y0 + 44, x0 + sum(col_w), y0 + 44), fill=GOLD, width=1)

    im.save("fig-transfer.png")


if __name__ == "__main__":
    import os
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    emblem()
    split_figure()
    chains_figure()
    keys_figure()
    transfer_figure()
    print("wrote emblem, fig-split, fig-chains, fig-keys, fig-transfer")
