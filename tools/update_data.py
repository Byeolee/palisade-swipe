#!/usr/bin/env python3
"""data.json 자동 갱신 — 09시/17시 모니터링에서 그대로 실행한다.

하는 일
  1) 구글 시트("팰리세이드 HEV 중고 매매 트래커", byungkun3@gmail.com)를 gog로 읽는다.
  2) 판매중 매물마다 엔카/케이카 상세를 조회해 사진·옵션·신차가를 채운다(캐시 사용).
  3) 사이트가 읽는 data.json을 다시 쓴다.

사용 예
  python3 tools/update_data.py                       # 캐시 6시간, 시트는 gog로 조회
  python3 tools/update_data.py --max-age-hours 0     # 상세 전부 새로 조회
  python3 tools/update_data.py --sheet-json dump.json  # gog 결과 파일 재사용
  python3 tools/update_data.py --no-push             # 파일만 갱신, 커밋은 수동

이후 배포:  git add data.json && git commit -m "data: ..." && git push
(기본값은 커밋·푸시까지 수행한다. --no-push로 끌 수 있다.)
"""
import argparse
import base64
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

SHEET_ID = '1eLtG_fUK3KSwoW6IQNzUuFx8ujzSno0_EBCQo02MmCc'
SHEET_ACCOUNT = 'byungkun3@gmail.com'
SHEET_RANGE = '시트1!A1:Z200'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
ENCAR_OPT = {'010': 'sunroof', '002': 'ecs', '087': 'aroundView',
             '090': 'vent2', '091': 'massage', '095': 'hud'}
KCAR_KEY = b'SKFJ2424DasfaJRI'
KCAR_IV = b'sfq241sf3dscs321'


# ── 시트 ────────────────────────────────────────────────
def strip_markers(v):
    if not isinstance(v, str):
        return '' if v is None else str(v)
    v = re.sub(r'<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>', '', v)
    v = re.sub(r'<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>', '', v)
    v = v.replace('Source: google_api', '')
    return v.strip('-\n ').strip()


def read_sheet(sheet_json=None):
    if sheet_json and os.path.exists(sheet_json):
        raw = open(sheet_json).read()
    else:
        cmd = ['gog', '--readonly', 'sheets', 'get', SHEET_ID, SHEET_RANGE,
               '--account', SHEET_ACCOUNT]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        raw = out.stdout
        if not raw.strip():
            raise SystemExit(f'gog 실패: {out.stderr[:400]}')
    env = json.loads(raw)
    data = env.get('data', env)
    values = data.get('values')
    if isinstance(values, dict) and 'items' in values:
        values = values['items']
    if (values is None or (isinstance(values, dict) and values.get('omitted'))) \
            and data.get('saved_to'):
        saved = data['saved_to']
        saved = saved if os.path.isabs(saved) else os.path.join('/workspace', saved)
        env2 = json.load(open(saved))
        values = env2['data']['values']
        if isinstance(values, dict) and 'items' in values:
            values = values['items']
    if not values:
        raise SystemExit('시트 값이 비어 있습니다.')
    return [[strip_markers(c) for c in row] for row in values]


# ── 엔카 ────────────────────────────────────────────────
def fetch_encar(vid, tries=12, gap=2.5):
    base = 'https://api.encar.com/v1/readside/vehicle/'
    for _ in range(tries):
        req = urllib.request.Request(
            base + str(vid),
            headers={'User-Agent': UA, 'Accept': 'application/json',
                     'Referer': 'https://fem.encar.com/'})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                return {'_gone': e.code}
        except Exception:
            pass
        time.sleep(gap)
    return None


def encar_detail(vid, cache_dir, max_age_h):
    path = os.path.join(cache_dir, f'{vid}.json')
    if max_age_h > 0 and os.path.exists(path) and \
            (time.time() - os.path.getmtime(path)) < max_age_h * 3600:
        try:
            return json.load(open(path))
        except Exception:
            pass
    d = fetch_encar(vid)
    if d and '_gone' not in d:
        os.makedirs(cache_dir, exist_ok=True)
        json.dump(d, open(path, 'w'), ensure_ascii=False)
    return d


# ── 케이카 ──────────────────────────────────────────────
def kcar_detail(code, cache_dir, max_age_h):
    path = os.path.join(cache_dir, f'{code}.json')
    if max_age_h > 0 and os.path.exists(path) and \
            (time.time() - os.path.getmtime(path)) < max_age_h * 3600:
        try:
            return json.load(open(path))
        except Exception:
            pass
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
    clean = {k: v for k, v in {'wr_txt_idx': code, 'pageno': 1, 'limit': 10}.items()
             if v not in (None, '', 0, False)}
    payload = {'enc': base64.b64encode(
        AES.new(KCAR_KEY, AES.MODE_CBC, KCAR_IV).encrypt(
            pad(json.dumps(clean, ensure_ascii=False,
                           separators=(',', ':')).encode(), 16))).decode()}
    req = urllib.request.Request(
        'https://api.kcar.com/bc/search/list/drct',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json;charset=UTF-8',
                 'Accept': 'application/json, text/plain, */*',
                 'Origin': 'https://www.kcar.com',
                 'Referer': 'https://www.kcar.com/bc/search/IntgSearchList',
                 'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            json.loads(r.read())
    except Exception:
        pass
    url = f'https://api.kcar.com/bc/car-info-detail-of-ng?i_sCarCd={code}'
    req = urllib.request.Request(url, headers={
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.kcar.com',
        'Referer': 'https://www.kcar.com/bc/detail/carInfoDtl?i_sCarCd=' + code,
        'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = (json.loads(r.read()) or {}).get('data') or {}
    except Exception:
        return None
    if d:
        os.makedirs(cache_dir, exist_ok=True)
        json.dump(d, open(path, 'w'), ensure_ascii=False)
    return d


# ── 가격 이력 ────────────────────────────────────────────
def parse_history(note, registered, first_price, current_price, today):
    note = note or ''
    tokens = []
    for m in re.finditer(r'(?<![\d./])(\d{1,2})/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?', note):
        mo, da = int(m.group(1)), int(m.group(2))
        if not (1 <= mo <= 12 and 1 <= da <= 31):
            continue
        if note[m.end():m.end() + 1] == '식':
            continue
        tokens.append((m.start(), m.group(1), m.group(2), m.group(3), m.group(4)))

    points = []
    for i, (pos, mo, da, hh, mi) in enumerate(tokens):
        end = tokens[i + 1][0] if i + 1 < len(tokens) else len(note)
        chunk = note[pos:end]
        cut = chunk.find('기존')
        if cut > 0:
            chunk = chunk[:cut]
        for m in re.finditer(r'(?<![\d,])([4-6],?\d{3})(?![\d,])', chunk):
            v = int(m.group(1).replace(',', ''))
            if not (4000 <= v <= 6999):
                continue
            if re.search(r'\d+\s*행[\s(]*$', chunk[max(0, m.start() - 6):m.start()]):
                continue
            points.append({'date': f'{today.year}-{mo:0>2}-{da:0>2}',
                           'time': f'{int(hh):02d}:{mi}' if hh else None, 'price': v})

    if points:
        hist = points
        if first_price and registered and hist[0]['date'] != registered:
            hist.insert(0, {'date': registered, 'time': None, 'price': first_price})
    else:
        hist = [{'date': registered, 'time': None, 'price': first_price or current_price}]

    dedup = []
    for p in sorted(hist, key=lambda x: (x['date'], x['time'] or '00:00')):
        if dedup and dedup[-1]['price'] == p['price']:
            continue
        dedup.append(p)
    if dedup and dedup[-1]['price'] != current_price:
        dedup.append({'date': today.isoformat(), 'time': None, 'price': current_price})
    return dedup


def num(v):
    try:
        return int(float(str(v).replace(',', '').strip()))
    except Exception:
        return None


# ── 빌드 ────────────────────────────────────────────────
def build(rows, encar_cache, kcar_cache, max_age_h, today):
    header, data = rows[0], rows[1:]
    listings, origin, stats = [], {}, {'encar': 0, 'kcar': 0, 'noPhoto': 0, 'gone': []}

    for r in data:
        r = list(r) + [''] * (15 - len(r))
        (cat, name, seats, year, km, color, region, cur, first, reg, status,
         _solddate, _solddays, note, link) = r[:15]
        if status != '판매중':
            continue

        kmap = re.search(r'(EC\d{8})', link or '') or re.search(r'(EC\d{8})', note or '')
        em = re.search(r'/detail/(\d{8})', link or '')
        cid = kmap.group(1) if kmap else (em.group(1) if em else '')
        source = 'kcar' if cid.startswith('EC') else 'encar'

        trim = next((t for t in ('캘리그래피', '프레스티지', '익스클루시브', '르블랑')
                     if t in name), '')
        rec = {
            'id': cid, 'source': source, 'trim': trim, 'title': name,
            'drive': '4WD' if '4WD' in cat else '2WD', 'seats': seats,
            'sunroof': ('선루프' in cat and '선루프X' not in cat),
            'yearMonth': year, 'km': num(km), 'color': color, 'region': region,
            'price': num(cur), 'firstPrice': num(first), 'registered': reg,
            'status': status, 'note': note or '',
            'url': link or (f'https://www.kcar.com/bc/detail/carInfoDtl?i_sCarCd={cid}'
                            if source == 'kcar' else f'https://fem.encar.com/cars/detail/{cid}'),
            'photos': [],
            'options': {'sunroof': False, 'aroundView': False, 'hud': False,
                        'ecs': False, 'vent2': False, 'massage': False},
            'listPrice': None,
        }
        rec['options']['sunroof'] = rec['sunroof']

        if source == 'encar':
            d = encar_detail(cid, encar_cache, max_age_h)
            if d and '_gone' in d:
                stats['gone'].append(cid)
                continue
            if d:
                c = d.get('category', {})
                rec['listPrice'] = c.get('originPrice')
                outer = sorted([p for p in (d.get('photos') or [])
                                if p.get('type') == 'OUTER' and p.get('path')],
                               key=lambda x: x.get('code') or '')
                rec['photos'] = ['https://ci.encar.com/carpicture' + p['path']
                                 for p in outer][:5]
                for code in ((d.get('options') or {}).get('standard') or []):
                    key = ENCAR_OPT.get(code)
                    if key:
                        rec['options'][key] = True
                rec['registeredAd'] = (d.get('manage') or {}).get('firstAdvertisedDateTime')
                rec['dealer'] = (d.get('contact') or {}).get('address')
                if c.get('originPrice'):
                    origin.setdefault((trim, rec['drive']), c['originPrice'])
            stats['encar'] += 1
        else:
            d = kcar_detail(cid, kcar_cache, max_age_h)
            if d:
                opts = [o.get('optnNm') or '' for o in (d.get('optList') or [])]
                rec['photos'] = [p.get('elanPath') for p in (d.get('photoList') or [])
                                 if p.get('elanPath')][:5]
                rec['options'].update({
                    'sunroof': any('선루프' in o for o in opts),
                    'ecs': any(o.startswith('ECS') for o in opts),
                    'aroundView': any('어라운드' in o for o in opts),
                    'vent2': any(o.startswith('통풍시트 : 뒷좌석') for o in opts),
                    'massage': any(('안마' in o or '마사지' in o) for o in opts),
                    'hud': any('헤드업' in o for o in opts),
                })
                rv = d.get('rvo') or {}
                rec['dealer'] = rv.get('cntrNm')
                rec['registeredAd'] = rv.get('carRegDttm')
                hist = d.get('carhistory') or {}
                rec['accident'] = {'self': hist.get('owncarDmgeAcdtCnt'),
                                   'other': hist.get('othrcarWrdgAcdtCnt'),
                                   'otherAmount': hist.get('othrcarWrdgInsrAmtSum')}
            stats['kcar'] += 1

        if not rec['listPrice']:
            rec['listPrice'] = origin.get((trim, rec['drive']))
        rec['depreciation'] = (round((1 - rec['price'] / rec['listPrice']) * 100, 1)
                               if rec['listPrice'] and rec['price'] else None)
        rec['priceHistory'] = parse_history(note, reg, num(first), num(cur), today)
        hist = rec['priceHistory']
        rec['change'] = None if len(hist) < 2 else {
            'delta': hist[-1]['price'] - hist[-2]['price'], 'lastDate': hist[-1]['date']}
        try:
            rec['isNew'] = (today - dt.date.fromisoformat(reg)).days <= 2
        except Exception:
            rec['isNew'] = False
        rec['options']['sunroof'] = rec['sunroof']
        if not rec['photos']:
            stats['noPhoto'] += 1
        listings.append(rec)

    listings.sort(key=lambda x: (x['price'] or 0))
    stamped = dt.datetime.now().replace(second=0, microsecond=0).isoformat(timespec='minutes')
    return {
        'generatedAt': stamped,
        'source': '구글 시트 "팰리세이드 HEV 중고 매매 트래커" + 엔카/케이카 상세 API',
        'count': len(listings), 'listings': listings,
    }, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sheet-json', default=None)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data.json'))
    ap.add_argument('--encar-cache', default=os.path.join(ROOT, '.cache', 'encar'))
    ap.add_argument('--kcar-cache', default=os.path.join(ROOT, '.cache', 'kcar'))
    ap.add_argument('--max-age-hours', type=float, default=6)
    ap.add_argument('--no-push', action='store_true')
    args = ap.parse_args()

    today = dt.date.today()
    rows = read_sheet(args.sheet_json)
    payload, stats = build(rows, args.encar_cache, args.kcar_cache,
                           args.max_age_hours, today)
    json.dump(payload, open(args.out, 'w'), ensure_ascii=False, indent=1)
    print(json.dumps({'out': args.out, 'count': payload['count'],
                      'generatedAt': payload['generatedAt'], **stats},
                     ensure_ascii=False))

    if args.no_push or stats['gone']:
        if stats['gone']:
            print('완판(404) 매물:', ', '.join(stats['gone']), file=sys.stderr)
        return
    subprocess.run(['git', '-C', ROOT, 'add', 'data.json'], check=False)
    msg = f"data: {today:%m/%d} 모니터링 반영 ({payload['count']}대)"
    if subprocess.run(['git', '-C', ROOT, 'diff', '--cached', '--quiet']).returncode == 0:
        print('변동 없음 — 커밋 생략')
        return
    subprocess.run(['git', '-C', ROOT, '-c', 'user.name=이병건',
                    '-c', 'user.email=byungkun3@gmail.com', 'commit', '-qm', msg],
                   check=False)
    subprocess.run(['git', '-C', ROOT, 'push', 'origin', 'HEAD:main'], check=False)


if __name__ == '__main__':
    main()
