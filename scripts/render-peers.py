"""Caption and encode the real frames from capture-peers.mjs (optional Pillow dependency)."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

CAPTIONS = [
    "Two reviewers have the same VibeCheck patch open.",
    "The operator approves Compare results.",
    "Both open tabs receive the new control.",
    "The operator runs the product check once.",
    "Both reviewers see the same four fixes and two unchanged controls.",
    "The operator restores the original review.",
    "The draft stays open. Each reviewer keeps their selected pane.",
]


def font(size, bold=False):
    names = ("segoeuib.ttf", "DejaVuSans-Bold.ttf") if bold else ("segoeui.ttf", "DejaVuSans.ttf")
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def compose(directory, data, width, height):
    margin, gutter = 22, 16
    canvas = Image.new("RGB", (margin * 2 + gutter + width * 2, height + 127), "#111512")
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, 12), "MORPH FACTORY  /  VIBECHECK", font=font(15, True), fill="#c9e99b")
    draw.text((margin, 37), CAPTIONS[data["caption"]], font=font(27, True), fill="#f3f5ee")
    for idx, (key, label) in enumerate([("left", "Operator"), ("right", "Peer reviewer")]):
        x = margin + idx * (width + gutter)
        draw.text((x, 82), label, font=font(17, True), fill="#c6cec3")
        draw.rectangle((x - 1, 108, x + width, 109 + height), fill="#191d1a", outline="#485348")
        with Image.open(directory / data[key]) as original:
            panel = original.convert("RGB")
            if panel.width != width:
                panel = panel.resize((width, round(panel.height * width / panel.width)), Image.Resampling.LANCZOS)
            canvas.paste(panel.crop((0, 0, width, min(height, panel.height))), (x, 109))
    return canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frames", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads((args.frames / "frames.json").read_text(encoding="utf-8"))
    captures = data["frames"]
    assert data["operatorPosts"] == 1 and data["peerPosts"] == 0
    assert data["fixed"] == 4 and data["unchanged"] == 2
    with Image.open(args.frames / captures[0]["left"]) as first:
        width = first.width
    rendered, durations = [], []
    previous = None
    for i, entry in enumerate(captures):
        frame = compose(args.frames, entry, width, 500)
        next_at = captures[i + 1]["at"] if i + 1 < len(captures) else data["duration"]
        duration = max(10, 10 * (round(next_at / 10) - round(entry["at"] / 10)))
        if previous is not None and ImageChops.difference(frame, previous).getbbox() is None:
            durations[-1] += duration
            continue
        rendered.append(frame.convert("P", palette=Image.Palette.ADAPTIVE, colors=224))
        durations.append(duration)
        previous = frame
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered[0].save(args.output, save_all=True, append_images=rendered[1:], duration=durations, loop=0,
                     disposal=1, optimize=True)
    print(f"{len(captures)} sampled pairs, {len(rendered)} distinct frames, "
          f"{sum(durations) / 1000:.2f} seconds, {args.output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
