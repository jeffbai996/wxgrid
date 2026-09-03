"""Curated fallback list of ~25 well-known North American ski resorts.

Used when the Overpass build has never run or fails outright, and merged
into every Overpass-built catalog afterwards (seed elevations win when OSM
tags don't carry `ele`/`ele:min`/`ele:max` — Overpass ski-area relations
frequently omit elevation tags entirely, seed values fill that hole with
numbers we're actually confident about rather than inventing any).

Coordinates are the resort base/village; elevations in metres.
"""
from __future__ import annotations

SEED_RESORTS: list[dict] = [
    {"name": "Whistler Blackcomb", "country": "CA", "region": "BC", "lat": 50.1163, "lon": -122.9574, "ele_base_m": 675, "ele_summit_m": 2284,
     "featured": True, "website": "https://www.whistlerblackcomb.com/", "conditions_url": "https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/terrain-and-lift-status.aspx"},
    {"name": "Big White", "country": "CA", "region": "BC", "lat": 49.7167, "lon": -118.9333, "ele_base_m": 1508, "ele_summit_m": 2319,
     "featured": True, "website": "https://www.bigwhite.com/", "conditions_url": "https://www.bigwhite.com/mountain-conditions"},
    {"name": "Sun Peaks", "country": "CA", "region": "BC", "lat": 50.8836, "lon": -119.8886, "ele_base_m": 1255, "ele_summit_m": 2152,
     "featured": True, "website": "https://www.sunpeaksresort.com/", "conditions_url": "https://www.sunpeaksresort.com/ski-ride/the-mountain/lifts-trail-status"},
    {"name": "Revelstoke", "country": "CA", "region": "BC", "lat": 50.9581, "lon": -118.1642, "ele_base_m": 512, "ele_summit_m": 2225,
     "featured": True, "website": "https://www.revelstokemountainresort.com/", "conditions_url": "https://www.revelstokemountainresort.com/mountain/conditions/"},
    {"name": "Kicking Horse", "country": "CA", "region": "BC", "lat": 51.2969, "lon": -117.0567, "ele_base_m": 1190, "ele_summit_m": 2450,
     "featured": True, "website": "https://kickinghorseresort.com/", "conditions_url": "https://kickinghorseresort.com/conditions/"},
    {"name": "Lake Louise", "country": "CA", "region": "AB", "lat": 51.4419, "lon": -116.1620, "ele_base_m": 1646, "ele_summit_m": 2637,
     "featured": True, "website": "https://www.skilouise.com/", "conditions_url": "https://reports.skilouise.com/"},
    {"name": "Sunshine Village", "country": "CA", "region": "AB", "lat": 51.0833, "lon": -115.7667, "ele_base_m": 1660, "ele_summit_m": 2730,
     "featured": True, "website": "https://www.skibanff.com/", "conditions_url": "https://www.skibanff.com/conditions/"},
    {"name": "Cypress Mountain", "country": "CA", "region": "BC", "lat": 49.4025, "lon": -123.2033, "ele_base_m": 920, "ele_summit_m": 1440,
     "featured": True, "website": "https://www.cypressmountain.com/", "conditions_url": "https://www.cypressmountain.com/mountain-report"},
    {"name": "Grouse Mountain", "country": "CA", "region": "BC", "lat": 49.3825, "lon": -123.0822, "ele_base_m": 884, "ele_summit_m": 1231,
     "featured": True, "website": "https://www.grousemountain.com/", "conditions_url": "https://www.grousemountain.com/current_conditions"},
    {"name": "Mt Seymour", "country": "CA", "region": "BC", "lat": 49.3644, "lon": -122.9394, "ele_base_m": 1010, "ele_summit_m": 1449,
     "featured": True, "website": "https://mtseymour.ca/", "conditions_url": "https://mtseymour.ca/the-mountain/todays-conditions-hours"},
    {"name": "Mt Baker", "country": "US", "region": "WA", "lat": 48.8571, "lon": -121.6819, "ele_base_m": 1280, "ele_summit_m": 1650,
     "featured": True, "website": "https://www.mtbaker.us/", "conditions_url": "https://www.mtbaker.us/snow-report/"},
    {"name": "Crystal Mountain", "country": "US", "region": "WA", "lat": 46.9354, "lon": -121.4745, "ele_base_m": 1341, "ele_summit_m": 2134},
    {"name": "Stevens Pass", "country": "US", "region": "WA", "lat": 47.7448, "lon": -121.0890, "ele_base_m": 1240, "ele_summit_m": 1808,
     "featured": True, "website": "https://www.stevenspass.com/", "conditions_url": "https://www.stevenspass.com/the-mountain/mountain-conditions/lift-and-terrain-status.aspx"},
    {"name": "Snoqualmie", "country": "US", "region": "WA", "lat": 47.4237, "lon": -121.4131, "ele_base_m": 921, "ele_summit_m": 1645},
    {"name": "Mt Hood Meadows", "country": "US", "region": "OR", "lat": 45.3311, "lon": -121.6656, "ele_base_m": 1372, "ele_summit_m": 2255},
    {"name": "Mt Bachelor", "country": "US", "region": "OR", "lat": 43.9792, "lon": -121.6883, "ele_base_m": 1928, "ele_summit_m": 2764},
    {"name": "Jackson Hole", "country": "US", "region": "WY", "lat": 43.5875, "lon": -110.8280, "ele_base_m": 1924, "ele_summit_m": 3185},
    {"name": "Alta", "country": "US", "region": "UT", "lat": 40.5884, "lon": -111.6386, "ele_base_m": 2094, "ele_summit_m": 3216},
    {"name": "Snowbird", "country": "US", "region": "UT", "lat": 40.5820, "lon": -111.6558, "ele_base_m": 2365, "ele_summit_m": 3353},
    {"name": "Park City", "country": "US", "region": "UT", "lat": 40.6514, "lon": -111.5080, "ele_base_m": 2103, "ele_summit_m": 3049},
    {"name": "Vail", "country": "US", "region": "CO", "lat": 39.6403, "lon": -106.3742, "ele_base_m": 2475, "ele_summit_m": 3527},
    {"name": "Breckenridge", "country": "US", "region": "CO", "lat": 39.4817, "lon": -106.0384, "ele_base_m": 2926, "ele_summit_m": 3914},
    {"name": "Aspen Snowmass", "country": "US", "region": "CO", "lat": 39.2097, "lon": -106.9497, "ele_base_m": 2473, "ele_summit_m": 3813},
    {"name": "Mammoth Mountain", "country": "US", "region": "CA", "lat": 37.6308, "lon": -119.0326, "ele_base_m": 2424, "ele_summit_m": 3369},
    {"name": "Palisades Tahoe", "country": "US", "region": "CA", "lat": 39.1971, "lon": -120.2358, "ele_base_m": 1889, "ele_summit_m": 2743},
    {"name": "Killington", "country": "US", "region": "VT", "lat": 43.6045, "lon": -72.8201, "ele_base_m": 396, "ele_summit_m": 1293},
    {"name": "Tremblant", "country": "CA", "region": "QC", "lat": 46.2093, "lon": -74.5844, "ele_base_m": 265, "ele_summit_m": 875},
]

# Resort-owned camera pages, plus a small preview set where the operator
# publishes a stable still-image endpoint. Streams without a still remain a
# direct Cams link; loading a dozen third-party video players into the panel
# would be a heroic way to turn a weather app into a space heater.
_CAM_META: dict[str, dict] = {
    "Whistler Blackcomb": {
        "cams_url": "https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/mountain-cams.aspx",
        "mountain_cams": [
            {"name": "Roundhouse", "image": "https://player.brownrice.com/snapshot/whistlerroundhouse", "page": "https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/mountain-cams.aspx", "provider": "Whistler Blackcomb", "credit": "Whistler Blackcomb · Brownrice Internet", "elevation_m": 1850},
            {"name": "Whistler Peak", "image": "https://player.brownrice.com/snapshot/whistlerpeak", "page": "https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/mountain-cams.aspx", "provider": "Whistler Blackcomb", "credit": "Whistler Blackcomb · Brownrice Internet", "elevation_m": 2182},
            {"name": "7th Heaven", "image": "https://player.brownrice.com/snapshot/whistler7thheaven", "page": "https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/mountain-cams.aspx", "provider": "Whistler Blackcomb", "credit": "Whistler Blackcomb · Brownrice Internet", "elevation_m": 2284},
        ],
    },
    "Big White": {
        "cams_url": "https://www.bigwhite.com/mountain-conditions/webcams",
        "mountain_cams": [
            {"name": "Village Centre", "image": "https://www.bigwhite.com/sites/default/files/village_404.jpg", "page": "https://www.bigwhite.com/mountain-conditions/webcams", "provider": "Big White", "credit": "Big White Ski Resort"},
            {"name": "The Cliff", "image": "https://www.bigwhite.com/sites/default/files/cliff_399.jpg", "page": "https://www.bigwhite.com/mountain-conditions/webcams", "provider": "Big White", "credit": "Big White Ski Resort"},
            {"name": "Gem Lake", "image": "https://www.bigwhite.com/sites/default/files/gemlake_405.jpg", "page": "https://www.bigwhite.com/mountain-conditions/webcams", "provider": "Big White", "credit": "Big White Ski Resort"},
        ],
    },
    "Sun Peaks": {
        "cams_url": "https://www.sunpeaksresort.com/bike-hike/weather-webcams/webcams",
        "mountain_cams": [
            {"name": "Valley", "image": "https://www.sunpeaksresort.com/sites/default/files/spr_website_data/webcams/Valley.jpg", "page": "https://www.sunpeaksresort.com/bike-hike/weather-webcams/webcams", "provider": "Sun Peaks", "credit": "Sun Peaks Resort", "elevation_m": 1255},
            {"name": "Sundance", "image": "https://www.sunpeaksresort.com/sites/default/files/spr_website_data/webcams/sundance.jpg", "page": "https://www.sunpeaksresort.com/bike-hike/weather-webcams/webcams", "provider": "Sun Peaks", "credit": "Sun Peaks Resort", "elevation_m": 1731},
            {"name": "Top of the World", "image": "https://www.sunpeaksresort.com/sites/default/files/spr_website_data/webcams/westbowl-totw.jpg", "page": "https://www.sunpeaksresort.com/bike-hike/weather-webcams/webcams", "provider": "Sun Peaks", "credit": "Sun Peaks Resort", "elevation_m": 2093},
        ],
    },
    "Revelstoke": {"cams_url": "https://www.revelstokemountainresort.com/mountain/conditions/webcams/"},
    "Kicking Horse": {"cams_url": "https://kickinghorseresort.com/conditions/summer-mountain-cams/"},
    "Lake Louise": {
        "cams_url": "https://cams.skilouise.com/",
        "mountain_cams": [
            {"name": "Gondola Top", "image": "https://cams.skilouise.com/cam1sm.jpg", "page": "https://cams.skilouise.com/", "provider": "Lake Louise", "credit": "Lake Louise Ski Resort"},
            {"name": "Ptarmigan", "image": "https://cams.skilouise.com/cam3sm.jpg", "page": "https://cams.skilouise.com/", "provider": "Lake Louise", "credit": "Lake Louise Ski Resort"},
            {"name": "Paradise", "image": "https://cams.skilouise.com/cam8sm.jpg", "page": "https://cams.skilouise.com/", "provider": "Lake Louise", "credit": "Lake Louise Ski Resort"},
        ],
    },
    "Sunshine Village": {
        "cams_url": "https://www.skibanff.com/conditions/#webcams",
        "mountain_cams": [
            {"name": "Standish", "image": "https://cameras.skibanff.com/dynamic/15m", "page": "https://www.skibanff.com/conditions/#webcams", "provider": "Sunshine Village", "credit": "Banff Sunshine Village", "elevation_m": 2400},
            {"name": "Aurora", "image": "https://cameras.skibanff.com/dynamic/10m", "page": "https://www.skibanff.com/conditions/#webcams", "provider": "Sunshine Village", "credit": "Banff Sunshine Village", "elevation_m": 2330},
            {"name": "Mount Assiniboine", "image": "https://cameras.skibanff.com/dynamic/17m", "page": "https://www.skibanff.com/conditions/#webcams", "provider": "Sunshine Village", "credit": "Banff Sunshine Village", "elevation_m": 3618},
        ],
    },
    "Cypress Mountain": {"cams_url": "https://www.cypressmountain.com/webcams"},
    "Grouse Mountain": {"cams_url": "https://www.grousemountain.com/web-cams/"},
    "Mt Seymour": {"cams_url": "https://mtseymour.ca/the-mountain/todays-conditions-hours#webcams"},
    "Stevens Pass": {
        "cams_url": "https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx",
        "mountain_cams": [
            {"name": "Snow Stake", "image": "https://player.brownrice.com/snapshot/stevenspasssnowstake", "page": "https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx", "provider": "Stevens Pass", "credit": "Stevens Pass · Brownrice Internet"},
            {"name": "Jupiter", "image": "https://player.brownrice.com/snapshot/stevenspassjupiter", "page": "https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx", "provider": "Stevens Pass", "credit": "Stevens Pass · Brownrice Internet"},
            {"name": "Skyline", "image": "https://player.brownrice.com/snapshot/stevenspassskyline", "page": "https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx", "provider": "Stevens Pass", "credit": "Stevens Pass · Brownrice Internet"},
        ],
    },
}

for _resort in SEED_RESORTS:
    _resort.update(_CAM_META.get(_resort["name"], {}))

del _resort
