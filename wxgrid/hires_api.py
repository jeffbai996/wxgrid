"""Routes for the point-only high-resolution models (wxgrid.hires)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from wxgrid import hires

router = APIRouter(prefix="/api/hires")


@router.get("")
def api_hires_models():
    """Which convection-allowing models are on offer, and where they cover."""
    return {"models": [{"key": k, **{f: v[f] for f in ("label", "short", "grid", "hours", "area")}}
                       for k, v in hires.MODELS.items()]}


@router.get("/{key}")
def api_hires_point(key: str, lat: float = Query(..., ge=-90, le=90),
                    lon: float = Query(..., ge=-540, le=540)):
    try:
        return hires.point(key, lat, ((lon + 180) % 360 + 360) % 360 - 180)
    except KeyError:
        raise HTTPException(404, f"unknown high-resolution model {key}")
