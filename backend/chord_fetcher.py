"""Fetch and cache chord/tab sheets for playlist tracks."""
from __future__ import annotations

import json
import os
import re

from lyrics_fetcher import cache_base_name, parse_track_name, build_search_queries
from tab_scraper import (
    search_tab_candidates,
    fetch_candidate_content,
)


def cache_path(cache_dir: str, track_name: str) -> str:
    return os.path.join(cache_dir, f"{cache_base_name(track_name)}.crd.json")


def load_cached_chords(cache_dir: str, track_name: str) -> dict | None:
    path = cache_path(cache_dir, track_name)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not data.get("content"):
            return None
        data["from_cache"] = True
        data["found"] = True
        data["saved_path"] = path
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"[Chords] Cache read failed: {e}")
        return None


def save_chords(cache_dir: str, track_name: str, payload: dict) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    path = cache_path(cache_dir, track_name)
    to_save = {
        "content": payload.get("content") or "",
        "type": payload.get("type") or "Chords",
        "source": payload.get("source") or "",
        "source_name": payload.get("source_name") or "",
        "source_url": payload.get("source_url") or payload.get("url") or "",
        "song_name": payload.get("song_name") or "",
        "artist_name": payload.get("artist_name") or "",
        "rating": payload.get("rating"),
        "votes": payload.get("votes") or 0,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_save, f, ensure_ascii=False, indent=2)
    return path


def _payload_from_fetch(got: dict, artist: str, title: str) -> dict:
    return {
        "found": True,
        "from_cache": False,
        "content": got.get("content") or "",
        "type": got.get("type") or "Chords",
        "source": got.get("source") or "",
        "source_name": got.get("source_name") or "",
        "source_url": got.get("url") or "",
        "song_name": got.get("song_name") or title,
        "artist_name": got.get("artist_name") or artist,
        "rating": got.get("rating"),
        "votes": got.get("votes") or 0,
        "search_artist": artist,
        "search_title": title,
    }


def search_chord_candidates(artist: str = "", title: str = "", query: str = "") -> list[dict]:
    artist = (artist or "").strip()
    title = (title or "").strip()
    query = (query or "").strip()
    searches = []
    if query:
        searches.append(query)
    searches.extend(build_search_queries(artist, title))
    if artist and title:
        searches.append(f"{artist} - {title}")

    seen_q = set()
    unique_q = []
    for q in searches:
        q = re.sub(r"\s+", " ", q).strip()
        key = q.lower()
        if q and key not in seen_q:
            seen_q.add(key)
            unique_q.append(q)

    merged: list[dict] = []
    seen_ids = set()
    for q in unique_q[:3]:
        print(f"[Chords] Candidates query: {q!r}")
        for item in search_tab_candidates(q, artist, title):
            key = item.get("id") or item.get("url")
            if key in seen_ids:
                continue
            seen_ids.add(key)
            merged.append(item)
        if merged:
            break
    return merged[:15]


def get_or_fetch_chords(cache_dir: str, track_name: str, refresh: bool = False) -> dict:
    artist, title = parse_track_name(track_name)
    print(f"[Chords] Search: artist={artist!r} title={title!r} refresh={refresh}")

    if not refresh:
        cached = load_cached_chords(cache_dir, track_name)
        if cached:
            cached["search_artist"] = artist
            cached["search_title"] = title
            return cached

    queries = build_search_queries(artist, title)
    if not queries:
        queries = [track_name]

    last_error = "Chord/tab tidak ditemukan"
    for q in queries:
        candidates = search_tab_candidates(q, artist, title)
        if not candidates:
            continue
        for cand in candidates[:4]:
            print(f"[Chords] Trying {cand.get('source_name')} {cand.get('type')} {cand.get('url')}")
            got = fetch_candidate_content(cand)
            if not got or not got.get("content"):
                last_error = "Gagal memuat isi chord/tab"
                continue
            payload = _payload_from_fetch(got, artist, title)
            saved = save_chords(cache_dir, track_name, payload)
            payload["saved"] = True
            payload["saved_path"] = saved
            print(
                f"[Chords] Saved {got.get('source_name')} {got.get('type')} "
                f"{got.get('artist_name')} - {got.get('song_name')}"
            )
            return payload

    return {
        "found": False,
        "message": last_error,
        "search_artist": artist,
        "search_title": title,
    }


def apply_chords_for_track(cache_dir: str, track_name: str, candidate: dict) -> dict:
    artist, title = parse_track_name(track_name)
    got = fetch_candidate_content(candidate)
    if not got or not got.get("content"):
        return {"found": False, "message": "Gagal memuat chord/tab yang dipilih"}
    payload = _payload_from_fetch(got, artist, title)
    saved = save_chords(cache_dir, track_name, payload)
    payload["saved"] = True
    payload["saved_path"] = saved
    return payload
