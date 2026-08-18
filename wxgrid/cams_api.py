"""Routes for the global air-quality layers in wxgrid.cams.

Read-only: everything served here comes out of the cache that
`python -m wxgrid.cams --refresh` writes. Mount with

    from wxgrid.cams_api import router as _cams_router
    app.include_router(_cams_router)
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response

from wxgrid import cams

router = APIRouter(prefix="/api/cams")

# Layer PNGs are immutable for a given (run, var, step): a run id is in the
# catalog the client already fetched, so it can cache hard.
PNG_CACHE = "public, max-age=3600"


@router.get("/catalog")
def api_cams_catalog():
    """Available run, forecast hours, variables and their legends."""
    cat = cams.catalog()
    cat["legends"] = {v: cams.legend(v) for v in cams.VARS}
    return cat


@router.get("/layer/{var}/{step}.png")
def api_cams_layer(var: str, step: int, run: str | None = Query(None, description="run id, default latest")):
    if var not in cams.VARS:
        raise HTTPException(404, f"unknown variable {var!r}; have {sorted(cams.VARS)}")
    try:
        png = cams.layer_png(var, step, rid=run)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return Response(png, media_type="image/png", headers={"Cache-Control": PNG_CACHE})


@router.get("/point")
def api_cams_point(lat: float = Query(..., ge=-90, le=90),
                   lon: float = Query(..., ge=-180, le=180),
                   grid_only: bool = Query(False, description="skip the Open-Meteo call")):
    """Particulates from the cached model grid, plus the gas phase and AQIs
    from CAMS via Open-Meteo (one keyless call, so it can fail on its own)."""
    if grid_only:
        return {"lat": lat, "lon": lon, "grid": cams.grid_point(lat, lon), "cams": None}
    return cams.point(lat, lon)
