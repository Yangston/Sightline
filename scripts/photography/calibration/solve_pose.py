"""Robust absolute camera pose from image pixels and WGS84 control points."""

from __future__ import annotations

import argparse
import json
from math import asin, atan2, degrees, radians, tan
from pathlib import Path

import cv2
import numpy as np

WGS84_A = 6378137.0
WGS84_E2 = 6.69437999014e-3


def geodetic_to_ecef(longitude: float, latitude: float, height: float) -> np.ndarray:
    lon, lat = radians(longitude), radians(latitude)
    sin_lat, cos_lat = np.sin(lat), np.cos(lat)
    n = WGS84_A / np.sqrt(1 - WGS84_E2 * sin_lat * sin_lat)
    return np.array([(n + height) * cos_lat * np.cos(lon), (n + height) * cos_lat * np.sin(lon), (n * (1 - WGS84_E2) + height) * sin_lat])


def ecef_to_geodetic(point: np.ndarray) -> tuple[float, float, float]:
    x, y, z = point
    lon = atan2(y, x)
    p = np.hypot(x, y)
    lat = atan2(z, p * (1 - WGS84_E2))
    for _ in range(8):
        n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
        height = p / np.cos(lat) - n
        lat = atan2(z, p * (1 - WGS84_E2 * n / (n + height)))
    n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
    height = p / np.cos(lat) - n
    return degrees(lon), degrees(lat), float(height)


def enu_rotation(longitude: float, latitude: float) -> np.ndarray:
    lon, lat = radians(longitude), radians(latitude)
    return np.array([[-np.sin(lon), np.cos(lon), 0], [-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)], [np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)]])


def reprojection_rms(objects, images, rvec, tvec, camera, indices) -> float:
    projected, _ = cv2.projectPoints(objects[indices], rvec, tvec, camera, np.zeros(5))
    delta = projected.reshape(-1, 2) - images[indices]
    return float(np.sqrt(np.mean(np.sum(delta * delta, axis=1))))


def refine_pose_and_focal(objects, images, indices, image_size, base_focal, camera, rvec, tvec, rms):
    flags = (
        cv2.CALIB_USE_INTRINSIC_GUESS
        | cv2.CALIB_FIX_PRINCIPAL_POINT
        | cv2.CALIB_FIX_ASPECT_RATIO
        | cv2.CALIB_ZERO_TANGENT_DIST
        | cv2.CALIB_FIX_K1
        | cv2.CALIB_FIX_K2
        | cv2.CALIB_FIX_K3
        | cv2.CALIB_FIX_K4
        | cv2.CALIB_FIX_K5
        | cv2.CALIB_FIX_K6
    )
    try:
        _, refined_camera, _, refined_rvecs, refined_tvecs = cv2.calibrateCamera(
            [objects[indices].astype(np.float32)],
            [images[indices].astype(np.float32)],
            image_size,
            camera.copy(),
            np.zeros(8),
            flags=flags,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-9),
        )
    except cv2.error:
        return camera, rvec, tvec, rms, camera[0, 0] / base_focal
    focal_scale = float(refined_camera[0, 0] / base_focal)
    if not 0.65 <= focal_scale <= 1.45:
        return camera, rvec, tvec, rms, camera[0, 0] / base_focal
    refined_rvec, refined_tvec = refined_rvecs[0], refined_tvecs[0]
    refined_rms = reprojection_rms(
        objects,
        images,
        refined_rvec,
        refined_tvec,
        refined_camera,
        indices,
    )
    if not np.isfinite(refined_rms) or refined_rms > rms:
        return camera, rvec, tvec, rms, camera[0, 0] / base_focal
    return (
        refined_camera,
        refined_rvec,
        refined_tvec,
        refined_rms,
        focal_scale,
    )


def classify_solution(metrics: dict, prior: dict, max_delta: float) -> tuple[bool, bool]:
    absolute_accepted = (
        metrics["inliers"] >= 12
        and metrics["inlierRatio"] >= 0.35
        and metrics["rmsErrorPx"] <= 6
        and metrics["imageCoverage"] >= 0.06
        and metrics["positionDeltaM"] <= max_delta
        and metrics["positiveDepthRatio"] >= 0.9
    )
    orientation_accepted = (
        not prior.get("coarse", False)
        and metrics["inliers"] >= 20
        and metrics["inlierRatio"] >= 0.25
        and metrics["rmsErrorPx"] <= 4
        and metrics["imageCoverage"] >= 0.015
        and metrics["positionDeltaM"] <= max_delta
        and metrics["positiveDepthRatio"] >= 0.9
    )
    return absolute_accepted, orientation_accepted


def solve(request: dict) -> dict:
    image_points = np.asarray(request["imagePoints"], dtype=np.float64)
    world = request["worldPoints"]
    prior = request["prior"]
    if len(image_points) < 8 or len(world) != len(image_points):
        raise ValueError("At least eight paired 2D/3D correspondences are required.")
    origin = geodetic_to_ecef(prior["longitude"], prior["latitude"], prior["altitudeM"])
    ecef_to_enu = enu_rotation(prior["longitude"], prior["latitude"])
    objects = np.asarray([ecef_to_enu @ (geodetic_to_ecef(p["longitude"], p["latitude"], p["altitudeM"]) - origin) for p in world], dtype=np.float64)
    width, height = request["imageSize"]["width"], request["imageSize"]["height"]
    base_focal = width / (2 * tan(radians(request["horizontalFovDeg"]) / 2))
    best = None
    for scale in np.linspace(0.72, 1.28, 15):
        focal = base_focal * scale
        camera = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1]], dtype=np.float64)
        ok, rvec, tvec, inliers = cv2.solvePnPRansac(objects, image_points, camera, np.zeros(5), flags=cv2.SOLVEPNP_EPNP, iterationsCount=5000, reprojectionError=6.0, confidence=0.999)
        if not ok or inliers is None or len(inliers) < 6:
            continue
        indices = inliers.ravel()
        rvec, tvec = cv2.solvePnPRefineLM(objects[indices], image_points[indices], camera, np.zeros(5), rvec, tvec)
        rms = reprojection_rms(objects, image_points, rvec, tvec, camera, indices)
        score = (len(indices), -rms)
        if best is None or score > best[0]:
            best = (score, scale, camera, rvec, tvec, indices, rms)
    if best is None:
        raise RuntimeError("RANSAC could not recover a stable absolute pose.")
    _, scale, camera, rvec, tvec, indices, rms = best
    camera, rvec, tvec, rms, scale = refine_pose_and_focal(
        objects,
        image_points,
        indices,
        (width, height),
        base_focal,
        camera,
        rvec,
        tvec,
        rms,
    )
    rotation, _ = cv2.Rodrigues(rvec)
    camera_to_world = rotation.T
    center_enu = (-camera_to_world @ tvec).ravel()
    center_ecef = origin + ecef_to_enu.T @ center_enu
    lon, lat, altitude = ecef_to_geodetic(center_ecef)
    forward = camera_to_world[:, 2]
    forward /= np.linalg.norm(forward)
    right = camera_to_world[:, 0]
    heading = degrees(atan2(forward[0], forward[1])) % 360
    pitch = degrees(asin(float(np.clip(forward[2], -1, 1))))
    right0 = np.cross(forward, np.array([0.0, 0.0, 1.0]))
    right0 /= max(np.linalg.norm(right0), 1e-9)
    up0 = np.cross(right0, forward)
    roll = degrees(atan2(float(np.dot(right, up0)), float(np.dot(right, right0))))
    hull = cv2.convexHull(image_points[indices].astype(np.float32))
    coverage = float(cv2.contourArea(hull) / (width * height))
    position_delta = float(np.linalg.norm(center_enu))
    depths = np.linalg.norm(objects[indices] - center_enu, axis=1)
    horizontal_fov = degrees(2 * atan2(width, 2 * camera[0, 0]))
    vertical_fov = degrees(2 * atan2(height, 2 * camera[1, 1]))
    metrics = {
        "matches": int(len(image_points)),
        "inliers": int(len(indices)),
        "inlierRatio": float(len(indices) / len(image_points)),
        "rmsErrorPx": rms,
        "imageCoverage": coverage,
        "positionDeltaM": position_delta,
        "positiveDepthRatio": float(np.mean((rotation @ objects.T + tvec).T[:, 2] > 0)),
    }
    max_delta = max(35.0, float(prior.get("horizontalAccuracyM", 10)) * 4)
    absolute_accepted, orientation_accepted = classify_solution(metrics, prior, max_delta)
    accepted = absolute_accepted or orientation_accepted
    solution_mode = "absolute-pose" if absolute_accepted else "orientation-with-gps-prior" if orientation_accepted else "rejected"
    output_position = {"longitude": lon, "latitude": lat, "altitudeM": altitude} if absolute_accepted else {"longitude": prior["longitude"], "latitude": prior["latitude"], "altitudeM": prior["altitudeM"]}
    return {
        "accepted": accepted,
        "solutionMode": solution_mode,
        "rejectionReasons": [] if accepted else [name for name, failed in {
            "too-few-inliers": metrics["inliers"] < 12,
            "low-inlier-ratio": metrics["inlierRatio"] < 0.35,
            "high-reprojection-error": rms > 6,
            "poor-image-coverage": coverage < 0.06,
            "excessive-gps-displacement": position_delta > max_delta,
            "failed-cheirality": metrics["positiveDepthRatio"] < 0.9,
            "coarse-prior-requires-absolute-pose": prior.get("coarse", False) and not absolute_accepted,
        }.items() if failed],
        "position": output_position,
        "pose": {"headingDeg": heading, "pitchDeg": pitch, "rollDeg": roll},
        "optics": {"horizontalFovDeg": horizontal_fov, "verticalFovDeg": vertical_fov, "focalScale": float(scale)},
        "frustum": {"nearM": max(0.25, float(np.percentile(depths, 5)) * 0.25), "farM": min(20_000, max(30, float(np.percentile(depths, 95)) * 1.35))},
        "metrics": metrics,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("request", type=Path)
    args = parser.parse_args()
    print(json.dumps(solve(json.loads(args.request.read_text(encoding="utf-8")))))


if __name__ == "__main__":
    main()
