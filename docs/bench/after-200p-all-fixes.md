# Load test — after-200p-all-fixes

- players: 200 · window: 86.7s · server pid: 20816
- server process: RSS avg 989 MB (min 710 / max 1210) · CPU avg 53% of one core (max 129%) · samples 86

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 392 | 552 | 1569 | 5477 | 16186 | 24876 | 1314 | 0 | 0 |
| auth_me | 295 | 553 | 3984 | 8335 | 20130 | 24885 | 1542 | 0 | 0 |
| city_catalog | 348 | 583 | 4581 | 5476 | 24842 | 24889 | 1582 | 0 | 0 |
| city_view | 564 | 782 | 5363 | 12218 | 25618 | 25747 | 2205 | 0 | 0 |
| notifications | 398 | 677 | 1756 | 6857 | 25571 | 25607 | 1799 | 0 | 0 |
| player_resources | 414 | 907 | 2070 | 5892 | 20715 | 25823 | 1947 | 0 | 0 |
| player_state | 578 | 681 | 3197 | 12820 | 25576 | 25590 | 2027 | 0 | 0 |
| season_ranking | 480 | 911 | 5210 | 19741 | 25819 | 25835 | 2467 | 0 | 0 |
| season_view | 425 | 867 | 1981 | 11105 | 25423 | 25831 | 2123 | 0 | 0 |
| train_cancel | 204 | 30001 | 30007 | 35892 | 55098 | 59894 | 30798 | 201 | 0 |

**Total measured ops:** 4098 · errors: 201 · typed refusals: 0 · wall RPS: 47.2
