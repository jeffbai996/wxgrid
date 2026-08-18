"""Routes for the SIGMET / AIRMET layer in wxgrid.sigmet."""
from __future__ import annotations

from fastapi import APIRouter, Query

from wxgrid import sigmet

router = APIRouter(prefix="/api/sigmet")


@router.get("/layer")
def api_sigmet_layer():
    return sigmet.sigmet_layer()


@router.get("/point")
def api_sigmet_point(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    return {"hazards": sigmet.sigmet_point(lat, lon)}
