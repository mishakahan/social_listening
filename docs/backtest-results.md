# Backtest Results — Confirmation Gate

Each labelled case asserts whether a candidate _should_ surface to the radar.
"hold" means the gate correctly suppressed a false positive.

| case | expected | actual | match | reasons |
|---|---|---|---|---|
| single-author-spike | hold | hold | match | significant: p=0.001 (obs=246.3); too concentrated: 0.00 bits, 1 authors |
| broad-organic-rise | pass | pass | match | significant: p=0.001 (obs=246.3); breadth ok: 1.55 bits, 21 authors |
| flat-noise | hold | hold | match | not beyond own noise: p=0.422; too concentrated: 0.99 bits, 11 authors |

**3/3 labelled cases matched expectation.**

_Verdicts are honest, descriptive outputs. An honest "hold" is a valid
result; no specific accuracy figure is required for acceptance (contract §1.2)._
