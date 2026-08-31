# Load test — after-10p-final

- players: 10 · window: 30.5s · server pid: 18974
- server process: RSS avg 760 MB (min 553 / max 852) · CPU avg 62% of one core (max 87%) · samples 30

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 114 | 97 | 180 | 217 | 280 | 339 | 107 | 0 | 0 |
| auth_me | 80 | 93 | 165 | 194 | 715 | 715 | 110 | 0 | 0 |
| city_catalog | 106 | 91 | 202 | 238 | 286 | 493 | 108 | 0 | 0 |
| city_view | 167 | 115 | 218 | 242 | 427 | 734 | 134 | 0 | 0 |
| notifications | 108 | 115 | 203 | 210 | 261 | 722 | 126 | 0 | 0 |
| player_resources | 108 | 137 | 223 | 255 | 292 | 313 | 145 | 0 | 0 |
| player_state | 183 | 204 | 318 | 337 | 705 | 812 | 220 | 0 | 0 |
| season_ranking | 129 | 134 | 246 | 297 | 636 | 638 | 153 | 0 | 0 |
| season_view | 112 | 145 | 228 | 273 | 373 | 770 | 158 | 0 | 0 |
| train_cancel | 63 | 2264 | 2991 | 3292 | 3729 | 3729 | 2226 | 0 | 0 |

**Total measured ops:** 1170 · errors: 0 · typed refusals: 0 · wall RPS: 38.4
