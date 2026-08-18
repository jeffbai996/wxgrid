"""Routes for the agency-radar catalogue and the aurora nowcast in wxgrid.radar.

GET /api/radar/sources?lat=&lon=   every radar source, its frame timestamps and
                                   tile-URL templates, plus the id this map
                                   centre should prefer and the fallback chain
GET /api/radar/aurora.json         OVATION validity times, peak probability,
                                   current Kp, and the colour ramp
GET /api/radar/aurora.png          the nowcast as a Web-Mercator RGBA PNG
GET /api/radar/lightning           why there is no lightning layer

Tiles are never proxied: /sources hands the browser templates that point
straight at ECCC, NOAA and RainViewer, all of which allow cross-origin reads.
The aurora PNG is served from here because SWPC publishes JSON, not tiles.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from starlette.responses import Response

from wxgrid import radar

router = APIRouter(prefix="/api/radar")


@router.get("/sources")
def api_radar_sources(lat: float | None = Query(None, ge=-90, le=90),
                      lon: float | None = Query(None, ge=-180, le=180)):
    return radar.sources(lat, lon)


@router.get("/aurora.json")
def api_aurora_meta():
    try:
        return radar.aurora_meta()
    except Exception as exc:
        raise HTTPException(503, f"aurora nowcast unavailable: {exc}") from exc


@router.get("/aurora.png")
def api_aurora_png():
    try:
        png = radar.aurora_png()
    except Exception as exc:
        raise HTTPException(503, f"aurora nowcast unavailable: {exc}") from exc
    # OVATION is recomputed every ~5 min; let the browser hold it for half that.
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=150"})


@router.get("/lightning")
def api_lightning():
    """Always the same answer, and the answer is no — see wxgrid.radar."""
    return radar.LIGHTNING_STATUS
