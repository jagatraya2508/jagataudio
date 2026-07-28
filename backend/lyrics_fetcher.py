"""Fetch and cache song lyrics via LRCLIB (https://lrclib.net)."""
import json
import os
import re
import urllib.parse
import urllib.request

# Strip anything in (...) or [...]
PARENS_BRACKETS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")

# feat. / ft. / featuring — drop collaborator suffix from title
FEAT_SPLIT = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|with)\s+", re.IGNORECASE)

# Split "Artist - Title" (hyphen, en-dash, em-dash)
ARTIST_TITLE_SPLIT = re.compile(r"\s+[-–—]\s+", re.UNICODE)


def clean_artist(text: str) -> str:
    """Keep only the main artist / band name."""
    t = text.strip()
    t = PARENS_BRACKETS.sub("", t)
    t = FEAT_SPLIT.split(t)[0]
    return re.sub(r"\s+", " ", t).strip()


def clean_title(text: str) -> str:
    """Keep only the core song title — drop tags, extras, feat. blocks."""
    t = text.strip()
    prev = None
    while prev != t:
        prev = t
        t = PARENS_BRACKETS.sub("", t)
    t = FEAT_SPLIT.split(t)[0]
    # Trailing segment after " - " inside title (e.g. remix label)
    if " - " in t:
        parts = [p.strip() for p in t.split(" - ") if p.strip()]
        if len(parts) > 1 and len(parts[0].split()) <= 6:
            t = parts[0]
    return re.sub(r"\s+", " ", t).strip()


def parse_track_name(track_name: str) -> tuple[str, str]:
    """
    Extract penyanyi + judul from a filename / track label.
    Ignores everything else (Official Audio, Guitar Solo, etc.).
    """
    raw = track_name.strip()
    parts = ARTIST_TITLE_SPLIT.split(raw, maxsplit=1)
    if len(parts) == 2:
        return clean_artist(parts[0]), clean_title(parts[1])
    return "", clean_title(raw)


def build_search_queries(artist: str, title: str) -> list[str]:
    """Search queries: artist + judul only, never the raw filename."""
    queries = []
    if artist and title:
        queries.append(f"{artist} {title}")
    if title:
        queries.append(title)

    seen = set()
    unique = []
    for q in queries:
        q = re.sub(r"\s+", " ", q).strip()
        key = q.lower()
        if q and key not in seen:
            seen.add(key)
            unique.append(q)
    return unique


def cache_base_name(track_name: str) -> str:
    safe = re.sub(r'[<>:"/\\|?*]', "_", track_name.strip())
    safe = re.sub(r"\s+", " ", safe).strip()
    return safe or "unknown"


def cache_paths(cache_dir: str, track_name: str) -> tuple[str, str]:
    base = cache_base_name(track_name)
    return (
        os.path.join(cache_dir, f"{base}.lrc"),
        os.path.join(cache_dir, f"{base}.txt"),
    )


def load_cached_lyrics(cache_dir: str, track_name: str) -> dict | None:
    lrc_path, txt_path = cache_paths(cache_dir, track_name)
    if os.path.exists(lrc_path):
        with open(lrc_path, encoding="utf-8") as f:
            return {"format": "lrc", "content": f.read(), "saved_path": lrc_path, "from_cache": True}
    if os.path.exists(txt_path):
        with open(txt_path, encoding="utf-8") as f:
            return {"format": "plain", "content": f.read(), "saved_path": txt_path, "from_cache": True}
    return None


def save_lyrics(cache_dir: str, track_name: str, content: str, fmt: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    lrc_path, txt_path = cache_paths(cache_dir, track_name)
    path = lrc_path if fmt == "lrc" else txt_path
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def _http_get_json(url: str, timeout: int = 15) -> list | dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": "JagatAudio/1.1 (lyrics)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[Lyrics] Request failed: {url} -> {e}")
        return None


def _count_synced_lines(result: dict) -> int:
    """Count timed lyric lines that have actual text (measure completeness)."""
    syn = result.get("syncedLyrics") or ""
    if not syn:
        return 0
    count = 0
    for raw in syn.splitlines():
        line = raw.strip()
        if not line.startswith("["):
            continue
        # skip metadata tags
        if re.match(r"^\[(?:ti|ar|al|by|offset|length|re|ve|au|la|tool|key|bpm|language):", line, re.I):
            continue
        # [mm:ss.xx]text — require some lyric text
        m = re.match(r"^\[\d{1,2}:\d{2}(?:[\.:]\d{1,3})?\]\s*(.*)$", line)
        if m and (m.group(1) or "").strip():
            count += 1
    return count


def _pick_best_result(results: list, duration: int | None, artist: str = "", title: str = "") -> dict | None:
    if not results:
        return None

    def score(r: dict) -> tuple:
        has_sync = bool(r.get("syncedLyrics"))
        has_plain = bool(r.get("plainLyrics"))
        if not has_sync and not has_plain:
            return (999, 999, 999, 999)

        dur_diff = 999
        if duration and duration > 0:
            dur_diff = abs((r.get("duration") or duration) - duration)

        name_bonus = 0
        r_artist = (r.get("artistName") or "").lower()
        r_title = (r.get("trackName") or "").lower()
        if artist and artist.lower() in r_artist:
            name_bonus -= 3
        if title and title.lower() in r_title:
            name_bonus -= 4

        # Prefer synced; penalize duration mismatch heavily when duration is known
        sync_penalty = 0 if has_sync else 5
        if duration and duration > 0 and dur_diff > 30:
            # likely different song / edit length — soft penalty (cover may be longer)
            dur_diff = dur_diff + 15
        elif duration and duration > 0 and dur_diff > 4:
            dur_diff = dur_diff + 5

        # Prefer more complete synced lyrics (more timed lines with text)
        line_count = _count_synced_lines(r) if has_sync else 0
        completeness = -line_count  # min() → more lines wins

        return (sync_penalty, name_bonus, completeness, dur_diff)

    synced = [r for r in results if r.get("syncedLyrics")]
    candidates = synced if synced else [r for r in results if r.get("syncedLyrics") or r.get("plainLyrics")]
    if not candidates:
        return None
    return min(candidates, key=score)


def _result_to_lyrics(result: dict, artist: str, title: str, source: str) -> dict | None:
    if result.get("syncedLyrics"):
        return {
            "format": "lrc",
            "content": result["syncedLyrics"],
            "artist": result.get("artistName", artist),
            "title": result.get("trackName", title),
            "source": source,
        }
    if result.get("plainLyrics"):
        return {
            "format": "plain",
            "content": result["plainLyrics"],
            "artist": result.get("artistName", artist),
            "title": result.get("trackName", title),
            "source": source,
        }
    return None


def _fetch_lrclib_search(query: str, duration: int | None, artist: str, title: str) -> dict | None:
    encoded = urllib.parse.quote(query)
    results = _http_get_json(f"https://lrclib.net/api/search?q={encoded}")
    if not isinstance(results, list) or not results:
        return None
    best = _pick_best_result(results, duration, artist, title)
    if not best:
        return None
    return _result_to_lyrics(best, artist, title, "lrclib")


def _fetch_lrclib_get(artist: str, title: str, duration: int | None) -> dict | None:
    if not artist or not title:
        return None
    params = {"artist_name": artist, "track_name": title}
    if duration and duration > 0:
        params["duration"] = duration
    data = _http_get_json(f"https://lrclib.net/api/get?{urllib.parse.urlencode(params)}")
    if isinstance(data, dict):
        return _result_to_lyrics(data, artist, title, "lrclib")
    return None


def _fetch_lyrics_ovh(artist: str, title: str) -> dict | None:
    if not artist or not title:
        return None
    url = f"https://api.lyrics.ovh/v1/{urllib.parse.quote(artist)}/{urllib.parse.quote(title)}"
    data = _http_get_json(url, timeout=20)
    if isinstance(data, dict) and data.get("lyrics"):
        return {
            "format": "plain",
            "content": data["lyrics"].strip(),
            "artist": artist,
            "title": title,
            "source": "lyrics.ovh",
        }
    return None


def fetch_lyrics_online(track_name: str, duration: int | None = None) -> dict | None:
    artist, title = parse_track_name(track_name)
    print(f"[Lyrics] Search: artist={artist!r} title={title!r} duration={duration}")

    # Kumpulkan semua kandidat lalu pilih yang paling lengkap (bukan langsung return get)
    pooled: list[dict] = []
    seen_ids: set = set()

    def _add(item: dict | None):
        if not isinstance(item, dict):
            return
        rid = item.get("id")
        if rid is not None:
            if rid in seen_ids:
                return
            seen_ids.add(rid)
        pooled.append(item)

    if artist and title:
        params = {"artist_name": artist, "track_name": title}
        if duration and duration > 0:
            params["duration"] = int(duration)
        data = _http_get_json(f"https://lrclib.net/api/get?{urllib.parse.urlencode(params)}")
        _add(data if isinstance(data, dict) else None)

    for query in build_search_queries(artist, title):
        encoded = urllib.parse.quote(query)
        results = _http_get_json(f"https://lrclib.net/api/search?q={encoded}")
        if isinstance(results, list):
            for r in results:
                _add(r)

    best = _pick_best_result(pooled, duration, artist, title)
    if best:
        found = _result_to_lyrics(best, artist, title, "lrclib")
        if found:
            found["search_artist"] = artist
            found["search_title"] = title
            print(
                f"[Lyrics] Picked: {best.get('artistName')!r} - {best.get('trackName')!r} "
                f"({_count_synced_lines(best)} baris sync)"
            )
            return found

    found = _fetch_lyrics_ovh(artist, title)
    if found:
        found["search_artist"] = artist
        found["search_title"] = title
        return found

    return None


def get_or_fetch_lyrics(cache_dir: str, track_name: str, duration: int | None = None, refresh: bool = False) -> dict:
    if not refresh:
        cached = load_cached_lyrics(cache_dir, track_name)
        if cached:
            artist, title = parse_track_name(track_name)
            return {"found": True, "saved": True, "search_artist": artist, "search_title": title, **cached}

    online = fetch_lyrics_online(track_name, duration)
    if not online:
        artist, title = parse_track_name(track_name)
        return {"found": False, "search_artist": artist, "search_title": title}

    saved_path = save_lyrics(cache_dir, track_name, online["content"], online["format"])
    return {
        "found": True,
        "saved": True,
        "saved_path": saved_path,
        "from_cache": False,
        "format": online["format"],
        "content": online["content"],
        "artist": online.get("artist"),
        "title": online.get("title"),
        "source": online.get("source"),
        "search_artist": online.get("search_artist"),
        "search_title": online.get("search_title"),
    }


def search_lyrics_candidates(
    artist: str = "",
    title: str = "",
    duration: int | None = None,
    query: str | None = None,
    limit: int = 15,
) -> list[dict]:
    """Return multiple LRCLIB matches for manual selection."""
    queries: list[str] = []
    if query and query.strip():
        queries.append(query.strip())
    else:
        if artist.strip() and title.strip():
            queries.append(f"{artist.strip()} {title.strip()}")
        if title.strip():
            queries.append(title.strip())
        elif artist.strip():
            queries.append(artist.strip())

    seen_ids: set[int] = set()
    candidates: list[dict] = []

    for q in queries:
        encoded = urllib.parse.quote(q)
        results = _http_get_json(f"https://lrclib.net/api/search?q={encoded}")
        if not isinstance(results, list):
            continue
        for r in results:
            rid = r.get("id")
            if rid is None or rid in seen_ids:
                continue
            if not r.get("syncedLyrics") and not r.get("plainLyrics"):
                continue
            seen_ids.add(rid)
            line_count = _count_synced_lines(r)
            candidates.append({
                "id": rid,
                "artist": r.get("artistName") or "",
                "title": r.get("trackName") or "",
                "album": r.get("albumName") or "",
                "duration": r.get("duration"),
                "has_sync": bool(r.get("syncedLyrics")),
                "has_plain": bool(r.get("plainLyrics")),
                "synced_lines": line_count,
            })

    def sort_key(c: dict) -> tuple:
        sync_penalty = 0 if c.get("has_sync") else 1
        # lebih banyak baris = lebih lengkap
        completeness = -(c.get("synced_lines") or 0)
        dur_diff = 999
        if duration and duration > 0 and c.get("duration"):
            dur_diff = abs(c["duration"] - duration)
        return (sync_penalty, completeness, dur_diff)

    candidates.sort(key=sort_key)
    return candidates[:limit]


def fetch_lyrics_by_lrclib_id(lrclib_id: int) -> dict | None:
    data = _http_get_json(f"https://lrclib.net/api/get/{lrclib_id}")
    if not isinstance(data, dict):
        return None
    return _result_to_lyrics(
        data,
        data.get("artistName", ""),
        data.get("trackName", ""),
        "lrclib",
    )


def apply_lyrics_for_track(
    cache_dir: str,
    track_name: str,
    lrclib_id: int,
) -> dict:
    """Download a specific LRCLIB result and attach it to a playlist track."""
    online = fetch_lyrics_by_lrclib_id(lrclib_id)
    if not online:
        return {"found": False}

    search_artist = online.get("artist") or ""
    search_title = online.get("title") or ""
    saved_path = save_lyrics(cache_dir, track_name, online["content"], online["format"])
    return {
        "found": True,
        "saved": True,
        "saved_path": saved_path,
        "from_cache": False,
        "format": online["format"],
        "content": online["content"],
        "source": online.get("source"),
        "search_artist": search_artist,
        "search_title": search_title,
    }
