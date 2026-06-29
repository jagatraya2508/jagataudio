import cloudscraper
from bs4 import BeautifulSoup
import json
import urllib.parse
import re
import requests

def try_guitartabs_search(song: str, band: str = "") -> list:
    headers = {'User-Agent': 'Mozilla/5.0'}
    enc_song = urllib.parse.quote(song)
    enc_band = urllib.parse.quote(band)
    url = f"https://www.guitartabs.cc/search.php?tabtype=any&band={enc_band}&song={enc_song}"
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, 'html.parser')
        valid = []
        for a in soup.find_all('a'):
            href = a.get('href', '')
            if '/tabs/' in href and ('_tab.html' in href or '_crd.html' in href):
                title = a.text.strip()
                if 'bass' not in title.lower() and 'drum' not in title.lower():
                    t_type = "Chords" if "_crd.html" in href else "Tab"
                    valid.append((href, title, t_type))
        return valid
    except:
        return []

def search_tab_data(query: str):
    """
    Searches for a tab on guitartabs.cc with smart query splitting,
    extracts the tab content, and returns a dictionary with the data.
    """
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        
        valid_tabs = try_guitartabs_search(song=query)
        
        if not valid_tabs and "-" in query:
            parts = [p.strip() for p in query.split("-", 1)]
            valid_tabs = try_guitartabs_search(song=parts[0], band=parts[1])
            if not valid_tabs:
                valid_tabs = try_guitartabs_search(song=parts[1], band=parts[0])
                
        if not valid_tabs:
            words = query.split()
            if len(words) > 2:
                valid_tabs = try_guitartabs_search(song=" ".join(words[:2]))
                if not valid_tabs:
                    valid_tabs = try_guitartabs_search(song=words[0])
                
        if not valid_tabs:
            return {"error": f"Maaf, tidak menemukan hasil tabulatur/chord untuk '{query}' di database."}
            
        best_href, best_title, tab_type = valid_tabs[0]
        best_tab_url = f"https://www.guitartabs.cc{best_href}"
        
        # 2. Fetch the actual tab page
        tab_response = requests.get(best_tab_url, headers=headers)
        if tab_response.status_code != 200:
            return {"error": "Gagal membuka halaman sumber tab."}
            
        tab_soup = BeautifulSoup(tab_response.text, 'html.parser')
        pres = tab_soup.find_all('pre')
        
        if len(pres) < 2:
            if len(pres) == 1:
                tab_content = pres[0].text
            else:
                return {"error": "Gagal mengekstrak isi tab dari halaman."}
        else:
            tab_content = pres[1].text
            
        formatted_content = f"=== JAGAT AUDIO - ONLINE TAB SEARCH ===\n"
        formatted_content += f"Pencarian: {query}\n"
        formatted_content += f"Sumber: {best_tab_url}\n"
        formatted_content += f"Judul Asli: {best_title}\n"
        formatted_content += f"Tipe: {tab_type}\n\n"
        formatted_content += tab_content

        return {
            "success": True,
            "source": best_tab_url,
            "type": tab_type,
            "rating": "N/A",  # Guitartabs doesn't show standard rating on search
            "content": formatted_content
        }
        
    except Exception as e:
        return {"error": f"Terjadi kesalahan saat mencari tab online: {str(e)}"}

if __name__ == "__main__":
    # Test
    search_and_download_tab("peterpan mungkin nanti", "test_tab.txt")
