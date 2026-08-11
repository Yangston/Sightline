"""Score a fixed coordinate lattice from metadata-stripped pixels only."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch
from geoclip import GeoCLIP
from PIL import Image


ROTATIONS = (0, 90, 180, 270)


def rotated(image: Image.Image, degrees: int) -> Image.Image:
    if degrees == 0:
        return image.copy()
    transpose = {
        90: Image.Transpose.ROTATE_90,
        180: Image.Transpose.ROTATE_180,
        270: Image.Transpose.ROTATE_270,
    }
    return image.transpose(transpose[degrees])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    coordinates = request["coordinates"]
    if not coordinates:
        raise ValueError("The image-only coordinate lattice is empty.")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = GeoCLIP(from_pretrained=True).eval().to(device)
    locations = torch.tensor(
        [[item["latitude"], item["longitude"]] for item in coordinates],
        dtype=torch.float32,
        device=device,
    )
    with torch.inference_mode():
        location_features = torch.nn.functional.normalize(
            model.location_encoder(locations), dim=1
        )
        scale = model.logit_scale.exp()

    source = Image.open(request["pixelPath"]).convert("RGB")
    candidates = [rotated(source, degrees) for degrees in ROTATIONS]
    pixel_batch = torch.cat(
        [model.image_encoder.preprocess_image(candidate) for candidate in candidates],
        dim=0,
    ).to(device)
    with torch.inference_mode():
        image_features = torch.nn.functional.normalize(
            model.image_encoder(pixel_batch), dim=1
        )
        score_batch = scale * (image_features @ location_features.T)
    best = None
    rotation_scores = []
    for index, degrees in enumerate(ROTATIONS):
        scores = score_batch[index]
        maximum = float(scores.max().item())
        rotation_scores.append({"rotationDeg": degrees, "maximumScore": maximum})
        if best is None or maximum > best[0]:
            best = (
                maximum,
                degrees,
                candidates[index],
                scores.detach().cpu().tolist(),
            )

    assert best is not None
    _, degrees, selected, scores = best
    output_path = Path(request["rotatedOutputPath"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    selected.save(output_path, format="PNG", optimize=False)
    ranked = sorted(
        [
            {
                **coordinate,
                "score": float(scores[index]),
            }
            for index, coordinate in enumerate(coordinates)
        ],
        key=lambda item: item["score"],
        reverse=True,
    )
    print(
        json.dumps(
            {
                "pixelRotationDeg": degrees,
                "rotationScores": rotation_scores,
                "scoredCoordinates": ranked,
                "model": "geoclip-1.2.0",
            }
        )
    )


if __name__ == "__main__":
    main()
