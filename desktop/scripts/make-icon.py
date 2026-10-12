# Builds desktop/build/icon.png (1024 x 1024) from the Moonfin Leviathan sprite in
# assets/fish: the game has no icon art of its own. electron-builder turns this one
# PNG into the .icns, .ico and Linux icon sizes.
#
#   python3 desktop/scripts/make-icon.py
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SPRITE = ROOT / 'assets' / 'fish' / 'moonfin-leviathan.png'
OUT = ROOT / 'desktop' / 'build' / 'icon.png'

SIZE = 1024
MARGIN = 72  # macOS-style padding around the tile
RADIUS = 200
TOP = (12, 52, 92)  # sunlit water
BOTTOM = (3, 12, 30)  # the deep
GLOW = (64, 200, 255)


def main() -> None:
    # Vertical gradient, top to bottom.
    tile = Image.new('RGB', (SIZE, SIZE))
    draw = ImageDraw.Draw(tile)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        draw.line([(0, y), (SIZE, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))

    # A soft glow behind the fish.
    glow = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(glow).ellipse([SIZE * 0.2, SIZE * 0.25, SIZE * 0.8, SIZE * 0.75], fill=110)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    tile = Image.composite(Image.new('RGB', (SIZE, SIZE), GLOW), tile, glow)

    # The sprite's fish sits in the middle of a 512 px transparent square: crop to it, then scale up.
    fish = Image.open(SPRITE).convert('RGBA')
    fish = fish.crop(fish.getbbox())
    width = round((SIZE - 2 * MARGIN) * 0.78)
    fish = fish.resize((width, round(fish.height * width / fish.width)), Image.LANCZOS)
    tile = tile.convert('RGBA')
    tile.alpha_composite(fish, ((SIZE - fish.width) // 2, (SIZE - fish.height) // 2))

    # Rounded tile with a transparent margin.
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN], RADIUS, fill=255)
    icon = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(tile, (0, 0), mask)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUT, optimize=True)
    print(f'wrote {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
