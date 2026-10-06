"""Protocol boundaries test without loading or substituting a model."""

import io
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from gliner_runtime import RequestError, safe_schema_text, serve, sigmoid, validate_request


class ProtocolTests(unittest.TestCase):
    def test_finite_native_logit_activation(self):
        self.assertEqual(sigmoid(0), 0.5)
        self.assertAlmostEqual(sigmoid(2) + sigmoid(-2), 1)
        self.assertEqual(sigmoid(-1000), 0)
        with self.assertRaises(RequestError):
            sigmoid(float("nan"))

    def test_validate_bounded_schema(self):
        request = {"text": "Synthetic passage", "heads": {"q": {"prompt": "Positive?",
                   "labels": {"yes": "Positive", "no": "Negative"}}}}
        self.assertEqual(validate_request(request)[0], request["text"])
        request["text"] = "x" * 65_537
        with self.assertRaises(RequestError) as failure:
            validate_request(request)
        self.assertEqual(failure.exception.code, "input_too_large")

    def test_marker_escaping_preserves_legible_text(self):
        self.assertEqual(safe_schema_text("Title (optional) [L]"), "Title （optional） ［L］")

    def test_errors_recover_without_echoing_state(self):
        class UnusedRuntime:
            max_input_tokens = 512

        output = io.StringIO()
        serve(UnusedRuntime(), io.StringIO('secret-invalid-json\n[]\n{"id":"end","action":"shutdown"}\n'), output)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(lines[0]["type"], "ready")
        self.assertEqual(lines[1]["error"]["message"], "Malformed JSON")
        self.assertEqual(lines[2]["error"]["code"], "invalid_request")
        self.assertEqual(lines[3], {"id": "end", "type": "shutdown"})
        self.assertNotIn("secret-invalid-json", output.getvalue())


if __name__ == "__main__":
    unittest.main()
