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
    assert "calc(6px + env(safe-area-inset-bottom))" in block


def test_next_48_hour_blurb_vertical_space_is_compact():
    css = _read("styles.css")
    rule = css.split(".summary {", 1)[1].split("}", 1)[0]
    assert "margin: 1px 0 3px" in rule
    assert "padding: 0 0 0 11px" in rule
