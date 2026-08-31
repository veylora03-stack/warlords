# Load test — final-100p

- players: 100 · window: 52.9s · server pid: 23585
- server process: RSS avg 884 MB (min 874 / max 906) · CPU avg 64% of one core (max 122%) · samples 52

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 185 | 243 | 1106 | 2838 | 3778 | 3925 | 506 | 0 | 0 |
| auth_me | 147 | 198 | 718 | 1742 | 3010 | 3474 | 375 | 0 | 0 |
| city_catalog | 171 | 217 | 872 | 1758 | 3460 | 3622 | 432 | 0 | 0 |
| city_view | 297 | 301 | 903 | 1868 | 3376 | 4313 | 487 | 0 | 0 |
| notifications | 204 | 209 | 858 | 2226 | 3335 | 4175 | 433 | 0 | 0 |
| player_resources | 178 | 332 | 945 | 3173 | 3989 | 4329 | 561 | 0 | 0 |
| player_state | 272 | 270 | 977 | 2454 | 3697 | 3936 | 499 | 0 | 0 |
| season_ranking | 231 | 331 | 983 | 1312 | 3330 | 4227 | 489 | 0 | 0 |
| season_view | 195 | 304 | 814 | 1195 | 3806 | 3974 | 457 | 0 | 0 |
| train_cancel | 89 | 3192 | 5585 | 6002 | 6195 | 6195 | 3151 | 0 | 0 |

**Total measured ops:** 1969 · errors: 0 · typed refusals: 0 · wall RPS: 37.2
