# Battle Engine load test — battle-100p

- attacks: 100 · concurrency: 100 · defenders: 25 · server pid: 2771
- every attack is a REAL full-pipeline battle (validate → lock → energy → simulate → casualties → loot → notifications)
- server process: RSS avg 1131 MB (min 1094 / max 1165) · CPU avg 72% of one core (max 97%) · samples 4

| attacks | n | p50 | p90 | p95 | p99 | max | avg |
|---|---|---|---|---|---|---|---|
| POST /api/v1/battles/attack | 100 | 2831 | 4546 | 4749 | 4895 | 4927 | 2896 |

**Resolved battles (200):** 100/100 · wall time 4.9s · throughput 20.3 attacks/s

**Typed refusals:** none

**Errors (5xx/network):** none
