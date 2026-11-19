"""Compose four screenshots from capture-demo.mjs into the README animation (requires Pillow)."""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


STEPS = (
    ("01-open-review", "Open the calendar repair", "Check output is selected on a VibeCheck draft."),
    ("02-rehearsed", "Rehearse the change", "Try the signed candidate with a copy of the running state."),
    ("03-approved", "Approve Compare results", "The new control arrives in the same open draft."),
    ("04-results", "Compare both checkouts", "Four date cases turn green. Both timestamp controls still pass."),
)


def font(size, bold=False):
    for name in (("segoeuib.ttf", "DejaVuSans-Bold.ttf") if bold else ("segoeui.ttf", "DejaVuSans.ttf")):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frames", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    frames = []
    for index, (name, title, subtitle) in enumerate(STEPS):
        canvas = Image.new("RGB", (1024, 790), "#121815")
        draw = ImageDraw.Draw(canvas)
        for i in range(len(STEPS)):
            x = 48 + 235 * i
            draw.rounded_rectangle((x, 29, x + 224, 33), radius=2,
                                   fill="#d7f49b" if i <= index else "#333e36")
        draw.text((48, 52), title, fill="#f1f4ed", font=font(35, True))
        draw.text((50, 103), subtitle, fill="#b9c6bb", font=font(22))
        with Image.open(args.frames / (name + ".png")) as original:
            panel = original.convert("RGB")
            panel.thumbnail((914, 585), Image.Resampling.LANCZOS)
        x = (canvas.width - panel.width) // 2
        y = 155 + (585 - panel.height) // 2
        draw.rounded_rectangle((x - 4, y - 4, x + panel.width + 3, y + panel.height + 3),
                               radius=8, fill="#334136", outline="#435046")
        canvas.paste(panel, (x, y))
        draw.text((48, 749), "Morph Factory", fill="#aeb8af", font=font(16, True))
        draw.text((975, 749), "VibeCheck  /  6a2349d", fill="#aeb8af", font=font(16), anchor="ra")
        frames.append(canvas.convert("P", palette=Image.Palette.ADAPTIVE, colors=224))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(args.output, save_all=True, append_images=frames[1:], loop=0,
                   duration=[2900, 3200, 3500, 5000], optimize=False, disposal=2)


if __name__ == "__main__":
    main()
