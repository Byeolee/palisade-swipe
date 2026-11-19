# 🚗 팰리세이드 HEV 매물 스와이프

디 올 뉴 팰리세이드 하이브리드(LX3) 중고 매물을 틴더처럼 넘겨보는 모바일 카드 웹앱입니다.
매물 데이터는 구글 시트 트래커(`팰리세이드 HEV 중고 매매 트래커`)와 엔카·케이카 상세 API에서 생성한
`data.json` 하나로 구동됩니다. 빌드 도구도 서버도 필요 없는 정적 사이트입니다.

- 앱: https://byeolee.github.io/palisade-swipe/
- 데이터: [`data.json`](data.json) (35대, 2026-11-19 17:40 스냅샷)

## 기능

| 기능 | 설명 |
| --- | --- |
| 스와이프 | 오른쪽 = 찜 ♥, 왼쪽 = 패스 ✕. 버튼(♥ / ✕)과 되돌리기(↩) 지원 |
| 탭 = 카드 뒤집기 | 카드를 살짝 탭하면 3D 플립. 8px 이상 움직이면 드래그(스와이프)로 처리 |
| 카드 앞면 | 차량 사진, 신규 / 인하·인상 뱃지, 현재가·신차 대비 감가, 트림·구동·연식·주행·지역, 핵심 옵션 |
| 카드 뒷면 | 상세 스펙, 가격 변동 스텝 차트(SVG, 변동폭 표시), 시트 비고, 엔카/케이카 원문 링크 |
| 필터 | 전체 / 4WD / 5,000만 이하 / 선루프 O / 최근 인하·신규 — 칩마다 남은 카드 수 표시 |
| 찜 목록 | 찜한 매물 모아보기, 가격 오름차순 비교표(옵션 O/X), 찜 해제, 전체 해제 |
| 저장 | 찜/패스/필터를 `localStorage`(`palisade-swipe-v1`)에 저장 — 새로고침·재방문해도 유지 |

## data.json 형식

```jsonc
{
  "generatedAt": "2026-11-19T17:40",
  "source": "구글 시트 … + 엔카/케이카 상세 API",
  "count": 35,
  "listings": [
    {
      "id": "42848583",              // 엔카 매물ID 또는 케이카 차량코드(EC…)
      "source": "encar",             // encar | kcar
      "trim": "캘리그래피",           // 프레스티지 | 캘리그래피 | 익스클루시브
      "title": "팰리세이드(LX3) HEV 2.5T 캘리그래피",
      "drive": "2WD", "seats": "9인승", "sunroof": true,
      "yearMonth": "25/04", "km": 27577, "color": "담녹색", "region": "전북",
      "price": 5070,                 // 현재가(만원)
      "firstPrice": 5050,            // 시트 최초가격(만원)
      "listPrice": 6186,             // 신차가(만원, 엔카 originPrice)
      "depreciation": 18.0,          // 신차 대비 감가 %
      "registered": "2026-11-03",    // 트래커 등록일
      "status": "판매중",
      "note": "…시트 비고 원문…",
      "options": { "sunroof": true, "aroundView": true, "hud": true,
                   "ecs": true, "vent2": true, "massage": true },
      "photos": ["https://ci.encar.com/carpicture/…jpg", "…"],   // 최대 5장
      "priceHistory": [ {"date": "2026-11-03", "time": null, "price": 5050},
                        {"date": "2026-11-19", "time": "08:28", "price": 5070} ],
      "change": { "delta": -20, "lastDate": "2026-11-19" },   // 마지막 변동(만원)
      "isNew": false,                // 등록 2일 이내
      "url": "https://fem.encar.com/cars/detail/42848583"
    }
  ]
}
```

- 판매완료 매물은 담지 않습니다(판매중만).
- `priceHistory`는 시트의 최초가격 + 비고란 변동 로그(`11/19 5,290→5,250`)를 파싱한 값입니다.
  마지막 항목이 현재가와 다르면 오늘 날짜로 현재가를 덧붙입니다.
- `photos`는 엔카 상세 API의 `photos[].path` → `https://ci.encar.com/carpicture{path}`,
  케이카 상세 API의 `photoList[].elanPath`에서 가져옵니다. 비어 있거나 로드에 실패하면
  앱이 "사진 준비 중" 플레이스홀더를 보여 줍니다.

## 갱신 (09시 / 17시 모니터링 연동)

```bash
# 1) 시트 상태를 data.json으로 재생성 (시트·상세 API 조회 → 사진·옵션·가격이력 갱신)
python3 tools/update_data.py

# 2) 배포
git add data.json && git commit -m "data: $(date +%m/%d) 모니터링 반영" && git push
```

`tools/update_data.py`는 `gog`(byungkun3@gmail.com)로 시트를 읽고, 판매중 매물의 엔카/케이카
상세를 조회해 `data.json`을 다시 씁니다. 상세 응답은 `.cache/`(git 제외)에 6시간 캐시합니다.
GitHub Pages는 `main` 브랜치 루트를 그대로 서빙하므로 푸시 후 1분 안에 반영됩니다.

- 캐시가 비어 있으면 엔카 상세 30건을 재시도(2.5초 간격, 성공률 40~60%)로 받아오므로 첫 실행은 5~10분 걸릴 수 있습니다.
- 케이카 상세는 `pycryptodome`이 필요합니다(캐시가 있으면 임포트하지 않음).
- 커밋·푸시는 스크립트가 직접 합니다. `--no-push`로 파일만 갱신할 수 있습니다.
- **CSS/JS를 고칠 때는 `index.html`의 `?v=...` 값을 함께 올려 주세요.** GitHub Pages가 자산을
  10분간 캐시하므로, 값을 올리지 않으면 사용자가 예전 화면을 보게 됩니다. `data.json`은
  `cache: 'no-store'`로 매번 새로 받습니다.
