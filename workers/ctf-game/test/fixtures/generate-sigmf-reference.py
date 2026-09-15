"""Regenerate synthetic cross-implementation anchors, not campaign evidence.

Optional maintenance environment: sigmf==1.2.6, numpy==2.5.3.
Run this file with that environment's Python; Node tests need only the JSON.
The official SDK reads the two NCD captures with autoscale=False; NumPy uses
complex128 for the negative-exponent, unscaled DFT. All input data is authored
here. No third-party recording or implementation is copied into the fixture.
"""
import base64
import hashlib
import json
import pathlib
import struct
import tempfile

import numpy as np
import sigmf


def main():
    raw = bytearray(b"ABC")
    expected = []
    for n in range(32):
        if n == 16:
            raw.extend(b"VWXYZ")
        i, q = n * 17 - 256, n * 31 % 1024 - 512
        raw.extend(struct.pack(">hh", i, q))
        expected.extend([i, q])
    raw.extend(b"TAIL")
    metadata = {
        "global": {
            "core:datatype": "ci16_be", "core:version": "1.2.6",
            "core:dataset": "ncd.dat", "core:sample_rate": 32000,
            "core:trailing_bytes": 4, "core:sha512": hashlib.sha512(raw).hexdigest(),
        },
        "captures": [
            {"core:sample_start": 0, "core:header_bytes": 3, "core:frequency": 915000000},
            {"core:sample_start": 16, "core:header_bytes": 5},
        ],
        "annotations": [{"core:sample_start": 3, "core:sample_count": 4, "core:label": "Synthetic reference"}],
    }
    with tempfile.TemporaryDirectory(prefix="sigmf-reference-") as directory:
        path = pathlib.Path(directory) / "ncd.dat"
        path.write_bytes(raw)
        record = sigmf.SigMFFile(metadata=metadata, data_file=str(path))
        record.validate()
        samples = np.concatenate([record.read_samples_in_capture(i, autoscale=False) for i in range(2)])
        pairs = [component for sample in samples for component in [float(sample.real), float(sample.imag)]]
        assert pairs == expected
        fft = np.fft.fft(samples.astype(np.complex128))
        fixture = {
            "provenance": {
                "source": "Synthetic test data authored for this repository; independently read by the official SigMF Python SDK. No third-party recording or code is embedded.",
                "sdk": "sigmf " + sigmf.__version__,
                "sdkSource": "https://github.com/sigmf/SigMF/tree/v1.2.6",
                "numpy": np.__version__, "autoscale": False,
                "method": "read_samples_in_capture, concatenate, cast complex128; numpy.fft.fft (unscaled, negative exponent)",
            },
            "metadata": metadata, "datasetBase64": base64.b64encode(raw).decode(),
            "samples": pairs,
            "captureByteRanges": [list(record.get_capture_byte_boundarys(i)) for i in range(2)],
            "dft": [component for value in fft for component in [float(value.real), float(value.imag)]],
        }
        pathlib.Path(__file__).with_name("sigmf-reference.json").write_text(json.dumps(fixture, indent=2) + "\n")


if __name__ == "__main__":
    main()
