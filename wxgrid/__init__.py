"""wxgrid — global weather-model grids for the map front end and Python consumers.

One store, two consumers: model runs (ECMWF IFS/AIFS, NOAA GFS, ...) are
fetched as GRIB2, normalised onto a common 0.25° lat/lon grid, and written to
Zarr. The FastAPI layer serves Mercator-projected PNG layers and coarse wind
vectors to the browser; `wxgrid.reader` hands the same arrays to Python.
"""
