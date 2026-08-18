"""Routes for forecast uncertainty (wxgrid.ens), mounted at /api/ens.

GET /api/ens/plume?lat=&lon=&model=&run=&var=   percentile fan for one variable
GET /api/ens/spread?lat=&lon=&model=&run=       every stored `_sd` series at a point
GET /api/ens/sources                            which models carry uncertainty, and why

Every plume response carries `basis`: "members" when the percentiles were
taken across real ensemble members, "gaussian-from-spread" when they were
synthesised from a stored standard deviation. Nothing here guesses — a client
that draws the second as if it were the first is misleading its reader, so
the field is mandatory and never omitted.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from wxgrid import ens

router = APIRouter(prefix="/api/ens")


def _wrap_lon(lon: float) -> float:
    """The map hands out longitudes on repeated world copies."""
    return ((lon + 180.0) % 360.0 + 360.0) % 360.0 - 180.0


@router.get("/plume")
def api_plume(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540),
              model: str = "gefs", run: str = "latest", var: str = "t2m"):
    try:
        return ens.plume(model, run, lat, _wrap_lon(lon), var)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))


@router.get("/spread")
def api_spread(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540),
               model: str = "gefs", run: str = "latest"):
    try:
        return ens.spread_point(model, run, lat, _wrap_lon(lon))
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))


@router.get("/sources")
def api_sources():
    """What the front end needs to decide whether to offer an uncertainty view,
    plus the measured reason there is no member-backed plume."""
    return {"spread": ens.models_with_spread(),
            "vars": {k: {kk: vv for kk, vv in v.items() if kk != "floor"}
                     for k, v in ens.SPREAD_VARS.items()},
            "members": {m: ens.member_sources(m) for m in ens.models_with_spread()},
            "cost": ens.cost_report()}
