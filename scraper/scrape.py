import json
import os
import sys
import re
from datetime import date
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

DATA_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "prices.json")
TARGET_URL = "https://www.selectcarleasing.com/car-leasing/tesla/model-y/"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def parse_price(text):
    if not text:
        return None
    match = re.search(r"[\d,]+\.?\d*", text.replace(",", ""))
    return float(match.group()) if match else None


def parse_months(text):
    if not text:
        return None
    match = re.search(r"\d+", text)
    return int(match.group()) if match else None


def parse_mileage(text):
    if not text:
        return None
    match = re.search(r"[\d,]+", text.replace(",", ""))
    return int(match.group()) if match else None


def scrape_page(page):
    listings = []

    # Wait for car listing cards to appear
    try:
        page.wait_for_selector(
            "article, [class*='vehicle'], [class*='car-card'], [class*='result'], [class*='listing']",
            timeout=15000,
        )
    except PlaywrightTimeoutError:
        print("WARNING: timed out waiting for listing cards", flush=True)

    # Broad card selector — works across common lease site layouts
    cards = page.query_selector_all(
        "article, [class*='vehicle-card'], [class*='car-card'], "
        "[class*='result-item'], [class*='listing-card']"
    )
    print(f"  Found {len(cards)} candidate cards", flush=True)

    for card in cards:
        try:
            # --- Variant name ---
            name_el = card.query_selector(
                "h2, h3, [class*='title'], [class*='name'], [class*='model']"
            )
            variant = name_el.inner_text().strip() if name_el else None

            # Skip cards that aren't Model Y
            if variant and "model y" not in variant.lower() and "tesla" not in variant.lower():
                continue

            # --- Monthly price ---
            monthly_el = card.query_selector(
                "[class*='monthly'], [class*='price']:not([class*='initial']):not([class*='deposit']), "
                "[class*='per-month'], [data-price]"
            )
            monthly_price = None
            if monthly_el:
                monthly_price = parse_price(monthly_el.inner_text())

            # Fallback: find any price-looking text in the card
            if monthly_price is None:
                all_text = card.inner_text()
                # Look for pattern like "£449" or "449.99 per month"
                price_matches = re.findall(r"£\s*([\d,]+\.?\d*)", all_text)
                if price_matches:
                    prices = [float(p.replace(",", "")) for p in price_matches]
                    # Monthly price is typically the smallest value on a lease card
                    monthly_price = min(prices)

            # --- Initial payment / deposit ---
            deposit_el = card.query_selector(
                "[class*='initial'], [class*='deposit'], [class*='advance']"
            )
            initial_payment = parse_price(deposit_el.inner_text()) if deposit_el else None

            # --- Contract length ---
            term_el = card.query_selector(
                "[class*='term'], [class*='contract'], [class*='duration'], [class*='month']"
            )
            contract_months = None
            if term_el:
                contract_months = parse_months(term_el.inner_text())
            if contract_months is None:
                # Scan card text for e.g. "36 months" or "24 month"
                match = re.search(r"(\d+)\s*months?", card.inner_text(), re.IGNORECASE)
                contract_months = int(match.group(1)) if match else None

            # --- Annual mileage ---
            mileage_el = card.query_selector(
                "[class*='mileage'], [class*='miles'], [class*='annual']"
            )
            annual_mileage = None
            if mileage_el:
                annual_mileage = parse_mileage(mileage_el.inner_text())
            if annual_mileage is None:
                match = re.search(r"([\d,]+)\s*(?:miles?|mpа)\s*(?:per\s*year|p\.?a\.?|annual)", card.inner_text(), re.IGNORECASE)
                if match:
                    annual_mileage = int(match.group(1).replace(",", ""))

            if variant or monthly_price:
                listing = {
                    "variant": variant or "Tesla Model Y",
                    "monthly_price": monthly_price,
                    "initial_payment": initial_payment,
                    "contract_months": contract_months,
                    "annual_mileage": annual_mileage,
                }
                listings.append(listing)
                print(f"  + {listing['variant']} | £{monthly_price}/mo | {contract_months}mo | {annual_mileage}mi/yr", flush=True)

        except Exception as e:
            print(f"  WARNING: error parsing card: {e}", flush=True)
            continue

    return listings


def get_next_page_url(page):
    next_btn = page.query_selector(
        "a[rel='next'], [class*='pagination'] a[aria-label*='next' i], "
        "[class*='next-page'], [class*='pagination__next']"
    )
    if next_btn:
        href = next_btn.get_attribute("href")
        if href:
            return href if href.startswith("http") else f"https://www.selectcarleasing.com{href}"
    return None


def load_existing_data():
    try:
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_data(data):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def main():
    today = date.today().isoformat()
    print(f"Scraping Tesla Model Y prices for {today}...", flush=True)

    all_listings = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1280, "height": 800},
            locale="en-GB",
        )
        page = context.new_page()

        # Block images/fonts to speed up scraping
        page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", lambda r: r.abort())

        url = TARGET_URL
        page_num = 1

        while url:
            print(f"Page {page_num}: {url}", flush=True)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_load_state("networkidle", timeout=15000)
            except PlaywrightTimeoutError:
                print(f"WARNING: timeout loading {url} — trying to scrape what loaded", flush=True)

            # Accept cookies if prompted
            for selector in ["[id*='accept'], [class*='accept-cookie'], button[aria-label*='accept' i]"]:
                btn = page.query_selector(selector)
                if btn:
                    try:
                        btn.click()
                        page.wait_for_timeout(500)
                    except Exception:
                        pass

            listings = scrape_page(page)
            all_listings.extend(listings)

            next_url = get_next_page_url(page)
            url = next_url
            page_num += 1

            if page_num > 20:  # Safety limit
                print("WARNING: reached page limit (20)", flush=True)
                break

        browser.close()

    print(f"\nTotal listings scraped: {len(all_listings)}", flush=True)

    if not all_listings:
        print("ERROR: no listings found — check selectors or site structure", flush=True)
        sys.exit(1)

    data = load_existing_data()

    # Upsert today's entry
    existing_dates = {entry["date"]: i for i, entry in enumerate(data)}
    entry = {"date": today, "listings": all_listings}

    if today in existing_dates:
        data[existing_dates[today]] = entry
        print(f"Updated existing entry for {today}", flush=True)
    else:
        data.append(entry)
        print(f"Added new entry for {today}", flush=True)

    save_data(data)
    print(f"Saved to {DATA_FILE}", flush=True)


if __name__ == "__main__":
    main()
