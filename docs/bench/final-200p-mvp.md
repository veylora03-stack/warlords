# Load test — final-200p-mvp

- players: 200 · window: 91.1s · server pid: 23585
- server process: RSS avg 950 MB (min 724 / max 1165) · CPU avg 39% of one core (max 101%) · samples 91

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 211 | 280 | 2581 | 6984 | 30000 | 30001 | 1695 | 5 | 0 |
| auth_me | 182 | 245 | 1600 | 2663 | 30001 | 30002 | 939 | 2 | 0 |
| city_catalog | 215 | 265 | 2060 | 3094 | 22918 | 30001 | 1130 | 2 | 0 |
| city_view | 299 | 405 | 13771 | 30001 | 30001 | 30004 | 3272 | 19 | 0 |
| notifications | 258 | 279 | 3218 | 26076 | 30001 | 30001 | 2254 | 11 | 0 |
| player_resources | 250 | 325 | 1699 | 28854 | 30001 | 30002 | 2331 | 11 | 0 |
| player_state | 329 | 336 | 2364 | 4532 | 30001 | 30002 | 1535 | 8 | 0 |
| season_ranking | 324 | 411 | 2158 | 30001 | 30002 | 30002 | 2983 | 23 | 0 |
| season_view | 237 | 435 | 3162 | 30001 | 30002 | 30003 | 3269 | 21 | 0 |
| train_cancel | 129 | 22893 | 38842 | 39329 | 39748 | 39768 | 25047 | 58 | 0 |

**Total measured ops:** 2434 · errors: 160 · typed refusals: 0 · wall RPS: 26.7
