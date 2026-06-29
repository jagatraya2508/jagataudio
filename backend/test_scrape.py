import cloudscraper

def test():
    scraper = cloudscraper.create_scraper()
    response = scraper.get("https://www.ultimate-guitar.com/search.php?search_type=title&value=metallica+one")
    print(response.status_code)

if __name__ == "__main__":
    test()
