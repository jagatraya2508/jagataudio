import random
import time
import os
from gear_db import GEAR_DB

# Generic gears for random generation
GENERIC_AMPS = [
    {"head": "Fender Twin Reverb", "cabinet": "2x12 Open Back", "settings": "Clean Channel, Bright Switch ON"},
    {"head": "Marshall JCM800", "cabinet": "Marshall 1960A 4x12", "settings": "High Sensitivity Input, Pre-Amp: 8"},
    {"head": "Mesa/Boogie Dual Rectifier", "cabinet": "Mesa 4x12 Oversized", "settings": "Modern High Gain, Diode Rectifier"}
]
GENERIC_GUITARS = [
    {"model": "Fender Stratocaster", "pickups": "Alnico V Single Coils", "strings": "10-46 Standard"},
    {"model": "Gibson Les Paul Standard", "pickups": "PAF-style Humbuckers", "strings": "10-46 Standard"},
    {"model": "Ibanez RG Series", "pickups": "High-Output Ceramic Humbuckers", "strings": "09-42 Super Slinky"}
]

def get_gear_for_song(artist_title: str):
    """Simulates an AI detecting gear based on song artist and title."""
    # Simulate processing time
    time.sleep(2.5)
    
    artist_title_lower = artist_title.lower() if artist_title else ""
    
    # Try to find a match in our database
    for artist, gear in GEAR_DB.items():
        aliases = gear.get("aliases", [])
        if artist in artist_title_lower or any(alias in artist_title_lower for alias in aliases):
            
            # Buat teks alternatif gear sederhana
            alt_guitar = "Epiphone / Squier atau gitar sejenis dengan spesifikasi pickup yang mirip"
            alt_amp = "Plugin digital (seperti Neural DSP, Bias FX) atau combo amp solid-state (Boss Katana)"
            
            return {
                "detected": True,
                "confidence": random.randint(85, 98),
                "artist_matched": artist.title(),
                "tone": gear["tone"],
                "amp": gear["amp"],
                "pedal": gear["pedal"],
                "guitar": gear["guitar"],
                "description": gear["description"],
                "alternative": f"Alternatif Hemat/Modern: Anda bisa menggunakan {alt_guitar}. Untuk ampli, gunakan {alt_amp} yang disetel mendekati karakter {gear['amp']['head']}."
            }
            
    # If no match, generate a plausible guess based on random selection
    tone_types = ["Clean & Shimmering", "Crunch / Overdrive", "High Gain / Distortion"]
    selected_tone = random.choice(tone_types)
    
    # Select gears based on tone (smart logic)
    pedal = {}
    if "Clean" in selected_tone:
        amp = GENERIC_AMPS[0] # Fender
        guitar = GENERIC_GUITARS[0] # Stratocaster
        pedal = {"modulation": "Boss CE-2 Chorus", "reverb": "Strymon BigSky"}
    elif "Crunch" in selected_tone:
        amp = GENERIC_AMPS[1] # Marshall
        guitar = GENERIC_GUITARS[1] # Les Paul
        pedal = {"overdrive": "Ibanez Tube Screamer", "boost": "Xotic EP Booster"}
    else:
        amp = GENERIC_AMPS[2] # Mesa Boogie
        guitar = GENERIC_GUITARS[2] # Ibanez
        pedal = {"distortion": "Boss DS-1", "noise_gate": "ISP Decimator"}
    
    desc = f"Analisis AI mendeteksi karakteristik '{selected_tone}'. Karakter ini sangat cocok dieksekusi dengan gitar {guitar['model']} yang masuk ke ampli {amp['head']} dan didorong oleh efek {list(pedal.values())[0]}."
    alt_desc = f"Alternatif: Jika {guitar['model']} terlalu mahal, cari versi entry-level (seperti Squier/Epiphone/Cort). Untuk ampli, gunakan Multi-Efek digital modern dengan simulasi {amp['head']}."
    
    return {
        "detected": True,
        "confidence": random.randint(50, 75),
        "artist_matched": "Analisis AI Generik",
        "tone": selected_tone,
        "amp": amp,
        "pedal": pedal,
        "guitar": guitar,
        "description": desc,
        "alternative": alt_desc
    }
