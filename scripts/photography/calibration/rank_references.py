"""Rank ephemeral provider views with GeoCLIP's pinned CLIP image encoder."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import torch
from geoclip import GeoCLIP
from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = GeoCLIP(from_pretrained=True).eval().to(device)

    def embed_many(filenames: list[str]) -> torch.Tensor:
        pixels = torch.cat(
            [
                model.image_encoder.preprocess_image(
                    Image.open(filename).convert("RGB")
                )
                for filename in filenames
            ],
            dim=0,
        ).to(device)
        with torch.inference_mode():
            return torch.nn.functional.normalize(
                model.image_encoder(pixels), dim=1
            )

    query = embed_many([request["query"]])[0]
    ranked = []
    references = request["references"]
    for start in range(0, len(references), 8):
        chunk = references[start : start + 8]
        embeddings = embed_many([reference["path"] for reference in chunk])
        scores = embeddings @ query
        ranked.extend(
            {
                "id": reference["id"],
                "score": float(scores[index].item()),
            }
            for index, reference in enumerate(chunk)
        )
    ranked.sort(key=lambda item: item["score"], reverse=True)
    limit = max(1, min(24, int(request.get("limit", 24))))
    print(json.dumps({"model": "geoclip-clip-image-encoder-1.2.0", "ranked": ranked[:limit]}))


if __name__ == "__main__":
    main()
