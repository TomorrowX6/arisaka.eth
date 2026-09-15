# Public reference vectors

`nist-mlkem768.json` contains selected **public, synthetic** ML-KEM-768 vectors
from NIST's ACVP-Server `ML-KEM-encapDecap-FIPS203/internalProjection.json`.
The exact upstream Git revision and source URL are embedded in the fixture.

Cases 26 / 27 cover deterministic encapsulation, 86 valid decapsulation, 88
modified-ciphertext implicit rejection, 128 an invalid decapsulation-key hash,
and 137 noncanonical encapsulation-key coefficients. The independent reference
and the pinned producer are checked against these expected bytes, not merely
against one another. These test private keys are not deployment credentials.
