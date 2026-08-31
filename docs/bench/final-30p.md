# Load test — final-30p

- players: 30 · window: 41.6s · server pid: 23585
- server process: RSS avg 850 MB (min 784 / max 872) · CPU avg 35% of one core (max 80%) · samples 41

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 81 | 12 | 58 | 111 | 290 | 290 | 33 | 0 | 0 |
| auth_me | 51 | 11 | 33 | 45 | 126 | 126 | 19 | 0 | 0 |
| city_catalog | 65 | 14 | 67 | 124 | 257 | 257 | 33 | 0 | 0 |
| city_view | 127 | 18 | 79 | 167 | 258 | 610 | 39 | 0 | 0 |
| notifications | 79 | 15 | 91 | 193 | 216 | 216 | 34 | 0 | 0 |
| player_resources | 81 | 21 | 131 | 162 | 383 | 383 | 47 | 0 | 0 |
| player_state | 112 | 19 | 70 | 149 | 514 | 627 | 43 | 0 | 0 |
| season_ranking | 91 | 22 | 169 | 252 | 583 | 583 | 59 | 0 | 0 |
| season_view | 69 | 17 | 136 | 220 | 563 | 563 | 49 | 0 | 0 |
| train_cancel | 31 | 121 | 316 | 514 | 968 | 968 | 192 | 0 | 0 |

**Total measured ops:** 787 · errors: 0 · typed refusals: 0 · wall RPS: 18.9
