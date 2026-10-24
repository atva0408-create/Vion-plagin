# The YAMNet classes behind VION's audio labels: a doorbell rang as "Doorbell" or "Ding-dong" and was nothing, while any
# door sound ("Door") and the clink of a glass ("Glass") were a doorbell and a break-in (audit 2026-10-23, F5).
# Run: python -m unittest discover -s spec
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from defaults import YAMNET_TO_LABEL  # noqa: E402
from detector import build_detections  # noqa: E402

LISTEN = {"doorbell", "glass_break", "dog_bark"}


def labels(*scores: tuple[str, float]) -> list[str]:
    return sorted(d["attribute"] for d in build_detections(scores, LISTEN, 0.5))


class YamnetClasses(unittest.TestCase):
    def test_a_doorbell_is_a_doorbell(self) -> None:
        self.assertEqual(labels(("Doorbell", 0.9)), ["doorbell"])
        self.assertEqual(labels(("Ding-dong", 0.9)), ["doorbell"])
        self.assertEqual(labels(("Knock", 0.9)), ["doorbell"], "a knock at the door: someone is there too")

    def test_a_door_is_no_doorbell(self) -> None:
        self.assertEqual(labels(("Door", 0.9), ("Sliding door", 0.9)), [])

    def test_shattering_glass_is_a_break_and_a_glass_is_not(self) -> None:
        self.assertEqual(labels(("Shatter", 0.9)), ["glass_break"])
        self.assertEqual(labels(("Breaking", 0.9)), ["glass_break"])
        self.assertEqual(labels(("Glass", 0.9)), [], "a glass set down or clinked is no break-in")

    def test_the_best_score_of_a_label_wins(self) -> None:
        found = build_detections([("Doorbell", 0.6), ("Ding-dong", 0.8), ("Bark", 0.4)], LISTEN, 0.5)
        self.assertEqual([(d["attribute"], d["confidence"]) for d in found], [("doorbell", 0.8)])

    def test_every_mapped_class_is_a_yamnet_class(self) -> None:
        # the names YAMNet's class map (yamnet_class_map.csv, 521 classes) spells them
        known = {
            "Speech",
            "Bark",
            "Dog",
            "Cat",
            "Siren",
            "Fire alarm",
            "Alarm",
            "Car alarm",
            "Shatter",
            "Breaking",
            "Gunshot, gunfire",
            "Screaming",
            "Yell",
            "Crying, sobbing",
            "Baby cry, infant cry",
            "Smoke detector, smoke alarm",
            "Doorbell",
            "Ding-dong",
            "Knock",
        }
        self.assertEqual(set(YAMNET_TO_LABEL) - known, set(), "a class YAMNet does not report never fires")


if __name__ == "__main__":
    unittest.main()
