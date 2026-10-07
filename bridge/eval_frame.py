"""Score frame_detector against the AprilTags on a recording.

    python bridge/eval_frame.py ~/petrifeye-recordings/<session> [...]

For every frame where all four tags were seen, the tag-based screen corners
(corners_px in frames.jsonl) are taken as the truth and compared with what
detect_frame finds in the same video frame. Reported per recording:

  found       frames where the frame detector returned a screen at all
  corner err  distance to the tag-based corners, in scene-camera pixels,
              and converted to SCREEN pixels (CSS px) using the screen's own
              size in that frame — the unit gaze error is felt in
  wrong       detections more than 20 camera px off: a different rectangle
"""
import json
import os
import sys

import av
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from frame_detector import detect_frame  # noqa: E402


def evaluate(rec):
    lines = [json.loads(l) for l in open(os.path.join(rec, "frames.jsonl"))]
    errs_cam, errs_screen, found, wrong, scored = [], [], 0, 0, 0
    found_without_tags = total_without_tags = 0
    with av.open(os.path.join(rec, "scene.mp4")) as c:
        for i, fr in enumerate(c.decode(video=0)):
            if i >= len(lines):
                break
            f = lines[i]
            gt = (f.get("surfaces") or {}).get("main", {}).get("corners_px")
            four = len(f.get("markers", [])) == 4 and gt and f.get("viewport")
            img = fr.to_ndarray(format="bgr24")
            det = detect_frame(img)
            if not four:
                total_without_tags += 1
                found_without_tags += det is not None
                continue
            scored += 1
            if det is None:
                continue
            found += 1
            gt = np.float64(gt)
            e = np.linalg.norm(det - gt, axis=1)
            if e.max() > 20:
                wrong += 1
                continue
            # camera px -> screen px: the viewport's width over its width in
            # the image, top and bottom edges averaged.
            W = f["viewport"][0]
            width_img = (np.linalg.norm(gt[1] - gt[0]) + np.linalg.norm(gt[2] - gt[3])) / 2
            errs_cam.append(e)
            errs_screen.append(e * W / width_img)
    name = os.path.basename(rec.rstrip("/"))
    if not scored:
        print(f"{name}: no frames with all four tags")
        return
    print(f"\n{name}")
    print(f"  frames with all 4 tags: {scored}   found: {found} ({100 * found / scored:.1f}%)   "
          f"wrong rectangle: {wrong}")
    if errs_cam:
        ec, es = np.concatenate(errs_cam), np.concatenate(errs_screen)
        print(f"  corner error, camera px: median {np.median(ec):.2f}   90th {np.percentile(ec, 90):.2f}   "
              f"max {ec.max():.2f}")
        print(f"  corner error, screen px: median {np.median(es):.1f}   90th {np.percentile(es, 90):.1f}   "
              f"max {es.max():.1f}")
    print(f"  frames WITHOUT 4 tags: {total_without_tags}, frame found in {found_without_tags} "
          f"(unscored — looking away, partial view, or a false find)")


if __name__ == "__main__":
    for rec in sys.argv[1:]:
        evaluate(os.path.expanduser(rec))
