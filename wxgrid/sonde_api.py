"""Routes for observed radiosonde soundings (wxgrid.sonde), mounted at
/api/sonde. Mount with

    from wxgrid.sonde_api import router as _sonde_router
    app.include_router(_sonde_router)

Both endpoints answer with the same envelope — {station, sounding, reason} —
so the Skew-T tab has one shape to draw and one place to look when there is
nothing to draw. `sounding` is null with a `reason` rather than a 404 whenever
the *station* was found: "no station near here" and "that station has not
flown yet today" are different problems and the front end shows them
differently. Levels are thinned to `max_levels` (default 320), which keeps the
response near 30 KB even for a full BUFR ascent.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from wxgrid import sonde

router = APIRouter(prefix="/api/sonde")


def _envelope(st: dict | None, when: str, max_levels: int, missing: str) -> dict:
    if st is None:
        return {"station": None, "sounding": None, "reason": missing}
    got = sonde.sounding(st["id"], when, max_levels)
    if got is None:
        return {"station": st, "sounding": None,
                "reason": f"no sounding posted for {st['name'] or st['id']} at {when}"}
    # sonde.sounding() re-resolves the station by id, so anything the caller
    # learned on the way in — how far away it is — has to be put back.
    meta = {**got["station"], **{k: st[k] for k in ("distance_km",) if k in st}}
    return {"station": meta, "sounding": {**got, "station": meta}, "reason": None}


@router.get("/nearest")
def api_sonde_nearest(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                      max_km: float = Query(400.0, gt=0, le=2000),
                      when: str = Query("latest", max_length=20),
                      max_levels: int = Query(sonde.MAX_LEVELS, ge=20, le=1000)):
    """Closest launch site to a point plus its latest ascent."""
    st = sonde.nearest_station(lat, lon, max_km)
    return _envelope(st, when, max_levels, f"no radiosonde station within {max_km:g} km")


@router.get("/station/{station_id}")
def api_sonde_station(station_id: str, when: str = Query("latest", max_length=20),
                      max_levels: int = Query(sonde.MAX_LEVELS, ge=20, le=1000)):
    """One station by WMO number, ICAO id or IGRA id."""
    st = sonde.station(station_id)
    if st is None:
        raise HTTPException(404, f"unknown radiosonde station {station_id!r}")
    return _envelope(st, when, max_levels, "")
