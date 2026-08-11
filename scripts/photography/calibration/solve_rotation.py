"""RANSAC/Wahba camera orientation from query/reference bearing pairs."""

from __future__ import annotations

import argparse
import json
from math import asin, atan2, cos, degrees, radians, sin, tan
from pathlib import Path

import cv2
import numpy as np


def rays(points, width, height, horizontal_fov, focal_scale=1.0):
    focal = width / (2 * tan(radians(horizontal_fov) / 2)) * focal_scale
    values = np.column_stack(((points[:, 0] - width / 2) / focal, (points[:, 1] - height / 2) / focal, np.ones(len(points))))
    return values / np.linalg.norm(values, axis=1, keepdims=True)


def camera_to_world(heading_deg, pitch_deg, roll_deg=0):
    heading, pitch, roll = map(radians, (heading_deg, pitch_deg, roll_deg))
    forward = np.array([sin(heading) * cos(pitch), cos(heading) * cos(pitch), sin(pitch)])
    right0 = np.cross(forward, np.array([0.0, 0.0, 1.0])); right0 /= np.linalg.norm(right0)
    up0 = np.cross(right0, forward)
    right = cos(roll) * right0 + sin(roll) * up0
    up = -sin(roll) * right0 + cos(roll) * up0
    return np.column_stack((right, -up, forward))


def fit_rotation(source, target):
    u, _, vt = np.linalg.svd(source.T @ target)
    rotation = vt.T @ u.T
    if np.linalg.det(rotation) < 0:
        vt[-1] *= -1
        rotation = vt.T @ u.T
    return rotation


def solve(request):
    query_points = np.asarray(request["queryPoints"], dtype=float)
    reference_points = np.asarray(request["referencePoints"], dtype=float)
    if len(query_points) < 8 or len(query_points) != len(reference_points):
        raise ValueError("At least eight paired bearings are required.")
    minimum_inliers = int(request.get("minimumInliers", 12))
    search_prior_only = bool(request.get("searchPriorOnly", False))
    if minimum_inliers < 8:
        raise ValueError("minimumInliers cannot be lower than eight.")
    qsize, rsize = request["querySize"], request["referenceSize"]
    reference_pose = request["referencePose"]
    reference_rotation = camera_to_world(reference_pose["headingDeg"], reference_pose["pitchDeg"], reference_pose.get("rollDeg", 0))
    reference_rays = rays(reference_points, rsize["width"], rsize["height"], request["referenceHorizontalFovDeg"])
    world_rays = (reference_rotation @ reference_rays.T).T
    homography, homography_mask = cv2.findHomography(
        query_points,
        reference_points,
        cv2.USAC_MAGSAC,
        3.0,
        None,
        10_000,
        0.999,
    )
    homography_indices = (
        np.flatnonzero(homography_mask.ravel())
        if homography_mask is not None
        else np.array([], dtype=int)
    )
    homography_rms = None
    homography_coverage = 0.0
    if homography is not None and len(homography_indices) >= 4:
        projected = cv2.perspectiveTransform(
            query_points.reshape(-1, 1, 2).astype(np.float32),
            homography,
        ).reshape(-1, 2)
        delta = projected[homography_indices] - reference_points[homography_indices]
        homography_rms = float(np.sqrt(np.mean(np.sum(delta * delta, axis=1))))
        homography_hull = cv2.convexHull(query_points[homography_indices].astype(np.float32))
        homography_coverage = float(cv2.contourArea(homography_hull) / (qsize["width"] * qsize["height"]))
    rng = np.random.default_rng(11)
    best = None
    for scale in ([1.0] if search_prior_only else np.linspace(0.72, 1.28, 15)):
        query_rays = rays(query_points, qsize["width"], qsize["height"], request["queryHorizontalFovDeg"], scale)
        for _ in range(300 if search_prior_only else 1500):
            sample = rng.choice(len(query_rays), 3, replace=False)
            rotation = fit_rotation(query_rays[sample], world_rays[sample])
            predicted = (rotation @ query_rays.T).T
            errors = np.degrees(np.arccos(np.clip(np.sum(predicted * world_rays, axis=1), -1, 1)))
            inliers = np.flatnonzero(errors < 2.5)
            if len(inliers) < 6:
                continue
            refined = fit_rotation(query_rays[inliers], world_rays[inliers])
            predicted = (refined @ query_rays.T).T
            errors = np.degrees(np.arccos(np.clip(np.sum(predicted * world_rays, axis=1), -1, 1)))
            inliers = np.flatnonzero(errors < 2.5)
            rms = float(np.sqrt(np.mean(errors[inliers] ** 2)))
            score = (len(inliers), -rms)
            if best is None or score > best[0]:
                best = (score, scale, refined, inliers, rms)
    if best is None:
        raise RuntimeError("Bearing RANSAC could not recover a stable orientation.")
    _, scale, rotation, inliers, rms = best
    fine_best = None
    minimum_refined_inliers = max(minimum_inliers, int(len(inliers) * 0.95))
    for refined_scale in ([scale] if search_prior_only else np.linspace(max(0.6, scale - 0.08), min(1.5, scale + 0.08), 81)):
        query_rays = rays(query_points, qsize["width"], qsize["height"], request["queryHorizontalFovDeg"], refined_scale)
        refined_rotation = fit_rotation(query_rays[inliers], world_rays[inliers])
        predicted = (refined_rotation @ query_rays.T).T
        errors = np.degrees(np.arccos(np.clip(np.sum(predicted * world_rays, axis=1), -1, 1)))
        refined_inliers = np.flatnonzero(errors < 2.5)
        if len(refined_inliers) < minimum_refined_inliers:
            continue
        refined_rotation = fit_rotation(query_rays[refined_inliers], world_rays[refined_inliers])
        predicted = (refined_rotation @ query_rays.T).T
        errors = np.degrees(np.arccos(np.clip(np.sum(predicted * world_rays, axis=1), -1, 1)))
        refined_rms = float(np.sqrt(np.mean(errors[refined_inliers] ** 2)))
        score = (-refined_rms, len(refined_inliers))
        if fine_best is None or score > fine_best[0]:
            fine_best = (score, refined_scale, refined_rotation, refined_inliers, refined_rms)
    if fine_best is not None:
        _, scale, rotation, inliers, rms = fine_best
    query_rays = rays(query_points, qsize["width"], qsize["height"], request["queryHorizontalFovDeg"], scale)
    reference_scale = 1.0
    reference_fine_best = None
    for refined_reference_scale in ([1.0] if search_prior_only else np.linspace(0.85, 1.15, 61)):
        refined_reference_rays = rays(reference_points, rsize["width"], rsize["height"], request["referenceHorizontalFovDeg"], refined_reference_scale)
        refined_world_rays = (reference_rotation @ refined_reference_rays.T).T
        refined_rotation = fit_rotation(query_rays[inliers], refined_world_rays[inliers])
        predicted = (refined_rotation @ query_rays.T).T
        errors = np.degrees(np.arccos(np.clip(np.sum(predicted * refined_world_rays, axis=1), -1, 1)))
        refined_inliers = np.flatnonzero(errors < 2.5)
        if len(refined_inliers) < minimum_refined_inliers:
            continue
        refined_rotation = fit_rotation(query_rays[refined_inliers], refined_world_rays[refined_inliers])
        predicted = (refined_rotation @ query_rays.T).T
        errors = np.degrees(np.arccos(np.clip(np.sum(predicted * refined_world_rays, axis=1), -1, 1)))
        refined_rms = float(np.sqrt(np.mean(errors[refined_inliers] ** 2)))
        score = (-refined_rms, len(refined_inliers))
        if reference_fine_best is None or score > reference_fine_best[0]:
            reference_fine_best = (score, refined_reference_scale, refined_world_rays, refined_rotation, refined_inliers, refined_rms)
    if reference_fine_best is not None:
        _, reference_scale, world_rays, rotation, inliers, rms = reference_fine_best
    homography_pose = (
        request.get("preferHomographyPose", False)
        and len(homography_indices) >= 100
        and len(homography_indices) / len(query_points) >= 0.75
        and homography_rms is not None
        and homography_rms <= 3.0
        and homography_coverage >= 0.08
    )
    if homography_pose:
        scale = 1.0
        reference_scale = 1.0
        query_rays = rays(query_points, qsize["width"], qsize["height"], request["queryHorizontalFovDeg"])
        reference_rays = rays(reference_points, rsize["width"], rsize["height"], request["referenceHorizontalFovDeg"])
        world_rays = (reference_rotation @ reference_rays.T).T
        rotation = fit_rotation(query_rays[homography_indices], world_rays[homography_indices])
        predicted = (rotation @ query_rays.T).T
        errors = np.degrees(np.arccos(np.clip(np.sum(predicted * world_rays, axis=1), -1, 1)))
        inliers = homography_indices[errors[homography_indices] < 2.5]
        rotation = fit_rotation(query_rays[inliers], world_rays[inliers])
        predicted = (rotation @ query_rays.T).T
        errors = np.degrees(np.arccos(np.clip(np.sum(predicted * world_rays, axis=1), -1, 1)))
        rms = float(np.sqrt(np.mean(errors[inliers] ** 2)))
    forward, right = rotation[:, 2], rotation[:, 0]
    heading = degrees(atan2(forward[0], forward[1])) % 360
    pitch = degrees(asin(float(np.clip(forward[2], -1, 1))))
    right0 = np.cross(forward, np.array([0.0, 0.0, 1.0])); right0 /= np.linalg.norm(right0)
    up0 = np.cross(right0, forward)
    roll = degrees(atan2(float(np.dot(right, up0)), float(np.dot(right, right0))))
    hull = cv2.convexHull(query_points[inliers].astype(np.float32))
    coverage = float(cv2.contourArea(hull) / (qsize["width"] * qsize["height"]))
    ratio = float(len(inliers) / len(query_points))
    accepted = len(inliers) >= minimum_inliers and ratio >= 0.5 and rms <= 2.0 and coverage >= 0.008
    horizontal_fov = degrees(2 * atan2(qsize["width"], 2 * (qsize["width"] / (2 * tan(radians(request["queryHorizontalFovDeg"]) / 2)) * scale)))
    vertical_fov = degrees(2 * atan2(qsize["height"], 2 * (qsize["width"] / (2 * tan(radians(request["queryHorizontalFovDeg"]) / 2)) * scale)))
    return {
        "accepted": accepted,
        "solutionMode": "bearing-rotation-with-gps-prior" if accepted else "rejected",
        "rejectionReasons": [] if accepted else ["bearing-orientation-quality-gate"],
        "position": request["prior"],
        "pose": {"headingDeg": heading, "pitchDeg": pitch, "rollDeg": roll},
        "optics": {"horizontalFovDeg": horizontal_fov, "verticalFovDeg": vertical_fov, "focalScale": float(scale), "referenceFocalScale": float(reference_scale)},
        "frustum": {"nearM": 1, "farM": 2000},
        "metrics": {"matches": int(len(query_points)), "inliers": int(len(inliers)), "inlierRatio": ratio, "rmsErrorPx": None, "angularRmsDeg": rms, "imageCoverage": coverage, "positionDeltaM": 0, "positiveDepthRatio": 1, "homographyInliers": int(len(homography_indices)), "homographyInlierRatio": float(len(homography_indices) / len(query_points)), "homographyRmsPx": homography_rms, "homographyCoverage": homography_coverage, "homographyPose": homography_pose},
    }


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("request", type=Path); args = parser.parse_args()
    print(json.dumps(solve(json.loads(args.request.read_text(encoding="utf-8")))))


if __name__ == "__main__":
    main()
