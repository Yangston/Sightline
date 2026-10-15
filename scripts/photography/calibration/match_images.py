"""Match one photograph to ephemeral Cesium reference renders.

JSON request/response is used so the Node importer can keep provider imagery
outside the public tree. SuperPoint and ALIKED with LightGlue are the supported
publishing matchers.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np


def geometric_filter(points0: np.ndarray, points1: np.ndarray) -> tuple[np.ndarray, str]:
    if len(points0) < 8:
        return np.zeros(len(points0), dtype=bool), "insufficient"
    _, mask = cv2.findFundamentalMat(
        points0,
        points1,
        cv2.USAC_MAGSAC,
        2.5,
        0.999,
        10_000,
    )
    fundamental_mask = (
        mask.ravel().astype(bool)
        if mask is not None
        else np.zeros(len(points0), dtype=bool)
    )
    _, homography_mask = cv2.findHomography(
        points0,
        points1,
        cv2.USAC_MAGSAC,
        3.0,
        None,
        10_000,
        0.999,
    )
    homography_mask = (
        homography_mask.ravel().astype(bool)
        if homography_mask is not None
        else np.zeros(len(points0), dtype=bool)
    )
    if homography_mask.sum() > fundamental_mask.sum():
        return homography_mask, "homography"
    return fundamental_mask, "fundamental"


class LightGlueBackend:
    def __init__(self, max_keypoints: int, feature_type: str):
        import torch
        from lightglue import ALIKED, LightGlue, SuperPoint
        from lightglue.utils import load_image, rbd

        extractors = {"superpoint": SuperPoint, "aliked": ALIKED}
        if feature_type not in extractors:
            raise ValueError(f"Unsupported LightGlue feature type: {feature_type}")
        self.name = f"lightglue-{feature_type}"
        self.torch = torch
        self.load_image = load_image
        self.rbd = rbd
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.extractor = extractors[feature_type](max_num_keypoints=max_keypoints).eval().to(self.device)
        self.matcher = LightGlue(features=feature_type, depth_confidence=0.95, width_confidence=0.99).eval().to(self.device)

    def extract(self, filename: str):
        image = self.load_image(filename).to(self.device)
        with self.torch.inference_mode():
            return self.extractor.extract(image, resize=1600)

    def match(self, query, reference):
        with self.torch.inference_mode():
            result = self.matcher({"image0": query, "image1": reference})
        q, r, result = [self.rbd(value) for value in (query, reference, result)]
        pairs = result["matches"].detach().cpu().numpy()
        return (
            q["keypoints"].detach().cpu().numpy()[pairs[:, 0]],
            r["keypoints"].detach().cpu().numpy()[pairs[:, 1]],
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))
    try:
        import torch

        torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
        torch.set_num_interop_threads(1)
    except (ImportError, RuntimeError):
        pass
    try:
        max_keypoints = int(request.get("maxKeypoints", 4096))
        feature_type = str(request.get("featureType", "superpoint"))
        backend = LightGlueBackend(max_keypoints, feature_type)
    except (ImportError, ModuleNotFoundError) as error:
        raise RuntimeError(
            "LightGlue is unavailable. Run `npm run photos:setup`."
        ) from error

    query = backend.extract(request["query"])
    candidates = []
    for reference in request["references"]:
        ref_features = backend.extract(reference["path"])
        query_points, reference_points = backend.match(query, ref_features)
        mask, geometric_model = geometric_filter(query_points, reference_points)
        query_inliers = query_points[mask]
        reference_inliers = reference_points[mask]
        candidates.append(
            {
                "id": reference["id"],
                "rawMatches": int(len(query_points)),
                "geometricInliers": int(mask.sum()),
                "geometricModel": geometric_model,
                "queryPoints": query_inliers.tolist(),
                "referencePoints": reference_inliers.tolist(),
            }
        )
    candidates.sort(key=lambda item: item["geometricInliers"], reverse=True)
    candidate_limit = max(3, min(24, int(request.get("candidateLimit", 3))))
    print(json.dumps({"matcher": backend.name, "candidates": candidates[:candidate_limit]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # JSON error keeps the orchestrator actionable.
        print(json.dumps({"error": str(error)}))
        raise
