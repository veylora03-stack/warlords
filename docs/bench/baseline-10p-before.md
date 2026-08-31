# Load test — baseline-10p-before

- players: 10 · window: 45.3s · server pid: 16903
- server process: RSS avg 431 MB (min 399 / max 470) · CPU avg 2% of one core (max 32%) · samples 45

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 4 | 108 | 10029 | 10029 | 10029 | 10029 | 3803 | 0 | 0 |
| city_catalog | 3 | 117 | 5021 | 5021 | 5021 | 5021 | 1751 | 0 | 0 |
| city_view | 7 | 10032 | 25092 | 25092 | 25092 | 25092 | 11510 | 0 | 0 |
| notifications | 3 | 5033 | 5097 | 5097 | 5097 | 5097 | 3418 | 0 | 0 |
| player_resources | 1 | 150 | 150 | 150 | 150 | 150 | 150 | 0 | 0 |
| player_state | 3 | 30001 | 30001 | 30001 | 30001 | 30001 | 21715 | 2 | 0 |
| season_ranking | 2 | 30001 | 30001 | 30001 | 30001 | 30001 | 30001 | 2 | 0 |
| season_view | 1 | 30002 | 30002 | 30002 | 30002 | 30002 | 30002 | 1 | 0 |
| train_cancel | 3 | 30001 | 30002 | 30002 | 30002 | 30002 | 30001 | 3 | 0 |

**Total measured ops:** 27 · errors: 8 · typed refusals: 0 · wall RPS: 0.6
