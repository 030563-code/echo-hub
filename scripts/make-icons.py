"""Cut the E out of the Echo Barrier wordmark and render the app icons.

The source is a JPEG wordmark, so the letter is first binarised, then smoothed
by upscaling and re-thresholding, so the slanted corners come out as clean
diagonals instead of a staircase. Everything after that is rendered from that
one high-resolution mask.
"""
from PIL import Image

SRC = 'public/logo.jpg'
E_BOX = (8, 30, 124, 142)          # the E, measured off the wordmark
ORANGE = (255, 112, 38)            # --echo-orange
BLACK = (0, 0, 0)
WHITE = (255, 255, 255)


def letter_mask() -> Image.Image:
    """The E as a high-resolution alpha mask: white is ink."""
    e = Image.open(SRC).convert('L').crop(E_BOX)
    big = e.resize((e.width * 8, e.height * 8), Image.BICUBIC)
    return big.point(lambda v: 255 if v < 128 else 0)


MASK = letter_mask()


def icon(size: int, bg, ink, fraction: float) -> Image.Image:
    """One square tile: the E centred at `fraction` of the tile's width."""
    tile = Image.new('RGB', (size, size), bg)
    target_w = round(size * fraction)
    target_h = round(target_w * MASK.height / MASK.width)
    m = MASK.resize((target_w, target_h), Image.LANCZOS)
    layer = Image.new('RGB', (target_w, target_h), ink)
    tile.paste(layer, ((size - target_w) // 2, (size - target_h) // 2), m)
    return tile


if __name__ == '__main__':
    import sys
    variants = {
        'white': (WHITE, BLACK),
        'orange': (ORANGE, BLACK),
        'black': (BLACK, WHITE),
    }
    if sys.argv[1] == 'preview':
        pad = 24
        sheet = Image.new('RGB', (3 * 256 + 4 * pad, 256 + 2 * pad), (235, 235, 235))
        for i, (name, (bg, ink)) in enumerate(variants.items()):
            sheet.paste(icon(256, bg, ink, 0.66), (pad + i * (256 + pad), pad))
        sheet.save(sys.argv[2])
        print('preview written')
    else:
        bg, ink = variants[sys.argv[1]]
        # Normal icons: the letter at two thirds of the tile.
        icon(192, bg, ink, 0.66).save('public/icon-192.png')
        icon(512, bg, ink, 0.66).save('public/icon-512.png')
        # Maskable: Android crops to a circle, so the letter sits inside the
        # safe zone (the inner 80%), which for a square-ish mark is about half.
        icon(512, bg, ink, 0.52).save('public/icon-maskable-512.png')
        # iOS rounds the corners itself and does not honour transparency.
        icon(180, bg, ink, 0.62).save('src/app/apple-icon.png')
        # Next serves this as the favicon.
        icon(64, bg, ink, 0.72).save('src/app/icon.png')
        print('icons written:', sys.argv[1])
