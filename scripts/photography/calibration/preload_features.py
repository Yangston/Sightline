"""Download or locally verify the publishable calibration feature models."""

import argparse
from pathlib import Path

import torch
from lightglue import ALIKED, LightGlue, SuperPoint
from geoclip import GeoCLIP


REQUIRED_CHECKPOINTS = (
    "aliked-n16.pth",
    "aliked_lightglue_v0-1_arxiv.pth",
    "superpoint_lightglue_v0-1_arxiv.pth",
    "superpoint_v1.pth",
)


def verify_cached_models() -> None:
    checkpoint_dir = Path(torch.hub.get_dir()) / "checkpoints"
    missing = [
        filename
        for filename in REQUIRED_CHECKPOINTS
        if not (checkpoint_dir / filename).is_file()
        or (checkpoint_dir / filename).stat().st_size == 0
    ]
    if missing:
        raise RuntimeError(
            "Missing cached calibration checkpoints: "
            + ", ".join(missing)
            + ". Run `npm run photos:setup`."
        )
    model = GeoCLIP(from_pretrained=True).eval()
    if model.image_encoder is None or model.location_encoder is None:
        raise RuntimeError("GeoCLIP 1.2.0 and its CLIP encoder are unavailable.")
    print(f"ready: {len(REQUIRED_CHECKPOINTS)} cached calibration checkpoints")
    print("ready: geoclip-1.2.0 and openai/clip-vit-large-patch14")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify imports and cached checkpoints without loading or downloading models.",
    )
    args = parser.parse_args()
    if args.check:
        verify_cached_models()
        return

    extractors = {
        "superpoint": SuperPoint,
        "aliked": ALIKED,
    }
    for name, extractor in extractors.items():
        extractor(max_num_keypoints=2048).eval()
        LightGlue(features=name).eval()
        print(f"ready: lightglue-{name}")
    GeoCLIP(from_pretrained=True).eval()
    print("ready: geoclip-1.2.0 and openai/clip-vit-large-patch14")


if __name__ == "__main__":
    main()
