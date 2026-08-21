"""wxgrid — global weather-model grids for the map front end and Python consumers.

One store, two consumers: global runs are normalised onto the original 0.25°
lat/lon grid; HRDPS/HRRR are reprojected onto regular 0.025° regional grids.
The FastAPI layer serves Mercator-projected PNG layers and coarse wind vectors
to the browser; `wxgrid.reader` hands the same arrays to Python.
"""
