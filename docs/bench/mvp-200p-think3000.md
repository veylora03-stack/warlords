# Load test — mvp-200p-think3000

- players: 200 · window: 90.3s · server pid: 21419
- server process: RSS avg 933 MB (min 874 / max 951) · CPU avg 40% of one core (max 102%) · samples 90

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 223 | 335 | 3732 | 5185 | 17739 | 20729 | 1335 | 0 | 0 |
| auth_me | 143 | 275 | 1566 | 3593 | 17912 | 20499 | 945 | 0 | 0 |
| city_catalog | 203 | 355 | 2388 | 3673 | 12160 | 17775 | 972 | 0 | 0 |
| city_view | 324 | 490 | 4736 | 17866 | 20044 | 20814 | 2238 | 0 | 0 |
| notifications | 257 | 407 | 4353 | 12826 | 19807 | 20630 | 1746 | 0 | 0 |
| player_resources | 273 | 509 | 5711 | 19620 | 21009 | 24080 | 2674 | 0 | 0 |
| player_state | 319 | 433 | 3846 | 6656 | 20741 | 20941 | 1646 | 0 | 0 |
| season_ranking | 262 | 513 | 4789 | 19838 | 24182 | 26001 | 2522 | 0 | 0 |
| season_view | 242 | 518 | 4935 | 19163 | 21019 | 21258 | 2339 | 0 | 0 |
| train_cancel | 127 | 18829 | 41280 | 41523 | 43329 | 43559 | 23570 | 59 | 0 |

**Total measured ops:** 2373 · errors: 59 · typed refusals: 0 · wall RPS: 26.3
