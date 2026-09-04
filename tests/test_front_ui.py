import re
from pathlib import Path


ROOT = Path(__file__).parents[1]


def _read(name: str) -> str:
    return (ROOT / "front" / name).read_text()


def test_model_row_is_flat_and_hides_nothing():
    # The AI-child fold shipped 2026-08-21 and was vetoed the same day
    # (Jeff: "go back to how it was"). The contract is now the opposite:
    # every model renders as a plain always-visible pill, and a long row
    # scrolls sideways instead of folding members away.
    app = _read("app.js")
    css = _read("styles.css")
    assert "aiParent" not in app
    assert "model-child" not in app
    assert "#models { flex: 0 1 auto; min-width: 132px; overflow-x: auto;" in css


def test_phone_model_and_layer_rows_are_denser_without_shrinking_levels():
    app = _read("app.js")
    css = _read("styles.css")
    assert 'railLabel("Winter mode", "Winter")' in app
    assert 'f.key === "ptype" ? "Precip" : ""' in app
    assert ".rail-label-phone { display: none; }" in css
    assert "#models button { padding: 4px 9px; font-size: 11.5px;" in css
    assert ".rail button { padding: 3px 8px;" in css
    assert "#levels button { padding: 4px 9px" not in css


def test_winter_mode_is_a_reversible_workspace_with_featured_resort_details():
    html = _read("index.html")
    app = _read("app.js")
    overlays = _read("overlays.js")
    panes = _read("panes.js")
    static_api = _read("static-api.js")
    css = _read("styles.css")
    assert 'id="winter-toggle"' in html and "Winter mode" in html
    assert "WINTER_FAMILY_ORDER" in app and 'wxgrid.winterReturn' in app
    assert 'state.base = "topo"' in app and "state.resorts = true" in app and "state.avy = true" in app
    assert 'id: "resort-icon"' in overlays and '["get", "featured"]' in overlays
    assert "function clearResortDetail()" in overlays and "pistes-groomed" in overlays
    assert "Live conditions ↗" in panes
    for label in ('"Easy"', '"Intermediate"', '"Difficult"', '"Expert"'):
        assert label in overlays
    assert 'CA: "Canada"' in panes and "Mountain cams" in panes
    assert "stationName(o.name)" in panes and "province.toUpperCase()}, Canada" in panes
    assert 'country: latinize(a.country ||' in static_api
    assert "Band weather is model-estimated" not in panes
    assert "North American ratings" in overlays
    assert 'pisteGrade("black", "Difficult", "#111318"' in overlays
    assert "local_case: local.caseColor" in overlays
    assert 'return { resort, boundary: null, lifts: [], pistes: [] }' in static_api
    assert "body.has-resort #point" in css and "body.winter-mode .rail" in css
    resort_blocks = [part.split("}", 1)[0] for part in css.split("body.has-resort #point {")[1:]]
    assert any("max(var(--top-h), 48px)" in block and "max(var(--tb-h), 96px)" in block
               for block in resort_blocks)


def test_wind_tables_use_a_shafted_downwind_needle_and_tape_dates_do_not_autosize():
    app = _read("app.js")
    panes = _read("panes.js")
    tape = _read("tape.js")
    route = _read("route.js")
    css = _read("styles.css")
    assert "(deg + 180) % 360" in app and "180 + 45" not in app
    assert "M12 21V4M5.5 10.5 12 4l6.5 6.5" in css
    assert "border-left:1.5px solid currentColor" not in panes
    assert panes.count('class="dirarrow"') >= 4
    assert 'class="dirarrow"' in tape and 'class="dirarrow"' in route
    assert "font-size: 11px" in css
    assert "-webkit-text-size-adjust: 100%" in css
    assert "table.bandtape th.band { padding: 6px 10px 5px; }" in css


def test_particles_settle_on_real_cold_boot_lifecycle_and_bound_polar_steps():
    source = _read("particles.js")
    for event in ('map.on("style.load", this._settle)',
                  'map.on("projectiontransition", this._settle)',
                  'map.on("load", this._settle)'):
        assert event in source
    assert "new ResizeObserver(this._settle)" in source
    assert "MAX_STEP_PX" in source and "screenStep > stepCap" in source
    assert "this.map.unproject([x, y])" in source
    assert "nlat > 89.99 || nlat < -89.99" in source
    # polarQuiet (0.4 density above 65N) was removed 2026-08-21 on Jeff's
    # order - the thinning read as the wind dying at the pole. The px
    # governor asserted above is the polar control now.
    assert "this._seedLat > 65" in source
    assert "polarView ? 0.12 : 0.06" in source


def test_global_weather_image_reaches_the_finite_visual_poles():
    app = _read("app.js")
    assert "const WORLD = [[-180, 89.99], [180, 89.99], [180, -89.99], [-180, -89.99]]" in app


def test_layer_probe_maps_regional_pixels_inside_the_model_domain():
    source = _read("probe.js")
    assert "model.regional" in source
    assert "const [west, south, east, north] = model.domain" in source
    assert "mercatorY(north)" in source and "mercatorY(south)" in source


def test_tape_has_equal_outer_gutters_and_owns_safe_area_padding():
    css = _read("styles.css")
    block = css.split("#timebar {", 1)[1].split("}", 1)[0]
    assert "left: 8px; right: 8px" in block
    assert "bottom: 8px" in block
    assert "calc(3px + env(safe-area-inset-bottom))" in block   # tightened 2026-09-02, slider sits on the edge


def test_next_48_hour_blurb_vertical_space_is_compact():
    css = _read("styles.css")
    rule = css.split(".summary {", 1)[1].split("}", 1)[0]
    assert "margin: 1px 0 3px" in rule
    assert "padding: 0 0 0 11px" in rule


def test_alert_polygons_open_a_map_card_and_highlight_themselves():
    ov = _read("overlays.js")
    # the toast clipped every long area name at 160 characters
    assert 'WX.fn.toast(`${p.event} · ${p.area}`' not in ov
    assert 'openAlertCard(e.lngLat, f.properties)' in ov
    assert "function openAlertCard(" in ov and 'mapCard(at, "alert-pop"' in ov
    # the clicked shape wears a heavier outline while its card is open
    assert 'id: "alerts-hi"' in ov and 'M().setFilter("alerts-hi", ["==", ["get", "id"]' in ov
    # and the card asks for the prose the layer deliberately does not carry
    assert "/alerts/detail?id=" in ov


def test_environment_canada_alerts_use_the_layer_geomet_still_serves():
    ov = _read("overlays.js")
    # "ALERTS" was retired: GeoMet answers "Couche non disponible" for it, so
    # the Canadian layer was painting nothing at all
    assert "LAYERS=ALERTS&" not in ov
    assert "LAYERS=Current-Alerts&" in ov
    # the raster has no feature to click, so a tap asks GeoMet what is there
    assert "/alerts/ec?lat=" in ov


def test_the_beach_block_leans_on_the_servers_nearest_water_probe():
    panes = _read("panes.js")
    # the old test was "does this exact gridpoint have a wave height", which
    # on a 0.25° grid asks whether the pin landed up to 28 km offshore
    assert "d.derived.coast" in panes
    assert "const nearCoast = (pt, d, i) => marineHere(d.series, i) || !!coastNear(d)" in panes
    assert 'seaVal(d, i, "swh")' in panes and 'seaVal(d, i, "sst")' in panes


def test_surf_and_beach_read_the_swell_direction_and_the_tide():
    panes = _read("panes.js")
    assert "compass(mwd.v)" in panes                 # met convention: where it comes FROM
    assert "function nextTide(pt)" in panes and "nextTide(pt)" in panes


def test_the_field_path_hides_the_raster_layer_without_removing_it():
    # The GPU path draws "wx-field" and leaves "wx" in the style: overlays.js
    # dims that layer id for radar and satellite, and the shader reads its
    # opacity back. Hidden, and pointed at a blank image so no PNG is fetched.
    app = _read("app.js")
    assert 'const fieldLive = () => !!(WX.field && WX.field.live);' in app
    assert 'visibility: gpu ? "none" : "visible"' in app
    assert 'map.addSource("wx", { type: "image", url: gpu ? BLANK : layerUrl()' in app
    assert 'if (gpu && !map.getLayer("wx-field")) map.addLayer(WX.field.layer, firstSymbolId());' in app
    # and giving up puts the raster back rather than leaving an empty map
    assert 'function fieldGaveUp()' in app
    assert 'map.setLayoutProperty("wx", "visibility", "visible")' in app


def test_the_timeline_mixes_two_steps_and_lands_on_a_real_one():
    app = _read("app.js")
    # the slider is continuous only where the field layer can mix
    assert 'slider.step = fieldLive() ? "0.02" : "1";' in app
    assert "function settleStep()" in app and "slider.onchange = () => { settleStep();" in app
    # playback glides between steps instead of swapping whole frames
    assert "playRaf = requestAnimationFrame(playFrame)" in app
    assert "WX.field.show(fieldSpec()); renderClock();" in app
    # the clock follows the mix, so the map and the time agree mid-scrub
    assert "runDate().getTime() + shownHours() * 3600e3" in app


def test_precipitation_type_is_drawn_as_cells_and_everything_else_smooth():
    field = _read("field.js")
    assert 'const CELL_LAYERS = new Set(["ptype"]);' in field
    # accumulations hold their step in time but stay continuous in space
    assert '"tp6", "tp24", "tp72"' in field.split("SNAP_LAYERS")[1].split(")")[0]
    assert "vec4 crw(float t)" in field and "u_cells > 0.5" in field


def test_the_probe_reads_the_field_and_keeps_the_colour_fallback():
    probe = _read("probe.js")
    assert "const got = WX.field.sample(lng, lat);" in probe
    assert 'if (WX.field && WX.field.live) { data = null; forUrl = ""; return; }' in probe
    # the nearest-colour inversion is still there for the raster path
    assert "for (let k = 0; k < 256; k++) { const c = r.cols[k].rgb;" in probe


def test_the_service_worker_keeps_field_files_with_the_run():
    sw = _read("sw.js")
    # The field files need a cache generation of their own, and the number only
    # ever goes up: pin the floor, not the name, so the next unrelated bump is
    # not a test failure.
    m = re.search(r'const VERSION = "wxgrid-v(\d+)"', sw)
    assert m and int(m.group(1)) >= 31
    assert "IMMUTABLE = /^api\\/(layer|field|wind|isolines|thunder)\\//" in sw
    assert "/\\/api\\/(?:layer|field|wind|isolines|thunder)(\\/[^/]+\\/[^/]+\\/)/" in sw


def test_the_field_layer_holds_the_last_frame_while_the_next_loads():
    # An ImageSource keeps its old image across updateImage. Blanking the map
    # for the length of a request would be the one place the new path is
    # worse than the one it replaces.
    field = _read("field.js")
    assert "let pending = null;" in field
    assert "if (!pending || !pending.a || !pending.a.img) return;" in field
    assert "if (pending && (e === pending.a || e === pending.b)) continue;" in field


def test_the_outdoors_tide_card_draws_the_curve_and_the_hero_stays_lean():
    panes = _read("panes.js")
    css = _read("styles.css")
    assert "function tideCard(pt)" in panes and "${tideCard(pt)}" in panes
    # cosine between consecutive turns — the classic hi/lo interpolation
    assert "Math.cos(" in panes.split("function tideCard")[1].split("\n  }\n")[0]
    # the curve sits in the Outdoors tides block, not on the hero
    assert panes.index("${tideCard(pt)}") > panes.index("<b>Tides</b><span class=\"nm\">${esc(t.station)}")
    assert "tideCard(pt)" not in panes.split("function renderNow")[1].split("fetchNearStorm(pt)")[0]
    assert "tide-hero" not in css and "tide-hero" not in panes
    # only turns still ahead of the card's time are listed
    assert "new Date(e.time).getTime() > now).slice(0, 8)" in panes


def test_outdoors_is_sectioned_with_a_graphic_per_question_and_names_its_worry():
    panes = _read("panes.js")
    out = panes.split("function renderOutdoors")[1].split("function hourStrip")[0]
    assert 'section("Sky &amp; rain", sky' in out and 'section("Sun", uv' in out and 'section("Wind", gust' in out
    assert "Workable, watch it" not in out                     # the verdict says what to watch
    assert 'class="why"' in out
    assert 'rows.push(["Sun"' not in out                       # sunrise lives on the hero
    assert "const H = 48;" in out                              # every strip: two days
    assert "function hourStrip(d, i, hours, cell, label)" in panes and "function windCard(d, i, hours)" in panes


def test_the_tide_chart_marks_time_with_a_ring_and_follows_the_pointer():
    panes = _read("panes.js"); css = _read("styles.css")
    assert 'class="tdot now"' in panes and "tnow" not in panes          # no bar
    assert "function wireTideProbe()" in panes and "wireTideProbe();" in panes
    assert 'addEventListener("pointermove"' in panes.split("function wireTideProbe")[1].split("\n  }\n")[0]
    assert ".tide-area .tnow" not in css


def test_the_wind_chart_is_drawn_like_the_tide_chart():
    panes = _read("panes.js"); css = _read("styles.css")
    wind = panes.split("function windCard")[1].split("function wireWindProbe")[0]
    assert 'class="tide-y"' in wind and 'class="tide-x"' in wind        # axes
    assert 'class="tdot now"' in wind and "polyline class=\"g\"" in wind   # ring, gust line
    assert "function wireWindProbe()" in panes and "wireWindProbe();" in panes
    assert "sparkStrip" not in panes and ".hstrip.line" not in css      # the old strip is gone


def test_each_probe_wires_its_own_chart():
    panes = _read("panes.js"); css = _read("styles.css")
    # the wind card reuses the tide frame, so the tide probe must pick the
    # area that carries tide events — not the first .tide-area in the DOM
    assert '$("#outdoors .tide-area[data-ev]")' in panes
    tide_css = "\n".join(l for l in css.splitlines() if l.startswith((".tide", ".tides-obs")))
    assert "font-mono" not in tide_css                      # Urbanist/DM Sans, not Geist Mono


def test_the_outdoors_verdict_carries_a_briefing_and_the_tape_shades_its_rain():
    panes = _read("panes.js"); tape = _read("tape.js"); css = _read("styles.css")
    assert "function outdoorsBrief(d, i, c)" in panes and 'class="brief"' in panes
    # the hero summary says where the sky is going and where the wind is from
    summ = panes.split("function story(d, sel)")[1].split("const BEAUFORT")[0]
    assert "Clouding over" in summ and "Clearing" in summ and "from the ${compass(" in summ
    assert "rest.slice(0, 4)" in summ
    # Rain is a continuous, filled trace behind the exact amount. The scale
    # keeps 10 mm as the minimum ceiling but expands for genuinely wet days.
    assert "Math.max(10, ...rainAmount)" in tape
    assert "Math.sqrt(Math.max(0, mm) / rainScale)" in tape
    assert 'class="precip-area"' in tape and 'class="bar"' not in tape
    assert ".precip-area .fill" in css and ".precip-area .line" in css
    # Curves replace the angular midpoint polyline, and a dry bucket stays
    # empty even when the next forecast period is wet.
    assert "if (here <= 0) return \"\"" in tape
    assert "C15 ${startY.toFixed(1)}" in tape and "C65 ${peakY.toFixed(1)}" in tape
    assert "L50 ${rainY(here)" not in tape
    assert "stroke-linecap: round" in css and "shape-rendering: geometricPrecision" in css


def test_outdoors_cards_lead_with_the_number_and_keep_green_quiet():
    panes = _read("panes.js"); css = _read("styles.css")
    out = panes.split("function renderOutdoors")[1].split("function hourStrip")[0]
    assert "const lead = (v) =>" in out and '<span class="v">${lead(v)}</span><span class="k">' in out   # value first
    assert ".od .kv .stat.good .v { color: var(--fg); }" in css                                       # fine = uncoloured
    assert ".od .kv .stat.meh { border-left-color: var(--warm); }" in css


def test_outdoors_cards_carry_a_glyph_and_a_gauge_where_the_reading_is_a_share():
    panes = _read("panes.js"); css = _read("styles.css")
    assert "const OD_GLYPHS" in panes and 'class="glyph"' in panes and 'class="gauge"' in panes
    out = panes.split("function renderOutdoors")[1].split("function hourStrip")[0]
    assert 'k.startsWith("Dry, calm")' in out and "num / 11" in out            # dry hours of 72, UV of 11
    assert ".od .kv .stat .glyph" in css and ".od .kv .stat .gauge b" in css


def test_every_outdoors_strip_answers_the_pointer():
    panes = _read("panes.js"); css = _read("styles.css")
    assert "function wireStripProbes()" in panes and "wireStripProbes();" in panes
    assert ".hstrip .cells .tlab" in css
    assert "cloud ${Math.round(c * 100)}%" in panes            # the sky strip says cloud and rain in words


def test_no_webgl_leaves_the_forecast_working_and_night_shades_the_strips():
    app = _read("app.js"); panes = _read("panes.js"); css = _read("styles.css")
    assert "function hasWebGL()" in app and "function noMap(center, zoom)" in app
    assert "map = hasWebGL() ? new maplibregl.Map({" in app
    for m in ("project(", "unproject(", "getBounds()", "queryRenderedFeatures", "once(ev", "jumpTo(o)"):
        assert m in app.split("function noMap")[1].split("function fieldGaveUp")[0]
    assert "body.no-map #map" in css
    assert "function isNight(lat, lon, when)" in panes and "function nightBands(x0, x1, X)" in panes
    assert "${nights}" in panes and "${nightBands(x0, x1, X)}" in panes         # wind and tide charts
    assert ".hstrip .cells i.n::after" in css and ".tide-area .nb" in css


def test_the_hero_and_the_outdoors_verdict_read_one_story_and_the_tape_has_a_column_card():
    panes = _read("panes.js"); tape = _read("tape.js"); css = _read("styles.css")
    assert "function story(d, sel)" in panes
    assert "const parts = story(d, sel);" in panes.split("function summarise")[1].split("\n  }\n")[0]
    assert "const parts = story(d, i);" in panes.split("function outdoorsBrief")[1].split("\n  }\n")[0]
    assert "rest.push(" not in panes.split("function story(d, sel)")[1].split("function summarise")[0]
    assert "function wireTapeHover(tape)" in tape and "wireTapeHover(tape);" in tape
    assert 'if (e.pointerType === "touch") return;' in tape
    assert "#tape-card" in css
    assert 'class="card-head"' in tape and 'class="card-metrics"' in tape
    assert 'class="metric ${kind}"' in tape
    assert 'name = "Snow"' in tape
    assert "#tape-card .source.ai" in css and "#tape-card .metric.feels" in css


def test_the_marine_touring_and_leave_at_cards_exist_and_make_one_call_each():
    panes = _read("panes.js"); route = _read("route.js"); css = _read("styles.css")
    assert "function marineCard(pt, d, i)" in panes and 'section("Sea", marineCard(pt, d, i)' in panes
    m = panes.split("function marineCard")[1].split("function hourStrip")[0]
    assert '"offshore"' in m and '"onshore"' in m and "Blown out" in m and "Clean" in m
    assert "const touringHtml" in panes and "${touringHtml}${powderHtml}" in panes
    assert "High concern" in panes and "Caution" in panes and "Lower concern" in panes
    assert "touring-remark" in panes and ".touring-remark" in css
    assert "async function bestDepartures()" in route and "function scoreSummary(s, thr)" in route
    assert "[0, 3, 6, 9, 12, 15, 18, 21, 24]" in route            # nine departures over a day
    assert ".modcard.marine, .modcard.touring" in css


def test_aloft_readings_are_cards_and_legend_ticks_are_urbanist():
    panes = _read("panes.js"); css = _read("styles.css")
    assert "function statCards(rows, cls)" in panes and '], "aloft-kv")' in panes
    assert '<dl class="kv">' not in panes.split("function renderAloft")[1].split("const capeClass")[0]
    assert ".aloft-kv .stat" in css and ".aloft-kv .stat.g-baro" in css
    assert "font: 650 10.5px var(--font-display)" in css.split(".legend-ticks {")[1].split("}")[0]
    assert '<i class="lvl">850 hPa</i>' in panes


def test_the_storm_list_is_fetched_once_per_card():
    panes = _read("panes.js")
    assert "let stormMemo = { t: 0, p: null };" in panes and "storms().then((gj) =>" in panes


def test_overlays_module_does_not_read_consts_before_they_exist():
    # 2026-09-01: a satellite table at module scope called WMS(), a const
    # declared later in the file; the TDZ throw killed WX.ov for every user.
    # The table is a function now, evaluated when the overlay is switched on.
    ov = _read("overlays.js")
    assert "const SAT_LAYERS = () => [" in ov
    assert "const SAT_LAYERS = [" not in ov
    assert "of SAT_LAYERS()" in ov and "SAT_LAYERS().forEach" in ov


def test_now_pane_readings_are_stat_tiles_and_the_card_carries_webcams():
    # 2026-09-02: pills → stat tiles (label over number, like the wind box);
    # a webcams strip slotted in once per pin from /api/webcams (DriveBC first).
    panes = _read("panes.js")
    css = _read("styles.css")
    assert "const stat = (k, v, unit, color, extra = \"\", title = \"\") =>" in panes
    assert 'normal.push(stat("Rain 6 h"' in panes and 'normal.push(stat("Pressure"' in panes
    assert 'class="chipv" style="color:#71b8ff"' not in panes            # the old pill is gone
    assert '<div id="cams-slot" class="cams" hidden></div>' in panes
    assert "function fetchCams(pt)" in panes and "function openCam(c)" in panes
    assert ".meta:has(.stat) { display: grid;" in css
    assert ".meta .stat::before" in css and "background: var(--c); opacity: .85;" in css
    assert "color: var(--fg); display: flex; align-items: baseline" in css
    assert ".cam-view::backdrop" in css
    assert 'class="icon cam-view-close"' in panes
    assert ".cam-view-close { width: 32px !important; height: 32px !important;" in css


def test_now_wind_compass_uses_a_hubless_open_needle():
    panes = _read("panes.js")
    css = _read("styles.css")
    assert 'path class="needle" d="M24 32 L24 12 M19.5 17 L24 12 L28.5 17"' in panes
    assert 'class="hub"' not in panes
    assert ".wind-dial text.card { font: 600 5.25px" in css
    assert ".wind-dial .needle { fill: none;" in css and "stroke-width: 1.35" in css


def test_winter_tab_stays_for_winter_sport_country_all_year():
    panes = _read("panes.js")
    assert "const SKI_LAT = 33;" in panes
    assert "return Math.abs(pt.lat) >= SKI_LAT || elev >= 1000;" in panes


def test_locate_sits_at_the_foot_of_the_tool_strip():
    app = _read("app.js")
    assert 'class="sep strip-locate-sep"' in app
    assert 'if (locate) st.insertBefore(locate, more);' in app
    assert '!el.classList.contains("strip-locate-sep")' in app


def test_fire_and_smoke_are_their_own_strip_group_and_flyout_icons_match():
    app = _read("app.js"); html = _read("index.html")
    assert '["sigmet", "SIGMET", "warn"], null,' in app
    assert '["fires", "Fires", "warn"], ["smoke", "Smoke"], null,' in app
    assert '<div class="menu-sec">Fire &amp; smoke</div>' in html
    assert 'pop.style.setProperty("--strip-btn", st.style.getPropertyValue("--strip-btn"));' in app


def test_tape_control_walks_all_three_states_and_every_change_glides():
    # 2026-09-02: full → header → away → full from one button (and a grip
    # tap); away is a pill, not a black slab; the glide runs for every pair.
    app = _read("app.js"); css = _read("styles.css"); html = _read("index.html")
    assert 'const nextTapeState = () => ({ full: "mini", mini: "away", away: "full" })[tapeState] || "full";' in app
    assert app.index("const nextTapeState") < app.index("function wireOnce")
    assert "const animatable = prev !== s && !matchMedia(\"(prefers-reduced-motion: reduce)\").matches;" in app
    assert 'id="tape-pill"' in html
    for part in ('class="t"', 'class="status"', 'class="field"', 'class="value"', 'class="sub"'):
        assert part in html
    assert "#timebar.tape-away { height: 38px !important;" in css and "@keyframes pill-in" in css
    assert "const TAPE_AWAY_HEIGHT = 38, TAPE_TAP_SLOP = 14;" in app
    assert 'tb.classList.add("is-resizing", "tape-dragging");' in app
    assert '$("#lead").textContent = atNow ? "" :' in app
    assert 'tapeGrip.addEventListener("click",' in app
    assert "#timebar.tape-dragging { height: var(--tape-drag-height) !important;" in css


def test_tape_drag_is_frame_paced_and_stops_at_its_natural_content_height():
    app = _read("app.js"); css = _read("styles.css")
    assert 'const tapeMaxHeight = (bounds = tapeBounds())' in app
    assert 'tapeDrag.want = clamp(tapeDrag.height + tapeDrag.y - clientY, TAPE_AWAY_HEIGHT, tapeDrag.max);' in app
    assert 'max: maxH, distance: 0, from: tapeState' in app
    assert 'tapeGrip.setAttribute("aria-valuemax", Math.round(maxH));' in app
    assert 'const px = `${tapeDrag.want.toFixed(2)}px`;' in app
    assert 'const samples = e.getCoalescedEvents ? e.getCoalescedEvents() : null;' in app
    assert 'if (dragging || animating) return;' in app
    assert '#timebar.user-sized table.wtape { min-height: 0; }' in css
    assert 'height .38s cubic-bezier(.22,1,.36,1)' in css


def test_collapsed_tape_pill_reports_time_slice_field_and_centre_value():
    app = _read("app.js"); field = _read("field.js"); probe = _read("probe.js"); overlays = _read("overlays.js")
    assert "function renderTapePill()" in app
    assert "WX.probe.valueAt(c.lng, c.lat)" in app
    assert 'reading = state.radarSource && state.radarSource.label' in app
    assert 'put(".t", time); put(".status", status); put(".field", field);' in app
    assert "if (WX.fn && WX.fn.renderTapePill) WX.fn.renderTapePill();" in field
    assert "if (WX.fn && WX.fn.renderTapePill) WX.fn.renderTapePill();" in probe
    assert "if (WX.fn.renderTapePill) WX.fn.renderTapePill();" in overlays


def test_tape_slice_label_sits_with_resolution_controls():
    html = _read("index.html"); css = _read("styles.css")
    assert html.index('id="tape-now"') < html.index('id="tape-slice"') < html.index('id="tape-res"')
    assert '<span id="tape-slice">slice</span>' in html
    assert '#tape-slice { margin-left: 12px; margin-right: -8px;' in css
    assert '#tape-slice, #tape-where { color: var(--dim); font: 650 11.5px var(--font-display);' in css
    assert "-webkit-text-size-adjust: 100%" in css


def test_daily_tape_continues_with_aigfs_and_marks_the_model_handoff():
    app = _read("app.js"); tape = _read("tape.js"); css = _read("styles.css")
    assert "state.point.ai = r; renderPoint(); WX.tape.renderTape();" in app
    assert "function refreshTapeAI()" in tape and "function tapeView(d0)" in tape
    assert 'tapeRes !== 24 || state.model === "aigfs"' in tape
    assert 'model: "aigfs"' in tape and 'class="model-handoff">AI-GFS' in tape
    assert "!primaryDays.has(zk(new Date(v)).day)" in tape
    assert "WX.fn.jumpModelTime(col.model, col.valid)" in tape
    assert "table.wtape th.day.ai-start, table.wtape td.ai-start" in css
    seam = css.split("table.wtape th.day.ai-start, table.wtape td.ai-start", 1)[1].split("}", 1)[0]
    assert "border-left: 2px solid #65a8ff" in seam
    assert "box-shadow" not in seam


def test_six_hour_tape_uses_named_local_day_periods_and_separates_temperature_rows():
    tape = _read("tape.js"); css = _read("styles.css")
    assert '["NITE", "MORN", "NOON", "EVE"]' in tape
    assert "agg && aggRes === 6 ? periodTxt(dt)" in tape
    assert 'label("Air temp", WX.units.tempUnit)' in tape
    assert 'label("Feels like", WX.units.tempUnit)' in tape
    assert "Air high / low" not in tape and "Feels high / low" not in tape
    assert 'class="pair-sep"' in tape
    assert "table.wtape tr.r-feels td" in css and "table.wtape .pair-sep" in css
    assert "table.wtape.slice-6 tr.r-hour td" in css


def test_sidebar_keeps_winter_near_the_bottom_but_first_in_the_phone_scroller():
    app = _read("app.js"); css = _read("styles.css")
    rail = app.split('const rail = $("#layers")', 1)[1].split("const railRun", 1)[0]
    assert rail.index('class="rail-seg rail-run"') < rail.index("${winterButton}")
    assert 'class="rail-sec rail-winter-sec">Season' in rail
    assert ".rail .rail-winter { order: -2; margin: 0; }" in css


def test_settings_drawer_is_compact_accessible_and_keeps_utilities_collapsed():
    app = _read("app.js"); settings = _read("settings.js")
    assert 'width:min(400px,100%)' in settings and "@media (max-width:540px)" in settings
    assert 'aria-labelledby", "settings-title"' in settings and 'aria-modal", "true"' in settings
    assert "Units, time & display" in settings
    assert 'class="setting-list"' in settings
    assert 'class="utility"><summary>Keyboard shortcuts' in settings
    assert 'class="utility"><summary>Embed this view' in settings
    assert 'b.setAttribute("aria-pressed", String(on))' in settings
    assert "function open(opener = null)" in settings and "returnFocus.focus" in settings
    assert 'e.currentTarget.closest(".menu")?.querySelector(".menu-btn")' in app
    assert "e.stopImmediatePropagation(); close();" in settings
    assert "Units apply everywhere" not in settings


def test_cursor_value_copy_is_consistent_in_menu_and_strip():
    app = _read("app.js"); html = _read("index.html")
    assert app.count("Show value under cursor") >= 2
    assert html.count("Show value under cursor") >= 2
    assert "Value under the cursor" not in app
    assert "Cursor value" not in html


def test_cursor_probe_accepts_ipad_trackpad_but_ignores_touch_mouse_events():
    app = _read("app.js"); probe = _read("probe.js")
    assert 'matchMedia("(hover: hover)")' not in probe
    assert "oe.sourceCapabilities && oe.sourceCapabilities.firesTouchEvents" in app
    assert 'WX.probe.hover(fromTouch ? null : e.lngLat)' in app
    assert 'pt.setAttribute("aria-pressed", state.probeChip ? "true" : "false")' in app


def test_spread_measures_keep_a_stable_four_colour_key_and_chart_colour():
    panes = _read("panes.js"); ens = _read("ens.js"); css = _read("styles.css")
    for color in ("#ff9254", "#4fc6b2", "#59a8ff", "#b69cff"):
        assert color in panes
    assert 'WXEns.drawPlume(c, pt.plume, { color: selected.color })' in panes
    assert 'const accent = opts.color || css("--accent", "#ff8a3d");' in ens
    assert '.spread-vars button::before' in css and 'var(--spread-color)' in css


def test_resort_difficulty_uses_local_signage_without_rewriting_osm_data():
    overlays = _read("overlays.js"); panes = _read("panes.js")
    assert "function pisteScheme(country)" in overlays
    assert 'label = northAmerica.has(code) ? "North American ratings" : "Oceania ratings"' in overlays
    assert 'id = "japan"; label = "Japanese ratings"' in overlays
    assert 'id = "scandinavia"; label = "Scandinavian ratings"' in overlays
    assert 'local_color: local.color' in overlays and 'local_mark: local.mark' in overlays
    assert '"line-color": ["get", "local_color"]' in overlays
    assert '["get", "local_mark"], " ", ["coalesce", ["get", "name"], ["get", "ref"]]' in overlays
    assert '<span class="k">Ski area</span>' in panes
    assert '<div class="board-head"><span>Elevation bands</span>' in panes
    assert "const scheme = W().pisteScheme" in panes


def test_storms_tool_uses_a_distinct_cloud_and_lightning_icon():
    html = _read("index.html")
    storm = html.split('id="storms-toggle"', 1)[1].split("</button>", 1)[0]
    assert 'M6.8 15.5h10.1' in storm
    assert 'm13 13.5-2.4 4.2' in storm
    assert 'M12 2a10 10' not in storm


def test_the_hero_carries_a_quiet_vs_normal_line():
    panes = _read("panes.js"); css = _read("styles.css")
    assert '<div class="vs-normal" id="normal-slot" hidden></div>' in panes
    assert "function paintNormal(pt, d, i, todays)" in panes and "/normals?lat=" in panes
    assert ".hero .vs-normal { margin-top: 2px; font: 500 11px var(--font-mono); color: var(--dim);" in css
