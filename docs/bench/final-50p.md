# Load test — final-50p

- players: 50 · window: 41.2s · server pid: 23585
- server process: RSS avg 872 MB (min 861 / max 882) · CPU avg 63% of one core (max 100%) · samples 41

| endpoint | n | p50 | p90 | p95 | p99 | max | avg | errors | refusals |
|---|---|---|---|---|---|---|---|---|---|
| army_catalog | 148 | 140 | 369 | 477 | 721 | 849 | 177 | 0 | 0 |
| auth_me | 109 | 116 | 336 | 501 | 644 | 651 | 158 | 0 | 0 |
| city_catalog | 129 | 126 | 419 | 605 | 819 | 820 | 179 | 0 | 0 |
| city_view | 243 | 160 | 541 | 764 | 905 | 937 | 229 | 0 | 0 |
| notifications | 162 | 135 | 465 | 684 | 862 | 894 | 199 | 0 | 0 |
| player_resources | 178 | 152 | 698 | 818 | 956 | 968 | 251 | 0 | 0 |
| player_state | 212 | 153 | 455 | 650 | 758 | 812 | 207 | 0 | 0 |
| season_ranking | 209 | 179 | 463 | 585 | 811 | 974 | 224 | 0 | 0 |
| season_view | 172 | 170 | 652 | 799 | 885 | 970 | 255 | 0 | 0 |
| train_cancel | 72 | 807 | 1748 | 1850 | 1955 | 1955 | 868 | 0 | 0 |

**Total measured ops:** 1634 · errors: 0 · typed refusals: 0 · wall RPS: 39.7
