# Battle Engine load test — battle-500p

- attacks: 500 · concurrency: 500 · defenders: 125 · server pid: 2771
- every attack is a REAL full-pipeline battle (validate → lock → energy → simulate → casualties → loot → notifications)
- server process: RSS avg 1539 MB (min 1498 / max 1596) · CPU avg 99% of one core (max 127%) · samples 25

| attacks | n | p50 | p90 | p95 | p99 | max | avg |
|---|---|---|---|---|---|---|---|
| POST /api/v1/battles/attack | 500 | 15174 | 23329 | 24329 | 25152 | 25334 | 14067 |

**Resolved battles (200):** 500/500 · wall time 25.3s · throughput 19.7 attacks/s

**Typed refusals:** none

**Errors (5xx/network):** none
