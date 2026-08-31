# Load test — after-10p-writeengine

- players: 10 · window: 30.3s · server pid: 21419
- server process: RSS avg 861 MB (min 725 / max 986) · CPU avg 55% of one core (max 88%) · samples 30

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 103 | 86 | 133 | 152 | 245 | 249 | 88 | 0 | 0 |
| auth_me | 73 | 79 | 159 | 200 | 4335 | 4335 | 146 | 0 | 0 |
| city_catalog | 113 | 96 | 191 | 248 | 346 | 4324 | 148 | 0 | 0 |
| city_view | 157 | 123 | 267 | 349 | 714 | 4415 | 175 | 0 | 0 |
| notifications | 107 | 104 | 201 | 249 | 4334 | 4380 | 195 | 0 | 0 |
| player_resources | 133 | 129 | 259 | 316 | 602 | 4392 | 179 | 0 | 0 |
| player_state | 141 | 100 | 197 | 232 | 437 | 686 | 120 | 0 | 0 |
| season_ranking | 131 | 144 | 289 | 353 | 4349 | 4421 | 230 | 0 | 0 |
| season_view | 97 | 128 | 275 | 294 | 4403 | 4403 | 194 | 0 | 0 |
| train_cancel | 57 | 2195 | 3047 | 3197 | 6271 | 6271 | 2217 | 0 | 0 |

**Total measured ops:** 1112 · errors: 0 · typed refusals: 0 · wall RPS: 36.7
