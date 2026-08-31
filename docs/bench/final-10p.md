# Load test — final-10p

- players: 10 · window: 33.7s · server pid: 23585
- server process: RSS avg 855 MB (min 660 / max 1009) · CPU avg 56% of one core (max 98%) · samples 33

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 90 | 83 | 166 | 272 | 3620 | 3620 | 144 | 0 | 0 |
| auth_me | 82 | 86 | 186 | 400 | 507 | 507 | 113 | 0 | 0 |
| city_catalog | 90 | 94 | 171 | 213 | 597 | 597 | 108 | 0 | 0 |
| city_view | 180 | 109 | 210 | 267 | 514 | 731 | 131 | 0 | 0 |
| notifications | 106 | 101 | 205 | 243 | 332 | 500 | 122 | 0 | 0 |
| player_resources | 112 | 132 | 248 | 365 | 506 | 520 | 156 | 0 | 0 |
| player_state | 151 | 108 | 187 | 229 | 304 | 375 | 120 | 0 | 0 |
| season_ranking | 116 | 122 | 227 | 320 | 752 | 3739 | 178 | 0 | 0 |
| season_view | 122 | 136 | 219 | 262 | 364 | 364 | 144 | 0 | 0 |
| train_cancel | 65 | 2614 | 3492 | 4377 | 5493 | 5493 | 2806 | 0 | 0 |

**Total measured ops:** 1114 · errors: 0 · typed refusals: 0 · wall RPS: 33.0
