"""Search public chord/tab sheets (Ultimate Guitar + GuitarTabs.cc).

Returns text only — no images, chord diagrams, or album art.
"""
from __future__ import annotations

import html
import json
import urllib.parse

import cloudscraper
import requests
from bs4 import BeautifulSoup

UG_SEARCH = "https://www.ultimate-guitar.com/search.php"
UG_ALLOWED_TYPES = {
    "Chords": 100,
    "Tab": 70,
    "Ukulele": 40,
    "Ukulele Chords": 40,
    "Bass Tabs": 20,
    "Bass": 20,
}

_scraper = None
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def _get_scraper():
    global _scraper
    if _scraper is None:
        _scraper = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "windows", "desktop": True}
        )
    return _scraper


def _parse_js_store(page_html: str) -> dict | None:
    soup = BeautifulSoup(page_html, "html.parser")
    el = soup.select_one(".js-store")
    if not el:
        return None
    raw = el.get("data-content")
    if not raw:
        return None
    try:
        return json.loads(html.unescape(raw))
    except (json.JSONDecodeError, TypeError):
        return None


def _ug_page_data(page_html: str) -> dict:
    store = _parse_js_store(page_html) or {}
    return ((store.get("store") or {}).get("page") or {}).get("data") or {}


def try_guitartabs_search(song: str, band: str = "") -> list:
    headers = {"User-Agent": _UA}
    enc_song = urllib.parse.quote(song)
    enc_band = urllib.parse.quote(band)
    url = f"https://www.guitartabs.cc/search.php?tabtype=any&band={enc_band}&song={enc_song}"
    try:
        r = requests.get(url, headers=headers, timeout=12)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, "html.parser")
        valid = []
        seen = set()
        for a in soup.find_all("a"):
            href = a.get("href", "")
            if "/tabs/" not in href or ("_tab.html" not in href and "_crd.html" not in href):
                continue
            title = a.text.strip()
            low = title.lower()
            if "bass" in low or "drum" in low:
                continue
            if href in seen:
                continue
            seen.add(href)
            t_type = "Chords" if "_crd.html" in href else "Tab"
            valid.append((href, title, t_type))
        return valid
    except Exception as e:
        print(f"[Chords] GuitarTabs search failed: {e}")
        return []


def fetch_guitartabs_content(href: str) -> str | None:
    headers = {"User-Agent": _UA}
    url = href if href.startswith("http") else f"https://www.guitartabs.cc{href}"
    try:
        tab_response = requests.get(url, headers=headers, timeout=12)
        if tab_response.status_code != 200:
            return None
        tab_soup = BeautifulSoup(tab_response.text, "html.parser")
        pres = tab_soup.find_all("pre")
        if not pres:
            return None
        tab_content = pres[1].text if len(pres) >= 2 else pres[0].text
        return (tab_content or "").strip() or None
    except Exception as e:
        print(f"[Chords] GuitarTabs fetch failed: {e}")
        return None


def search_guitartabs_candidates(query: str) -> list[dict]:
    valid_tabs = try_guitartabs_search(song=query)
    if not valid_tabs and "-" in query:
        parts = [p.strip() for p in query.split("-", 1)]
        valid_tabs = try_guitartabs_search(song=parts[1], band=parts[0])
        if not valid_tabs:
            valid_tabs = try_guitartabs_search(song=parts[0], band=parts[1])
    if not valid_tabs:
        words = query.split()
        if len(words) > 2:
            valid_tabs = try_guitartabs_search(song=" ".join(words[:2]))
            if not valid_tabs:
                valid_tabs = try_guitartabs_search(song=words[0])

    out = []
    for href, title, t_type in valid_tabs[:12]:
        url = href if href.startswith("http") else f"https://www.guitartabs.cc{href}"
        out.append({
            "id": f"gt:{href}",
            "source": "guitartabs",
            "source_name": "GuitarTabs",
            "url": url,
            "type": t_type,
            "song_name": title,
            "artist_name": "",
            "rating": None,
            "votes": 0,
            "version": None,
        })
    return out


def search_ug_candidates(query: str) -> list[dict]:
    scraper = _get_scraper()
    url = UG_SEARCH + "?" + urllib.parse.urlencode({
        "search_type": "title",
        "value": query,
    })
    try:
        r = scraper.get(url, timeout=18, headers={"User-Agent": _UA})
        if r.status_code != 200:
            print(f"[Chords] UG search status {r.status_code}")
            return []
        data = _ug_page_data(r.text)
        results = data.get("results") or []
        out = []
        seen = set()
        for item in results:
            tab_type = item.get("type") or ""
            tab_url = item.get("tab_url") or ""
            if tab_type not in UG_ALLOWED_TYPES:
                continue
            if not tab_url or "/pro/" in tab_url:
                continue
            if "tabs.ultimate-guitar.com" not in tab_url:
                continue
            tab_id = item.get("id")
            key = tab_id or tab_url
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "id": f"ug:{tab_id or tab_url}",
                "source": "ultimate-guitar",
                "source_name": "Ultimate Guitar",
                "url": tab_url,
                "type": tab_type,
                "song_name": item.get("song_name") or "",
                "artist_name": item.get("artist_name") or "",
                "rating": item.get("rating"),
                "votes": int(item.get("votes") or 0),
                "version": item.get("version"),
                "difficulty": item.get("difficulty") or item.get("ug_difficulty"),
            })
        return out
    except Exception as e:
        print(f"[Chords] UG search failed: {e}")
        return []


def fetch_ug_content(tab_url: str) -> dict | None:
    scraper = _get_scraper()
    try:
        r = scraper.get(tab_url, timeout=18, headers={"User-Agent": _UA})
        if r.status_code != 200:
            return None
        data = _ug_page_data(r.text)
        tab = data.get("tab") or {}
        view = data.get("tab_view") or {}
        if view.get("blocked"):
            return None
        wiki = view.get("wiki_tab") or {}
        content = (wiki.get("content") or "").strip()
        if not content:
            return None
        return {
            "content": content,
            "song_name": tab.get("song_name") or "",
            "artist_name": tab.get("artist_name") or "",
            "type": tab.get("type") or "Chords",
            "rating": tab.get("rating"),
            "votes": int(tab.get("votes") or 0),
            "url": tab_url,
            "source": "ultimate-guitar",
            "source_name": "Ultimate Guitar",
        }
    except Exception as e:
        print(f"[Chords] UG fetch failed: {e}")
        return None


def fetch_candidate_content(candidate: dict) -> dict | None:
    source = candidate.get("source")
    url = candidate.get("url") or ""
    if source == "ultimate-guitar":
        got = fetch_ug_content(url)
        if not got:
            return None
        got["id"] = candidate.get("id")
        return got
    if source == "guitartabs":
        href = url.replace("https://www.guitartabs.cc", "")
        content = fetch_guitartabs_content(href)
        if not content:
            return None
        return {
            "id": candidate.get("id"),
            "content": content,
            "song_name": candidate.get("song_name") or "",
            "artist_name": candidate.get("artist_name") or "",
            "type": candidate.get("type") or "Chords",
            "rating": None,
            "votes": 0,
            "url": url,
            "source": "guitartabs",
            "source_name": "GuitarTabs",
        }
    return None


def _candidate_score(item: dict, artist: str = "", title: str = "") -> float:
    type_bonus = UG_ALLOWED_TYPES.get(item.get("type") or "", 5)
    rating = float(item.get("rating") or 0)
    votes = int(item.get("votes") or 0)
    score = type_bonus + rating * 8 + min(votes, 3000) / 250
    if item.get("source") == "ultimate-guitar":
        score += 12
    hay = f"{item.get('artist_name') or ''} {item.get('song_name') or ''}".lower()
    if artist and artist.lower() in hay:
        score += 8
    if title:
        # Prefer the main studio version over "acoustic / mtv unplugged"
        t = title.lower()
        if t and t in hay:
            score += 6
        extra = (item.get("song_name") or "").lower()
        for tag in ("acoustic", "unplugged", "live", "karaoke", "drum"):
            if tag in extra and tag not in t:
                score -= 6
    return score


def search_tab_candidates(query: str, artist: str = "", title: str = "") -> list[dict]:
    """Merge UG + GuitarTabs results, ranked, no page fetch."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    q = (query or "").strip()
    if not q:
        return []

    found: list[dict] = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = {
            pool.submit(search_ug_candidates, q): "ug",
            pool.submit(search_guitartabs_candidates, q): "gt",
        }
        for fut in as_completed(futs):
            label = futs[fut]
            try:
                found.extend(fut.result() or [])
            except Exception as e:
                print(f"[Chords] {label} candidates failed: {e}")

    found.sort(key=lambda it: _candidate_score(it, artist, title), reverse=True)
    # Dedupe by song+type+source, keep top 15
    seen = set()
    unique = []
    for item in found:
        key = (item.get("source"), item.get("url"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
        if len(unique) >= 15:
            break
    return unique


def search_tab_data(query: str):
    """
    Backward-compatible: return the best matching chord/tab sheet.
    """
    try:
        candidates = search_tab_candidates(query)
        if not candidates:
            return {"error": f"Maaf, tidak menemukan hasil tabulatur/chord untuk '{query}'."}

        last_error = None
        for cand in candidates[:4]:
            got = fetch_candidate_content(cand)
            if got and got.get("content"):
                return {
                    "success": True,
                    "source": got.get("url"),
                    "type": got.get("type") or cand.get("type"),
                    "rating": got.get("rating") if got.get("rating") is not None else "N/A",
                    "content": got["content"],
                    "song_name": got.get("song_name"),
                    "artist_name": got.get("artist_name"),
                    "source_name": got.get("source_name"),
                }
            last_error = f"Gagal membuka {cand.get('url')}"
        return {"error": last_error or "Gagal mengekstrak isi chord/tab."}
    except Exception as e:
        return {"error": f"Terjadi kesalahan saat mencari tab online: {str(e)}"}
