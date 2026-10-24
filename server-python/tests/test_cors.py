from __future__ import annotations

import unittest
from unittest.mock import patch

from app import is_allowed_origin


class CorsTests(unittest.TestCase):
    def test_configured_frontend_and_original_local_origins_are_allowed(self) -> None:
        with patch.dict("os.environ", {"CLIENT_ORIGIN": "https://ghost-rush.example"}):
            self.assertTrue(is_allowed_origin("https://ghost-rush.example"))
            self.assertTrue(is_allowed_origin("http://localhost:5173"))
            self.assertTrue(is_allowed_origin("http://127.0.0.1:5173"))
            self.assertTrue(is_allowed_origin("http://192.168.1.24:5173"))
            self.assertTrue(is_allowed_origin("http://10.12.0.4:5173"))
            self.assertTrue(is_allowed_origin("http://172.20.4.8:5173"))

    def test_unconfigured_or_non_local_origins_are_rejected(self) -> None:
        with patch.dict("os.environ", {"CLIENT_ORIGIN": "https://ghost-rush.example"}):
            self.assertFalse(is_allowed_origin("https://attacker.example"))
            self.assertFalse(is_allowed_origin("http://192.168.1.24:5174"))
            self.assertFalse(is_allowed_origin("https://localhost:5173"))
            self.assertTrue(is_allowed_origin(None))


if __name__ == "__main__":
    unittest.main()
