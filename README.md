# ERIS v2 - Rawalpindi Emergency Response Intelligence System

Dashboard URL: http://localhost:8000

    python run_all.py     # phases 1-6, including the road-map layer
    python server.py      # start the dashboard only if it is not already running

Real incident data (optional): data/incidents.csv with columns lat,lon,type,datetime,response_min
Without it, phase 5 creates a SIMULATED demo set (clearly labelled in the dashboard).

## Dashboard status

The dashboard has separate Overview, Emergency Mapping, Network Analysis,
Predictive Analytics (Demo), Hotspot Heatmaps, Accessibility, Facility Optimization, Planning
Recommendations, Priority Zones, Dispatch Center, and Reports & Analytics
views. Predictive Analytics is explicitly labeled as a demo and Planning
Recommendations presents access-time bands and candidate planning
hypotheses, not trained AI outputs or verified sites. It uses generated project outputs for facility counts, road-network
access estimates, service-area polygons, candidate sites, and incident
summaries. Network Analysis and Dispatch Center use the existing `/api/dispatch`
route endpoint; clicking the map selects an origin.

Priority Zones aggregates sampled road-node travel times into 500 m grid cells
in projected coordinates. Cell colors show mean time to the slower available
hospital/fire service; hover for each service's mean and the number of sampled
nodes in that cell. The grid is a visualization of the sampled network, not
neighborhood boundaries or population-weighted coverage. Its adjacent chart
uses fixed travel-time bands; the class table remains a relative quartile
summary.

Reports can download incident and sampled access-point CSV files, export
facility GeoJSON, and open the browser print dialog for PDF output. Reports &
Analytics shows fixed travel-time bands and a Data sources and date summary
with the study-area definition and analysis-environment versions. The road
graph file timestamp indicates 2026-11-08 (an approximate download date; the
facility extract has no separate timestamp). Its Limits section also covers
incident records, population, facility verification, geographic coverage,
route assumptions, and interpretation of model outputs.

The maps use a taller, responsive viewport-based layout so mapped features and
routes are easier to inspect. On narrow screens, map sizing adapts to the
viewport and the dashboard retains its existing single-column layout.

The Overview page prioritizes a large dark-basemap map with boundary, named
hospitals, fire stations, and OpenStreetMap area names enabled by default.
Area labels are clipped to the study boundary and reveal neighborhood-level
names as the map is zoomed in; road lines and access samples can be enabled from
the map's layer panel. Its side panels summarize 10-minute
road-node coverage, hospital access-time estimates, and the highest-ranked
sample coordinates. Dispatch Center uses a three-panel scenario layout with
explicit demo-only severity, route estimates, suggested facilities, and a
simulated route marker; it does not dispatch real units. The dashboard uses a
single page scroll, a compact KPI strip, and a collapsible sidebar on small
screens.

Network Analysis starts with the 10-minute hospital (blue) and fire-station
(red) service-area polygons, facility markers, and no road lines. The hospital
service area is shown initially; hospital and fire service areas have separate
toggles and use light fills to keep overlapping areas and markers legible.
Clinics can be shown separately, and routes, clinics, and roads can be enabled as needed. Its
coverage chart describes equal-weight sampled road nodes within the compact
8 km study boundary; full coverage at a threshold does not imply full-city or
district coverage and is not population-weighted.

Area labels come from named OpenStreetMap place points within the study boundary.
They are community-mapped locality references, not official administrative
neighborhood boundaries.

## Map and hospital directory

The interactive map combines OpenStreetMap tiles with the project road-network
GeoJSON layer, facility markers, and feature popups. The source contains 78
mapped OSM healthcare/hospital records in the project's 8 km study area;
unnamed records are excluded from map markers and the searchable directory.
The current directory displays 72 named hospital records and each record's
available OSM tags, including address, contact, facility type, services,
opening hours, and other metadata; untagged details are identified as
unavailable rather than inferred. The emergency-services source has 8 records,
including ambulance stations; nearby fire-station search includes only named
records tagged as fire stations.

On Emergency Mapping, the facility-name suggestions search the loaded
hospital and fire-station lists. Users can opt in to continuous browser
geolocation, see named nearby facilities sorted by road distance, select a
specific facility, and request up to three distinct routes ordered by estimated
free-flow travel time. Route choices show distance, travel-time estimates, and
directions for the selected path. Alternatives are calculated from the mapped
drive graph; they do not use live traffic or imply road availability. Location
access requires user permission and a secure context such as localhost or
HTTPS. The route and nearby-service endpoints are served by `server.py`;
restart the existing server process after updating backend code to enable new
route responses.

Emergency Mapping also provides an optional WorldPop population overlay when
the population preparation script has been run. To generate it, run
`python scripts/07_prepare_population.py`. The script retrieves the Pakistan
2025 constrained 100 m estimate from the WorldPop API, clips it to the existing
study-area boundary, and writes a GeoTIFF, a Leaflet PNG overlay, and metadata
to `dashboard/data/`. The selected R2025A v1 release is marked alpha by
WorldPop; values are modeled estimates, not census observations, and the
dashboard does not currently use them to calculate population-weighted access.
Attribution and the dataset citation are saved in
`dashboard/data/population_metadata.json`.

OpenStreetMap is community maintained and may be incomplete or out of date, so
this study-area directory is not an authoritative or exhaustive Rawalpindi
hospital register. Verify contact details with the facility before relying on
them. Map data and tiles are attributed to OpenStreetMap contributors.

## Data limitations

- Incident data is simulated unless `data/incidents.csv` is supplied. Simulated
  model metrics are not real-world validation. A project CSV is not considered
  an official or verified Rescue 1122 incident feed unless its provenance has
  been independently confirmed.
- WorldPop R2025A population values are estimates and the release is marked
  alpha by its publisher. The layer is visualized only; accessibility and
  service-area statistics remain road-node based, not population weighted.
- The generated access sample is road-node based, not population weighted.
- Reported high-threshold coverage is confined to the compact 8 km project
  boundary; full sampled-node coverage there must not be interpreted as
  full Rawalpindi city/district coverage.
- Route estimates near the study-area boundary are less reliable because the
  road graph is clipped to the project boundary and may omit useful roads or
  connections beyond it.
- Accessibility estimates use the available road graph and do not account for
  live traffic, road closures, or verified dispatch times.
- Verified official hospital and fire-station registers are not included.
  Existing facility locations and tags are community-mapped OpenStreetMap
  records and may be incomplete or out of date.
- The project does not have an official Rescue 1122 incident feed. Unless an
  authorized, provenance-documented incident file is supplied, incident
  records are simulated. No restricted or personally identifiable incident
  records should be imported into the dashboard.
- The project facility query covers an 8 km study area around Rawalpindi city
  centre and is not an exhaustive district-wide inventory.
- Verified traffic/dispatch data and population-weighted exposure figures are
  therefore unavailable.
- Facility optimization uses a 5-minute greedy maximal-coverage scenario over
  the same 4,000 sampled road nodes and rounded access times used on the
  Accessibility page. Candidate locations are selected from a
  seeded random sample of road-graph nodes and are for further assessment, not
  site recommendations. Results near the study-area edge may reflect boundary
  clipping because facilities and roads just outside the approximately 8 km
  study area are not counted. Population weighting and p-median optimization
  are not implemented; land availability, road access, and site suitability
  require field verification.
- Facility search searches loaded OSM facility names; it is not a geocoder.
